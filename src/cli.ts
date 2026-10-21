#!/usr/bin/env node
import { cli } from './cli-commands'

process.exitCode = await cli.run()
