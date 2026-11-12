import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { Hono } from 'hono'
import { z } from 'zod'
import { createWebhooks, defineWebhook, type WebhookEvent } from './index'
import {
	github,
	hmac,
	hubspot,
	infisical,
	meta,
	sharedSecret,
	shopify,
	stripe,
	svix,
	twilio
} from './signatures'

const secret = "It's a Secret to Everybody"
const payload = 'Hello, World!'

const check = (
	verify: ReturnType<typeof github.verify>,
	headers: Record<string, string>,
	rawBody = payload
) => verify({ c: {} as never, rawBody, headers, fail: () => false })

/** The reason a scheme passed to `fail`, or `true`. */
async function reason(
	verify: ReturnType<typeof github.verify>,
	headers: Record<string, string>,
	rawBody = payload,
	url = 'https://example.com/hook'
) {
	let why: string | undefined
	const c = { req: { url, method: 'POST' } } as never
	const ok = await verify({
		c,
		rawBody,
		headers,
		fail: (r) => {
			why = r
			return false
		}
	})
	return ok === true ? true : why
}

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
		// The reason goes to onEvent only.
		expect(await res.json()).toEqual({ error: 'Invalid signature' })
		expect(events[0]?.validation).toEqual({
			target: 'signature',
			issues: [{ message: 'mismatch' }]
		})
		expect(events[0]?.body).toBeUndefined()
	})
})

describe('failure reasons', () => {
	test('built-in schemes say why they rejected', async () => {
		const signed = await stripe.sign(payload, secret)
		expect(await reason(stripe.verify(secret), {})).toBe('missing-header')
		expect(
			await reason(stripe.verify(secret), { 'stripe-signature': 'v1=00' })
		).toBe('malformed')
		const old = await stripe.sign(payload, secret, { timestamp: 1 })
		expect(await reason(stripe.verify(secret), old)).toBe(
			'timestamp-out-of-tolerance'
		)
		expect(await reason(stripe.verify('other'), signed)).toBe('mismatch')
		expect(await reason(stripe.verify(secret), signed)).toBe(true)
	})
})

test('meta signs like github', () => {
	expect(meta).toBe(github)
})

describe('sharedSecret', () => {
	const bearer = sharedSecret({ header: 'Authorization', prefix: 'Bearer ' })

	test('accepts the exact secret only', async () => {
		const headers = await bearer.sign('', 'tok')
		expect(headers).toEqual({ authorization: 'Bearer tok' })
		expect(await reason(bearer.verify('tok'), headers)).toBe(true)
		expect(
			await reason(bearer.verify('tok'), { authorization: 'Bearer tok2' })
		).toBe('mismatch')
		expect(
			await reason(bearer.verify('tok'), { authorization: 'Basic tok' })
		).toBe('malformed')
		expect(await reason(bearer.verify('tok'), {})).toBe('missing-header')
	})

	test('an unset secret fails closed instead of matching a missing header', async () => {
		const scheme = sharedSecret({ header: 'x-token' })
		await expect(check(scheme.verify(''), { 'x-token': '' })).resolves.toBe(
			false
		)
		await expect(check(scheme.verify(''), { 'x-token': 'x' })).rejects.toThrow(
			'empty'
		)
	})
})

describe('infisical', () => {
	const body = (timestamp: number) =>
		JSON.stringify({ event: 'secrets.modified', timestamp })

	test('matches Infisical: hex HMAC of the JSON body, t from the body', async () => {
		const raw = body(Date.now())
		const expected = createHmac('sha256', secret).update(raw).digest('hex')
		const headers = await infisical.sign(raw, secret)
		expect(headers['x-infisical-signature']).toBe(
			`t=${JSON.parse(raw).timestamp};${expected}`
		)
		expect(await reason(infisical.verify(secret), headers, raw)).toBe(true)
		expect(await reason(infisical.verify('other'), headers, raw)).toBe(
			'mismatch'
		)
	})

	test('rejects a replayed body even with a fresh header timestamp', async () => {
		const raw = body(Date.now() - 301_000)
		const { 'x-infisical-signature': header = '' } = await infisical.sign(
			raw,
			secret
		)
		const fresh = header.replace(/^t=\d+/, `t=${Date.now()}`)
		expect(
			await reason(
				infisical.verify(secret),
				{ 'x-infisical-signature': fresh },
				raw
			)
		).toBe('timestamp-out-of-tolerance')
		expect(
			await reason(infisical.verify(secret), { 'x-infisical-signature': 'x' })
		).toBe('malformed')
	})
})

describe('twilio', () => {
	// The example from Twilio's security docs, checked against the Twilio SDK.
	const url = 'https://mycompany.com/myapp.php?foo=1&bar=2'
	const form =
		'CallSid=CA1234567890ABCDE&Caller=%2B12349013030&Digits=1234&From=%2B12349013030&To=%2B18005551212'

	test("matches Twilio's documented example", async () => {
		const headers = await twilio.sign(form, '12345', { url })
		expect(headers).toEqual({
			'x-twilio-signature': '0/KCTR6DLpKmkAf8muzZqo1nDgQ='
		})
		expect(
			await reason(twilio.verify('12345', { url: () => url }), headers, form)
		).toBe(true)
	})

	test('checks c.req.url by default and tries every url candidate', async () => {
		const headers = await twilio.sign(form, '12345', { url })
		expect(await reason(twilio.verify('12345'), headers, form, url)).toBe(true)
		expect(await reason(twilio.verify('12345'), headers, form)).toBe('mismatch')
		expect(
			await reason(
				twilio.verify('12345', { url: () => ['https://internal/x', url] }),
				headers,
				form
			)
		).toBe(true)
	})
})

describe('hubspot', () => {
	const url = 'https://example.com/hook?a=%3A'

	test('signs METHOD + decoded url + body + timestamp', async () => {
		const t = Date.now()
		const headers = await hubspot.sign(payload, secret, { url, timestamp: t })
		const expected = createHmac('sha256', secret)
			.update(`POSThttps://example.com/hook?a=:${payload}${t}`)
			.digest('base64')
		expect(headers).toEqual({
			'x-hubspot-signature-v3': expected,
			'x-hubspot-request-timestamp': String(t)
		})
		expect(await reason(hubspot.verify(secret), headers, payload, url)).toBe(
			true
		)
	})

	test('rejects old timestamps', async () => {
		const headers = await hubspot.sign(payload, secret, {
			url,
			timestamp: Date.now() - 301_000
		})
		expect(await reason(hubspot.verify(secret), headers, payload, url)).toBe(
			'timestamp-out-of-tolerance'
		)
	})
})
