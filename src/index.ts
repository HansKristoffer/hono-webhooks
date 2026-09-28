import type {
	StandardJSONSchemaV1,
	StandardSchemaV1
} from '@standard-schema/spec'
import { type Context, type Env, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { basePath } from 'hono/route'
import type { ParamKeys } from 'hono/types'

export type { StandardSchemaV1 }

/** HEAD is not listed: Hono answers HEAD requests with the matching GET route. */
export type WebhookMethod =
	| 'GET'
	| 'POST'
	| 'PUT'
	| 'PATCH'
	| 'DELETE'
	| 'OPTIONS'

/**
 * How the request body is parsed before validation.
 * - `auto` (default): by `Content-Type`. JSON types are parsed as JSON,
 *   `application/x-www-form-urlencoded` as a string record, anything else as text.
 * - `json`, `form`, `text`: always parse that way, whatever the header says.
 */
export type BodyType = 'auto' | 'json' | 'form' | 'text'

/** The part of the request (or the response) a schema validates. */
export type ValidationTarget =
	| 'params'
	| 'query'
	| 'headers'
	| 'signature'
	| 'body'
	| 'response'

type Schema = StandardSchemaV1
type Out<S, Fallback> = S extends Schema
	? StandardSchemaV1.InferOutput<S>
	: Fallback
type MaybePromise<T> = T | Promise<T>
type UnionToIntersection<U> = (
	U extends unknown
		? (k: U) => void
		: never
) extends (k: infer I) => void
	? I
	: never

type ParamRecord<K extends string> = K extends `${infer Name}?`
	? { [N in Name]?: string }
	: { [N in K]: string }

/**
 * Params typed from the path string: `/users/:id` gives `{ id: string }`,
 * `/files/:name?` gives `{ name?: string }`.
 */
export type PathParams<P extends string> = [ParamKeys<P>] extends [never]
	? Record<string, never>
	: UnionToIntersection<ParamRecord<ParamKeys<P>>>

/** What a `verify` function gets: the request before its body is parsed. */
export interface VerifyInput<E extends Env = any> {
	c: Context<E>
	/** The body exactly as received. */
	rawBody: string
	/** All request headers, lower-case names, not schema-validated. */
	headers: Record<string, string>
}

/** Checks a request's signature. `hono-webhooks/signatures` has ready-made ones. */
export type Verify<E extends Env = any> = (
	input: VerifyInput<E>
) => MaybePromise<boolean>

export interface WebhookConfig<
	P extends string = string,
	TParams extends Schema | undefined = Schema | undefined,
	TQuery extends Schema | undefined = Schema | undefined,
	THeaders extends Schema | undefined = Schema | undefined,
	TBody extends Schema | undefined = Schema | undefined,
	TResponse extends Schema | undefined = Schema | undefined,
	E extends Env = any
> {
	method: WebhookMethod
	/** Hono path pattern, relative to where the webhooks are mounted. */
	path: P
	params?: TParams
	query?: TQuery
	/** Header names are lower-case. */
	headers?: THeaders
	body?: TBody
	/**
	 * Checks the signature right after routing, before anything is validated
	 * or parsed. Returning `false` answers `401 { error: 'Invalid signature' }`.
	 *
	 * @example verify: shopify.verify((c) => c.env.SHOPIFY_SECRET)
	 */
	verify?: Verify<E>
	/**
	 * Checks what the handler returns. A mismatch is reported on
	 * `WebhookEvent.validation` and the response is still sent.
	 */
	response?: TResponse
	/** @default 'auto' */
	bodyType?: BodyType
	/** Shown by the CLI. */
	description?: string
}

export interface WebhookInput<
	E extends Env,
	P extends string,
	TParams,
	TQuery,
	THeaders,
	TBody
> {
	/** The Hono context: `c.env`, `c.var`, `c.header()`, `c.req.raw`, ... */
	c: Context<E, P>
	params: Out<TParams, PathParams<P>>
	query: Out<TQuery, Record<string, string>>
	headers: Out<THeaders, Record<string, string>>
	/** `undefined` for an empty body when there is no body schema. */
	body: Out<TBody, unknown>
	/** The body exactly as received, for signature verification. */
	rawBody: string
}

/**
 * What a handler may return: a `Response` is sent as is, `undefined` becomes
 * `204 No Content`, a string is sent as text and anything else as JSON.
 */
export type WebhookResult<TResponse> = MaybePromise<
	Response | (TResponse extends Schema ? Out<TResponse, never> : unknown)
>

export interface Webhook<
	E extends Env = any,
	P extends string = string,
	TParams extends Schema | undefined = any,
	TQuery extends Schema | undefined = any,
	THeaders extends Schema | undefined = any,
	TBody extends Schema | undefined = any,
	TResponse extends Schema | undefined = any
> {
	config: WebhookConfig<P, TParams, TQuery, THeaders, TBody, TResponse, E>
	// Method syntax keeps the parameter bivariant, so any webhook fits Webhook<E>[].
	handler(
		input: WebhookInput<E, P, TParams, TQuery, THeaders, TBody>
	): WebhookResult<TResponse>
}

/** Reported once per request that reaches the webhooks, after the response is built. */
export interface WebhookEvent<E extends Env = any> {
	c: Context<E>
	/** The matched path pattern, e.g. `/users/:id`. `undefined` for a 404. */
	route: string | undefined
	method: string
	/**
	 * The requested path relative to the mount point, e.g. `/orders/42`. The
	 * full path is `c.req.path`.
	 */
	path: string
	status: number
	/** Fractional milliseconds from `performance.now()`. */
	durationMs: number
	/**
	 * Each part is set once it has been validated: the schema's output, or
	 * the raw string record when there is no schema.
	 */
	params?: Record<string, unknown>
	query?: Record<string, unknown>
	headers?: Record<string, unknown>
	body?: unknown
	rawBody?: string
	/** What the handler returned, unless it returned a `Response`. */
	response?: unknown
	/** Anything thrown: a `WebhookValidationError`, an `HTTPException` or a handler error. */
	error?: unknown
	/** Set when validation failed, including a response that failed its schema. */
	validation?: {
		target: ValidationTarget
		issues: readonly StandardSchemaV1.Issue[]
	}
}

/** What `around` knows about a request before it is handled. */
export interface WebhookRequestInfo<E extends Env = any> {
	c: Context<E>
	/** The matched path pattern, e.g. `/users/:id`. `undefined` for a 404. */
	route: string | undefined
	method: string
}

export interface WebhooksOptions<E extends Env = any> {
	/**
	 * Wraps each request, 404s and 405s included, with the route already
	 * known: start a span, set up `AsyncLocalStorage`, time it. Call `next()`
	 * to handle the request (which also runs `onEvent`) and return its
	 * response.
	 */
	around?: (
		info: WebhookRequestInfo<E>,
		next: () => Promise<Response>
	) => Promise<Response>
	/**
	 * Called after every request: log it, store it, record metrics. Runs
	 * inside the request's async context (and inside `around`), so the active
	 * span and `AsyncLocalStorage` values are available. Not awaited; a
	 * returned promise is handed to `executionCtx.waitUntil` when the runtime
	 * has one, and its rejection is logged.
	 */
	onEvent?: (event: WebhookEvent<E>) => MaybePromise<void>
	/**
	 * Turns an error into a response. Return nothing to use the default:
	 * `400 { error, issues }` for validation, the status of an `HTTPException`,
	 * and `500 { error: 'Internal Server Error' }` for anything else.
	 */
	onError?: (error: unknown, c: Context<E>) => MaybePromise<Response | void>
	/**
	 * Log unexpected errors with `console.error` when the default 500
	 * response is used. Turn off when `onEvent` already logs them.
	 * @default true
	 */
	logErrors?: boolean
}

export type WebhooksApp<E extends Env = any> = Hono<E> & {
	/** The definitions, in the order they were passed. */
	readonly webhooks: readonly Webhook<E>[]
}

/**
 * Thrown when a request part fails its schema (400) or the signature check
 * fails (401).
 */
export class WebhookValidationError extends HTTPException {
	constructor(
		readonly target: Exclude<ValidationTarget, 'response'>,
		readonly issues: readonly StandardSchemaV1.Issue[]
	) {
		super(target === 'signature' ? 401 : 400, {
			message: `Invalid ${target}`
		})
		this.name = 'WebhookValidationError'
	}
}

function makeDefineWebhook<E extends Env>() {
	return <
		const P extends string,
		TParams extends Schema | undefined = undefined,
		TQuery extends Schema | undefined = undefined,
		THeaders extends Schema | undefined = undefined,
		TBody extends Schema | undefined = undefined,
		TResponse extends Schema | undefined = undefined
	>(
		config: WebhookConfig<P, TParams, TQuery, THeaders, TBody, TResponse, E>,
		handler: (
			input: WebhookInput<E, P, TParams, TQuery, THeaders, TBody>
		) => WebhookResult<TResponse>
	): Webhook<E, P, TParams, TQuery, THeaders, TBody, TResponse> => ({
		config,
		handler
	})
}

function detectBodyType(contentType = ''): Exclude<BodyType, 'auto'> {
	if (/[/+]json\b/i.test(contentType)) return 'json'
	if (/x-www-form-urlencoded/i.test(contentType)) return 'form'
	return 'text'
}

function parseBody(raw: string, type: BodyType, contentType?: string) {
	if (!raw) return undefined
	const resolved = type === 'auto' ? detectBodyType(contentType) : type
	if (resolved === 'text') return raw
	if (resolved === 'form') return Object.fromEntries(new URLSearchParams(raw))
	try {
		return JSON.parse(raw)
	} catch {
		throw new WebhookValidationError('body', [{ message: 'Malformed JSON' }])
	}
}

async function parse(
	schema: Schema | undefined,
	value: unknown,
	target: Exclude<ValidationTarget, 'response'>
) {
	if (!schema) return value
	const result = await schema['~standard'].validate(value)
	if (result.issues) throw new WebhookValidationError(target, result.issues)
	return result.value
}

function defaultErrorResponse(error: unknown, c: Context, log: boolean) {
	if (error instanceof WebhookValidationError) {
		return c.json({ error: error.message, issues: error.issues }, error.status)
	}
	if (error instanceof HTTPException) {
		return error.res ?? c.json({ error: error.message }, error.status)
	}
	if (log) console.error(error)
	return c.json({ error: 'Internal Server Error' }, 500)
}

function report(c: Context, pending: MaybePromise<void>) {
	if (!(pending instanceof Promise)) return
	const handled = pending.catch((error) =>
		console.error('hono-webhooks: onEvent failed', error)
	)
	try {
		c.executionCtx.waitUntil(handled)
	} catch {
		// No execution context outside Workers-style runtimes; the promise still runs.
	}
}

function isDynamic(path: string) {
	return path.includes(':') || path.includes('*')
}

function makeCreateWebhooks<E extends Env>() {
	return (
		webhooks: readonly Webhook<E>[],
		options: WebhooksOptions<E> = {}
	): WebhooksApp<E> => {
		const app = new Hono<E>()
		const methodsByPath = new Map<string, WebhookMethod[]>()

		for (const { config } of webhooks) {
			const methods = methodsByPath.get(config.path) ?? []
			if (methods.includes(config.method)) {
				throw new Error(
					`hono-webhooks: ${config.method} ${config.path} is defined twice`
				)
			}
			methods.push(config.method)
			methodsByPath.set(config.path, methods)
		}

		type Run = (c: Context<E>, event: WebhookEvent<E>) => Promise<Response>
		const handle = (route: string | undefined, run: Run) => {
			const execute = async (c: Context<E>) => {
				const start = performance.now()
				const base = basePath(c)
				const event: WebhookEvent<E> = {
					c,
					route,
					method: c.req.method,
					path:
						base === '/' ? c.req.path : c.req.path.slice(base.length) || '/',
					status: 0,
					durationMs: 0
				}
				let res: Response
				try {
					res = await run(c, event)
				} catch (error) {
					event.error = error
					if (error instanceof WebhookValidationError) {
						event.validation = { target: error.target, issues: error.issues }
					}
					res =
						(await options.onError?.(error, c)) ??
						defaultErrorResponse(error, c as Context, options.logErrors ?? true)
				}
				event.status = res.status
				event.durationMs = performance.now() - start
				if (options.onEvent) report(c as Context, options.onEvent(event))
				return res
			}
			const { around } = options
			return (c: Context<E>) =>
				around
					? around({ c, route, method: c.req.method }, () => execute(c))
					: execute(c)
		}

		// Hono tries handlers in registration order, so static paths go first
		// and win over a dynamic pattern that also matches.
		const ordered = [...webhooks].sort(
			(a, b) =>
				Number(isDynamic(a.config.path)) - Number(isDynamic(b.config.path))
		)

		for (const { config, handler } of ordered) {
			app.on(
				config.method,
				config.path,
				handle(config.path, async (c, event) => {
					// The signature is checked first, so unauthenticated callers only
					// ever see 401, never a description of the schemas.
					event.rawBody = await c.req.text()
					if (
						config.verify &&
						!(await config.verify({
							c,
							rawBody: event.rawBody,
							headers: c.req.header()
						}))
					) {
						throw new WebhookValidationError('signature', [
							{ message: 'Signature does not match' }
						])
					}
					type Parts = Record<string, unknown>
					event.params = (await parse(
						config.params,
						c.req.param(),
						'params'
					)) as Parts
					event.query = (await parse(
						config.query,
						c.req.query(),
						'query'
					)) as Parts
					event.headers = (await parse(
						config.headers,
						c.req.header(),
						'headers'
					)) as Parts
					event.body = await parse(
						config.body,
						parseBody(
							event.rawBody,
							config.bodyType ?? 'auto',
							c.req.header('content-type')
						),
						'body'
					)

					const result = await handler({
						c,
						params: event.params,
						query: event.query,
						headers: event.headers,
						body: event.body,
						rawBody: event.rawBody
					} as WebhookInput<E, string, any, any, any, any>)

					if (result instanceof Response) return result
					event.response = result

					if (config.response) {
						const checked = await config.response['~standard'].validate(result)
						if (checked.issues) {
							event.validation = { target: 'response', issues: checked.issues }
						}
					}

					if (result === undefined) return c.body(null, 204)
					if (typeof result === 'string') {
						return c.text(result, 200, {
							'content-type': 'text/plain; charset=UTF-8'
						})
					}
					return c.json(result as object)
				})
			)
		}

		for (const [path, methods] of methodsByPath) {
			app.all(
				path,
				handle(path, async (c) => {
					c.header('Allow', methods.join(', '))
					throw new HTTPException(405, {
						message: `Method ${c.req.method} not allowed`
					})
				})
			)
		}

		app.all(
			'*',
			handle(undefined, async () => {
				throw new HTTPException(404, { message: 'Route not found' })
			})
		)

		return Object.assign(app, { webhooks })
	}
}

/**
 * Defines one webhook. Types for `params`, `query`, `headers`, `body` and the
 * return value come from the schemas; `params` falls back to the path.
 *
 * @example
 * defineWebhook(
 *   { method: 'POST', path: '/orders/:id', body: z.object({ total: z.number() }) },
 *   async ({ params, body }) => ({ id: params.id, total: body.total })
 * )
 */
export const defineWebhook = makeDefineWebhook<any>()

/**
 * Builds a Hono app that serves the webhooks. Mount it under a prefix:
 * `app.route('/webhooks', createWebhooks([...]))`. Unknown paths below the
 * prefix answer 404, known paths with the wrong method answer 405.
 */
export const createWebhooks = makeCreateWebhooks<any>()

/**
 * `defineWebhook` and `createWebhooks` bound to your Hono `Env`, so handlers
 * see typed `c.env` and `c.var`.
 *
 * @example
 * export const { defineWebhook, createWebhooks } =
 *   createWebhookFactory<{ Bindings: { STRIPE_SECRET: string } }>()
 */
export function createWebhookFactory<E extends Env = any>() {
	return {
		defineWebhook: makeDefineWebhook<E>(),
		createWebhooks: makeCreateWebhooks<E>()
	}
}

/**
 * Validation issues as one line: `total: Expected number; items.0.id: Required`.
 */
export function formatIssues(issues: readonly StandardSchemaV1.Issue[]) {
	return issues
		.map((issue) => {
			const path = issuePath(issue)
			return path ? `${path}: ${issue.message}` : issue.message
		})
		.join('; ')
}

function issuePath(issue: StandardSchemaV1.Issue) {
	const path = issue.path
		?.map((segment) =>
			String(typeof segment === 'object' ? segment.key : segment)
		)
		.join('.')
	return path || null
}

/** A flat, JSON-safe record of a `WebhookEvent`, ready to log or store. */
export interface WebhookEventSummary {
	route: string | null
	method: string
	/** Relative to the mount point. */
	path: string
	status: number
	/** Rounded to two decimals. */
	durationMs: number
	/** From `x-forwarded-for`, `x-real-ip` or `cf-connecting-ip`; clients can spoof these. */
	ip: string | null
	userAgent: string | null
	params: Record<string, unknown> | null
	query: Record<string, unknown> | null
	body: unknown
	response: unknown
	error: { name: string; message: string; stack: string | null } | null
	validation: {
		target: ValidationTarget
		/** `formatIssues(issues)` */
		message: string
		issues: { message: string; path: string | null }[]
	} | null
}

/**
 * Flattens an event for logging or storage. Request headers are left out on
 * purpose: they carry signatures and credentials.
 *
 * @example
 * onEvent: (e) => db.insert(webhookCalls).values(summarizeEvent(e))
 */
export function summarizeEvent(event: WebhookEvent): WebhookEventSummary {
	const { c, error, validation } = event
	return {
		route: event.route ?? null,
		method: event.method,
		path: event.path,
		status: event.status,
		durationMs: Math.round(event.durationMs * 100) / 100,
		ip:
			c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
			c.req.header('x-real-ip') ||
			c.req.header('cf-connecting-ip') ||
			null,
		userAgent: c.req.header('user-agent') ?? null,
		params: event.params ?? null,
		query: event.query ?? null,
		body: event.body ?? null,
		response: event.response ?? null,
		error:
			error === undefined
				? null
				: error instanceof Error
					? {
							name: error.name,
							message: error.message,
							stack: error.stack ?? null
						}
					: { name: 'Error', message: String(error), stack: null },
		validation: validation
			? {
					target: validation.target,
					message: formatIssues(validation.issues),
					issues: validation.issues.map((issue) => ({
						message: issue.message,
						path: issuePath(issue)
					}))
				}
			: null
	}
}

export interface WebhookDescription {
	method: WebhookMethod
	path: string
	description: string | null
	/** Whether the webhook has a `verify` function. */
	verified: boolean
	bodyType: BodyType
	/**
	 * JSON Schema per part: the input side for request parts, the output side
	 * for `response`. `null` when the part has no schema or its library
	 * doesn't implement Standard JSON Schema.
	 */
	jsonSchema: Record<
		'params' | 'query' | 'headers' | 'body' | 'response',
		Record<string, unknown> | null
	>
}

function toJsonSchema(
	schema: Schema | undefined,
	side: 'input' | 'output',
	target: StandardJSONSchemaV1.Target
) {
	const props = (schema as Partial<StandardJSONSchemaV1> | undefined)?.[
		'~standard'
	]
	try {
		return props?.jsonSchema?.[side]({ target }) ?? null
	} catch {
		return null
	}
}

/**
 * Describes webhooks for docs, admin pages or OpenAPI, with JSON Schemas from
 * any library that implements Standard JSON Schema (Zod 4.2+, for example).
 */
export function describeWebhooks(
	source: WebhooksApp | readonly Webhook[],
	{ target = 'draft-2020-12' }: { target?: StandardJSONSchemaV1.Target } = {}
): WebhookDescription[] {
	const webhooks = 'webhooks' in source ? source.webhooks : source
	return webhooks.map(({ config }) => ({
		method: config.method,
		path: config.path,
		description: config.description ?? null,
		verified: Boolean(config.verify),
		bodyType: config.bodyType ?? 'auto',
		jsonSchema: {
			params: toJsonSchema(config.params, 'input', target),
			query: toJsonSchema(config.query, 'input', target),
			headers: toJsonSchema(config.headers, 'input', target),
			body: toJsonSchema(config.body, 'input', target),
			response: toJsonSchema(config.response, 'output', target)
		}
	}))
}

type In<S, Fallback> = S extends Schema
	? StandardSchemaV1.InferInput<S>
	: Fallback

/** What `testWebhook` sends, typed from the webhook's schemas. */
export type TestWebhookInput<W> =
	W extends Webhook<infer E, infer P, infer TParams, any, any, infer TBody>
		? {
				/** Filled into the path pattern. */
				params?: In<TParams, PathParams<P>>
				/** Overrides the path, e.g. for wildcard patterns. */
				path?: string
				query?: Record<string, string>
				headers?: Record<string, string>
				/**
				 * A string is sent as is (`text/plain` unless you set a content
				 * type). Anything else is sent as JSON, or url-encoded when the
				 * webhook's `bodyType` is `'form'`.
				 */
				body?: In<TBody, unknown> | string
				/** Headers computed from the raw body, e.g. `(raw) => shopify.sign(raw, secret)`. */
				sign?: (rawBody: string) => MaybePromise<Record<string, string>>
				/** Bindings, available as `c.env`. */
				env?: E extends { Bindings: infer B } ? B : unknown
				/** `onEvent`, `onError` and so on, as for `createWebhooks`. */
				options?: WebhooksOptions<E>
			}
		: never

function fillPath(pattern: string, params: Record<string, unknown>) {
	return pattern.replace(/\/:(\w+)(?:\{[^}]*\})?\??/g, (_, name: string) => {
		const value = params[name]
		return value === undefined ? '' : `/${encodeURIComponent(String(value))}`
	})
}

