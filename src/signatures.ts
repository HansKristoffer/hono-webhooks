import type { Context } from 'hono'
import type { Verify, VerifyInput } from './index'

/** A signing secret, or a function reading it per request (e.g. from `c.env`). */
export type Secret = string | ((c: Context<any>) => string | Promise<string>)

export interface SignatureScheme<VerifyOptions = void, SignOptions = void> {
	/** A `verify` function for `defineWebhook`. */
	verify(secret: Secret, options?: VerifyOptions): Verify
	/** The headers a provider would send with `rawBody`. For tests and the CLI. */
	sign(
		rawBody: string,
		secret: string,
		options?: SignOptions
	): Promise<Record<string, string>>
}

export interface HmacOptions {
	/** Header carrying the signature, e.g. `x-hub-signature-256`. */
	header: string
	encoding: 'hex' | 'base64'
	/** Text before the signature in the header, e.g. `sha256=`. */
	prefix?: string
	/** @default 'SHA-256' */
	hash?: 'SHA-1' | 'SHA-256' | 'SHA-512'
}

/**
 * The URL a provider signed. Behind a proxy `c.req.url` is the internal URL,
 * so return the public one; return several and any match passes.
 * @default (c) => c.req.url
 */
export type SignedUrl = (
	c: Context<any>
) => string | readonly string[] | Promise<string | readonly string[]>

/**
 * Why a built-in scheme rejected a request, passed to `fail` and so to
 * `onEvent` as `validation.issues[0].message`.
 */
export type VerifyFailureReason =
	| 'missing-header'
	| 'malformed'
	| 'timestamp-out-of-tolerance'
	| 'mismatch'

const encoder = new TextEncoder()

/** `fail` is optional here so a scheme called by hand with a bare input still works. */
const reject = (input: VerifyInput, reason: VerifyFailureReason) =>
	input.fail?.(reason) ?? false

/** A string secret is used as UTF-8; bytes are used as is. */
function hmacKey(secret: string | Uint8Array, hash: string) {
	if (!secret.length) {
		throw new Error('hono-webhooks: the signing secret is empty')
	}
	return crypto.subtle.importKey(
		'raw',
		(typeof secret === 'string'
			? encoder.encode(secret)
			: secret) as Uint8Array<ArrayBuffer>,
		{ name: 'HMAC', hash },
		false,
		['sign', 'verify']
	)
}

async function hmacSign(
	secret: string | Uint8Array,
	payload: string,
	hash = 'SHA-256'
) {
	const key = await hmacKey(secret, hash)
	return new Uint8Array(
		await crypto.subtle.sign('HMAC', key, encoder.encode(payload))
	)
}

/** `crypto.subtle.verify` compares in constant time. */
async function hmacVerify(
	secret: string | Uint8Array,
	payload: string,
	signature: Uint8Array,
	hash = 'SHA-256'
) {
	const key = await hmacKey(secret, hash)
	return crypto.subtle.verify(
		'HMAC',
		key,
		signature as Uint8Array<ArrayBuffer>,
		encoder.encode(payload)
	)
}

const toHex = (bytes: Uint8Array) =>
	Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

function fromHex(hex: string) {
	if (hex.length % 2 || /[^0-9a-f]/i.test(hex)) return undefined
	return Uint8Array.from(hex.match(/../g) ?? [], (h) => Number.parseInt(h, 16))
}

function fromBase64(base64: string) {
	try {
		return Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
	} catch {
		return undefined
	}
}

const resolveSecret = async (secret: Secret, c: Context) =>
	typeof secret === 'function' ? secret(c) : secret

const signedUrls = async (url: SignedUrl | undefined, c: Context) =>
	[(await url?.(c)) ?? c.req.url].flat()

const outsideTolerance = (seconds: number, toleranceSeconds: number) =>
	Math.abs(Date.now() / 1000 - seconds) > toleranceSeconds

/**
 * A scheme where one header carries an HMAC of the raw body. Covers most
 * providers; `github` and `shopify` are built with it.
 *
 * @example
 * const linear = hmac({ header: 'linear-signature', encoding: 'hex' })
 */
