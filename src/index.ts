import type { StandardSchemaV1 } from '@standard-schema/spec'
import { type Context, type Env, Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ParamKeys, ParamKeyToRecord } from 'hono/types'

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

/**
 * Params typed from the path string: `/users/:id` gives `{ id: string }`,
 * `/files/:name?` gives `{ name: string | undefined }`.
 */
export type PathParams<P extends string> = [ParamKeys<P>] extends [never]
	? Record<string, never>
	: UnionToIntersection<ParamKeyToRecord<ParamKeys<P>>>

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
	 * Checks the signature before the body is parsed or validated. Returning
	 * `false` answers `401 { error: 'Invalid signature' }`.
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
	/** The requested path. */
	path: string
	status: number
	durationMs: number
	/** Each part is set once it has been validated. */
	params?: unknown
	query?: unknown
	headers?: unknown
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
				const event: WebhookEvent<E> = {
					c,
					route,
					method: c.req.method,
					path: c.req.path,
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
						defaultErrorResponse(error, c as Context, !options.onError)
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
					event.params = await parse(config.params, c.req.param(), 'params')
					event.query = await parse(config.query, c.req.query(), 'query')
					event.headers = await parse(config.headers, c.req.header(), 'headers')
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
