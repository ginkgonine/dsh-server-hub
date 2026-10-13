import test from 'node:test'
import assert from 'node:assert/strict'
import fsPromises, { copyFile, link, mkdtemp, mkdir, chmod, lstat, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  commandDigest, ensureStateDirectory, getProcessIdentity, inspectExecution,
  inspectExistingProcess, issueLaunchTicket, launchSupervisor, readLaunchTicket,
  readSupervisorSecret, runTicket, stopExecution, verifyLaunchTicket,
} from '../src/tasks/executor.js'
import { main } from '../src/tasks/executor-cli.js'

// These fixtures deliberately fake confinement for harmless short test programs.
// They are NOT a deployable confinement adapter and must never leave tests.
const secret = 'test-only-hmac-secret-0123456789abcdef'
const fakeConfinement = async payload => ({ validated: true, enforcement: payload.enforcement, policy: payload.policy, commandDigest: payload.commandDigest })
const signing = { secret, validateConfinement: fakeConfinement }
const executorURL = new URL('../src/tasks/executor.js', import.meta.url).href

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-executor-test-')))
  const root = join(base, 'workspace')
  const stateDir = join(base, 'private-state')
  const secretFile = join(base, 'supervisor.key')
  await mkdir(root, { mode: 0o700 })
  await writeFile(secretFile, secret, { mode: 0o600 })
  t.after(() => rm(base, { recursive: true, force: true }))
  return { base, root, stateDir, secretFile }
}
async function ticketFor(f, code, changes = {}, options = {}) {
  return issueLaunchTicket({ executionId: 'exec-test', projectId: 'project-test', workspaceRoot: f.root, cwd: f.root, confinedArgv: [process.execPath, '-e', code], enforcement: 'full', policy: 'workspace-write', environment: {}, ...changes }, { ...signing, ...options })
}
async function waitState(f, executionId, predicate, timeout = 5000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const state = await inspectExecution({ stateDir: f.stateDir, executionId })
    if (predicate(state)) return state
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.fail(`Execution ${executionId} did not reach expected state`)
}
function subprocess(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
}

test('tickets require exact trusted confinement attestation and signed argv, not shell strings', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, 'process.exit(0)')
  assert.equal((await verifyLaunchTicket(ticket, { secret })).executionId, 'exec-test')
  await assert.rejects(issueLaunchTicket(ticket.payload, { secret }), /Trusted host/)
  await assert.rejects(ticketFor(f, '', {}, { validateConfinement: async () => ({ validated: true }) }), /did not attest/)
  await assert.rejects(ticketFor(f, '', { confinedArgv: 'node -e process.exit(0)' }), /confinedArgv/)
  await assert.rejects(ticketFor(f, '', { confinedArgv: ['node', '-e', ''] }), /command digest/)
  const tampered = structuredClone(ticket)
  tampered.payload.confinedArgv[2] = 'process.exit(7)'
  await assert.rejects(verifyLaunchTicket(tampered, { secret }), /signature mismatch/)
  await assert.rejects(verifyLaunchTicket(ticket, { secret: 'wrong-secret-012345678901234567890123' }), /signature mismatch/)
  await assert.rejects(ticketFor(f, '', {}, { secret: 'short' }), /32 bytes/)
})

test('partial confinement requires explicit opt-in by both signer and runner', async t => {
  const f = await fixture(t)
  await assert.rejects(ticketFor(f, '', { enforcement: 'partial' }), /explicit/)
  const ticket = await ticketFor(f, 'process.exit(0)', { enforcement: 'partial' }, { allowPartial: true })
  await assert.rejects(runTicket(ticket, { ...f, secret }), /explicit/)
  const result = await runTicket(ticket, { ...f, secret, allowPartial: true })
  assert.equal(result.result.exitCode, 0)
})

