import type { Context } from 'hono'
import type { Verify } from './index'

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

const encoder = new TextEncoder()

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
		verify:
			(secret) =>
			async ({ c, rawBody, headers }) => {
				const value = headers[name]
				if (!value?.startsWith(prefix)) return false
				const encoded = value.slice(prefix.length)
				const signature =
					encoding === 'hex' ? fromHex(encoded) : fromBase64(encoded)
				if (!signature) return false
				return hmacVerify(
					await resolveSecret(secret, c),
					rawBody,
					signature,
					hash
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
		async ({ c, rawBody, headers }) => {
			const parts = (headers['stripe-signature'] ?? '')
				.split(',')
				.map((part) => part.split('='))
			// Signed over the timestamp exactly as sent.
			const timestamp = parts.find(([k]) => k === 't')?.[1] ?? ''
			if (!/^\d+$/.test(timestamp)) return false
			if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) {
				return false
			}
			const key = await resolveSecret(secret, c)
			for (const [k, v] of parts) {
				const signature = k === 'v1' && v ? fromHex(v) : undefined
				if (
					signature &&
					(await hmacVerify(key, `${timestamp}.${rawBody}`, signature))
				) {
					return true
				}
			}
			return false
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
		async ({ c, rawBody, headers }) => {
			const prefix = headers['svix-id'] ? 'svix' : 'webhook'
			const id = headers[`${prefix}-id`]
			const timestamp = headers[`${prefix}-timestamp`] ?? ''
			const signatures = headers[`${prefix}-signature`]
			if (!id || !signatures || !/^\d+$/.test(timestamp)) return false
			if (Math.abs(Date.now() / 1000 - Number(timestamp)) > toleranceSeconds) {
				return false
			}
			const key = svixKey(await resolveSecret(secret, c))
			for (const entry of signatures.split(' ')) {
				const [version, encoded] = entry.split(',')
				const signature =
					version === 'v1' && encoded ? fromBase64(encoded) : undefined
				if (
					signature &&
					(await hmacVerify(key, `${id}.${timestamp}.${rawBody}`, signature))
				) {
					return true
				}
			}
			return false
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
