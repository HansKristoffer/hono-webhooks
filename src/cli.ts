#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
	createWebhooks,
	describeWebhooks,
	type Webhook,
	type WebhooksApp
} from './index'
import { github, type SignatureScheme, shopify, stripe } from './signatures'

const schemes: Record<string, SignatureScheme<any, any>> = {
	github,
	shopify,
	stripe
}

const HELP = `Usage: hono-webhooks <module> <command> [options]

<module> exports a createWebhooks() app or an array of webhooks, as default
or named export.

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
  -s, --sign <scheme>       Sign the body: ${Object.keys(schemes).join(', ')}
  -e, --secret-env <name>   Environment variable holding the signing secret

Examples:
  hono-webhooks ./src/webhooks.ts list
  hono-webhooks ./src/webhooks.ts schema /orders/:id
  hono-webhooks ./src/webhooks.ts test POST /orders/42 -b '{"total":10}'
  hono-webhooks ./src/webhooks.ts test POST /shopify -b '{"id":1}' \\
    -r ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET
`

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		help: { type: 'boolean', short: 'h' },
		preload: { type: 'string', short: 'r', multiple: true },
		body: { type: 'string', short: 'b' },
		query: { type: 'string', short: 'q' },
		header: { type: 'string', short: 'H', multiple: true },
		sign: { type: 'string', short: 's' },
		'secret-env': { type: 'string', short: 'e' }
	}
})

const [modulePath, command, ...args] = positionals

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

/** A file path relative to the cwd, or a package name. */
const importModule = (specifier: string) =>
	import(
		existsSync(resolve(specifier))
			? pathToFileURL(resolve(specifier)).href
			: specifier
	)

function isWebhooksApp(value: unknown): value is WebhooksApp {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as WebhooksApp).webhooks) &&
		typeof (value as WebhooksApp).request === 'function'
	)
}

function isWebhookArray(value: unknown): value is Webhook[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every(
			(item) =>
				typeof item?.config?.path === 'string' &&
				typeof item?.handler === 'function'
		)
	)
}

async function loadApp(path: string): Promise<WebhooksApp> {
	const mod = await importModule(path)
	const candidates = [mod.default, ...Object.values(mod)]
	const app = candidates.find(isWebhooksApp)
	if (app) return app
	const webhooks = candidates.find(isWebhookArray)
	if (webhooks) return createWebhooks(webhooks)
	return fail(
		`${path} exports neither a createWebhooks() app nor an array of webhooks`
	)
}

async function signatureHeaders(rawBody: string) {
	if (!values.sign) return {}
	const scheme =
		schemes[values.sign] ??
		fail(
			`Unknown scheme "${values.sign}", use one of: ${Object.keys(schemes).join(', ')}`
		)
	const name = values['secret-env'] ?? fail('--sign needs --secret-env <name>')
	const secret = process.env[name] ?? fail(`${name} is not set`)
	return scheme.sign(rawBody, secret)
}

async function main() {
	if (values.help || !modulePath || !command) {
		console.log(HELP)
		return
	}
	for (const preload of values.preload ?? []) await importModule(preload)
	const app = await loadApp(modulePath)

	if (command === 'list') {
		for (const { config } of app.webhooks) {
			const validates = [
				...(['params', 'query', 'headers', 'body'] as const).filter(
					(key) => config[key]
				),
				...(config.verify ? ['signature'] : [])
			].join(', ')
			console.log(
				`${config.method.padEnd(7)} ${config.path}${config.description ? `  ${config.description}` : ''}`
			)
			if (validates) console.log(`        validates ${validates}`)
		}
		return
	}

	if (command === 'schema') {
		const [path] = args
		const descriptions = describeWebhooks(app)
		const indexes = app.webhooks.flatMap((w, i) =>
			w.config.path === path ? [i] : []
		)
		if (!indexes.length) fail(`No webhook at ${path}`)
		for (const i of indexes) {
			const { config } = app.webhooks[i]!
			console.log(`${config.method} ${config.path}`)
			for (const part of [
				'params',
				'query',
				'headers',
				'body',
				'response'
			] as const) {
				if (!config[part]) continue
				const schema = descriptions[i]!.jsonSchema[part]
				console.log(
					`  ${part}: ${schema ? JSON.stringify(schema, null, 2).replaceAll('\n', '\n  ') : '(no JSON Schema support)'}`
				)
			}
		}
		return
	}

	if (command === 'test') {
		const [method, path] = args
		if (!method || !path) fail('Usage: test <method> <path>')
		const headers = new Headers()
		for (const header of values.header ?? []) {
			const at = header.indexOf(':')
			if (at < 1) fail(`Header must look like "name: value", got "${header}"`)
			headers.set(header.slice(0, at).trim(), header.slice(at + 1).trim())
		}
		if (values.body && !headers.has('content-type')) {
			try {
				JSON.parse(values.body)
				headers.set('content-type', 'application/json')
			} catch {
				headers.set('content-type', 'text/plain')
			}
		}
		for (const [name, value] of Object.entries(
			await signatureHeaders(values.body ?? '')
		)) {
			headers.set(name, value)
		}

		const url = `${path.startsWith('/') ? path : `/${path}`}${values.query ? `?${values.query}` : ''}`
		const start = performance.now()
		const res = await app.request(url, {
			method: method.toUpperCase(),
			headers,
			body: values.body
		})
		const text = await res.text()
		let body = text
		try {
			body = JSON.stringify(JSON.parse(text), null, 2)
		} catch {}
		console.log(`${res.status} (${(performance.now() - start).toFixed(1)}ms)`)
		if (body) console.log(body)
		if (!res.ok) process.exitCode = 1
		return
	}

	fail(`Unknown command: ${command}\n\n${HELP}`)
}

await main()
