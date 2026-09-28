import { describe, expect, spyOn, test } from 'bun:test'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import * as v from 'valibot'
import { z } from 'zod'
import {
	createWebhookFactory,
	createWebhooks,
	defineWebhook,
	describeWebhooks,
	formatIssues,
	summarizeEvent,
	testWebhook,
	type Webhook,
	type WebhookEvent,
	type WebhooksOptions,
	WebhookValidationError
} from './index'

const mount = (webhooks: Webhook[], options?: WebhooksOptions) => {
	const app = new Hono()
	app.route('/webhooks', createWebhooks(webhooks, options))
	return app
}

const post = (body: unknown, contentType = 'application/json') => ({
	method: 'POST',
	headers: { 'content-type': contentType },
	body: typeof body === 'string' ? body : JSON.stringify(body)
})

const collectEvents = () => {
	const events: WebhookEvent[] = []
	return { events, onEvent: (e: WebhookEvent) => void events.push(e) }
}

const silenceConsoleError = () =>
	spyOn(console, 'error').mockImplementation(() => {})

const health = defineWebhook({ method: 'GET', path: '/health' }, () => ({
	status: 'ok'
}))

describe('routing', () => {
	test('matches a static route', async () => {
		const res = await mount([health]).request('/webhooks/health')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ status: 'ok' })
	})

	test('answers 404 below the mount and leaves other paths alone', async () => {
		const app = mount([health])
		app.get('/webhooks-debug', (c) => c.text('debug'))

		const missing = await app.request('/webhooks/unknown')
		expect(missing.status).toBe(404)
		expect(await missing.json()).toEqual({ error: 'Route not found' })
		expect(await (await app.request('/webhooks-debug')).text()).toBe('debug')
	})

	test('answers 405 with an Allow header for a known path', async () => {
		const res = await mount([health]).request('/webhooks/health', {
			method: 'DELETE'
		})
		expect(res.status).toBe(405)
		expect(res.headers.get('allow')).toBe('GET')
		expect(await res.json()).toEqual({ error: 'Method DELETE not allowed' })
	})

	test('dispatches the same path by method', async () => {
		const get = defineWebhook(
			{ method: 'GET', path: '/items/:id' },
			() => 'get'
		)
		const put = defineWebhook(
			{ method: 'PUT', path: '/items/:id' },
			() => 'put'
		)
		const app = mount([get, put])

		expect(await (await app.request('/webhooks/items/1')).text()).toBe('get')
		expect(
			await (await app.request('/webhooks/items/1', { method: 'PUT' })).text()
		).toBe('put')
		const res = await app.request('/webhooks/items/1', { method: 'POST' })
		expect(res.status).toBe(405)
		expect(res.headers.get('allow')).toBe('GET, PUT')
	})

	test('static routes win over dynamic ones regardless of order', async () => {
		const dynamic = defineWebhook(
			{ method: 'GET', path: '/users/:id' },
			({ params }) => ({ id: params.id })
		)
		const me = defineWebhook({ method: 'GET', path: '/users/me' }, () => ({
			me: true
		}))
		const res = await mount([dynamic, me]).request('/webhooks/users/me')
		expect(await res.json()).toEqual({ me: true })
	})

	test('GET routes answer HEAD without a body', async () => {
		const res = await mount([health]).request('/webhooks/health', {
			method: 'HEAD'
		})
		expect(res.status).toBe(200)
		expect(await res.text()).toBe('')
	})

	test('throws on a duplicate method and path', () => {
		expect(() => createWebhooks([health, health])).toThrow(
			'GET /health is defined twice'
		)
	})

	test('exposes the definitions', () => {
		expect(createWebhooks([health]).webhooks).toEqual([health])
	})
})

describe('params', () => {
	test('extracts and decodes path params', async () => {
		const route = defineWebhook(
			{ method: 'GET', path: '/users/:userId/posts/:postId' },
			({ params }) => params
		)
		const res = await mount([route]).request(
			'/webhooks/users/hello%20world/posts/x'
		)
		expect(await res.json()).toEqual({ userId: 'hello world', postId: 'x' })
	})

	test('validates and transforms params', async () => {
		const route = defineWebhook(
			{
				method: 'GET',
				path: '/items/:id',
				params: z.object({ id: z.coerce.number().int() })
			},
			({ params }) => ({ next: params.id + 1 })
		)
		const app = mount([route])

		expect(await (await app.request('/webhooks/items/41')).json()).toEqual({
			next: 42
		})
		const res = await app.request('/webhooks/items/abc')
		expect(res.status).toBe(400)
		const json = (await res.json()) as { error: string; issues: unknown[] }
		expect(json.error).toBe('Invalid params')
		expect(json.issues.length).toBeGreaterThan(0)
	})
})

