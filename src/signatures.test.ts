import { describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { createWebhooks, defineWebhook, type WebhookEvent } from './index'
import { github, hmac, shopify, stripe, svix } from './signatures'

const secret = "It's a Secret to Everybody"
const payload = 'Hello, World!'

const check = (
	verify: ReturnType<typeof github.verify>,
	headers: Record<string, string>,
	rawBody = payload
) => verify({ c: {} as never, rawBody, headers })

describe('github', () => {
	test("matches GitHub's documented test vector", async () => {
		const headers = await github.sign(payload, secret)
		expect(headers).toEqual({
			'x-hub-signature-256':
				'sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
		})
		expect(await check(github.verify(secret), headers)).toBe(true)
	})

	test('rejects a tampered body, a wrong secret and junk headers', async () => {
		const headers = await github.sign(payload, secret)
		expect(await check(github.verify(secret), headers, 'Hello, World?')).toBe(
			false
		)
		expect(await check(github.verify('other'), headers)).toBe(false)
		expect(await check(github.verify(secret), {})).toBe(false)
		expect(
			await check(github.verify(secret), { 'x-hub-signature-256': 'sha256=zz' })
		).toBe(false)
		expect(
			await check(github.verify(secret), { 'x-hub-signature-256': 'md5=00' })
		).toBe(false)
	})
})

describe('shopify', () => {
	test('round-trips a base64 signature', async () => {
		const headers = await shopify.sign(payload, secret)
		expect(headers['x-shopify-hmac-sha256']).toMatch(/^[A-Za-z0-9+/]+=*$/)
		expect(await check(shopify.verify(secret), headers)).toBe(true)
		expect(
			await check(shopify.verify(secret), { 'x-shopify-hmac-sha256': '%%%' })
		).toBe(false)
	})
})

describe('stripe', () => {
	test('round-trips and checks the timestamp tolerance', async () => {
		const fresh = await stripe.sign(payload, secret)
		expect(await check(stripe.verify(secret), fresh)).toBe(true)

		const old = await stripe.sign(payload, secret, {
			timestamp: Math.floor(Date.now() / 1000) - 301
		})
		expect(await check(stripe.verify(secret), old)).toBe(false)
		expect(
			await check(stripe.verify(secret, { toleranceSeconds: 600 }), old)
		).toBe(true)
	})

	test('accepts any matching v1 during secret rotation', async () => {
		const { 'stripe-signature': header = '' } = await stripe.sign(
			payload,
			secret
		)
		const rotated = header.replace(',v1=', ',v1=00ff,v1=')
		expect(
			await check(stripe.verify(secret), { 'stripe-signature': rotated })
		).toBe(true)
	})
})

describe('svix', () => {
	// Example from the Svix docs.
	const svixSecret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
	const svixBody = '{"test": 2432232314}'
	const docs = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: 1614265330 }
	const forever = { toleranceSeconds: Number.POSITIVE_INFINITY }

	test("matches Svix's documented example", async () => {
		const headers = await svix.sign(svixBody, svixSecret, docs)
		expect(headers['svix-signature']).toBe(
			'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
		)
		expect(
			await check(svix.verify(svixSecret, forever), headers, svixBody)
		).toBe(true)
		expect(await check(svix.verify(svixSecret), headers, svixBody)).toBe(false)
	})

	test('accepts any v1 in the list and Standard Webhooks headers', async () => {
		const headers = await svix.sign(payload, svixSecret)
		const rotated = {
			'webhook-id': headers['svix-id'] ?? '',
			'webhook-timestamp': headers['svix-timestamp'] ?? '',
			'webhook-signature': `v1,AAAA ${headers['svix-signature']}`
		}
		expect(await check(svix.verify(svixSecret), rotated)).toBe(true)
		expect(
			await check(svix.verify(svixSecret), {
				...headers,
				'svix-id': 'msg_other'
			})
		).toBe(false)
	})

	test('rejects a secret that is not whsec_<base64>', async () => {
		await expect(svix.sign(payload, 'whsec_')).rejects.toThrow('whsec_')
	})
})

test('hmac supports other hashes and prefixes', async () => {
	const scheme = hmac({
		header: 'X-Sig',
		encoding: 'hex',
		prefix: 'sha1=',
		hash: 'SHA-1'
	})
	const headers = await scheme.sign(payload, secret)
	expect(headers['x-sig']).toMatch(/^sha1=[0-9a-f]{40}$/)
	expect(await check(scheme.verify(secret), headers)).toBe(true)
})

describe('verify option', () => {
	type Env = { Bindings: { SHOPIFY_SECRET: string } }
	const events: WebhookEvent[] = []
	const orders = defineWebhook(
		{
			method: 'POST',
			path: '/shopify',
			verify: shopify.verify((c) => c.env.SHOPIFY_SECRET),
			body: z.object({ id: z.number() })
		},
		({ body }) => ({ id: body.id })
	)
	const app = new Hono<Env>()
	app.route(
		'/webhooks',
		createWebhooks([orders], { onEvent: (e) => void events.push(e) })
	)
	const env = { SHOPIFY_SECRET: secret }
	const send = (body: string, headers: Record<string, string>) =>
		app.request(
			'/webhooks/shopify',
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', ...headers },
				body
			},
			env
		)

	test('a signed request reaches the body schema and the handler', async () => {
		const body = '{"id":7}'
		const res = await send(body, await shopify.sign(body, secret))
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id: 7 })
	})

	test('an unsigned request gets 401 before headers are validated', async () => {
		const topic = defineWebhook(
			{
				method: 'POST',
				path: '/topic',
				verify: shopify.verify(secret),
				headers: z.object({ 'x-shopify-topic': z.string() })
			},
			({ headers }) => headers['x-shopify-topic']
		)
		const res = await createWebhooks([topic]).request('/topic', {
			method: 'POST',
			body: '{}'
		})
		expect(res.status).toBe(401)
		expect(await res.text()).not.toContain('x-shopify-topic')
	})

	test('a bad signature answers 401 before the body is parsed', async () => {
		events.length = 0
		const res = await send('{not json', { 'x-shopify-hmac-sha256': 'AAAA' })
		expect(res.status).toBe(401)
		expect(await res.json()).toEqual({
			error: 'Invalid signature',
			issues: [{ message: 'Signature does not match' }]
		})
		expect(events[0]?.validation?.target).toBe('signature')
		expect(events[0]?.body).toBeUndefined()
	})
})
