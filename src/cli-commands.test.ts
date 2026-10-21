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
	expect(help.code).toBe(0)
	expect(
		help.stdout
	).toBe(`Usage: hono-webhooks [module] [command] <args...> [options]

<module> exports a createWebhooks() app or an array of webhooks, as default
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
    -r ./src/secrets.ts --sign shopify --secret-env SHOPIFY_WEBHOOK_SECRET

Arguments:
  [module]   Module with the webhooks
  [command]  list, schema or test
  <args...>  schema: <path>, test: <method> <path>

Options:
  -r, --preload <string>...  Import a module first (e.g. to load secrets), repeatable
  -b, --body <string>        test: request body (JSON sets content-type: application/json)
  -q, --query <string>       test: query string, e.g. "a=1&b=2"
  -H, --header <string>...   test: request header "name: value", repeatable
  -s, --sign <string>        test: sign the body with github, shopify, stripe, svix
  -e, --secret-env <string>  test: environment variable holding the signing secret
  -h, --help                 Show help
`)
	// No module or command prints the same help and succeeds.
	expect(await run(self)).toEqual(help)
	expect(await run(self, 'list', '--help')).toEqual(help)
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