describe('query', () => {
	const search = defineWebhook(
		{
			method: 'GET',
			path: '/search',
			query: z.object({ q: z.string(), limit: z.coerce.number().default(10) })
		},
		({ query }) => query
	)

	test('validates and applies defaults', async () => {
		const res = await mount([search]).request('/webhooks/search?q=hi')
		expect(await res.json()).toEqual({ q: 'hi', limit: 10 })
	})

	test('rejects invalid query', async () => {
		const res = await mount([search]).request('/webhooks/search')
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: string }).error).toBe(
			'Invalid query'
		)
	})

	test('passes the raw query without a schema', async () => {
		const route = defineWebhook(
			{ method: 'GET', path: '/q' },
			({ query }) => query
		)
		const res = await mount([route]).request('/webhooks/q?a=1&b=2')
		expect(await res.json()).toEqual({ a: '1', b: '2' })
	})
})

describe('headers', () => {
	const protectedRoute = defineWebhook(
		{
			method: 'GET',
			path: '/protected',
			headers: z.object({ authorization: z.string() })
		},
		({ headers }) => ({ auth: headers.authorization })
	)

	test('validates headers case-insensitively', async () => {
		const res = await mount([protectedRoute]).request('/webhooks/protected', {
			headers: { Authorization: 'Bearer x' }
		})
		expect(await res.json()).toEqual({ auth: 'Bearer x' })
	})

	test('rejects missing headers', async () => {
		const res = await mount([protectedRoute]).request('/webhooks/protected')
		expect(res.status).toBe(400)
	})
})

describe('body', () => {
	const createUser = defineWebhook(
		{
			method: 'POST',
			path: '/users',
			body: z.object({ name: z.string(), email: z.email() })
		},
		({ body }) => ({ id: 1, name: body.name })
	)

	test('validates a JSON body', async () => {
		const res = await mount([createUser]).request(
			'/webhooks/users',
			post({ name: 'Ada', email: 'ada@example.com' })
		)
		expect(await res.json()).toEqual({ id: 1, name: 'Ada' })
	})

	test('rejects an invalid body', async () => {
		const res = await mount([createUser]).request(
			'/webhooks/users',
			post({ name: 'Ada' })
		)
		expect(res.status).toBe(400)
		expect(((await res.json()) as { error: string }).error).toBe('Invalid body')
	})

	test('rejects malformed JSON', async () => {
		const res = await mount([createUser]).request(
			'/webhooks/users',
			post('{nope')
		)
		expect(res.status).toBe(400)
		expect(await res.json()).toEqual({
			error: 'Invalid body',
			issues: [{ message: 'Malformed JSON' }]
		})
	})

	test('a JSON body sent as text/plain fails an object schema', async () => {
		const res = await mount([createUser]).request(
			'/webhooks/users',
			post({ name: 'Ada', email: 'ada@example.com' }, 'text/plain')
		)
		expect(res.status).toBe(400)
	})

	test('bodyType json ignores the content type', async () => {
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/json',
				bodyType: 'json',
				body: z.object({ a: z.number() })
			},
			({ body }) => body
		)
		const res = await mount([route]).request(
			'/webhooks/json',
			post({ a: 1 }, 'text/plain')
		)
		expect(await res.json()).toEqual({ a: 1 })
	})

	test('parses vendor JSON types', async () => {
		const route = defineWebhook(
			{ method: 'POST', path: '/cloudevents' },
			({ body }) => ({ body })
		)
		const res = await mount([route]).request(
			'/webhooks/cloudevents',
			post({ a: 1 }, 'application/cloudevents+json; charset=utf-8')
		)
		expect(await res.json()).toEqual({ body: { a: 1 } })
	})

	test('parses url-encoded forms', async () => {
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/twilio',
				body: z.object({ From: z.string(), Body: z.string() })
			},
			({ body }) => body
		)
		const res = await mount([route]).request(
			'/webhooks/twilio',
			post('From=%2B4512345678&Body=hi', 'application/x-www-form-urlencoded')
		)
		expect(await res.json()).toEqual({ From: '+4512345678', Body: 'hi' })
	})

	test('parses text bodies', async () => {
		const route = defineWebhook(
			{ method: 'POST', path: '/text', body: z.string() },
			({ body }) => body.toUpperCase()
		)
		const res = await mount([route]).request(
			'/webhooks/text',
			post('hello', 'text/plain;charset=utf-8')
		)
		expect(res.headers.get('content-type')).toContain('text/plain')
		expect(await res.text()).toBe('HELLO')
	})

	test('an empty body is undefined', async () => {
		const route = defineWebhook(
			{ method: 'POST', path: '/empty' },
			({ body }) => ({ empty: body === undefined })
		)
		const res = await mount([route]).request('/webhooks/empty', {
			method: 'POST'
		})
		expect(await res.json()).toEqual({ empty: true })
	})

	test('always passes the raw body next to the parsed one', async () => {
		const payload = '{"id":"evt_1",  "type":"charge.succeeded"}'
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/stripe',
				body: z.object({ id: z.string(), type: z.string() })
			},
			({ body, rawBody }) => ({ id: body.id, rawBody })
		)
		const res = await mount([route]).request('/webhooks/stripe', post(payload))
		expect(await res.json()).toEqual({ id: 'evt_1', rawBody: payload })
	})
})