export function hmac(options: HmacOptions): SignatureScheme {
	const { header, encoding, prefix = '', hash = 'SHA-256' } = options
	const name = header.toLowerCase()
	return {
		verify: (secret) => async (input) => {
			const value = input.headers[name]
			if (!value) return reject(input, 'missing-header')
			if (!value.startsWith(prefix)) return reject(input, 'malformed')
			const encoded = value.slice(prefix.length)
			const signature =
				encoding === 'hex' ? fromHex(encoded) : fromBase64(encoded)
			if (!signature) return reject(input, 'malformed')
			return (
				(await hmacVerify(
					await resolveSecret(secret, input.c),
					input.rawBody,
					signature,
					hash
				)) || reject(input, 'mismatch')
			)
		},
		async sign(rawBody, secret) {
			const signature = await hmacSign(secret, rawBody, hash)
			return {
				[name]: `${prefix}${encoding === 'hex' ? toHex(signature) : toBase64(signature)}`
			}
		}
	}
}

/** GitHub: `x-hub-signature-256: sha256=<hex>`. */
export const github = hmac({
	header: 'x-hub-signature-256',
	encoding: 'hex',
	prefix: 'sha256='
})

/** Meta (WhatsApp, Messenger, Instagram): signs like GitHub, with the app secret. */
export const meta = github

/** Shopify: `x-shopify-hmac-sha256: <base64>`. */
export const shopify = hmac({
	header: 'x-shopify-hmac-sha256',
	encoding: 'base64'
})

/**
 * Stripe: `stripe-signature: t=<unix>,v1=<hex>`, signed over `<t>.<body>`.
 * Rejects timestamps more than `toleranceSeconds` (default 300) away.
 */
export const stripe: SignatureScheme<
	{ toleranceSeconds?: number },
	{ timestamp?: number }
> = {
	verify:
		(secret, { toleranceSeconds = 300 } = {}) =>
		async (input) => {
			const header = input.headers['stripe-signature']
			if (!header) return reject(input, 'missing-header')
			const parts = header.split(',').map((part) => part.split('='))
			// Signed over the timestamp exactly as sent.
			const timestamp = parts.find(([k]) => k === 't')?.[1] ?? ''
			if (!/^\d+$/.test(timestamp)) return reject(input, 'malformed')
			if (outsideTolerance(Number(timestamp), toleranceSeconds)) {
				return reject(input, 'timestamp-out-of-tolerance')
			}
			const key = await resolveSecret(secret, input.c)
			for (const [k, v] of parts) {
				const signature = k === 'v1' && v ? fromHex(v) : undefined
				if (
					signature &&
					(await hmacVerify(key, `${timestamp}.${input.rawBody}`, signature))
				) {
					return true
				}
			}
			return reject(input, 'mismatch')
		},
	async sign(rawBody, secret, { timestamp } = {}) {
		const t = timestamp ?? Math.floor(Date.now() / 1000)
		const signature = await hmacSign(secret, `${t}.${rawBody}`)
		return { 'stripe-signature': `t=${t},v1=${toHex(signature)}` }
	}
}

/** Svix secrets are `whsec_` followed by the base64 key. */
function svixKey(secret: string) {
	const key = fromBase64(secret.replace(/^whsec_/, ''))
	if (!key?.length) {
		throw new Error('hono-webhooks: the Svix secret must be whsec_<base64>')
	}
	return key
}

/**
 * Svix and Standard Webhooks (Resend, Clerk, ...): `svix-id`,
 * `svix-timestamp` and `svix-signature: v1,<base64> v1,<base64>`, signed over
 * `<id>.<timestamp>.<body>` with the base64 key in a `whsec_` secret. The
 * `webhook-*` header names of Standard Webhooks work too. Rejects timestamps
 * more than `toleranceSeconds` (default 300) away.
 */
export const svix: SignatureScheme<
	{ toleranceSeconds?: number },
	{ id?: string; timestamp?: number }
