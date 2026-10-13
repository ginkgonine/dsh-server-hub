#!/usr/bin/env node
// This file and executor.js must be copied together when relocating src to lib.
// No HTTP listener, shell command mode, ambient credentials or auto-restart.
import { realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectExecution, readLaunchTicket, readSupervisorSecret, runTicket } from './executor.js'

export async function main(argv = process.argv.slice(2)) {
  const [mode, ...args] = argv
  if (mode !== 'run' && mode !== 'inspect') throw new Error('Usage: executor-cli.js run --ticket FILE --state-dir DIR --secret-file FILE [--allow-env KEY] [--allow-partial] [--log-cap BYTES] | inspect --state-dir DIR --execution-id ID')
  const options = { allowedEnvironmentKeys: [], allowPartial: false }
  const names = new Map([
    ['--ticket', 'ticket'], ['--state-dir', 'stateDir'], ['--secret-file', 'secretFile'],
    ['--execution-id', 'executionId'], ['--log-cap', 'logCapBytes'],
  ])
  const seen = new Set()
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (flag === '--allow-partial' && mode === 'run' && !seen.has(flag)) { options.allowPartial = true; seen.add(flag); continue }
    if (flag === '--allow-env' && mode === 'run') {
      const key = args[++i]
      if (!key || key.startsWith('--')) throw new Error('Missing --allow-env value')
      options.allowedEnvironmentKeys.push(key)
      continue
    }
    const key = names.get(flag)
    if (!key || seen.has(flag) || (mode === 'inspect' && !['stateDir', 'executionId'].includes(key)) || (mode === 'run' && key === 'executionId')) throw new Error(`Unsupported or duplicate argument: ${flag}`)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`Missing ${flag} value`)
    seen.add(flag)
    options[key] = key === 'logCapBytes' ? Number(value) : value
  }
  if (!options.stateDir) throw new Error('Deployment --state-dir is required')
  if (mode === 'inspect') {
    if (!options.executionId) throw new Error('--execution-id is required')
    return inspectExecution(options)
  }
  if (!options.ticket || !options.secretFile) throw new Error('Signed --ticket and private --secret-file are required')
  const ticket = await readLaunchTicket(options.ticket)
  options.secret = await readSupervisorSecret(options.secretFile)
  // The deployment key must never be in the writable training workspace.
  const root = ticket?.payload?.workspaceRoot
  if (typeof root === 'string') {
    const keyPath = await realpath(options.secretFile)
    if (keyPath === root || keyPath.startsWith(`${root}/`)) throw new Error('Signing key must be outside the agent workspace')
  }
  return runTicket(ticket, options)
}

const invoked = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invoked) {
  main().then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`)
    // CLI transport success is separate from the persisted child's real exit.
  }).catch(error => {
    process.stderr.write(`executor: ${error.message}\n`)
    process.exitCode = 1
  })
}