test('ticket expiration, policy, canonical cwd and workspace containment are enforced', async t => {
  const f = await fixture(t)
  const stale = await ticketFor(f, '', {}, { now: Date.now() - 120_000, ttlMs: 60_000 })
  await assert.rejects(verifyLaunchTicket(stale, { secret }), /stale/)
  const future = await ticketFor(f, '', {}, { now: Date.now() + 60_000 })
  await assert.rejects(verifyLaunchTicket(future, { secret }), /stale/)
  await assert.rejects(ticketFor(f, '', { policy: 'danger-full-access' }), /workspace-write/)
  await assert.rejects(ticketFor(f, '', { cwd: f.base }), /outside/)
  await assert.rejects(ticketFor(f, '', { cwd: 'relative' }), /absolute/)
  await assert.rejects(ticketFor(f, '', { cwd: join(f.root, 'missing') }), /ENOENT/)
  const alias = join(f.base, 'alias')
  await symlink(f.root, alias)
  await assert.rejects(ticketFor(f, '', { cwd: alias }), /canonical/)
})

test('only allowlisted environment reaches child; host environment and signing key do not', async t => {
  const f = await fixture(t)
  await assert.rejects(ticketFor(f, '', { environment: { SECRET: 'bad' } }), /not allowed/)
  await assert.rejects(ticketFor(f, '', { environment: { TRAINING_TEST: secret } }, { allowedEnvironmentKeys: ['TRAINING_TEST'] }), /secret must not pass/)
  const ticket = await ticketFor(f, 'console.log(JSON.stringify(process.env))', { environment: { TRAINING_TEST: 'allowed' } }, { allowedEnvironmentKeys: ['TRAINING_TEST'] })
  await assert.rejects(verifyLaunchTicket(ticket, { secret }), /not allowed/)
  process.env.DSH_EXECUTOR_TEST_SECRET = 'never-pass-through'
  try {
    await runTicket(ticket, { ...f, secret, allowedEnvironmentKeys: ['TRAINING_TEST'] })
    const output = JSON.parse((await readFile(join(f.stateDir, 'exec-test', 'log.txt'), 'utf8')).trim())
    assert.deepEqual(output, { TRAINING_TEST: 'allowed' })
  } finally { delete process.env.DSH_EXECUTOR_TEST_SECRET }
})

test('durable receipt/result preserve nonzero exit and bound combined disk log', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, "process.stdout.write('a'.repeat(5000)); process.stderr.write('b'.repeat(5000)); process.exitCode = 7")
  const outcome = await runTicket(ticket, { ...f, secret, logCapBytes: 1024 })
  assert.equal(outcome.result.exitCode, 7)
  assert.equal(outcome.result.signal, null)
  assert.equal(outcome.result.log.bytes, 1024)
  assert.equal(outcome.result.log.totalBytes, 10_000)
  assert.equal(outcome.result.log.truncated, true)
  const state = await inspectExecution({ ...f, executionId: 'exec-test' })
  assert.equal(state.status, 'ended')
  assert.equal(state.result.exitCode, 7)
  assert.ok(state.child.identity.pid > 0)
  assert.match(state.child.identity.startTime, /^\d+$/)
  assert.equal((await lstat(f.stateDir)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(f.stateDir, 'exec-test'))).mode & 0o777, 0o700)
  for (const name of ['manifest.json', 'ticket.json', 'start-intent.json', 'child.json', 'result.json', 'log.txt']) assert.equal((await lstat(join(f.stateDir, 'exec-test', name))).mode & 0o777, 0o600)
  assert.equal((await lstat(join(f.stateDir, 'exec-test', 'log.txt'))).size, 1024)
})

test('instant-exit child still has a durable PID/starttime receipt', async t => {
  const f = await fixture(t)
  for (let attempt = 0; attempt < 3; attempt++) {
    const executionId = `quick-exit-${attempt}`
    const ticket = await ticketFor(f, '', { executionId, confinedArgv: ['/bin/true'] })
    const completed = await runTicket(ticket, { ...f, secret })
    assert.equal(completed.result.exitCode, 0)
    const state = await inspectExecution({ ...f, executionId })
    assert.match(state.child.identity.startTime, /^\d+$/)
  }
})

