#!/usr/bin/env node
import { cli } from './cli-commands'

// hanzio/cli exits 2 on bad arguments; this CLI has always exited 1.
const code = await cli.run()
process.exitCode = code === 2 ? 1 : code
