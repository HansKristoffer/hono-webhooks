import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CliError, type CliWriter, defineCli, defineCommand } from 'hanzio/cli'
import { z } from 'zod'
import {
	createWebhooks,
	describeWebhooks,
	type Webhook,
	type WebhooksApp
} from './index'
import {
	github,
	type SignatureScheme,
	shopify,
	stripe,
	svix
} from './signatures'

const schemes: Record<string, SignatureScheme<any, any>> = {
	github,
	shopify,
	stripe,
	svix
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
	throw new CliError(
		`${path} exports neither a createWebhooks() app nor an array of webhooks`
	)
}

/** Errors Node gives for TypeScript it can't load but Bun can. */
const BUN_ONLY_ERRORS = new Set([
	'ERR_MODULE_NOT_FOUND',
	'ERR_UNKNOWN_FILE_EXTENSION',
	'ERR_UNSUPPORTED_DIR_IMPORT',
	'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX',
	'ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'
])

/**
 * Under Node, a Bun project's TypeScript (extensionless imports, for one)
 * fails to load. Rerun the same command under Bun when it is installed and
 * return its exit code.
 */
function rerunUnderBun(error: unknown, stderr: CliWriter): number {
	const code = (error as { code?: string }).code
	if (process.versions.bun || !code || !BUN_ONLY_ERRORS.has(code)) throw error
	stderr.write(`Node can't load the module (${code}), trying Bun\n`)
	const run = spawnSync('bun', process.argv.slice(1), { stdio: 'inherit' })
	if (run.error) {
		throw new CliError(
			'Bun is not installed either. Run the CLI with a runtime that can load your code, e.g. bunx --bun hono-webhooks ...'
		)
	}
	return run.status ?? 1
}

// One command with <module> <command> positionals: hanzio/cli reads command
// names first, so it can't put the module before them.
export const cli = defineCli({
	name: 'hono-webhooks',
	commands: defineCommand({
		description: `<module> exports a createWebhooks() app or an array of webhooks, as default
or named export.

Commands:
  list                  List the webhooks
  schema <path>         Print the JSON Schemas of the webhooks at <path>
  test <method> <path>  Send a request through the webhooks app

Examples:
  hono-webhooks ./src/webhooks.ts list
  hono-webhooks ./src/webhooks.ts schema /orders/:id
  hono-webhooks ./src/webhooks.ts test POST /orders/42 -b '{"total":10}'
  hono-webhooks ./src/webhooks.ts test POST /shopify -b '{"id":1}' \\
    -r ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET`,
		input: z.object({
			module: z
				.string()
				.optional()
				.meta({ positional: true, description: 'Module with the webhooks' }),
			command: z
				.enum(['list', 'schema', 'test'])
				.optional()
				.meta({ positional: true, description: 'list, schema or test' }),
			args: z.array(z.string()).meta({
				positional: true,
				description: 'schema: <path>, test: <method> <path>'
			}),
			preload: z.array(z.string()).meta({
				alias: 'r',
				description: 'Import a module first (e.g. to load secrets), repeatable'
			}),
			body: z.string().optional().meta({
				alias: 'b',
				description:
					'test: request body (JSON sets content-type: application/json)'
			}),
			query: z.string().optional().meta({
				alias: 'q',
				description: 'test: query string, e.g. "a=1&b=2"'
			}),
			header: z.array(z.string()).meta({
				alias: 'H',
				description: 'test: request header "name: value", repeatable'
			}),
			sign: z
				.string()
				.optional()
				.meta({
					alias: 's',
					description: `test: sign the body with ${Object.keys(schemes).join(', ')}`
				}),
			secretEnv: z.string().optional().meta({
				alias: 'e',
				description: 'test: environment variable holding the signing secret'
			})
		}),
		async run(input, ctx) {
			const print = (line: string) => ctx.stdout.write(`${line}\n`)
			if (!input.module || !input.command) {
				ctx.exitCode = await cli.run(['--help'], ctx)
				return
			}
			let app: WebhooksApp
			try {
				for (const preload of input.preload) await importModule(preload)
				app = await loadApp(input.module)
			} catch (error) {
				ctx.exitCode = rerunUnderBun(error, ctx.stderr)
				return
			}

			if (input.command === 'list') {
				for (const { config } of app.webhooks) {
					const validates = [
						...(['params', 'query', 'headers', 'body'] as const).filter(
							(key) => config[key]
						),
						...(config.verify ? ['signature'] : [])
					].join(', ')
					print(
						`${config.method.padEnd(7)} ${config.path}${config.description ? `  ${config.description}` : ''}`
					)
					if (validates) print(`        validates ${validates}`)
				}
				return
			}

			if (input.command === 'schema') {
				const [path] = input.args
				const descriptions = describeWebhooks(app)
				const indexes = app.webhooks.flatMap((w, i) =>
					w.config.path === path ? [i] : []
				)
				if (!indexes.length) throw new CliError(`No webhook at ${path}`)
				for (const i of indexes) {
					const { config } = app.webhooks[i]!
					print(`${config.method} ${config.path}`)
					for (const part of [
						'params',
						'query',
						'headers',
						'body',
						'response'
					] as const) {
						if (!config[part]) continue
						const schema = descriptions[i]!.jsonSchema[part]
						print(
							`  ${part}: ${schema ? JSON.stringify(schema, null, 2).replaceAll('\n', '\n  ') : '(no JSON Schema support)'}`
						)
					}
				}
				return
			}

			const [method, path] = input.args
			if (!method || !path) throw new CliError('Usage: test <method> <path>')
			const headers = new Headers()
			for (const header of input.header) {
				const at = header.indexOf(':')
				if (at < 1) {
					throw new CliError(
						`Header must look like "name: value", got "${header}"`
					)
				}
				headers.set(header.slice(0, at).trim(), header.slice(at + 1).trim())
			}
			if (input.body && !headers.has('content-type')) {
				try {
					JSON.parse(input.body)
					headers.set('content-type', 'application/json')
				} catch {
					headers.set('content-type', 'text/plain')
				}
			}
			if (input.sign) {
				const scheme = schemes[input.sign]
				if (!scheme) {
					throw new CliError(
						`Unknown scheme "${input.sign}", use one of: ${Object.keys(schemes).join(', ')}`
					)
				}
				const name = input.secretEnv
				if (!name) throw new CliError('--sign needs --secret-env <name>')
				const secret = ctx.env[name]
				if (secret === undefined) throw new CliError(`${name} is not set`)
				for (const [key, value] of Object.entries(
					await scheme.sign(input.body ?? '', secret)
				)) {
					headers.set(key, value)
				}
			}

			const url = `${path.startsWith('/') ? path : `/${path}`}${input.query ? `?${input.query}` : ''}`
			const start = performance.now()
			const res = await app.request(url, {
				method: method.toUpperCase(),
				headers,
				body: input.body
			})
			const text = await res.text()
			let body = text
			try {
				body = JSON.stringify(JSON.parse(text), null, 2)
			} catch {}
			print(`${res.status} (${(performance.now() - start).toFixed(1)}ms)`)
			if (body) print(body)
			if (!res.ok) ctx.exitCode = 1
		}
	})
})
