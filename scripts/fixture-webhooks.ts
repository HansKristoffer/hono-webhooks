// Loaded by the CLI smoke test in CI: runs the built package under Node.
import { z } from 'zod'
import { defineWebhook } from '../dist/index.js'
import { shopify } from '../dist/signatures.js'

// A plain array: the CLI builds the app itself.
export const webhooks = [
	defineWebhook(
		{ method: 'GET', path: '/health', description: 'Liveness' },
		() => ({ ok: true })
	),
	defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id',
			verify: shopify.verify(() => process.env.FIXTURE_SECRET ?? ''),
			body: z.object({ total: z.number() })
		},
		({ params, body }) => ({ id: params.id, total: body.total })
	)
]