test('exclusive claim prevents duplicate launches concurrently and after completion', async t => {
  const f = await fixture(t)
  const marker = join(f.root, 'launches')
  const ticket = await ticketFor(f, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => process.exit(0), 150)`)
  const results = await Promise.all([runTicket(ticket, { ...f, secret }), runTicket(ticket, { ...f, secret })])
  assert.equal(results.filter(item => item.duplicate).length, 1)
  const again = await runTicket(ticket, { ...f, secret })
  assert.equal(again.duplicate, true)
  assert.equal(again.status, 'ended')
  const conflicting = await ticketFor(f, 'process.exit(4)')
  await assert.rejects(runTicket(conflicting, { ...f, secret }), /different launch/)
  assert.equal(await readFile(marker, 'utf8'), 'x')
})

test('abandoned claim and spawn-without-receipt remain reconciling, never replayed', async t => {
  const f = await fixture(t)
  await ensureStateDirectory(f.stateDir, f.root)
  const directory = join(f.stateDir, 'exec-test')
  await mkdir(directory, { mode: 0o700 })
  const marker = join(f.root, 'must-not-launch')
  const ticket = await ticketFor(f, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe replay')`)
  assert.equal((await inspectExecution({ ...f, executionId: 'exec-test' })).status, 'reconciling')
  await writeFile(join(directory, 'start-intent.json'), JSON.stringify({ at: Date.now(), executionId: 'exec-test' }), { mode: 0o600 })
  const duplicate = await runTicket(ticket, { ...f, secret })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.status, 'reconciling')
  await assert.rejects(lstat(marker), /ENOENT/)
})

test('spawn failure is durably recorded without claiming an exit code', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, '', { confinedArgv: ['/definitely-missing-test-wrapper'] })
  const state = await runTicket(ticket, { ...f, secret })
  assert.equal(state.result.exitCode, null)
  assert.equal(state.result.signal, null)
  assert.equal(state.result.spawnError.code, 'ENOENT')
  assert.equal((await inspectExecution({ ...f, executionId: 'exec-test' })).status, 'ended')
})

test('state, records and secrets reject symlinks, hardlinks and unsafe modes', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, '')
  const target = join(f.base, 'target')
  await mkdir(target, { mode: 0o700 })
  await symlink(target, f.stateDir)
  await assert.rejects(runTicket(ticket, { ...f, secret }), /symlink/)
  await rm(f.stateDir)
  await ensureStateDirectory(f.stateDir, f.root)
  await chmod(f.stateDir, 0o755)
  await assert.rejects(runTicket(ticket, { ...f, secret }), /private/)
  await chmod(f.stateDir, 0o700)
  const directory = join(f.stateDir, 'exec-test')
  await mkdir(directory, { mode: 0o700 })
  await symlink(f.secretFile, join(directory, 'manifest.json'))
  await assert.rejects(inspectExecution({ ...f, executionId: 'exec-test' }), /symlink/)
  const keyAlias = join(f.base, 'key-alias')
  await symlink(f.secretFile, keyAlias)
  await assert.rejects(readSupervisorSecret(keyAlias), /symlink/)
  const hardlink = join(f.base, 'key-hardlink')
  await link(f.secretFile, hardlink)
  await assert.rejects(readSupervisorSecret(hardlink), /not linked/)
  await rm(hardlink)
  await chmod(f.secretFile, 0o644)
  await assert.rejects(readSupervisorSecret(f.secretFile), /private/)
  await assert.rejects(ensureStateDirectory(join(f.root, 'state'), f.root), /separate/)
})