/**
 * Sends one request through a single webhook, with routing, signature check,
 * validation and response handling, and returns the `Response`.
 *
 * @example
 * const res = await testWebhook(orderPaid, {
 *   params: { orderId: '42' },
 *   body: { amount: 10, currency: 'DKK' }
 * })
 */
export async function testWebhook<W extends Webhook>(
	webhook: W,
	input: TestWebhookInput<W> = {} as TestWebhookInput<W>
): Promise<Response> {
	const { config } = webhook
	const { body, sign, env, options } = input as TestWebhookInput<Webhook>
	const headers = new Headers(input.headers)
	let rawBody: string | undefined
	if (typeof body === 'string') {
		rawBody = body
		if (!headers.has('content-type')) headers.set('content-type', 'text/plain')
	} else if (body !== undefined && config.bodyType === 'form') {
		rawBody = new URLSearchParams(body as Record<string, string>).toString()
		if (!headers.has('content-type')) {
			headers.set('content-type', 'application/x-www-form-urlencoded')
		}
	} else if (body !== undefined) {
		rawBody = JSON.stringify(body)
		if (!headers.has('content-type')) {
			headers.set('content-type', 'application/json')
		}
	}
	for (const [name, value] of Object.entries(
		(await sign?.(rawBody ?? '')) ?? {}
	)) {
		headers.set(name, value)
	}
	const path =
		input.path ??
		fillPath(config.path, (input.params ?? {}) as Record<string, unknown>)
	const query = new URLSearchParams(input.query).toString()
	return createWebhooks([webhook], options).request(
		`${path || '/'}${query ? `?${query}` : ''}`,
		{ method: config.method, headers, body: rawBody },
		env as object | undefined
	)
}