> = {
	verify:
		(secret, { toleranceSeconds = 300 } = {}) =>
		async (input) => {
			const { headers } = input
			const prefix = headers['svix-id'] ? 'svix' : 'webhook'
			const id = headers[`${prefix}-id`]
			const timestamp = headers[`${prefix}-timestamp`]
			const signatures = headers[`${prefix}-signature`]
			if (!id || !signatures || !timestamp) {
				return reject(input, 'missing-header')
			}
			if (!/^\d+$/.test(timestamp)) return reject(input, 'malformed')
			if (outsideTolerance(Number(timestamp), toleranceSeconds)) {
				return reject(input, 'timestamp-out-of-tolerance')
			}
			const key = svixKey(await resolveSecret(secret, input.c))
			for (const entry of signatures.split(' ')) {
				const [version, encoded] = entry.split(',')
				const signature =
					version === 'v1' && encoded ? fromBase64(encoded) : undefined
				if (
					signature &&
					(await hmacVerify(
						key,
						`${id}.${timestamp}.${input.rawBody}`,
						signature
					))
				) {
					return true
				}
			}
			return reject(input, 'mismatch')
		},
	async sign(rawBody, secret, { id, timestamp } = {}) {
		const msgId = id ?? `msg_${crypto.randomUUID().replaceAll('-', '')}`
		const t = timestamp ?? Math.floor(Date.now() / 1000)
		const signature = await hmacSign(
			svixKey(secret),
			`${msgId}.${t}.${rawBody}`
		)
		return {
			'svix-id': msgId,
			'svix-timestamp': String(t),
			'svix-signature': `v1,${toBase64(signature)}`
		}
	}
}

export interface SharedSecretOptions {
	/** Header carrying the secret, e.g. `x-gitlab-token` or `authorization`. */
	header: string
	/** Text before the secret in the header, e.g. `Bearer `. */
	prefix?: string
}

// Web Crypto has no timingSafeEqual: HMAC the expected secret under a random
// key, then let crypto.subtle.verify (constant time) check the given one.
let compareKey: Promise<CryptoKey> | undefined
async function secretsEqual(given: string, expected: string) {
	if (!expected) throw new Error('hono-webhooks: the shared secret is empty')
	compareKey ??= crypto.subtle.generateKey(
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify']
	) as Promise<CryptoKey>
	const key = await compareKey
	const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(expected))
	return crypto.subtle.verify('HMAC', key, mac, encoder.encode(given))
}

/**
 * A secret sent as is in a header (GitLab's `x-gitlab-token`, Telegram's
 * `x-telegram-bot-api-secret-token`, `authorization: Bearer <token>`),
 * compared in constant time. An empty secret throws (a 500).
 *
 * @example
 * verify: sharedSecret({ header: 'x-gitlab-token' }).verify((c) => c.env.GITLAB_TOKEN)
 */
export function sharedSecret(options: SharedSecretOptions): SignatureScheme {
	const { prefix = '' } = options
	const name = options.header.toLowerCase()
	return {
		verify: (secret) => async (input) => {
			const value = input.headers[name]
			if (!value) return reject(input, 'missing-header')
			if (!value.startsWith(prefix)) return reject(input, 'malformed')
			return (
				(await secretsEqual(
					value.slice(prefix.length),
					await resolveSecret(secret, input.c)
				)) || reject(input, 'mismatch')
			)
		},
		async sign(_rawBody, secret) {
			return { [name]: `${prefix}${secret}` }
		}
	}
}

/**
 * Infisical: `x-infisical-signature: t=<ms>;<hex>`, an HMAC-SHA256 of the
 * JSON body. The body's own `timestamp` (milliseconds) is what is signed, so
 * that is what must be within `toleranceSeconds` (default 300).
 */
export const infisical: SignatureScheme<{ toleranceSeconds?: number }> = {
	verify:
		(secret, { toleranceSeconds = 300 } = {}) =>
		async (input) => {
			const header = input.headers['x-infisical-signature']
			if (!header) return reject(input, 'missing-header')
			const signature = fromHex(header.split(';')[1] ?? '')
			if (!signature?.length) return reject(input, 'malformed')
			let timestamp: unknown
			try {
				timestamp = JSON.parse(input.rawBody)?.timestamp
			} catch {}
			if (typeof timestamp !== 'number') return reject(input, 'malformed')
			if (
				!(await hmacVerify(
					await resolveSecret(secret, input.c),
					input.rawBody,
					signature
				))
			) {
				return reject(input, 'mismatch')
			}
			return (
				!outsideTolerance(timestamp / 1000, toleranceSeconds) ||
				reject(input, 'timestamp-out-of-tolerance')
			)
		},
	async sign(rawBody, secret) {
		let t: unknown
		try {
			t = JSON.parse(rawBody)?.timestamp
		} catch {}
		const signature = toHex(await hmacSign(secret, rawBody))
		return { 'x-infisical-signature': `t=${t ?? Date.now()};${signature}` }
	}
}

