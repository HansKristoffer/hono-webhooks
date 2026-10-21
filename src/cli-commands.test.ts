import { expect, test } from 'bun:test'
import { z } from 'zod'
import { cli } from './cli-commands'
import { defineWebhook } from './index'
import { shopify } from './signatures'

// The CLI loads this file as its <module>: an import of an already loaded
// module returns it from the cache, so these exports are the fixture.
export const webhooks = [
	defineWebhook(
		{ method: 'GET', path: '/health', description: 'Liveness' },
		() => ({ ok: true })
	),
	defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id',
			verify: shopify.verify(() => 'test-secret'),
			body: z.object({ total: z.number() })
		},
		({ params, body }) => ({ id: params.id, total: body.total })
	)
]

async function run(...argv: string[]) {
	let stdout = ''
	let stderr = ''
	const code = await cli.run(argv, {
		stdout: { write: (text) => (stdout += text) },
		stderr: { write: (text) => (stderr += text) },
		env: { SECRET: 'test-secret' }
	})
	return { code, stdout: stdout.replace(/\(\d+\.\dms\)/, '(1.0ms)'), stderr }
}

const self = import.meta.path

test('help', async () => {
	const help = await run('--help')
	expect(help).toEqual({
		code: 0,
		stdout: `hono-webhooks
<module> exports a createWebhooks() app or an array of webhooks, as default
or named export.

Usage: hono-webhooks <module> <command> [options]

Arguments:
  <module>  Module with the webhooks

Commands:
  list                   List the webhooks
  schema                 Print the JSON Schemas of the webhooks at <path>
  test                   Send a request through the webhooks app
  completion <bash|zsh>  Print a shell completion script

Options:
  -r, --preload <string>...  Import a module first (e.g. to load secrets), repeatable
  -h, --help                 Show help

Run "hono-webhooks <module> <command> --help" for a command's options.
`,
		stderr: ''
	})
	// No module or no command prints the same help and succeeds.
	expect(await run()).toEqual(help)
	expect(await run(self)).toEqual(help)
})

test('list --help', async () => {
	expect(await run(self, 'list', '--help')).toEqual({
		code: 0,
		stdout: `Usage: hono-webhooks <module> list [options]

List the webhooks

Arguments:
  <module>  Module with the webhooks

Options:
  -h, --help  Show help

Global options:
  -r, --preload <string>...  Import a module first (e.g. to load secrets), repeatable

Examples:
  hono-webhooks ./src/webhooks.ts list
`,
		stderr: ''
	})
})

test('schema --help', async () => {
	expect(await run(self, 'schema', '--help')).toEqual({
		code: 0,
		stdout: `Usage: hono-webhooks <module> schema <path> [options]

Print the JSON Schemas of the webhooks at <path>

Arguments:
  <module>  Module with the webhooks
  <path>    Webhook path

Options:
  -h, --help  Show help

Global options:
  -r, --preload <string>...  Import a module first (e.g. to load secrets), repeatable

Examples:
  hono-webhooks ./src/webhooks.ts schema /orders/:id
`,
		stderr: ''
	})
})

test('test --help', async () => {
	expect(await run(self, 'test', '--help')).toEqual({
		code: 0,
		stdout: `Usage: hono-webhooks <module> test <method> <path> [options]

Send a request through the webhooks app

Arguments:
  <module>  Module with the webhooks
  <method>  HTTP method, e.g. POST
  <path>    Request path

Options:
  -b, --body <string>        Request body (JSON sets content-type: application/json)
  -q, --query <string>       Query string, e.g. "a=1&b=2"
  -H, --header <string>...   Request header "name: value", repeatable
  -s, --sign <string>        Sign the body: github, shopify, stripe, svix
  -e, --secret-env <string>  Environment variable holding the signing secret
  -h, --help                 Show help

Global options:
  -r, --preload <string>...  Import a module first (e.g. to load secrets), repeatable

Examples:
  hono-webhooks ./src/webhooks.ts test POST /orders/42 -b '{"total":10}'
  hono-webhooks ./src/webhooks.ts test POST /shopify -b '{"id":1}' \\
    -r ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET
`,
		stderr: ''
	})
})

test('list', async () => {
	expect(await run(self, 'list')).toEqual({
		code: 0,
		stdout: `GET     /health  Liveness
POST    /orders/:id
        validates body, signature
`,
		stderr: ''
	})
})

test('schema', async () => {
	expect(await run(self, 'schema', '/orders/:id')).toEqual({
		code: 0,
		stdout: `POST /orders/:id
  body: {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "properties": {
      "total": {
        "type": "number"
      }
    },
    "required": [
      "total"
    ]
  }
`,
		stderr: ''
	})
	expect(await run(self, 'schema', '/nope')).toEqual({
		code: 1,
		stdout: '',
		stderr: 'No webhook at /nope\n'
	})
})

test('test', async () => {
	const argv = [self, 'test', 'POST', '/orders/1', '-b', '{"total":1}']
	expect(
		await run(
			...argv,
			'-r',
			self,
			'--sign',
			'shopify',
			'--secret-env',
			'SECRET'
		)
	).toEqual({
		code: 0,
		stdout: `200 (1.0ms)
{
  "id": "1",
  "total": 1
}
`,
		stderr: ''
	})
	// Unsigned, so the signature check fails and the CLI exits 1.
	expect((await run(...argv)).code).toBe(1)
	expect(await run(...argv, '--sign', 'shopify')).toEqual({
		code: 1,
		stdout: '',
		stderr: '--sign needs --secret-env <name>\n'
	})
})
