import {
	type Counter,
	type Histogram,
	type Meter,
	metrics,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace
} from '@opentelemetry/api'
import type { Context } from 'hono'
import {
	summarizeEvent,
	type WebhookEvent,
	type WebhookEventSummary,
	type WebhooksOptions
} from 'hono-webhooks'

/** The `route` label for 404s, which match no webhook. */
export const UNMATCHED_ROUTE = '__unmatched__'

export interface OtelWebhooksOptions {
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
		call: WebhookEventSummary,
		event: WebhookEvent
	) => void | Promise<void>
}

/**
 * `around` and `onEvent` that put each request in a server span and record
 * `webhook_request_total` and `webhook_request_duration_ms` by route and
 * outcome.
 *
 * @example
 * createWebhooks(webhooks, { ...otelWebhooks({ ignoreRoutes: ['/health'] }), logErrors: false })
 */
export function otelWebhooks(
	options: OtelWebhooksOptions = {}
): Required<Pick<WebhooksOptions, 'around' | 'onEvent'>> {
	const tracer = options.tracer ?? trace.getTracer('webhooks')
	const ignored = new Set(options.ignoreRoutes)
	// The span is looked up by context, so it is found even without an OTel
	// context manager.
	const spans = new WeakMap<Context, Span>()
	let instruments: { total: Counter; duration: Histogram } | undefined

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
			const call = summarizeEvent(event)
			const success = call.status < 400

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

			if (call.route === null || !ignored.has(call.route)) {
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

			return options.onWebhookCall?.(call, event)
		}
	}
}

function createInstruments(meter: Meter) {
	return {
		total: meter.createCounter('webhook_request_total', {
			description: 'HTTP webhook requests by route template and status'
		}),
		duration: meter.createHistogram('webhook_request_duration_ms', {
			unit: 'ms',
			description: 'HTTP webhook handler duration by route template and status'
		})
	}
}
