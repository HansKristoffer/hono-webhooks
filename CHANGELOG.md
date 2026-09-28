# Changelog

## [0.2.0](https://github.com/HansKristoffer/hono-webhooks/compare/v0.1.1...v0.2.0) (2026-09-28)


### ⚠ BREAKING CHANGES

* event.path is relative to the mount point (use event.c.req.path for the full path), onError no longer silences the default console.error (use logErrors: false), and hono >= 4.8 is required.

### Features

* around hook that wraps each request with the route known ([#6](https://github.com/HansKristoffer/hono-webhooks/issues/6)) ([eb21dfa](https://github.com/HansKristoffer/hono-webhooks/commit/eb21dfa35d2888dd9e28ecf0dcf9012df1fc2cd8))
* describeWebhooks, testWebhook and CLI --preload/--sign ([#8](https://github.com/HansKristoffer/hono-webhooks/issues/8)) ([2ccf930](https://github.com/HansKristoffer/hono-webhooks/commit/2ccf93093080da03147892bd5661f3ec5795b7ce))
* relative event paths, typed event parts, summarizeEvent and logErrors ([#7](https://github.com/HansKristoffer/hono-webhooks/issues/7)) ([460d4fa](https://github.com/HansKristoffer/hono-webhooks/commit/460d4fa8899edf56470ab18a944ae0b40876f85e))
* signature verification with verify and hono-webhooks/signatures ([#4](https://github.com/HansKristoffer/hono-webhooks/issues/4)) ([5f2fe98](https://github.com/HansKristoffer/hono-webhooks/commit/5f2fe98839ef32434c41507e386f95ddfae17519))

## [0.1.1](https://github.com/HansKristoffer/hono-webhooks/compare/v0.1.0...v0.1.1) (2026-09-28)


### Bug Fixes

* use a clean bin path so npm publishes without warnings ([#2](https://github.com/HansKristoffer/hono-webhooks/issues/2)) ([31f67ae](https://github.com/HansKristoffer/hono-webhooks/commit/31f67ae17ce4bdcb89a9c5ac8165427c970611c9))
