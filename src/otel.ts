import {
	type Meter,
	metrics,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace
} from '@opentelemetry/api'
import type { Context, Env } from 'hono'
import {
	summarizeEvent,
	type WebhookEvent,
	type WebhookEventSummary,
	type WebhooksOptions
} from 'hono-webhooks'

/** The `route` label for 404s, which match no webhook. */
export const UNMATCHED_ROUTE = '__unmatched__'

/** A metric `otelWebhooks` records, described for a metric catalog. */
export interface WebhookMetricDefinition {
	name: string
	kind: 'counter' | 'histogram'
	unit?: string
	description: string
	/** Attribute key to its closed set of values, or `'string'` when open. */
	attributes: Record<string, readonly string[] | 'string'>
}

const metricAttributes = {
	route: 'string',
	status: ['success', 'failed']
} as const

/**
 * The metrics `otelWebhooks` records, as data: list them in a metric
 * catalog without creating a second recorder.
 */
export const webhookMetrics = [
	{
		name: 'webhook_request_total',
		kind: 'counter',
		description: 'HTTP webhook requests by route template and status',
		attributes: metricAttributes
	},
	{
		name: 'webhook_request_duration_ms',
		kind: 'histogram',
		unit: 'ms',
		description: 'HTTP webhook handler duration by route template and status',
		attributes: metricAttributes
	}
] as const satisfies readonly WebhookMetricDefinition[]

/** `summarizeEvent(event)` plus what a completion log needs. */
export interface WebhookCall extends WebhookEventSummary {
	/** `error` for 5xx, `warn` for 4xx, else `info`. */
	level: 'info' | 'warn' | 'error'
	outcome: 'success' | 'failed' | 'validation_failed'
}

/** `console` fits, as does any logger with these three methods. */
export type WebhookLogger = Record<
	WebhookCall['level'],
	(message: string, fields: Record<string, string | number>) => void
>

export interface OtelWebhooksOptions<E extends Env = any> {
	/** @default trace.getTracer('webhooks') */
	tracer?: Tracer
	/** @default metrics.getMeter('webhooks'), resolved on the first request */
	meter?: Meter
	/** Routes that get a span but no metrics, e.g. `['/health']`. */
	ignoreRoutes?: readonly string[]
	/**
	 * Called after every request, ignored routes included, with the span
	 * still active: log it, store it. A returned promise is handled like
	 * `onEvent`'s.
	 */
	onWebhookCall?: (
		call: WebhookCall,
		event: WebhookEvent<E>
	) => void | Promise<void>
	/**
	 * Logs one `webhook.completed` event per request at `call.level`, with
	 * `route`, `method`, `status_code`, `duration_ms`, `status` (the outcome)
	 * and `error_type`. 404s and `ignoreRoutes` are skipped. Called with the
	 * request's span, so the logger can attach to it.
	 *
	 * @example
	 * logger: () => console
	 */
	logger?: (span: Span) => WebhookLogger
}

/**
 * `around` and `onEvent` that put each request in a server span and record
 * `webhook_request_total` and `webhook_request_duration_ms` by route and
 * outcome.
 *
 * With `createWebhookFactory<AppEnv>()`, call `otelWebhooks<AppEnv>(...)`
 * so `onWebhookCall` gets a typed context.
 *
 * @example
 * createWebhooks(webhooks, { ...otelWebhooks({ ignoreRoutes: ['/health'] }), logErrors: false })
 */
export function otelWebhooks<E extends Env = any>(
	options: OtelWebhooksOptions<E> = {}
): Required<Pick<WebhooksOptions<E>, 'around' | 'onEvent'>> {
	const tracer = options.tracer ?? trace.getTracer('webhooks')
	const ignored = new Set(options.ignoreRoutes)
	// The span is looked up by context, so it is found even without an OTel
	// context manager.
	const spans = new WeakMap<Context, Span>()
	let instruments: ReturnType<typeof createInstruments> | undefined

	return {
		around: ({ c, route, method }, next) => {
			const label = route ?? UNMATCHED_ROUTE
			return tracer.startActiveSpan(
				`webhook: ${method} ${label}`,
				{
					kind: SpanKind.SERVER,
					attributes: { 'http.method': method, 'http.route': label }
				},
				async (span) => {
					spans.set(c, span)
					try {
						return await next()
					} finally {
						span.end()
					}
				}
			)
		},
		onEvent: (event) => {
			const summary = summarizeEvent(event)
			const success = summary.status < 400
			const call: WebhookCall = {
				...summary,
				level: summary.status >= 500 ? 'error' : success ? 'info' : 'warn',
				outcome: summary.validation
					? 'validation_failed'
					: success
						? 'success'
						: 'failed'
			}

			const span = spans.get(event.c)
			span?.setAttributes({
				'http.status_code': call.status,
				'webhook.duration_ms': call.durationMs,
				'webhook.success': success
			})
			if (call.validation) {
				span?.setAttribute('webhook.validation_error', call.validation.message)
			}
			if (event.error instanceof Error && call.status >= 500) {
				span?.recordException(event.error)
			}
			span?.setStatus({
				code: success ? SpanStatusCode.OK : SpanStatusCode.ERROR
			})

			const isIgnored = call.route !== null && ignored.has(call.route)
			if (!isIgnored) {
				// Created lazily so a meter provider registered after import still applies.
				instruments ??= createInstruments(
					options.meter ?? metrics.getMeter('webhooks')
				)
				const attributes = {
					route: call.route ?? UNMATCHED_ROUTE,
					status: success ? 'success' : 'failed'
				}
				instruments.total.add(1, attributes)
				instruments.duration.record(event.durationMs, attributes)
			}

			if (span && options.logger && call.route !== null && !isIgnored) {
				options.logger(span)[call.level]('webhook.completed', {
					event: 'webhook.completed',
					route: call.route,
					method: call.method,
					status_code: call.status,
					duration_ms: call.durationMs,
					status: call.outcome,
					...(call.error && { error_type: call.error.name })
				})
			}

			return options.onWebhookCall?.(call, event)
		}
	}
}

function createInstruments(meter: Meter) {
	const [total, duration] = webhookMetrics
	return {
		total: meter.createCounter(total.name, {
			description: total.description
		}),
		duration: meter.createHistogram(duration.name, {
			unit: duration.unit,
			description: duration.description
		})
	}
}
