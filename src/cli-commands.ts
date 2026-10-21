import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
	CliError,
	CliUsageError,
	type CommandContext,
	defineCli,
	defineCommand
} from 'hanzio/cli'
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
 * exit with its code.
 */
function rerunUnderBun(error: unknown): never {
	const code = (error as { code?: string }).code
	if (process.versions.bun || !code || !BUN_ONLY_ERRORS.has(code)) throw error
	process.stderr.write(`Node can't load the module (${code}), trying Bun\n`)
	const run = spawnSync('bun', process.argv.slice(1), { stdio: 'inherit' })
	if (run.error) {
		throw new CliError(
			'Bun is not installed either. Run the CLI with a runtime that can load your code, e.g. bunx --bun hono-webhooks ...'
		)
	}
	process.exit(run.status ?? 1)
}

type Ctx = CommandContext<WebhooksApp>

const print = (ctx: Ctx, line: string) => ctx.stdout.write(`${line}\n`)

const list = defineCommand({
	description: 'List the webhooks',
	examples: ['hono-webhooks ./src/webhooks.ts list'],
	run(_, ctx: Ctx) {
		for (const { config } of ctx.context.webhooks) {
			const validates = [
				...(['params', 'query', 'headers', 'body'] as const).filter(
					(key) => config[key]
				),
				...(config.verify ? ['signature'] : [])
			].join(', ')
			print(
				ctx,
				`${config.method.padEnd(7)} ${config.path}${config.description ? `  ${config.description}` : ''}`
			)
			if (validates) print(ctx, `        validates ${validates}`)
		}
	}
})

const schema = defineCommand({
	description: 'Print the JSON Schemas of the webhooks at <path>',
	examples: ['hono-webhooks ./src/webhooks.ts schema /orders/:id'],
	input: z.object({
		path: z.string().meta({ positional: true, description: 'Webhook path' })
	}),
	run({ path }, ctx: Ctx) {
		const app = ctx.context
		const descriptions = describeWebhooks(app)
		const indexes = app.webhooks.flatMap((w, i) =>
			w.config.path === path ? [i] : []
		)
		if (!indexes.length) throw new CliError(`No webhook at ${path}`)
		for (const i of indexes) {
			const { config } = app.webhooks[i]!
			print(ctx, `${config.method} ${config.path}`)
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
					ctx,
					`  ${part}: ${schema ? JSON.stringify(schema, null, 2).replaceAll('\n', '\n  ') : '(no JSON Schema support)'}`
				)
			}
		}
	}
})

const testCommand = defineCommand({
	description: 'Send a request through the webhooks app',
	examples: [
		`hono-webhooks ./src/webhooks.ts test POST /orders/42 -b '{"total":10}'`,
		`hono-webhooks ./src/webhooks.ts test POST /shopify -b '{"id":1}' \\
    -r ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET`
	],
	input: z.object({
		method: z
			.string()
			.meta({ positional: true, description: 'HTTP method, e.g. POST' }),
		path: z.string().meta({ positional: true, description: 'Request path' }),
		body: z.string().optional().meta({
			alias: 'b',
			description: 'Request body (JSON sets content-type: application/json)'
		}),
		query: z.string().optional().meta({
			alias: 'q',
			description: 'Query string, e.g. "a=1&b=2"'
		}),
		header: z.array(z.string()).meta({
			alias: 'H',
			description: 'Request header "name: value", repeatable'
		}),
		sign: z
			.string()
			.optional()
			.meta({
				alias: 's',
				description: `Sign the body: ${Object.keys(schemes).join(', ')}`
			}),
		secretEnv: z.string().optional().meta({
			alias: 'e',
			description: 'Environment variable holding the signing secret'
		})
	}),
	async run(input, ctx: Ctx) {
		const { method, path } = input
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
		const res = await ctx.context.request(url, {
			method: method.toUpperCase(),
			headers,
			body: input.body
		})
		const text = await res.text()
		let body = text
		try {
			body = JSON.stringify(JSON.parse(text), null, 2)
		} catch {}
		print(ctx, `${res.status} (${(performance.now() - start).toFixed(1)}ms)`)
		if (body) print(ctx, body)
		if (!res.ok) ctx.exitCode = 1
	}
})

export const cli = defineCli({
	name: 'hono-webhooks',
	description: `<module> exports a createWebhooks() app or an array of webhooks, as default
or named export.`,
	globals: z.object({
		module: z
			.string()
			.meta({ positional: true, description: 'Module with the webhooks' }),
		preload: z.array(z.string()).meta({
			alias: 'r',
			description: 'Import a module first (e.g. to load secrets), repeatable'
		})
	}),
	async context({ module, preload }) {
		try {
			for (const specifier of preload) await importModule(specifier)
			return await loadApp(module)
		} catch (error) {
			return rerunUnderBun(error)
		}
	},
	commands: { list, schema, test: testCommand },
	onError(error, io) {
		// No module or command: print help and succeed, as `--help` does.
		if (error instanceof CliUsageError && error.kind === 'missing-command') {
			io.stdout.write(error.help)
			return 0
		}
		// Bad arguments exit 1 like every other failure.
		const code = io.print()
		return code === 2 ? 1 : code
	}
})
