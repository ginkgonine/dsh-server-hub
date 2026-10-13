import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { FileTaskLedger } from '../src/tasks/ledger.js'
import { TaskEventHub } from '../src/tasks/transport.js'
import { TaskExecutions } from '../src/tasks/execution-bridge.js'
import { validateTaskConfig } from '../src/tasks/config.js'

async function fixture(t, withSupervisor = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-execution-bridge-'))
  const projectRoot = path.join(root, 'project')
  await mkdir(projectRoot)
  const secretFile = path.join(root, 'key')
  await writeFile(secretFile, 's'.repeat(48), { mode: 0o600 })
  const ledger = await new FileTaskLedger(path.join(root, 'ledger')).init()
  const now = Date.now()
  await ledger.submit({ taskId: 'task-1', nodeId: 'v100', projectId: 'sr', instruction: 'test', state: 'queued', revision: 1, createdAt: now, updatedAt: now, notification: {} })
  await ledger.mutate('task-1', (draft) => { draft.state = 'dispatching' })
  const task = await ledger.mutate('task-1', (draft) => { draft.state = 'running' })
  const config = { nodeId: 'v100', projects: [{ id: 'sr', root: projectRoot, allowPartial: false }],
    ...(withSupervisor ? { supervisor: { stateDirectory: path.join(root, 'supervisor'), secretFile, controlBoundaryVerified: true, environment: {} } } : {}) }
  // Unit fixture only: fake confinement uses harmless commands, NOT a production sandbox attestation.
  const ctx = { sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: projectRoot }) },
    sandbox: { confine: async (argv) => ({ argv, enforcement: 'full' }) } }
  const bridge = new TaskExecutions({ ctx, config, ledger, events: new TaskEventHub(), pollMs: 25 })
  await bridge.initialize()
  t.after(async () => { bridge.close(); await ledger.close(); await rm(root, { recursive: true, force: true }) })
  return { root, projectRoot, config, ledger, task, bridge, ctx, exec: { agent: { session: {} }, callId: 'call-1', signal: new AbortController().signal } }
}

async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('observer timeout')), 3000) })]) }
  finally { clearTimeout(timer) }
}

test('supervisor activation requires an explicit control-boundary attestation and strict environment allowlist', () => {
  const base = { enabled: true, stateDirectory: '/private/tasks', supervisor: { stateDirectory: '/private/runner', secretFile: '/private/key', controlBoundaryVerified: false } }
  assert.throws(() => validateTaskConfig(base), /boundary/)
  base.supervisor.controlBoundaryVerified = true
  base.supervisor.environment = { SECRET_TOKEN: 'bad' }
  assert.throws(() => validateTaskConfig(base), /unknown field/)
})

test('execution is bound to one task, idempotent and returns actual nonzero exit without Agent polling', async (t) => {
  const { bridge, task, exec, ledger } = await fixture(t)
  const started = await bridge.start(task, { command: 'exit 7', idempotencyKey: 'run-1' }, exec)
  assert.match(started.executionId, /^exec-/)
  const saved = await ledger.get(task.taskId)
  let callbacks = 0
  const result = await bounded(new Promise((resolve, reject) => {
    bridge.observe(started.executionId, (value) => { callbacks++; resolve(value) }, saved).catch(reject)
  }))
  assert.equal(result.status, 'ended')
  assert.equal(result.result.exitCode, 7)
  assert.equal(callbacks, 1)
  const duplicate = await bridge.start(saved, { command: 'exit 7', idempotencyKey: 'run-1' }, exec)
  assert.equal(duplicate.executionId, started.executionId)
  await assert.rejects(bridge.start(saved, { command: 'exit 0', idempotencyKey: 'run-1' }, exec), /different command/)
  await assert.rejects(bridge.observe('other-execution', () => {}, saved), /own registered/)
})

test('a settled legacy observation can continue once as a managed execution without duplicating a running process', async (t) => {
  const { bridge, task, ledger, projectRoot, exec } = await fixture(t)
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: projectRoot, stdio: 'ignore' })
  await once(child, 'spawn')
  t.after(() => child.kill())
  const legacy = await bridge.registerExisting(task, { pid: child.pid })
  const linked = await ledger.get(task.taskId)
  await assert.rejects(bridge.start(linked, { command: 'exit 0', idempotencyKey: 'continue-1' }, exec), /already owns another/)
  const exited = once(child, 'close')
  child.kill()
  await exited
  const managed = await bridge.start(await ledger.get(task.taskId), { command: 'exit 0', idempotencyKey: 'continue-1' }, exec)
  assert.notEqual(managed.executionId, legacy.executionId)
  const saved = await ledger.get(task.taskId)
  assert.equal(saved.notification.executionHistory[0].type, 'legacy')
  const result = await bounded(new Promise((resolve, reject) => { bridge.observe(managed.executionId, resolve, saved).catch(reject) }))
  assert.equal(result.result.exitCode, 0)
})

test('unconfigured or partial confinement never silently launches arbitrary commands', async (t) => {
  const { bridge, task, exec, config, ctx } = await fixture(t, false)
  await assert.rejects(bridge.start(task, { command: 'exit 0' }, exec), /not explicitly configured/)
  config.supervisor = { stateDirectory: '/private', secretFile: '/private/key', environment: {} }
  ctx.sandbox.confine = async (argv) => ({ argv, enforcement: 'partial' })
  await assert.rejects(bridge.start(task, { command: 'exit 0' }, exec), /Partial/)
  await assert.rejects(bridge.start(task, { command: 'exit 0', cwd: '/' }, exec), /unknown field/)
})

test('existing process observations bind project cwd and identity without adoption or stopping', async (t) => {
  const { bridge, task, ledger, projectRoot } = await fixture(t, false)
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { cwd: projectRoot, stdio: 'ignore' })
  await once(child, 'spawn')
  t.after(() => { child.kill() })
  const registration = await bridge.registerExisting(task, { pid: child.pid })
  assert.equal(registration.status, 'running')
  const saved = await ledger.get(task.taskId)
  assert.equal((await bridge.status(saved)).status, 'running')
  await assert.rejects(bridge.stop(saved), /Only this task/)
  const result = bounded(new Promise((resolve, reject) => { bridge.observe(registration.executionId, resolve, saved).catch(reject) }))
  child.kill()
  const observed = await result
  assert.equal(observed.status, 'ended')
  assert.equal(observed.exitCodeKnown, false)
})