test('private reads reopen atomic replacements without accepting unsafe or unlinked inodes', async t => {
  for (const scenario of ['private replacement', 'hardlinked replacement', 'unsafe-mode replacement', 'unlink only', 'repeated replacement']) {
    await t.test(scenario, async t => {
      const f = await fixture(t)
      const path = join(f.base, 'record.json')
      await writeFile(path, JSON.stringify({ value: 'old' }), { mode: 0o600 })
      const originalOpen = fsPromises.open
      let replacements = 0
      const hook = t.mock.method(fsPromises, 'open', async (target, ...args) => {
        const handle = await originalOpen(target, ...args)
        if (target !== path || (replacements && scenario !== 'repeated replacement')) return handle
        try {
          replacements += 1
          if (scenario === 'unlink only') await rm(path)
          else {
            const next = join(f.base, `replacement-${replacements}.json`)
            await writeFile(next, JSON.stringify({ value: 'new' }), { mode: 0o600 })
            if (scenario === 'hardlinked replacement') await link(next, join(f.base, 'hardlink'))
            if (scenario === 'unsafe-mode replacement') await chmod(next, 0o644)
            await rename(next, path)
          }
          // Force exactly the real open -> atomic rename -> fstat interleaving.
          assert.equal((await handle.stat()).nlink, 0)
          return handle
        } catch (error) { await handle.close(); throw error }
      })
      syncBuiltinESMExports()
      try {
        if (scenario === 'private replacement') assert.deepEqual(await readLaunchTicket(path), { value: 'new' })
        else await assert.rejects(readLaunchTicket(path), /private, owned, and not linked/)
        assert.equal(replacements, scenario === 'repeated replacement' ? 4 : 1)
      } finally {
        hook.mock.restore()
        syncBuiltinESMExports()
      }
    })
  }
})

test('observational inspection detects PID identity reuse, cwd/digest mismatch and ended state', async t => {
  const f = await fixture(t)
  const identity = await getProcessIdentity(process.pid)
  const cwd = await realpath(process.cwd())
  assert.equal((await inspectExistingProcess({ ...identity, cwd })).status, 'running')
  assert.equal((await inspectExistingProcess({ ...identity, cwd, startTime: String(BigInt(identity.startTime) + 1n) })).status, 'mismatch')
  assert.equal((await inspectExistingProcess({ ...identity, cwd: f.root })).status, 'mismatch')
  assert.equal((await inspectExistingProcess({ ...identity, cwd, commandDigest: commandDigest(['/not-this-command']) })).status, 'mismatch')
  assert.equal((await inspectExistingProcess({ pid: process.pid, cwd })).status, 'unknown')
  assert.equal((await inspectExistingProcess({ pid: 2147483647, startTime: '1', cwd })).status, 'ended')
})

test('detached CLI survives launching host exit and reports real child exit', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, 'setTimeout(() => { console.log("persistent-child"); process.exitCode = 9 }, 400)')
  const host = await subprocess(['--input-type=module', '-e', `import {launchSupervisor} from ${JSON.stringify(executorURL)}; const value = await launchSupervisor(${JSON.stringify(ticket)}, ${JSON.stringify({ stateDir: f.stateDir, secretFile: f.secretFile })}); console.log(JSON.stringify(value))`])
  assert.equal(host.code, 0, host.stderr)
  const launch = JSON.parse(host.stdout.trim())
  assert.ok(launch.runner.pid > 0)
  const early = await waitState(f, 'exec-test', state => state.status === 'running')
  assert.equal(early.runnerStatus, 'running')
  const final = await waitState(f, 'exec-test', state => state.status === 'ended')
  assert.equal(final.result.exitCode, 9)
  assert.match(await readFile(join(f.stateDir, 'exec-test', 'log.txt'), 'utf8'), /persistent-child/)
  const inspect = await main(['inspect', '--state-dir', f.stateDir, '--execution-id', 'exec-test'])
  assert.equal(inspect.result.exitCode, 9)
})

test('runner loss is reconciling even with a live child; duplicate CLI never replays', async t => {
  const f = await fixture(t)
  const marker = join(f.root, 'launch-count')
  const ticket = await ticketFor(f, `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'x'); setTimeout(() => {}, 600)`)
  await launchSupervisor(ticket, f)
  const running = await waitState(f, 'exec-test', state => state.status === 'running')
  // Kill only the known runner, never the detached child process group.
  process.kill(running.manifest.runner.pid, 'SIGKILL')
  const abandoned = await waitState(f, 'exec-test', state => state.status === 'reconciling')
  assert.equal(abandoned.childStatus, 'running')
  const duplicate = await runTicket(ticket, { ...f, secret })
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.status, 'reconciling')
  const deadline = Date.now() + 3000
  while ((await getProcessIdentity(running.child.identity.pid)).status === 'running' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
  assert.notEqual((await getProcessIdentity(running.child.identity.pid)).status, 'running')
  assert.equal(await readFile(marker, 'utf8'), 'x')
  assert.equal((await inspectExecution({ ...f, executionId: 'exec-test' })).status, 'reconciling')
})