describe('responses', () => {
	test('passes a Response through', async () => {
		const route = defineWebhook(
			{ method: 'GET', path: '/custom' },
			() => new Response('Created', { status: 201 })
		)
		const res = await mount([route]).request('/webhooks/custom')
		expect(res.status).toBe(201)
		expect(await res.text()).toBe('Created')
	})

	test('handlers can use the Hono context', async () => {
		const route = defineWebhook(
			{ method: 'POST', path: '/accepted' },
			({ c }) => c.json({ queued: true }, 202)
		)
		const res = await mount([route]).request('/webhooks/accepted', {
			method: 'POST'
		})
		expect(res.status).toBe(202)
	})

	test('returning nothing answers 204', async () => {
		const route = defineWebhook({ method: 'POST', path: '/ack' }, () => {})
		const res = await mount([route]).request('/webhooks/ack', {
			method: 'POST'
		})
		expect(res.status).toBe(204)
	})

	test('a response schema mismatch is reported but still sent', async () => {
		const { events, onEvent } = collectEvents()
		const route = defineWebhook(
			{
				method: 'GET',
				path: '/bad',
				response: z.object({ id: z.number() })
			},
			// Handler lies about its shape at runtime.
			() => ({ id: 'nope' }) as unknown as { id: number }
		)
		const res = await mount([route], { onEvent }).request('/webhooks/bad')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: 'nope' })
		expect(events[0]?.validation?.target).toBe('response')
	})
})

describe('errors', () => {
	test('a throwing handler answers 500 and logs', async () => {
		const log = silenceConsoleError()
		const route = defineWebhook({ method: 'GET', path: '/boom' }, () => {
			throw new Error('Something went wrong')
		})
		const res = await mount([route]).request('/webhooks/boom')
		expect(res.status).toBe(500)
		expect(await res.json()).toEqual({ error: 'Internal Server Error' })
		expect(log).toHaveBeenCalled()
		log.mockRestore()
	})

	test('HTTPException keeps its status', async () => {
		const route = defineWebhook({ method: 'GET', path: '/teapot' }, () => {
			throw new HTTPException(418, { message: 'Short and stout' })
		})
		const res = await mount([route]).request('/webhooks/teapot')
		expect(res.status).toBe(418)
		expect(await res.json()).toEqual({ error: 'Short and stout' })
	})

	test('onError can replace any error response', async () => {
		const route = defineWebhook(
			{ method: 'POST', path: '/x', body: z.object({ a: z.string() }) },
			() => ({})
		)
		const app = mount([route], {
			onError: (error, c) =>
				error instanceof WebhookValidationError
					? c.json({ problem: error.target }, 422)
					: undefined
		})
		const res = await app.request('/webhooks/x', post({}))
		expect(res.status).toBe(422)
		expect(await res.json()).toEqual({ problem: 'body' })

		const notFound = await app.request('/webhooks/nope')
		expect(notFound.status).toBe(404)
	})
})

