# hono-webhooks

Type-safe webhook endpoints for [Hono](https://hono.dev). Define each webhook
once with its schemas, get typed `params`, `query`, `headers` and `body` in the
handler, and mount them all as one Hono app. You can use any
[Standard Schema](https://standardschema.dev) library: Zod, Valibot, ArkType
and others.

```ts
import { Hono } from 'hono'
import { createWebhooks, defineWebhook } from 'hono-webhooks'
import { z } from 'zod'

const orderPaid = defineWebhook(
	{
		method: 'POST',
		path: '/shop/orders/:orderId/paid',
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
- **Signed webhooks built in.** `verify` checks the signature on the raw
  body before anything is parsed, with ready-made verifiers and signers for
  Stripe, GitHub, Shopify and any HMAC scheme. `rawBody` is always passed to
  the handler too.
- **Plain Hono.** `createWebhooks` returns a Hono app. Handlers get the Hono
  context `c`, Hono middleware works, `HTTPException` works, and it runs on
  every runtime Hono supports.
- **One hook for observability.** `onEvent` fires once per request with the
  route, status, duration, validated input, response and error. Use it for
  logs, metrics, traces or an audit table.
- **A CLI** to list webhooks, print their JSON Schemas and send test requests.

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
- [Testing](#testing)
- [CLI](#cli)
- [API reference](#api-reference)
- [Migrating from `createHttpRoute`](#migrating-from-createhttproute)
- [Releasing](#releasing)

## Install

```bash
bun add hono-webhooks hono
# plus the schema library you use
bun add zod
```

`hono` (4.6 or newer) is a peer dependency. The package is ESM only. Bun
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
		params: v.object({ id: v.pipe(v.string(), v.transform(Number)) }),
		query: v.object({ dryRun: v.optional(v.picklist(['true', 'false'])) }),
		headers: v.object({ 'x-api-key': v.string() }),
		body: v.object({ name: v.string(), price: v.number() }),
		response: v.object({ id: v.number(), updated: v.boolean() })
	},
	async ({ params, query, headers, body }) => {
		// params.id: number, body.price: number, headers['x-api-key']: string
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
| `verify`      | `({ c, rawBody, headers }) => boolean \| Promise<boolean>`     | Checks the signature before the body is parsed (see [Signature verification](#signature-verification)). |
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

`verify` runs after the params, query and headers are validated but **before
the body is parsed**, on the raw body. A request with a bad signature never
reaches JSON parsing or the body schema, so signed webhooks can use `body`
like any other webhook:

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

When `verify` returns `false`, the answer is
`401 { error: 'Invalid signature', issues: [...] }` and `onEvent` gets
`validation.target: 'signature'`.

`hono-webhooks/signatures` has a verifier and a matching signer per provider:

| Scheme                                  | Header                                  | Signed content      |
| --------------------------------------- | --------------------------------------- | ------------------- |
| `github`                                | `x-hub-signature-256: sha256=<hex>`     | body                |
| `shopify`                               | `x-shopify-hmac-sha256: <base64>`       | body                |
| `stripe`                                | `stripe-signature: t=<unix>,v1=<hex>`   | `<t>.<body>`        |
| `hmac({ header, encoding, prefix?, hash? })` | any header, hex or base64, SHA-1/256/512 | body          |

- `scheme.verify(secret)` gives a `verify` function. `secret` is a string or
  `(c) => string | Promise<string>`, so it can come from `c.env`. An empty
  secret throws (a 500), instead of silently accepting or rejecting everything.
- `stripe.verify(secret, { toleranceSeconds })` also rejects timestamps more
  than 300 seconds away by default, and accepts any matching `v1` so secret
  rotation works.
- `scheme.sign(rawBody, secret)` returns the headers the provider would send,
  for tests and the CLI.
- Signatures are compared with `crypto.subtle.verify`, which runs in constant
  time. Everything uses Web Crypto, so it works on every runtime.

For another provider, write the function yourself:

```ts
verify: async ({ c, rawBody, headers }) =>
	headers['x-token'] === c.env.WEBHOOK_TOKEN
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
defineWebhook({ method: 'POST', path: '/ping' }, ({ c }) => {
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
| Hono's `HTTPException`                               | Its status and `{ error: message }`, or its `res`  |
| anything else                                        | `500 { error: 'Internal Server Error' }`, and the error is logged with `console.error` |

`issues` is the Standard Schema issue list: `{ message, path? }[]`.

Throw an `HTTPException` from a handler to answer with another status:

```ts
import { HTTPException } from 'hono/http-exception'

defineWebhook({ method: 'POST', path: '/orders/:id' }, async ({ params }) => {
	const order = await findOrder(params.id)
	if (!order) throw new HTTPException(404, { message: 'Unknown order' })
	// ...
})
```

`onError` changes the response for any error, including 404 and 405. Return a
`Response`, or nothing to fall back to the default. `console.error` is only
called when you don't pass `onError`.

```ts
import { WebhookValidationError } from 'hono-webhooks'

createWebhooks(webhooks, {
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
			path: event.path, // '/webhooks/orders/42'
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
| `method`, `path`                           | Request method and path                                                                              |
| `status`, `durationMs`                     | Response status and time spent in the webhooks app                                                   |
| `params`, `query`, `headers`, `body`, `rawBody` | Each is set once it passed validation, so a request that fails on `body` still reports `params` |
| `response`                                 | What the handler returned, unless it returned a `Response`                                           |
| `error`                                    | Whatever was thrown                                                                                  |
| `validation`                               | `{ target, issues }` when a request part or the response failed its schema                           |

`onEvent` isn't awaited, so a slow database write doesn't delay the response.
When it returns a promise, the promise is passed to
`c.executionCtx.waitUntil()` on runtimes that have one (Cloudflare Workers,
Vercel Edge), and a rejection is logged instead of crashing the request.

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

### Twilio form posts

```ts
defineWebhook(
	{
		method: 'POST',
		path: '/twilio/sms',
		body: z.object({ From: z.string(), Body: z.string() })
	},
	({ c, body }) =>
		c.body(`<Response><Message>Got "${body.Body}"</Message></Response>`, 200, {
			'content-type': 'text/xml'
		})
)
```

### Storing every call

```ts
createWebhooks(webhooks, {
	onEvent: (e) =>
		db.insert(webhookCalls).values({
			route: e.route ?? null,
			path: e.path,
			method: e.method,
			statusCode: e.status,
			durationMs: Math.round(e.durationMs),
			body: e.body ?? null,
			responseBody: e.response ?? null,
			errorMessage: e.error instanceof Error ? e.error.message : null,
			validationError: e.validation ?? null,
			ipAddress: e.c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? null,
			userAgent: e.c.req.header('user-agent') ?? null
		})
})
```

### OpenTelemetry metrics

```ts
import { metrics } from '@opentelemetry/api'

const duration = metrics.getMeter('webhooks').createHistogram('webhook.duration', { unit: 'ms' })

createWebhooks(webhooks, {
	onEvent: (e) =>
		duration.record(e.durationMs, {
			'http.route': e.route ?? 'unmatched',
			'http.request.method': e.method,
			'http.response.status_code': e.status
		})
})
```

For traces, add a tracing middleware (for example
[`@hono/otel`](https://github.com/honojs/middleware/tree/main/packages/otel))
on the parent app before `app.route('/webhooks', ...)`.

### Skipping noise

`onEvent` fires for everything, so filter in the hook:

```ts
onEvent(e) {
	if (e.route === '/health') return
	log(e)
}
```

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

## Testing

The webhooks app is a Hono app, so `request()` runs the full pipeline:
routing, validation, handler and response.

```ts
import { expect, test } from 'bun:test'
import { webhooks } from './webhooks'

test('rejects an order without a total', async () => {
	const res = await webhooks.request('/orders/42', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({})
	})
	expect(res.status).toBe(400)
})
```

Pass bindings as the third argument: `webhooks.request(path, init, env)`.

## CLI

```text
hono-webhooks <module> <command> [options]

Commands:
  list                      List the webhooks
  schema <path>             Print the JSON Schemas of the webhooks at <path>
  test <method> <path>      Send a request through the webhooks app

Options for test:
  -b, --body <text>         Request body (JSON sets content-type: application/json)
  -q, --query <params>      Query string, e.g. "a=1&b=2"
  -H, --header <k: v>       Request header, repeatable
```

`<module>` is a file that exports the `createWebhooks()` result, as default or
as any named export.

```bash
bunx hono-webhooks ./src/webhooks/index.ts list
bunx hono-webhooks ./src/webhooks/index.ts schema /orders/:id
bunx hono-webhooks ./src/webhooks/index.ts test POST /orders/42 -b '{"total":10}' -H 'x-api-key: dev'
```

- `test` sends a real request through the webhooks app (without the parent
  app's middleware) and exits with code 1 on a 4xx or 5xx response.
- `schema` prints JSON Schema for libraries that implement
  [Standard JSON Schema](https://standardschema.dev) (Zod 4.2+ does).
- The CLI imports your TypeScript file. That works under Bun, and under Node
  22.18+ which strips types natively. If the module needs setup first (loading
  secrets, for example), preload it: `bun --preload ./src/secrets.ts x hono-webhooks ...`.

## API reference

```ts
import {
	defineWebhook, // (config, handler) => Webhook
	createWebhooks, // (webhooks, options?) => WebhooksApp  (a Hono app + .webhooks)
	createWebhookFactory, // <E extends Env>() => { defineWebhook, createWebhooks }
	WebhookValidationError // extends HTTPException; .target, .issues
} from 'hono-webhooks'

import {
	github,
	shopify,
	stripe, // each: .verify(secret, options?) and .sign(rawBody, secret, options?)
	hmac // (options) => a scheme like the ones above
} from 'hono-webhooks/signatures'

import type {
	Webhook,
	WebhookConfig,
	WebhookInput,
	WebhookResult,
	WebhookEvent,
	WebhooksOptions,
	WebhooksApp,
	Verify,
	VerifyInput,
	WebhookMethod,
	BodyType,
	ValidationTarget,
	PathParams,
	StandardSchemaV1
} from 'hono-webhooks'
```

Use `Webhook` to type a list: `const all: Webhook<AppEnv>[] = [a, b]`.

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
| Built-in OTel span, logger, `recordWebhookCall` | `onEvent` (see [Recipes](#recipes)) and tracing middleware                    |
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
