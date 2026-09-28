// Loaded by the CLI smoke test in CI: runs the built package under Node.
import { z } from 'zod'
import { createWebhooks, defineWebhook } from '../dist/index.js'

export const webhooks = createWebhooks([
	defineWebhook(
		{ method: 'GET', path: '/health', description: 'Liveness' },
		() => ({
			ok: true
		})
	),
	defineWebhook(
		{
			method: 'POST',
			path: '/orders/:id',
			body: z.object({ total: z.number() })
		},
		({ params, body }) => ({ id: params.id, total: body.total })
	)
])