describe('onEvent', () => {
	test('reports successful requests with validated parts', async () => {
		const { events, onEvent } = collectEvents()
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/orders/:id',
				body: z.object({ total: z.number() })
			},
			({ params, body }) => ({ id: params.id, total: body.total })
		)
		await mount([route], { onEvent }).request(
			'/webhooks/orders/7',
			post({ total: 5 })
		)

		expect(events).toHaveLength(1)
		const [event] = events
		expect(event).toMatchObject({
			route: '/orders/:id',
			method: 'POST',
			path: '/orders/7',
			status: 200,
			params: { id: '7' },
			body: { total: 5 },
			rawBody: '{"total":5}',
			response: { id: '7', total: 5 }
		})
		expect(event?.durationMs).toBeGreaterThanOrEqual(0)
		expect(event?.error).toBeUndefined()
	})

	test('reports validation failures, errors, 404 and 405', async () => {
		silenceConsoleError()
		const { events, onEvent } = collectEvents()
		const boom = defineWebhook({ method: 'GET', path: '/boom' }, () => {
			throw new Error('boom')
		})
		const typed = defineWebhook(
			{ method: 'POST', path: '/typed', body: z.object({ a: z.string() }) },
			() => ({})
		)
		const app = mount([boom, typed], { onEvent })
		await app.request('/webhooks/typed', post({}))
		await app.request('/webhooks/boom')
		await app.request('/webhooks/missing')
		await app.request('/webhooks/boom', { method: 'POST' })

		expect(events.map((e) => [e.route, e.status])).toEqual([
			['/typed', 400],
			['/boom', 500],
			[undefined, 404],
			['/boom', 405]
		])
		expect(events[0]?.validation?.target).toBe('body')
		expect(events[1]?.error).toBeInstanceOf(Error)
	})

	test('a rejecting onEvent does not break the response', async () => {
		const log = silenceConsoleError()
		const res = await mount([health], {
			onEvent: async () => {
				throw new Error('db down')
			}
		}).request('/webhooks/health')
		expect(res.status).toBe(200)
		await Bun.sleep(0)
		expect(log).toHaveBeenCalled()
		log.mockRestore()
	})
})

describe('schema libraries', () => {
	test('works with valibot', async () => {
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/v/:n',
				params: v.object({ n: v.pipe(v.string(), v.transform(Number)) }),
				body: v.object({ name: v.string() })
			},
			({ params, body }) => ({ n: params.n * 2, name: body.name })
		)
		const app = mount([route])
		const ok = await app.request('/webhooks/v/21', post({ name: 'x' }))
		expect(await ok.json()).toEqual({ n: 42, name: 'x' })
		const bad = await app.request('/webhooks/v/21', post({ name: 1 }))
		expect(bad.status).toBe(400)
	})

	test('supports async schemas', async () => {
		const route = defineWebhook(
			{
				method: 'POST',
				path: '/async',
				body: z.object({ a: z.string() }).refine(async (b) => b.a === 'ok')
			},
			({ body }) => body
		)
		const app = mount([route])
		expect(
			(await app.request('/webhooks/async', post({ a: 'ok' }))).status
		).toBe(200)
		expect(
			(await app.request('/webhooks/async', post({ a: 'no' }))).status
		).toBe(400)
	})
})

describe('createWebhookFactory', () => {
	test('types c.env and c.var for the handlers', async () => {
		type AppEnv = {
			Bindings: { SECRET: string }
			Variables: { requestId: string }
		}
		const wh = createWebhookFactory<AppEnv>()
		const route = wh.defineWebhook(
			{ method: 'GET', path: '/env' },
			({ c }) => ({
				secret: c.env.SECRET,
				requestId: c.var.requestId
			})
		)

		const app = new Hono<AppEnv>()
		app.use(async (c, next) => {
			c.set('requestId', 'req_1')
			await next()
		})
		app.route('/webhooks', wh.createWebhooks([route]))

		const res = await app.request('/webhooks/env', {}, { SECRET: 's3cret' })
		expect(await res.json()).toEqual({ secret: 's3cret', requestId: 'req_1' })
	})
})