/** Twilio signs the URL followed by each form field's name and value, sorted by name. */
function twilioPayload(url: string, rawBody: string) {
	const fields = [...new URLSearchParams(rawBody)].sort(([a, x], [b, y]) =>
		a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1
	)
	return url + fields.map(([k, v]) => k + v).join('')
}

/**
 * Twilio: `x-twilio-signature: <base64>`, an HMAC-SHA1 with the auth token
 * over the full public URL and the sorted form fields (`bodyType: 'form'`).
 * Pass `url` when `c.req.url` is not the URL Twilio called.
 *
 * @example
 * verify: twilio.verify((c) => c.env.TWILIO_AUTH_TOKEN, { url: (c) => publicUrl(c) })
 */
export const twilio: SignatureScheme<{ url?: SignedUrl }, { url: string }> = {
	verify:
		(secret, { url } = {}) =>
		async (input) => {
			const signature = input.headers['x-twilio-signature']
			if (!signature) return reject(input, 'missing-header')
			const bytes = fromBase64(signature)
			if (!bytes) return reject(input, 'malformed')
			const key = await resolveSecret(secret, input.c)
			for (const candidate of await signedUrls(url, input.c)) {
				const payload = twilioPayload(candidate, input.rawBody)
				if (await hmacVerify(key, payload, bytes, 'SHA-1')) return true
			}
			return reject(input, 'mismatch')
		},
	async sign(rawBody, secret, options) {
		if (!options?.url) throw new Error('hono-webhooks: twilio.sign needs a url')
		const signature = await hmacSign(
			secret,
			twilioPayload(options.url, rawBody),
			'SHA-1'
		)
		return { 'x-twilio-signature': toBase64(signature) }
	}
}

const HUBSPOT_DECODE: Record<string, string> = {
	'%3A': ':',
	'%2F': '/',
	'%3F': '?',
	'%40': '@',
	'%21': '!',
	'%24': '$',
	'%27': "'",
	'%28': '(',
	'%29': ')',
	'%2A': '*',
	'%2C': ',',
	'%3B': ';'
}

/** HubSpot decodes these escapes in the URL before signing. */
const hubspotUrl = (url: string) =>
	url.replace(
		/%(3A|2F|3F|40|21|24|27|28|29|2A|2C|3B)/gi,
		(match) => HUBSPOT_DECODE[match.toUpperCase()] ?? match
	)

/**
 * HubSpot v3: `x-hubspot-signature-v3: <base64>`, an HMAC-SHA256 with the
 * app's client secret over `<METHOD><url><body><timestamp>`, and
 * `x-hubspot-request-timestamp` in milliseconds, rejected when more than
 * `toleranceSeconds` (default 300) away. Pass `url` when `c.req.url` is not
 * the URL HubSpot called.
 */
export const hubspot: SignatureScheme<
	{ url?: SignedUrl; toleranceSeconds?: number },
	{ url: string; method?: string; timestamp?: number }
> = {
	verify:
		(secret, { url, toleranceSeconds = 300 } = {}) =>
		async (input) => {
			const signature = input.headers['x-hubspot-signature-v3']
			const timestamp = input.headers['x-hubspot-request-timestamp']
			if (!signature || !timestamp) return reject(input, 'missing-header')
			const bytes = fromBase64(signature)
			if (!bytes || !/^\d+$/.test(timestamp)) return reject(input, 'malformed')
			if (outsideTolerance(Number(timestamp) / 1000, toleranceSeconds)) {
				return reject(input, 'timestamp-out-of-tolerance')
			}
			const key = await resolveSecret(secret, input.c)
			const method = input.c.req.method.toUpperCase()
			for (const candidate of await signedUrls(url, input.c)) {
				const payload = `${method}${hubspotUrl(candidate)}${input.rawBody}${timestamp}`
				if (await hmacVerify(key, payload, bytes)) return true
			}
			return reject(input, 'mismatch')
		},
	async sign(rawBody, secret, options) {
		if (!options?.url)
			throw new Error('hono-webhooks: hubspot.sign needs a url')
		const t = options.timestamp ?? Date.now()
		const method = (options.method ?? 'POST').toUpperCase()
		const signature = await hmacSign(
			secret,
			`${method}${hubspotUrl(options.url)}${rawBody}${t}`
		)
		return {
			'x-hubspot-signature-v3': toBase64(signature),
			'x-hubspot-request-timestamp': String(t)
		}
	}
}
