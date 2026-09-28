#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import type { WebhooksApp } from './index'

const HELP = `Usage: hono-webhooks <module> <command> [options]

<module> exports the result of createWebhooks(), as default or named export.

Commands:
  list                      List the webhooks
  schema <path>             Print the JSON Schemas of the webhooks at <path>
  test <method> <path>      Send a request through the webhooks app

Options for test:
  -b, --body <text>         Request body (JSON sets content-type: application/json)
  -q, --query <params>      Query string, e.g. "a=1&b=2"
  -H, --header <k: v>       Request header, repeatable

Examples:
  hono-webhooks ./src/webhooks.ts list
  hono-webhooks ./src/webhooks.ts schema /orders/:id
  hono-webhooks ./src/webhooks.ts test POST /orders/42 -b '{"total":10}'
`

const { values, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		help: { type: 'boolean', short: 'h' },
		body: { type: 'string', short: 'b' },
		query: { type: 'string', short: 'q' },
		header: { type: 'string', short: 'H', multiple: true }
	}
})

const [modulePath, command, ...args] = positionals

function fail(message: string): never {
	console.error(message)
	process.exit(1)
}

function isWebhooksApp(value: unknown): value is WebhooksApp {
	return (
		typeof value === 'object' &&
		value !== null &&
		Array.isArray((value as WebhooksApp).webhooks) &&
		typeof (value as WebhooksApp).request === 'function'
	)
}

async function loadApp(path: string) {
	const mod = await import(pathToFileURL(resolve(path)).href)
	const app = [mod.default, ...Object.values(mod)].find(isWebhooksApp)
	return app ?? fail(`${path} does not export a createWebhooks() app`)
}

function jsonSchemaOf(schema: unknown) {
	const props = (schema as Partial<StandardJSONSchemaV1>)['~standard']
	try {
		return props?.jsonSchema?.input({ target: 'draft-2020-12' })
	} catch {
		return undefined
	}
}

async function main() {
	if (values.help || !modulePath || !command) {
		console.log(HELP)
		return
	}
	const app = await loadApp(modulePath)

	if (command === 'list') {
		for (const { config } of app.webhooks) {
			const validates = (['params', 'query', 'headers', 'body'] as const)
				.filter((key) => config[key])
				.join(', ')
			console.log(
				`${config.method.padEnd(7)} ${config.path}${config.description ? `  ${config.description}` : ''}`
			)
			if (validates) console.log(`        validates ${validates}`)
		}
		return
	}

	if (command === 'schema') {
		const [path] = args
		const matches = app.webhooks.filter((w) => w.config.path === path)
		if (!matches.length) fail(`No webhook at ${path}`)
		for (const { config } of matches) {
			console.log(`${config.method} ${config.path}`)
			for (const key of [
				'params',
				'query',
				'headers',
				'body',
				'response'
			] as const) {
				if (!config[key]) continue
				const json = jsonSchemaOf(config[key])
				console.log(
					`  ${key}: ${json ? JSON.stringify(json, null, 2).replaceAll('\n', '\n  ') : '(no JSON Schema support)'}`
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