// Compile-time checks: `bun run typecheck` fails if inference regresses.
export const typeChecks = [
	defineWebhook(
		{ method: 'GET', path: '/a/:id/:slug?' },
		({ params, query, headers, body }) => {
			const id: string = params.id
			const slug: string | undefined = params.slug
			const q: string | undefined = query.anything
			const h: string | undefined = headers['x-anything']
			const b: unknown = body
			// @ts-expect-error not in the path
			params.missing
			return { id, slug, q, h, b }
		}
	),
	defineWebhook(
		{
			method: 'POST',
			path: '/b',
			body: z.object({ n: z.number() }),
			response: z.object({ ok: z.boolean() })
		},
		({ body }) => ({ ok: body.n > 0 })
	),
	defineWebhook(
		{ method: 'GET', path: '/b2', response: z.object({ ok: z.boolean() }) },
		// @ts-expect-error response must match its schema
		() => ({ ok: 'yes' })
	),
	defineWebhook(
		// @ts-expect-error HEAD is served by GET routes
		{ method: 'HEAD', path: '/c' },
		() => {}
	)
]

describe('around', () => {
	test('wraps matched, invalid, 404 and 405 requests with the route known', async () => {
		const seen: string[] = []
		const typed = defineWebhook(
			{ method: 'POST', path: '/typed/:id', body: z.object({ a: z.string() }) },
			() => ({})
		)
		const app = mount([typed], {
			around: async ({ route, method }, next) => {
				const res = await next()
				seen.push(`${method} ${route} ${res.status}`)
				return res
			}
		})
		await app.request('/webhooks/typed/1', post({ a: 'x' }))
		await app.request('/webhooks/typed/1', post({}))
		await app.request('/webhooks/typed/1')
		await app.request('/webhooks/nope')
		expect(seen).toEqual([
			'POST /typed/:id 200',
			'POST /typed/:id 400',
			'GET /typed/:id 405',
			'GET undefined 404'
		])
	})

	test('onEvent runs inside around and the async context', async () => {
		const { AsyncLocalStorage } = await import('node:async_hooks')
		const store = new AsyncLocalStorage<string>()
		const inEvent: (string | undefined)[] = []
		const app = mount([health], {
			around: ({ route }, next) => store.run(`span ${route}`, next),
			onEvent: () => void inEvent.push(store.getStore())
		})
		await app.request('/webhooks/health')
		expect(inEvent).toEqual(['span /health'])
	})

	test('can answer without calling next', async () => {
		const { events, onEvent } = collectEvents()
		const app = mount([health], {
			around: async ({ c }) => c.json({ paused: true }, 503),
			onEvent
		})
		const res = await app.request('/webhooks/health')
		expect(res.status).toBe(503)
		expect(events).toHaveLength(0)
	})
})

describe('events', () => {
	test('path is relative to the mount point, including dynamic mounts', async () => {
		const { events, onEvent } = collectEvents()
		const app = new Hono()
		app.route('/api/:tenant/hooks', createWebhooks([health], { onEvent }))
		await app.request('/api/acme/hooks/health')
		await app.request('/api/acme/hooks/missing/deep')
		expect(events.map((e) => [e.route, e.path])).toEqual([
			['/health', '/health'],
			[undefined, '/missing/deep']
		])
		expect(events[0]?.c.req.path).toBe('/api/acme/hooks/health')
	})

	test('logErrors: false keeps the default 500 without console.error', async () => {
		const log = silenceConsoleError()
		const boom = defineWebhook({ method: 'GET', path: '/boom' }, () => {
			throw new Error('boom')
		})
		const res = await mount([boom], { logErrors: false }).request(
			'/webhooks/boom'
		)
		expect(res.status).toBe(500)
		expect(log).not.toHaveBeenCalled()
		log.mockRestore()
	})

	test('formatIssues joins paths and messages', () => {
		expect(
			formatIssues([
				{ message: 'Expected number', path: ['total'] },
				{ message: 'Required', path: ['items', 0, { key: 'id' }] },
				{ message: 'Malformed JSON' }
			])
		).toBe('total: Expected number; items.0.id: Required; Malformed JSON')
	})

	test('summarizeEvent returns a flat, JSON-safe record', async () => {
		silenceConsoleError()
		const { events, onEvent } = collectEvents()
		const typed = defineWebhook(
			{
				method: 'POST',
				path: '/orders/:id',
				body: z.object({ total: z.number() })
			},
			() => {
				throw new TypeError('db down')
			}
		)
		const app = mount([typed], { onEvent })
		await app.request('/webhooks/orders/1?x=1', {
			...post({ total: 'x' }),
			headers: {
				'content-type': 'application/json',
				'x-forwarded-for': '203.0.113.9, 10.0.0.1',
				'user-agent': 'Shopify-Captain-Hook',
				authorization: 'secret'
			}
		})
		await app.request('/webhooks/orders/1', post({ total: 1 }))

		const [invalid, failed] = events.map(summarizeEvent)
		expect(invalid).toMatchObject({
			route: '/orders/:id',
			method: 'POST',
			path: '/orders/1',
			status: 400,
			ip: '203.0.113.9',
			userAgent: 'Shopify-Captain-Hook',
			params: { id: '1' },
			query: { x: '1' },
			body: null,
			response: null,
			validation: {
				target: 'body',
				message: expect.stringMatching(/^total: /),
				issues: [{ path: 'total', message: expect.any(String) }]
			}
		})
		expect(JSON.stringify(invalid)).not.toContain('secret')
		expect(failed?.error).toMatchObject({
			name: 'TypeError',
			message: 'db down'
		})
		expect(failed?.validation).toBeNull()
		expect(JSON.parse(JSON.stringify(failed))).toEqual(failed)
		expect(
			String(failed?.durationMs).split('.')[1]?.length ?? 0
		).toBeLessThanOrEqual(2)
	})
})

