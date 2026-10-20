import { describe, expect, test } from 'bun:test'
import { SpanKind, SpanStatusCode } from '@opentelemetry/api'
import {
	DataPointType,
	MeterProvider,
	MetricReader
} from '@opentelemetry/sdk-metrics'
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor
} from '@opentelemetry/sdk-trace-base'
import { Hono } from 'hono'
import { z } from 'zod'
import {
	createWebhooks,
	defineWebhook,
	type WebhookEvent,
	type WebhookEventSummary
} from './index'
import { type OtelWebhooksOptions, otelWebhooks } from './otel'

class TestReader extends MetricReader {
	protected onShutdown = async () => {}
	protected onForceFlush = async () => {}
}

const webhooks = [
	defineWebhook({ method: 'GET', path: '/health' }, () => ({ ok: true })),
	defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id',
			body: z.object({ total: z.number() })
		},
		({ params }) => ({ id: params.id })
	),
	defineWebhook({ method: 'POST', path: '/boom' }, () => {
		throw new Error('kaboom')
	})
]

const setup = (options: Omit<OtelWebhooksOptions, 'tracer' | 'meter'> = {}) => {
	const exporter = new InMemorySpanExporter()
	const tracer = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)]
	}).getTracer('test')
	const reader = new TestReader()
	const meter = new MeterProvider({ readers: [reader] }).getMeter('test')

	const app = new Hono()
	app.route(
		'/webhooks',
		createWebhooks(webhooks, {
			...otelWebhooks({ ...options, tracer, meter }),
			logErrors: false
		})
	)

	const metrics = async () => {
		const { resourceMetrics } = await reader.collect()
		const all = resourceMetrics.scopeMetrics.flatMap((s) => s.metrics)
		const total = all.find((m) => m.descriptor.name === 'webhook_request_total')
		const durations = all.find(
			(m) => m.descriptor.name === 'webhook_request_duration_ms'
		)

		return {
			total:
				total?.dataPointType === DataPointType.SUM
					? total.dataPoints.map(
							({ attributes: { route, status }, value }) => ({
								route,
								status,
								value
							})
						)
					: [],
			durations:
				durations?.dataPointType === DataPointType.HISTOGRAM
					? durations.dataPoints.map(
							({ attributes: { route, status }, value }) => ({
								route,
								status,
								count: value.count
							})
						)
					: []
		}
	}

	return { app, spans: () => exporter.getFinishedSpans(), metrics }
}

const post = (body: unknown) => ({
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(body)
})

describe('otelWebhooks', () => {
	test('records a span and metrics for a successful request', async () => {
		const { app, spans, metrics } = setup()
		const res = await app.request('/webhooks/orders/42', post({ total: 1 }))
		expect(res.status).toBe(200)

		const [span] = spans()
		expect(span?.name).toBe('webhook: POST /orders/:id')
		expect(span?.kind).toBe(SpanKind.SERVER)
		expect(span?.status.code).toBe(SpanStatusCode.OK)
		expect(span?.attributes).toMatchObject({
			'http.method': 'POST',
			'http.route': '/orders/:id',
			'http.status_code': 200,
			'webhook.success': true
		})
		expect(span?.attributes['webhook.duration_ms']).toBeNumber()

		expect(await metrics()).toEqual({
			total: [{ route: '/orders/:id', status: 'success', value: 1 }],
			durations: [{ route: '/orders/:id', status: 'success', count: 1 }]
		})
	})

	test('marks validation failures on the span and as failed', async () => {
		const { app, spans, metrics } = setup()
		const res = await app.request('/webhooks/orders/42', post({ total: 'x' }))
		expect(res.status).toBe(400)

		const [span] = spans()
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
		expect(span?.attributes['webhook.validation_error']).toStartWith('total:')
		expect(span?.events).toHaveLength(0)
		expect((await metrics()).total).toEqual([
			{ route: '/orders/:id', status: 'failed', value: 1 }
		])
	})

	test('records the exception of a handler error', async () => {
		const { app, spans } = setup()
		expect(
			(await app.request('/webhooks/boom', { method: 'POST' })).status
		).toBe(500)

		const [span] = spans()
		expect(span?.status.code).toBe(SpanStatusCode.ERROR)
		expect(span?.events[0]?.name).toBe('exception')
		expect(span?.events[0]?.attributes?.['exception.message']).toBe('kaboom')
	})

	test('labels unmatched requests', async () => {
		const { app, spans, metrics } = setup()
		expect((await app.request('/webhooks/nope')).status).toBe(404)

		expect(spans()[0]?.name).toBe('webhook: GET __unmatched__')
		expect((await metrics()).total).toEqual([
			{ route: '__unmatched__', status: 'failed', value: 1 }
		])
	})

	test('ignoreRoutes keeps the span and onWebhookCall but skips metrics', async () => {
		const calls: [WebhookEventSummary, WebhookEvent][] = []
		const { app, spans, metrics } = setup({
			ignoreRoutes: ['/health'],
			onWebhookCall: (call, event) => void calls.push([call, event])
		})
		await app.request('/webhooks/health')

		expect(spans()).toHaveLength(1)
		expect((await metrics()).total).toEqual([])
		expect(calls).toHaveLength(1)
		expect(calls[0]?.[0]).toMatchObject({ route: '/health', status: 200 })
		expect(calls[0]?.[1].route).toBe('/health')
	})
})
