# hono-webhooks

Type-safe webhook endpoints for [Hono](https://hono.dev). Define each webhook
once with its schemas, get typed `params`, `query`, `headers` and `body` in the
handler, and mount them all as one Hono app. You can use any
[Standard Schema](https://standardschema.dev) library: Zod, Valibot, ArkType
and others.

```ts
import { Hono } from 'hono'
import { createWebhooks, defineWebhook } from 'hono-webhooks'
import { sharedSecret } from 'hono-webhooks/signatures'
import { z } from 'zod'

const orderPaid = defineWebhook(
	{
		method: 'POST',
		path: '/shop/orders/:orderId/paid',
		verify: sharedSecret({ header: 'x-shop-token' }).verify((c) => c.env.SHOP_TOKEN),
		body: z.object({ amount: z.number(), currency: z.string() })
	},
	async ({ params, body }) => {
		await markPaid(params.orderId, body.amount, body.currency)
		return { received: true }
	}
)

const app = new Hono()
app.route('/webhooks', createWebhooks([orderPaid]))
```

- **Typed from the definition.** `params.orderId` is a `string` because it is
  in the path, `body` has the schema's output type, and the handler's return
  value is checked against the `response` schema.
- **Any schema library.** Zod, Valibot, ArkType, Effect Schema, or anything
  else that implements Standard Schema. Async schemas work too.
- **Signed webhooks built in, and required.** `verify` checks the signature
  on the raw body before anything is parsed, with ready-made verifiers and
  signers for Stripe, GitHub, Meta, Shopify, Svix, Twilio, HubSpot, Infisical,
  shared secrets and any HMAC scheme. A webhook that takes a body must have a
  `verify`, or say `verify: false`. `rawBody` is always passed to the handler
  too.
- **Bounded bodies.** Bodies over 1 MiB answer 413 before they are read.
- **Plain Hono.** `createWebhooks` returns a Hono app. Handlers get the Hono
  context `c`, Hono middleware works, `HTTPException` works, and it runs on
  every runtime Hono supports.
- **One hook for observability.** `onEvent` fires once per request with the
  route, status, duration, validated input, response and error. Use it for
  logs, metrics, traces or an audit table.
- **Tooling.** `describeWebhooks` gives JSON Schemas for docs and admin pages,
  `testWebhook` runs one webhook in tests with typed input, and the CLI lists
  webhooks and sends (signed) test requests.

## Contents

- [Install](#install)
- [Defining webhooks](#defining-webhooks)
- [Handler input](#handler-input)
- [Return values](#return-values)
- [Body parsing](#body-parsing)
- [Signature verification](#signature-verification)
- [Mounting](#mounting)
- [Typed env and middleware](#typed-env-and-middleware)
- [Errors](#errors)
- [Observability with `onEvent`](#observability-with-onevent)
- [Recipes](#recipes)
- [Describing webhooks](#describing-webhooks)
- [Testing](#testing)
- [CLI](#cli)
- [API reference](#api-reference)
- [Upgrading to 0.6](#upgrading-to-06)
- [Upgrading from 0.1](#upgrading-from-01)
- [Migrating from `createHttpRoute`](#migrating-from-createhttproute)
- [Releasing](#releasing)

## Install

```bash
bun add hono-webhooks hono
# plus the schema library you use
bun add zod
```

`hono` (4.8 or newer) is a peer dependency. The package is ESM only. Bun
loads the TypeScript source directly; Node and bundlers load the built files
from `dist`.

## Defining webhooks

`defineWebhook(config, handler)` returns a webhook definition. It does not
register anything; pass the definitions to `createWebhooks`.

```ts
import { defineWebhook } from 'hono-webhooks'
import * as v from 'valibot'

export const updateItem = defineWebhook(
	{
		method: 'PUT',
		path: '/items/:id',
		description: 'Update an item from the ERP',
		verify: sharedSecret({ header: 'x-api-key' }).verify((c) => c.env.ERP_KEY),
		params: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
		query: v.object({ dryRun: v.optional(v.picklist(['true', 'false'])) }),
		headers: v.object({ 'x-erp-user': v.string() }),
		body: v.object({ name: v.string(), price: v.number() }),
		response: v.object({ id: v.number(), updated: v.boolean() })
	},
	async ({ params, query, headers, body }) => {
		// params.id: number, body.price: number, headers['x-erp-user']: string
		return { id: params.id, updated: query.dryRun !== 'true' }
	}
)
```

| Option        | Type                                                          | Description                                                                                             |
| ------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `method`      | `'GET' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'OPTIONS'` | HTTP method. `HEAD` is answered by the `GET` route automatically.                                        |
| `path`        | `string`                                                      | A [Hono path](https://hono.dev/docs/api/routing): `/a/:id`, `/a/:id?`, `/a/:id{[0-9]+}`, `/a/*`. |
| `params`      | Standard Schema                                               | Validates path params. Without it, `params` is typed from `path`.                                       |
| `query`       | Standard Schema                                               | Validates the query string as `Record<string, string>`.                                                 |
| `headers`     | Standard Schema                                               | Validates headers as `Record<string, string>` with **lower-case** names.                                |
| `body`        | Standard Schema                                               | Validates the parsed body (see [Body parsing](#body-parsing)).                                          |
| `verify`      | `({ c, rawBody, headers, fail }) => boolean \| Promise<boolean>`, or `false` | Checks the signature before the body is parsed. Required for every method but `GET`; `false` means public on purpose (see [Signature verification](#signature-verification)). |
| `maxBodyBytes` | `number`                                                     | Overrides the app's body limit for this webhook (see [Mounting](#mounting)).                             |
| `response`    | Standard Schema                                               | Types the handler's return value and checks it at runtime (see [Return values](#return-values)).        |
| `bodyType`    | `'auto' \| 'json' \| 'form' \| 'text'`                        | How to parse the body. Default `'auto'`.                                                                |
| `description` | `string`                                                      | Shown by `hono-webhooks list`.                                                                          |

Schemas can transform: the handler receives the schema's **output**, so
`z.coerce.number()` on a param gives you a `number`.

### Params from the path

Without a `params` schema, the path gives the types:

```ts
defineWebhook({ method: 'GET', path: '/repos/:owner/:repo/:ref?' }, ({ params }) => {
	params.owner // string
	params.ref // string | undefined
	params.nope // type error
})
```

## Handler input

The handler receives one object:

| Field     | Type                                                   | Description                                                         |
| --------- | ------------------------------------------------------ | ------------------------------------------------------------------- |
| `c`       | `Context<E>`                                           | The Hono context: `c.env`, `c.var`, `c.header()`, `c.req.raw`, ... |
| `params`  | schema output, or typed from `path`                    | Path params, URL-decoded.                                           |
| `query`   | schema output, or `Record<string, string>`             | Query string. Repeated keys keep the first value.                   |
| `headers` | schema output, or `Record<string, string>`             | Request headers, lower-case names.                                  |
| `body`    | schema output, or `unknown`                            | Parsed body. `undefined` when the body is empty.                    |
| `rawBody` | `string`                                               | The body exactly as received. `''` when empty.                      |

## Return values

| Handler returns   | Response                                                             |
| ----------------- | -------------------------------------------------------------------- |
| a `Response`      | Sent as is. Use `c.json(data, 201)`, `c.redirect()`, `new Response()` |
| `undefined`       | `204 No Content`                                                     |
| a `string`        | `200`, `text/plain`                                                  |
| anything else     | `200`, JSON                                                          |

With a `response` schema, the return type is checked at compile time. At
runtime the value is also validated. If it fails, the response is **still
sent** so the caller isn't affected, and the failure is reported on
[`onEvent`](#observability-with-onevent) as `event.validation` with
`target: 'response'`.

## Body parsing

The body is read once as text (`rawBody`), then parsed according to
`bodyType`:

| `bodyType`       | Parsed as                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto` (default) | Depends on `Content-Type`: `application/json` and any `+json` type → JSON; `application/x-www-form-urlencoded` → `Record<string, string>`; anything else → `string` |
| `json`           | JSON, whatever the `Content-Type` says. Use it for providers that send JSON without the right header.                                      |
| `form`           | URL-encoded form (for example Twilio)                                                                                                      |
| `text`           | The raw string                                                                                                                             |

An empty body is `undefined` (the schema decides whether that's allowed).
Malformed JSON is a `400` with `issues: [{ message: 'Malformed JSON' }]`.

## Signature verification

`verify` runs on the raw body **right after routing, before anything is
validated or parsed**. A request with a bad signature gets a 401 and never
reaches the params, query, headers or body schemas, so unauthenticated
callers never see a description of your schemas. Signed webhooks can use
`headers` and `body` schemas like any other webhook:

```ts
import { shopify } from 'hono-webhooks/signatures'

export const orderCreated = defineWebhook(
	{
		method: 'POST',
		path: '/shopify/orders',
		verify: shopify.verify((c) => c.env.SHOPIFY_WEBHOOK_SECRET),
		body: z.object({ id: z.number(), total_price: z.string() })
	},
	({ body }) => {
		// only runs for correctly signed requests
	}
)
```

When `verify` returns anything but `true`, the answer is
`401 { error: 'Invalid signature' }` and `onEvent` gets
`validation.target: 'signature'` with the reason in
`validation.issues[0].message` (see [Failure reasons](#failure-reasons)).

### Every webhook says how it is authenticated

`verify` is required for every method except `GET`. `createWebhooks` throws
at startup for a webhook that has none:

```text
hono-webhooks: POST /update-secrets has no verify. Pass a verify function, or verify: false if it is public on purpose.
```

Pass `verify: false` for a webhook that really is public, such as a device
that cannot sign or a beacon. `describeWebhooks` reports it as
`verified: false` and `hono-webhooks list` prints `public (verify: false)`.
`GET` webhooks (health checks, provider URL challenges, OAuth callbacks) may
leave `verify` out.

A check that is not a signature still belongs in `verify`: an API key, an
OAuth `state`, a channel token. That keeps unauthenticated callers at 401
before any schema runs.

### Schemes

`hono-webhooks/signatures` has a verifier and a matching signer per provider:

| Scheme                                  | Header                                  | Signed content      |
| --------------------------------------- | --------------------------------------- | ------------------- |
| `github`, `meta` (WhatsApp, Messenger, Instagram) | `x-hub-signature-256: sha256=<hex>` | body          |
| `shopify`                               | `x-shopify-hmac-sha256: <base64>`       | body                |
| `stripe`                                | `stripe-signature: t=<unix>,v1=<hex>`   | `<t>.<body>`        |
| `svix` (Resend, Clerk, Standard Webhooks) | `svix-id`, `svix-timestamp`, `svix-signature: v1,<base64> ...` (or `webhook-*`) | `<id>.<timestamp>.<body>`, key from `whsec_<base64>` |
| `infisical`                             | `x-infisical-signature: t=<ms>;<hex>`   | body (which carries the `timestamp`) |
| `twilio`                                | `x-twilio-signature: <base64>` (HMAC-SHA1) | URL + sorted form fields |
| `hubspot` (v3)                          | `x-hubspot-signature-v3: <base64>`, `x-hubspot-request-timestamp` | `<METHOD><url><body><timestamp>` |
| `sharedSecret({ header, prefix? })`     | the secret itself, e.g. `authorization: Bearer <token>` | nothing; compared in constant time |
| `hmac({ header, encoding, prefix?, hash? })` | any header, hex or base64, SHA-1/256/512 | body          |

- `scheme.verify(secret)` gives a `verify` function. `secret` is a string or
  `(c) => string | Promise<string>`, so it can come from `c.env`. An empty
  secret throws (a 500), instead of silently accepting or rejecting everything.
- `stripe`, `svix`, `infisical` and `hubspot` reject timestamps more than 300
  seconds away by default (`verify(secret, { toleranceSeconds })`). `stripe`
  and `svix` accept any matching `v1`, so secret rotation works.
- `twilio` and `hubspot` sign the URL the provider called. Behind a proxy
  `c.req.url` is the internal URL, so pass the public one:
  `twilio.verify(secret, { url: (c) => publicUrl(c) })`. Return an array to
  try several; any match passes.
- `scheme.sign(rawBody, secret, options?)` returns the headers the provider
  would send, for tests and the CLI. `twilio.sign` and `hubspot.sign` need
  `{ url }`.
- Signatures are compared with `crypto.subtle.verify`, which runs in constant
  time; `sharedSecret` compares through it too. Everything uses Web Crypto,
  so it works on every runtime.

### Shared secrets

For a provider that sends a fixed token instead of a signature (GitLab's
`x-gitlab-token`, Telegram's `x-telegram-bot-api-secret-token`, a bearer
token), use `sharedSecret`. Do not compare with `===`: it is not constant
time, and an unset secret and a missing header compare equal
(`undefined === undefined`).

```ts
import { sharedSecret } from 'hono-webhooks/signatures'

verify: sharedSecret({ header: 'x-gitlab-token' }).verify((c) => c.env.GITLAB_WEBHOOK_TOKEN)
verify: sharedSecret({ header: 'authorization', prefix: 'Bearer ' }).verify(() => getSecret('API_TOKEN'))
```

To accept either of two headers, try both:

```ts
const header = sharedSecret({ header: 'x-once-secret' }).verify(secret)
const bearer = sharedSecret({ header: 'authorization', prefix: 'Bearer ' }).verify(secret)
verify: async (input) => (await header(input)) || bearer(input)
```

### Writing your own

A scheme that signs a timestamp in its own format (Slack's
`v0:<timestamp>:<body>`, for example) needs a hand-written `verify`. Check the
timestamp, and return `fail(reason)` so the operator sees why:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto'

verify: ({ c, rawBody, headers, fail }) => {
	const timestamp = Number(headers['x-slack-request-timestamp'])
	const given = headers['x-slack-signature'] ?? ''
	if (!timestamp || !given) return fail('missing-header')
	if (Math.abs(Date.now() / 1000 - timestamp) > 300) return fail('timestamp-out-of-tolerance')
	const expected = `v0=${createHmac('sha256', c.env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
	return (
		(given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected))) ||
		fail('mismatch')
	)
}
```

### Failure reasons

`fail(reason)` records why a check failed and returns `false`. The reason
goes to `onEvent` as `validation.issues[0].message` (and so to
`summarizeEvent(e).validation.message`), never to the caller. The built-in
schemes use `missing-header`, `malformed`, `timestamp-out-of-tolerance` and
`mismatch`, so a log tells clock skew from a wrong secret. A plain `false`
gives `Signature does not match`.

### Passing what `verify` learned to the handler

When the check finds out who is calling (an API key's organization, a
decoded JWT), set it on the context and read it in the handler. Type it with
[`createWebhookFactory`](#typed-env-and-middleware):

```ts
type AppEnv = { Variables: { caller?: { organizationId: string } } }
const { defineWebhook } = createWebhookFactory<AppEnv>()

defineWebhook(
	{
		method: 'POST',
		path: '/sessions',
		verify: async ({ c, fail }) => {
			const caller = await findApiKey(c.req.header('authorization'))
			if (!caller) return fail('unknown api key')
			c.set('caller', caller)
			return true
		}
	},
	({ c }) => createSession(c.var.caller!.organizationId)
)
```

## Mounting

`createWebhooks(webhooks, options?)` returns a Hono app. Mount it under a
prefix with `app.route()`:

```ts
const app = new Hono()
app.route('/webhooks', createWebhooks([stripe, github, health], options))
```

Below that prefix:

- An unknown path answers `404 { error: 'Route not found' }`.
- A known path with a method that isn't defined answers
  `405 { error: 'Method DELETE not allowed' }` with an `Allow` header.
- A static path wins over a dynamic one that also matches (`/users/me` beats
  `/users/:id`) no matter which order they were passed in.
- Defining the same method and path twice throws when `createWebhooks` runs.
- A body over `maxBodyBytes` (default 1 MiB) answers
  `413 { error: 'Payload too large' }` before it is read or verified, from
  `content-length` or while streaming. Set it on `createWebhooks(webhooks, {
  maxBodyBytes })` or per webhook; `Infinity` turns it off.

Anything mounted under the prefix gets the webhooks' behavior: the body
limit, `onEvent`, logging and metrics. A health check defined as a webhook
is fine; skip it in metrics and logs with `ignoreRoutes: ['/health']` (see
[OpenTelemetry](#opentelemetry)).

Because the webhooks app answers 404 for anything under its prefix, mount it
under its own prefix (`/webhooks`), not at `/`.

The definitions are available as `webhooksApp.webhooks`, which is handy for
generating docs.

## Typed env and middleware

`defineWebhook` and `createWebhooks` type `c` as `Context<any>`. To type
`c.env` (Cloudflare bindings) and `c.var` (values set by middleware), make a
factory once and use it everywhere:

```ts
// src/webhooks/factory.ts
import { createWebhookFactory } from 'hono-webhooks'

export type AppEnv = {
	Bindings: { STRIPE_WEBHOOK_SECRET: string; DB: D1Database }
	Variables: { requestId: string }
}

export const { defineWebhook, createWebhooks } = createWebhookFactory<AppEnv>()
```

```ts
defineWebhook({ method: 'POST', path: '/ping', verify: false }, ({ c }) => {
	c.env.DB // D1Database
	c.var.requestId // string
})
```

Middleware goes on the parent app, before `app.route()`, so it runs before
the webhooks (Hono runs handlers in the order they were registered):

```ts
const app = new Hono<AppEnv>()
app.use('/webhooks/*', requestId())
app.use('/webhooks/admin/*', bearerAuth({ token }))
app.route('/webhooks', createWebhooks(webhooks))
```

## Errors

Anything thrown while handling a request becomes a response:

| Thrown                                               | Default response                                  |
| ---------------------------------------------------- | ------------------------------------------------- |
| `WebhookValidationError` (a request schema failed)   | `400 { error: 'Invalid body', issues: [...] }`     |
| `WebhookValidationError` (the signature check failed) | `401 { error: 'Invalid signature' }`             |
| a body over `maxBodyBytes`                           | `413 { error: 'Payload too large' }`               |
| Hono's `HTTPException`                               | Its status and `{ error: message }`, or its `res`  |
| anything else                                        | `500 { error: 'Internal Server Error' }`, and the error is logged with `console.error` |

`issues` is the Standard Schema issue list: `{ message, path? }[]`.

Throw an `HTTPException` from a handler to answer with another status:

```ts
import { HTTPException } from 'hono/http-exception'

const verify = shopify.verify((c) => c.env.SHOPIFY_SECRET)

defineWebhook({ method: 'POST', path: '/orders/:id', verify }, async ({ params }) => {
	const order = await findOrder(params.id)
	if (!order) throw new HTTPException(404, { message: 'Unknown order' })
	// ...
})
```

`onError` changes the response for any error, including 404 and 405. Return a
`Response`, or nothing to fall back to the default.

The default 500 response logs the error with `console.error`. Pass
`logErrors: false` when you log errors yourself, in `onError` or `onEvent`,
so they aren't logged twice.

```ts
import { WebhookValidationError } from 'hono-webhooks'

createWebhooks(webhooks, {
	logErrors: false,
	onError(error, c) {
		if (error instanceof WebhookValidationError) {
			return c.json({ type: 'validation', target: error.target, issues: error.issues }, 422)
		}
		logger.error(error)
		// return nothing: default response
	}
})
```

## Observability with `onEvent`

`onEvent` is called once per request after the response is built, for
successes, validation failures, handler errors, 404s and 405s.

```ts
createWebhooks(webhooks, {
	onEvent(event) {
		logger.info('webhook', {
			route: event.route, // '/orders/:id', undefined for a 404
			method: event.method,
			path: event.path, // '/orders/42', relative to the mount point
			status: event.status,
			durationMs: event.durationMs
		})
	}
})
```

| Field                                      | Description                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `c`                                        | The Hono context, e.g. `c.req.header('user-agent')`                                                  |
| `route`                                    | Matched path pattern, `undefined` for a 404                                                          |
| `method`, `path`                           | Request method, and path relative to the mount point (`/orders/42`). The full path is `c.req.path` |
| `status`, `durationMs`                     | Response status, and time spent in the webhooks app in fractional milliseconds                      |
| `params`, `query`, `headers`               | `Record<string, unknown>`: the schema output, or the raw strings without a schema                    |
| `body`, `rawBody`                          | Parsed body and raw body                                                                             |
| `response`                                 | What the handler returned, unless it returned a `Response`                                           |
| `error`                                    | Whatever was thrown                                                                                  |
| `validation`                               | `{ target, issues }` when a request part, the signature or the response failed                      |

Each request part is set once it has passed validation, so a request that
fails on `body` still reports `params`.

### Summaries and issue messages

`summarizeEvent(event)` flattens an event into a JSON-safe record for logs or
a database table:

```ts
import { formatIssues, summarizeEvent } from 'hono-webhooks'

summarizeEvent(event)
// {
//   route: '/orders/:id', method: 'POST', path: '/orders/42', status: 400,
//   durationMs: 1.37,                // rounded to two decimals
//   ip: '203.0.113.9',               // x-forwarded-for, x-real-ip or cf-connecting-ip
//   userAgent: 'Shopify-Captain-Hook',
//   params: { id: '42' }, query: {}, body: null, response: null,
//   error: null,                     // or { name, message, stack }; null when validation is set
//   validation: {
//     target: 'body',
//     message: 'total: Expected number',
//     issues: [{ path: 'total', message: 'Expected number' }]
//   }
// }
```

- Missing values are `null`, never `undefined`.
- Request headers are left out on purpose, because they carry signatures and
  credentials.

The summary keeps the parsed body, the response and the query string.
Webhook bodies are often customer data and query strings can carry tokens,
so choose what to keep before storing it:

```ts
summarizeEvent(event, {
	body: false, // body and response become null
	query: false, // query becomes null
	headers: ['x-github-delivery', 'svix-id'] // kept as `headers`, lower-case
})
```

A delivery id header lets a stored call be matched to the provider's
delivery log.
- `ip` comes from headers the client can set, so only trust it behind a
  proxy that overwrites them.

`formatIssues(issues)` turns Standard Schema issues into one line, like
`total: Expected number; items.0.id: Required`.

`onEvent` isn't awaited, so a slow database write doesn't delay the response.
When it returns a promise, the promise is passed to
`c.executionCtx.waitUntil()` on runtimes that have one (Cloudflare Workers,
Vercel Edge), and a rejection is logged instead of crashing the request.

`onEvent` is called inside the request's async context, before the response
is returned. The active OpenTelemetry span, `AsyncLocalStorage` values and
anything set up in [`around`](#wrapping-requests-with-around) are available
there, so log lines written in `onEvent` attach to the request.

### Wrapping requests with `around`

`around` wraps every request, including 404s and 405s, and already knows the
matched route. Use it for anything that has to surround the whole request:
a tracing span, an `AsyncLocalStorage` scope, a timer. Call `next()` to
handle the request; it returns the response and runs `onEvent` inside your
wrapper.

```ts
createWebhooks(webhooks, {
	around: async ({ c, route, method }, next) => {
		const res = await next()
		console.log(method, route ?? '(no route)', res.status)
		return res
	}
})
```

`route` is the pattern relative to the mount point (`/orders/:id`), or
`undefined` for a 404. If `around` returns a response without calling
`next()`, the request isn't handled and `onEvent` doesn't run.

## Recipes

### Stripe events

The body schema only runs on verified requests. `constructEventAsync` from
the Stripe SDK works too, with `rawBody`, if you'd rather use their event
types.

```ts
import { stripe } from 'hono-webhooks/signatures'

export const stripeEvents = defineWebhook(
	{
		method: 'POST',
		path: '/stripe',
		verify: stripe.verify(process.env.STRIPE_WEBHOOK_SECRET!),
		body: z.object({
			id: z.string(),
			type: z.string(),
			data: z.object({ object: z.record(z.string(), z.unknown()) })
		})
	},
	async ({ body }) => {
		if (body.type === 'checkout.session.completed') {
			await fulfil(body.data.object)
		}
		return { received: true }
	}
)
```

### GitHub events

```ts
import { github } from 'hono-webhooks/signatures'

export const githubPush = defineWebhook(
	{
		method: 'POST',
		path: '/github',
		verify: github.verify((c) => c.env.GITHUB_WEBHOOK_SECRET),
		headers: z.object({ 'x-github-event': z.string() }),
		body: z.object({ ref: z.string().optional() })
	},
	({ headers, body }) => {
		if (headers['x-github-event'] === 'push') deploy(body.ref)
	}
)
```

### Resend (Svix) events

```ts
import { svix } from 'hono-webhooks/signatures'

export const resendEvents = defineWebhook(
	{
		method: 'POST',
		path: '/resend',
		verify: svix.verify((c) => c.env.RESEND_WEBHOOK_SECRET), // whsec_...
		body: z.object({
			type: z.string(),
			data: z.object({ email_id: z.string() })
		})
	},
	({ body }) => {
		if (body.type === 'email.bounced') markBounced(body.data.email_id)
	}
)
```

### Twilio form posts

Twilio signs the public URL it called, so pass it when the app runs behind a
proxy:

```ts
import { twilio } from 'hono-webhooks/signatures'

export const incomingSms = defineWebhook(
	{
		method: 'POST',
		path: '/twilio/sms',
		bodyType: 'form',
		verify: twilio.verify((c) => c.env.TWILIO_AUTH_TOKEN, {
			url: (c) => `${c.env.PUBLIC_URL}${new URL(c.req.url).pathname}`
		}),
		body: z.object({ From: z.string(), Body: z.string() })
	},
	({ c, body }) =>
		c.body(`<Response><Message>Got "${body.Body}"</Message></Response>`, 200, {
			'content-type': 'text/xml'
		})
)

// In a test, sign the URL testWebhook sends to
await testWebhook(incomingSms, {
	body: { From: '+4512345678', Body: 'hi' },
	sign: (raw, { url }) => twilio.sign(raw, 'token', { url })
})
```

Twilio answers a failed call with a spoken error unless it gets TwiML. Mount
the Twilio webhooks with their own `createWebhooks` and an `onError` that
returns TwiML with status 200.

### Duplicate deliveries and slow handlers

Providers retry: on a timeout, a 5xx, sometimes for no reason. Expect each
delivery more than once.

- Answer fast. Most providers give up after 5 to 30 seconds and send again.
  Enqueue a job and return; do the work in the job.
- Use the provider's delivery id (`svix-id`, Stripe's `event.id`,
  `x-github-delivery`) as the job key or a unique column, so a retry finds
  the first one.
- To cap handler time, put `timeout()` from `hono/timeout` on the mount:
  `app.use('/webhooks/*', timeout(10_000))`.

### Storing every call

```ts
import { summarizeEvent } from 'hono-webhooks'

createWebhooks(webhooks, {
	logErrors: false, // errors are stored below instead
	onEvent: async (e) => {
		if (e.route === '/health') return
		const call = summarizeEvent(e, { body: false, headers: ['x-github-delivery'] })
		await db.insert(webhookCalls).values({
			...call,
			errorMessage: call.error?.message ?? null,
			errorStack: call.error?.stack ?? null,
			validationError: call.validation?.message ?? null
		})
	}
})
```

### OpenTelemetry

`hono-webhooks/otel` puts each request in a server span and records two
metrics. It needs `@opentelemetry/api` (an optional peer dependency):

```bash
bun add @opentelemetry/api
```

```ts
import { otelWebhooks } from 'hono-webhooks/otel'

createWebhooks(webhooks, {
	...otelWebhooks({
		ignoreRoutes: ['/health'],
		// one `webhook.completed` log per request, with the request's span
		logger: (span) => createLogger({ span }),
		// what `call` keeps, as for summarizeEvent
		summary: { body: false },
		onWebhookCall(call, event) {
			// `call` is summarizeEvent(event) plus `level`, `outcome` and
			// `ignored`; the request's span is active here
			if (call.ignored) return
			storeCall(call)
			if (call.status >= 500) captureException(event.error)
		}
	}),
	// the completion log carries the error type
	logErrors: false
})
```

- **Span** `webhook: POST /orders/:id` (kind `SERVER`) with `http.method`,
  `http.route`, `http.status_code`, `webhook.duration_ms`, `webhook.success`
  and, for validation failures, `webhook.validation_error`. Status is `ERROR`
  for 4xx and 5xx; 5xx errors are recorded as exceptions. Spans created in
  handlers nest under it when an OTel context manager is registered.
- **Metrics** `webhook_request_total` (counter) and
  `webhook_request_duration_ms` (histogram, ms), both by `route` (the pattern,
  `__unmatched__` for a 404) and `status` (`success` below 400, else `failed`).
- **Log** `webhook.completed`, when `logger` is set, at `error` for 5xx,
  `warn` for 4xx and `info` otherwise, with `route`, `method`, `status_code`,
  `duration_ms`, `status` (`success`, `failed` or `validation_failed`),
  `error_type` and `error_message`. `logger` gets the request's span and returns anything with
  `info`, `warn` and `error` methods taking `(message, fields)`, so
  `logger: () => console` works. 404s and `ignoreRoutes` are not logged.
- `ignoreRoutes` skips metrics and the log; the span and `onWebhookCall` still
  run, with `call.ignored: true`.
- With `logErrors: false`, a handler error reaches the span and the log, not
  the parent app's `onError`. Report it to an error tracker from
  `onWebhookCall` (`event.error`).
- `webhookMetrics` describes both metrics (`name`, `kind`, `unit`,
  `description` and `attributes`, where each attribute maps to its values or
  `'string'`), so a metric catalog can list them:

  ```ts
  import { webhookMetrics } from 'hono-webhooks/otel'

  export const otelMetrics = [...appMetrics, ...webhookMetrics]
  ```
- `tracer` and `meter` default to `trace.getTracer('webhooks')` and
  `metrics.getMeter('webhooks')`. The meter is resolved on the first request,
  so registering the SDK after import works.

It returns `{ around, onEvent }`. To add your own, call them from yours, or
use `onWebhookCall` instead of `onEvent`.

### Skipping noise

`onEvent` fires for everything, so filter in the hook:

```ts
onEvent(e) {
	if (e.route === '/health') return
	log(e)
}
```

With `otelWebhooks`, use `ignoreRoutes` and check `call.ignored` in
`onWebhookCall`.

### Organising webhooks in a project

Keep one file per webhook and a registry that lists them:

```ts
// src/webhooks/index.ts
import { createWebhooks } from './factory'
import { health } from './health'
import { stripeEvents } from './stripe'

export const webhooks = createWebhooks([health, stripeEvents], { onEvent, onError })
```

```ts
// src/app.ts
app.route('/webhooks', webhooks)
```

Hono's `showRoutes(app)` from `hono/dev` prints every route at startup.

## Describing webhooks

`describeWebhooks(appOrArray)` returns one entry per webhook, with JSON
Schemas from any library that implements
[Standard JSON Schema](https://standardschema.dev) (Zod 4.2+ does). Use it for
an admin page, docs or an OpenAPI document:

```ts
import { describeWebhooks } from 'hono-webhooks'

describeWebhooks(webhooks)
// [{
//   method: 'POST',
//   path: '/orders/:id',
//   description: 'Order paid',
//   verified: true,          // has a verify function (false for verify: false)
//   bodyType: 'auto',
//   jsonSchema: { params: null, query: null, headers: null, body: {...}, response: {...} }
// }]

describeWebhooks(webhooks, { target: 'openapi-3.0' }) // or 'draft-07'
```

Request parts use the schema's input side (what the sender sends), `response`
its output side. A part is `null` when it has no schema, or when the library
can't produce JSON Schema.

## Testing

`testWebhook(webhook, input)` sends one request through a single webhook and
returns the `Response`. It runs everything a real request does: signature
check, validation, handler and response handling. Its input is typed from the
webhook's schemas:

```ts
import { expect, test } from 'bun:test'
import { testWebhook } from 'hono-webhooks'
import { shopify } from 'hono-webhooks/signatures'
import { orderPaid } from './webhooks/order-paid'

test('marks the order paid', async () => {
	const res = await testWebhook(orderPaid, {
		params: { orderId: '42' }, // filled into the path
		query: { dryRun: 'true' },
		body: { amount: 10, currency: 'DKK' }, // typed from the body schema
		sign: (rawBody) => shopify.sign(rawBody, 'test-secret'),
		env: { SHOPIFY_WEBHOOK_SECRET: 'test-secret' }
	})
	expect(res.status).toBe(200)
})
```

| Input     | Description                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------ |
| `params`  | Filled into the path pattern. Use `path` instead for wildcard patterns.                                      |
| `query`, `headers` | String records.                                                                                     |
| `body`    | A string is sent as is. Anything else is sent as JSON, or url-encoded when `bodyType` is `'form'`.            |
| `sign`    | Gets the exact raw body and `{ url, method }`, and returns headers to add, e.g. `(raw) => github.sign(raw, secret)` or `(raw, { url }) => twilio.sign(raw, token, { url })`. |
| `baseUrl` | Origin the request goes to, default `http://localhost`. For schemes that sign the URL.                       |
| `env`     | Bindings, available as `c.env`.                                                                              |
| `options` | `createWebhooks` options, e.g. `{ onEvent }`.                                                                |

To test a whole webhooks app with its routing, use Hono's `request()`:
`webhooks.request('/orders/42', init, env)`.

## CLI

```text
hono-webhooks <module> <command> [options]

Commands:
  list                      List the webhooks
  schema <path>             Print the JSON Schemas of the webhooks at <path>
  test <method> <path>      Send a request through the webhooks app

Options:
  -r, --preload <module>    Import a module first (e.g. to load secrets), repeatable

Options for test:
  -b, --body <text>         Request body (JSON sets content-type: application/json)
  -q, --query <params>      Query string, e.g. "a=1&b=2"
  -H, --header <k: v>       Request header, repeatable
  -s, --sign <scheme>       Sign the body: github, hubspot, infisical, meta, shopify, stripe, svix, twilio
  -e, --secret-env <name>   Environment variable holding the signing secret
```

`hono-webhooks <module> <command> --help` prints the options of one command.

`<module>` exports either a `createWebhooks()` app or an array of webhooks, as
default or as any named export. With an array, the CLI builds the app itself,
so it can point straight at the file that lists your webhooks.

```bash
bunx hono-webhooks ./src/webhooks/index.ts list
bunx hono-webhooks ./src/webhooks/index.ts schema /orders/:id
bunx hono-webhooks ./src/webhooks/index.ts test POST /orders/42 -b '{"total":10}' -H 'x-api-key: dev'

# Load secrets first, then sign the body like Shopify would
bunx hono-webhooks ./src/webhooks/index.ts test POST /shopify/orders -b '{"id":1}' \
  --preload ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET
```

- `test` sends a real request through the webhooks app (without the parent
  app's middleware) and exits with code 1 on a 4xx or 5xx response.
- `--preload` imports modules in order, before the webhooks module. It takes
  a file path or a package name.
- `--sign` signs the exact `--body` with the secret read from the environment
  variable named by `--secret-env`, after preloading, so a preloaded module
  can set it. `twilio` and `hubspot` sign `http://localhost<path>`, the URL
  the request is sent to. For `infisical`, put a current `timestamp`
  (milliseconds) in the body. For a shared secret, send the header with `-H`.
- `schema` prints the JSON Schemas from
  [`describeWebhooks`](#describing-webhooks).
- The CLI imports your TypeScript file. `bunx hono-webhooks` starts the CLI
  under Node (its shebang is `node`), and Node 22.18+ can load plain
  TypeScript. It can't load everything Bun can, such as extensionless
  imports (`import { x } from './x'`). When Node fails to load your module
  and Bun is installed, the CLI reruns the same command under Bun
  automatically. To skip the failed Node attempt in a Bun project, run
  `bunx --bun hono-webhooks ...`.

## API reference

```ts
import {
	defineWebhook, // (config, handler) => Webhook
	createWebhooks, // (webhooks, options?) => WebhooksApp  (a Hono app + .webhooks)
	createWebhookFactory, // <E extends Env>() => { defineWebhook, createWebhooks }
	WebhookValidationError, // extends HTTPException; .target, .issues
	describeWebhooks, // (appOrArray, { target? }) => WebhookDescription[]
	testWebhook, // (webhook, input?) => Promise<Response>
	summarizeEvent, // (event, options?) => WebhookEventSummary, flat and JSON-safe
	formatIssues, // (issues) => 'total: Expected number; ...'
	webhookPath // (webhook, params?) => '/channels/gmail/callback'
} from 'hono-webhooks'

import {
	github,
	meta,
	shopify,
	stripe,
	svix,
	infisical,
	twilio,
	hubspot, // each: .verify(secret, options?) and .sign(rawBody, secret, options?)
	hmac, // (options) => a scheme like the ones above
	sharedSecret // ({ header, prefix? }) => a scheme comparing the secret itself
} from 'hono-webhooks/signatures'

import type {
	Secret,
	SignatureScheme,
	HmacOptions,
	SharedSecretOptions,
	SignedUrl,
	VerifyFailureReason
} from 'hono-webhooks/signatures'

import {
	otelWebhooks, // (options?) => { around, onEvent } with spans and metrics
	webhookMetrics, // the two metric definitions, as data
	UNMATCHED_ROUTE // '__unmatched__', the route label for 404s
} from 'hono-webhooks/otel'

import type {
	Webhook,
	WebhookConfig,
	WebhookInput,
	WebhookResult,
	WebhookEvent,
	WebhookEventSummary,
	SummaryOptions,
	WebhookDescription,
	TestWebhookInput,
	WebhooksOptions,
	WebhookRequestInfo,
	WebhooksApp,
	Verify,
	VerifyInput,
	WebhookMethod,
	BodyType,
	ValidationTarget,
	PathParams,
	StandardSchemaV1
} from 'hono-webhooks'

import type {
	OtelWebhooksOptions,
	WebhookCall,
	WebhookLogger,
	WebhookMetricDefinition
} from 'hono-webhooks/otel'
```

Use `Webhook` to type a list: `const all: Webhook<AppEnv>[] = [a, b]`.

`webhookPath(webhook, params)` fills a webhook's path pattern, typed from the
path, so an OAuth redirect or a provider subscription URL is built from the
definition instead of typed twice. It is relative to the mount point; add
your origin and prefix.

## Upgrading to 0.6

- **`verify` is required for every method but `GET`.** `createWebhooks`
  throws at startup for a webhook without one. Add a `verify` function, or
  `verify: false` to a webhook that is public on purpose. Move checks that
  live in the handler (API keys, tokens, OAuth state) into `verify`.
- **Bodies over 1 MiB answer 413.** Raise it with `maxBodyBytes` on
  `createWebhooks` or on the webhook, or pass `Infinity` for the old
  behavior.
- **The 401 body is `{ error: 'Invalid signature' }`**, without `issues`.
  The reason is on `event.validation`.
- **`VerifyInput` has a `fail` function.** Code that calls a scheme's
  `verify` by hand should pass `fail: () => false` (the built-in schemes
  work without it).
- **Only `true` passes.** A custom `verify` returning another truthy value
  now answers 401.

## Upgrading from 0.1

- `event.path` is relative to the mount point (`/orders/42`), like
  `event.route`. Use `event.c.req.path` for the full path.
- Passing `onError` no longer turns off `console.error` for the default 500
  response. Pass `logErrors: false` for that.
- `hono` 4.8 or newer is required.

## Migrating from `createHttpRoute`

For code that used the in-app `lib/webhook` this package came from:

| Before                                         | After                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------- |
| `createHttpRoute(handlerData, handler)`        | `defineWebhook(config, handler)`                                              |
| `reqBodySchema`, `reqQuerySchema`, ...         | `body`, `query`, `headers`, `params`, `response`                              |
| `z.string()` body switches to text parsing     | Parsing follows `Content-Type`; set `bodyType: 'text'` to force it           |
| `z.any()` body skips the content-type check    | No content-type check anymore; leave `body` out and read `body` / `rawBody`  |
| `rawBody: true` + checking the signature by hand | `verify: shopify.verify(secret)` (or your own function); `rawBody` is always passed too |
| `request` in the handler                       | `c.req.raw`                                                                    |
| `useHonoWebhooks(app)`                         | `app.route('/webhooks', createWebhooks(webhooks, { onEvent }))`               |
| Built-in OTel span, logger, `recordWebhookCall` | `around` for the span, `onEvent` for logs and storage (see [Recipes](#recipes)) |
| `HEAD` / custom methods in `method`            | `GET` routes answer `HEAD` automatically                                      |
| Response schema mismatch recorded as 500       | Recorded as `event.validation` with the real status                           |
| Malformed JSON without a schema → `body: null` | `400 Invalid body`. Use `bodyType: 'text'` to accept anything                 |

## Releasing

Releases are automated with [Release Please](https://github.com/googleapis/release-please)
and npm trusted publishing:

1. PRs are squash-merged with a [conventional](https://www.conventionalcommits.org)
   title. `fix:` releases a patch, `feat:` a minor, `feat!:` or a
   `BREAKING CHANGE:` footer a major. `chore:`, `ci:`, `docs:`, `refactor:`
   and `test:` don't release.
2. Each push to `main` opens or updates a release PR with the next version and
   the changelog.
3. Merging the release PR tags the version, creates the GitHub release and
   publishes to npm with provenance.

## License

MIT