describe('describeWebhooks', () => {
	const order = defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id',
			description: 'Order paid',
			verify: () => true,
			body: z.object({ total: z.number() }),
			response: z.object({ ok: z.boolean() })
		},
		() => ({ ok: true })
	)
	const valibot = defineWebhook(
		{ method: 'GET', path: '/v', query: v.object({ q: v.string() }) },
		() => {}
	)

	test('returns JSON Schemas from an app or an array', () => {
		const [described] = describeWebhooks(createWebhooks([order]))
		expect(described).toMatchObject({
			method: 'POST',
			path: '/orders/:id',
			description: 'Order paid',
			verified: true,
			bodyType: 'auto',
			jsonSchema: {
				params: null,
				body: { type: 'object', required: ['total'] },
				response: { type: 'object', required: ['ok'] }
			}
		})
		expect(describeWebhooks([order])).toEqual(
			describeWebhooks(createWebhooks([order]))
		)
	})

	test('is null for libraries without Standard JSON Schema', () => {
		const [described] = describeWebhooks([valibot])
		expect(described?.jsonSchema.query).toBeNull()
		expect(described?.description).toBeNull()
	})
})

describe('testWebhook', () => {
	const order = defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id/:note?',
			query: z.object({ dry: z.enum(['1', '0']).optional() }),
			body: z.object({ total: z.number() })
		},
		({ c, params, query, body, headers }) => ({
			id: params.id,
			note: params.note ?? null,
			dry: query.dry ?? null,
			total: body.total,
			trace: headers['x-trace'] ?? null,
			region: (c.env as { REGION?: string } | undefined)?.REGION ?? null
		})
	)

	test('runs the full pipeline with typed input', async () => {
		const res = await testWebhook(order, {
			params: { id: 'a b' },
			query: { dry: '1' },
			headers: { 'x-trace': 't1' },
			body: { total: 5 },
			env: { REGION: 'eu' }
		})
		expect(await res.json()).toEqual({
			id: 'a b',
			note: null,
			dry: '1',
			total: 5,
			trace: 't1',
			region: 'eu'
		})
	})

	test('validates like a real request', async () => {
		const res = await testWebhook(order, {
			params: { id: '1', note: 'x' },
			// @ts-expect-error total must be a number
			body: { total: 'five' }
		})
		expect(res.status).toBe(400)
	})

	test('signs the exact raw body and sends forms url-encoded', async () => {
		const { shopify } = await import('./signatures')
		const signed = defineWebhook(
			{
				method: 'POST',
				path: '/sms',
				bodyType: 'form',
				verify: shopify.verify('s3cret'),
				body: z.object({ Body: z.string() })
			},
			({ body }) => body.Body
		)
		const ok = await testWebhook(signed, {
			body: { Body: 'hi there' },
			sign: (raw) => shopify.sign(raw, 's3cret')
		})
		expect(await ok.text()).toBe('hi there')
		expect((await testWebhook(signed, { body: { Body: 'x' } })).status).toBe(
			401
		)
	})
})