test('runner and CLI work after relocation together into lib', async t => {
  const f = await fixture(t)
  const library = join(f.base, 'lib', 'tasks')
  await mkdir(library, { recursive: true, mode: 0o700 })
  await copyFile(new URL('../src/tasks/executor.js', import.meta.url), join(library, 'executor.js'))
  await copyFile(new URL('../src/tasks/executor-cli.js', import.meta.url), join(library, 'executor-cli.js'))
  await writeFile(join(f.base, 'lib', 'package.json'), '{"type":"module"}', { mode: 0o600 })
  const { launchSupervisor: relocatedLaunch } = await import(pathToFileURL(join(library, 'executor.js')))
  const binaryKey = randomBytes(32)
  await writeFile(f.secretFile, binaryKey)
  assert.deepEqual(await readSupervisorSecret(f.secretFile), binaryKey)
  const ticket = await ticketFor(f, 'process.exit(0)', {}, { secret: binaryKey })
  await relocatedLaunch(ticket, f)
  const final = await waitState(f, 'exec-test', state => state.status === 'ended')
  assert.equal(final.result.exitCode, 0)
})

test('intentional supervisor stop validates execution identity and records actual signal', async t => {
  const f = await fixture(t)
  const ticket = await ticketFor(f, 'setTimeout(() => {}, 3000)')
  const launch = await launchSupervisor(ticket, f)
  // Ensure cleanup remains possible if an assertion fails while child is live.
  t.after(async () => {
    const state = await inspectExecution({ ...f, executionId: 'exec-test' }).catch(() => null)
    if (state?.status === 'running') await stopExecution({ ...f, executionId: 'exec-test', runnerIdentity: state.manifest.runner })
  })
  const running = await waitState(f, 'exec-test', state => state.status === 'running')
  await assert.rejects(stopExecution({ ...f, executionId: 'exec-test', runnerIdentity: { ...running.manifest.runner, startTime: '0' } }), /matching/)
  assert.equal((await getProcessIdentity(running.child.identity.pid)).status, 'running')
  assert.equal((await stopExecution({ ...f, executionId: 'exec-test', runnerIdentity: running.manifest.runner })).stopped, true)
  const final = await waitState(f, 'exec-test', state => state.status === 'ended')
  assert.equal(final.result.exitCode, null)
  assert.equal(final.result.signal, 'SIGTERM')
  assert.equal(final.result.stoppedBy, 'SIGTERM')
  assert.equal(JSON.parse(await readFile(join(f.stateDir, 'exec-test', 'supervisor-stop.json'), 'utf8')).executionId, 'exec-test')
  assert.equal((await stopExecution({ ...f, executionId: 'exec-test', runnerIdentity: launch.runner })).stopped, false)
})

test('CLI accepts only run/inspect flags and signed private ticket files', async t => {
  const f = await fixture(t)
  await assert.rejects(main(['shell', 'echo unsafe']), /Usage/)
  await assert.rejects(main(['run', '--command', 'echo unsafe']), /Unsupported/)
  await assert.rejects(main(['inspect', '--state-dir', f.stateDir, '--execution-id', 'test', '--allow-partial']), /Unsupported/)
  await assert.rejects(main(['run', '--state-dir', f.stateDir]), /Signed/)
  const unsigned = join(f.base, 'unsigned.json')
  await writeFile(unsigned, JSON.stringify({ command: 'echo unsafe' }), { mode: 0o600 })
  await assert.rejects(main(['run', '--ticket', unsigned, '--state-dir', f.stateDir, '--secret-file', f.secretFile]), /signed launch ticket/)
  await chmod(unsigned, 0o644)
  await assert.rejects(readLaunchTicket(unsigned), /private/)
})
