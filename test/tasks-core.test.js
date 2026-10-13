import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'
import { FileTaskLedger } from '../src/tasks/ledger.js'
import { validateEndpoint, validateNodeConfig, validateProjectConfig, validateTaskConfig, resolveTaskTarget } from '../src/tasks/config.js'
import { LIMITS, parseSubmit, validateSubmit, validateTaskRecord, validateTaskTransition } from '../src/tasks/protocol.js'

const token = 'a'.repeat(32)
const request = overrides => ({ version: 1, taskId: 'task-1', nodeId: 'worker-1', projectId: 'project-1', instruction: 'Implement the change.', ...overrides })
const record = overrides => {
  const { version, ...submission } = request()
  return { ...submission, state: 'queued', revision: 1, createdAt: 100, updatedAt: 100, ...overrides }
}
const node = overrides => ({ nodeId: 'worker-1', endpoint: 'http://127.0.0.1:3080', token, ...overrides })
const project = overrides => ({ id: 'project-1', root: '/workspace/project', agentPreset: 'default', ...overrides })

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-tasks-'))
  const ledger = new FileTaskLedger(directory)
  t.after(async () => { await ledger.close(); await fs.rm(directory, { recursive: true, force: true }) })
  await ledger.init()
  return { directory, ledger }
}

test('v1 submit is exact, bounded, detached, and cannot choose execution settings', () => {
  assert.deepEqual(parseSubmit(Buffer.from(JSON.stringify(request()))), request())
  for (const key of ['cwd', 'root', 'agentPreset', 'approvalPolicy', 'mode', 'resources', 'extra']) assert.throws(() => validateSubmit(request({ [key]: 'unsafe' })), /unknown field/)
  for (const bad of ['', '../escape', 'a.b', 'a/b', '-prefix', '__proto__', 'constructor', 'a'.repeat(129), '💥', 'a\n']) {
    for (const key of ['taskId', 'nodeId', 'projectId']) assert.throws(() => validateSubmit(request({ [key]: bad })), /safe id/)
  }
  assert.throws(() => validateSubmit(request({ version: 2 })), /version/)
  assert.throws(() => validateSubmit(request({ instruction: ' ' })), /bounded text/)
  assert.throws(() => validateSubmit(request({ instruction: 'é'.repeat(LIMITS.instruction / 2 + 1) })), /bounded text/)
  assert.throws(() => parseSubmit(' '.repeat(LIMITS.payload + 1)), /limit/)
  assert.throws(() => parseSubmit(Buffer.from([0xff])), /JSON/)
  assert.throws(() => parseSubmit('{'), /JSON/)
  assert.throws(() => parseSubmit(JSON.stringify(request()).replace('"version":1', '"version":1,"__proto__":{}')), /unknown field/)
  const input = request()
  const cloned = validateSubmit(input)
  input.instruction = 'changed'
  assert.notEqual(input.instruction, cloned.instruction)
})

test('validators reject getters, symbols, class instances, prototype pollution, non-JSON and unknown record fields', () => {
  const accessor = request()
  Object.defineProperty(accessor, 'instruction', { enumerable: true, get() { throw new Error('getter executed') } })
  assert.throws(() => validateSubmit(accessor), /data property/)
  assert.throws(() => validateSubmit({ ...request(), [Symbol('x')]: true }), /unknown field/)
  assert.throws(() => validateSubmit(Object.assign(Object.create({}), request())), /plain object/)
  for (const unsafe of [JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }, { prototype: {} }, new Date(), { nan: NaN }, { fn() {} }, [undefined]]) {
    assert.throws(() => validateTaskRecord(record({ result: unsafe })))
  }
  const cycle = {}; cycle.self = cycle
  assert.throws(() => validateTaskRecord(record({ result: cycle })), /acyclic/)
  assert.throws(() => validateTaskRecord(record({ metadata: {} })), /unknown field/)
  assert.equal({}.polluted, undefined)
})

test('configuration is disabled by default, exact, explicit and isolated from submit', () => {
  assert.deepEqual(validateTaskConfig(), { enabled: false, nodes: [], projects: [] })
  assert.throws(() => validateTaskConfig({ enabled: true }), /stateDirectory/)
  assert.throws(() => validateTaskConfig({ enabled: 'yes' }), /boolean/)
  assert.throws(() => validateTaskConfig({ autoDiscover: true }), /unknown field/)
  assert.throws(() => validateTaskConfig({ nodes: [node({ token: 'short' })] }), /32/)
  assert.throws(() => validateTaskConfig({ nodes: [node(), node()] }), /duplicate/)
  assert.throws(() => validateTaskConfig({ projects: [project()] }), /nodeId and token/)
  assert.throws(() => validateTaskConfig({ stateDirectory: 'relative' }), /absolute/)
  assert.throws(() => validateNodeConfig(node({ id: 'legacy' })), /unknown field/)
  assert.throws(() => validateNodeConfig(node({ projects: ['same', 'same'] })), /duplicates/)
  const cfg = { enabled: true, stateDirectory: '/private/tasks', nodeId: 'local-1', token, projects: [project()], nodes: [node({ projects: ['project-1'] })] }
  assert.equal(resolveTaskTarget(cfg, request()).node.nodeId, 'worker-1')
  assert.equal(resolveTaskTarget(cfg, request({ nodeId: 'local-1' })).project.root, '/workspace/project')
  assert.throws(() => resolveTaskTarget(cfg, request({ projectId: 'other' })), /disallowed/)
  assert.throws(() => resolveTaskTarget(cfg, request({ nodeId: 'other' })), /disallowed/)
  assert.throws(() => resolveTaskTarget({ ...cfg, enabled: false }, request()), /disabled/)
})

test('explicit project defaults restrict policy, mode and bounded resources', () => {
  const cfg = validateProjectConfig(project())
  assert.equal(cfg.approvalPolicy, 'ask')
  assert.equal(cfg.mode, 'workspace-write')
  assert.equal(cfg.allowPartial, false)
  assert.equal(cfg.stepLimit, 20)
  assert.equal(cfg.activeTimeoutMs, 600_000)
  assert.deepEqual(cfg.resources, [])
  assert.equal(validateProjectConfig(project({ approvalPolicy: 'never' })).approvalPolicy, 'never')
  for (const options of [{ mode: 'danger-full-access' }, { approvalPolicy: 'always' }, { resources: {} }, { resources: ['../x'] }, { root: '.' }, { stepLimit: 0 }, { activeTimeoutMs: Infinity }, { allowPartial: 'true' }, { approvalPolicy: null }, { mode: null }, { stepLimit: null }, { resources: null }]) assert.throws(() => validateProjectConfig(project(options)))
})

test('HTTP endpoints trust only canonical loopback including IPv6; all others require HTTPS', () => {
  for (const endpoint of ['http://localhost:3080/', 'http://127.0.0.1:3080', 'http://127.0.0.2:80', 'http://[::1]:3080', 'https://worker.example:443/base']) assert.ok(validateEndpoint(endpoint))
  for (const endpoint of ['http://example.com', 'http://192.168.1.2', 'http://[::]', 'http://localhost.evil', 'http://localhost.', 'http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://user:password@localhost', 'https://worker.example/?token=secret', 'https://worker.example/#x', 'file:///tmp/tasks', ' http://localhost', 'http:\\localhost']) assert.throws(() => validateEndpoint(endpoint), endpoint)
})

test('task transitions are explicit and terminal states cannot reopen', () => {
  const initial = record()
  const next = state => ({ ...initial, state, revision: 2, updatedAt: 101 })
  assert.equal(validateTaskTransition(initial, next('dispatching')).state, 'dispatching')
  assert.throws(() => validateTaskTransition(initial, next('succeeded')), /transition/)
  assert.throws(() => validateTaskTransition(initial, { ...next('dispatching'), instruction: 'changed' }), /immutable/)
  assert.throws(() => validateTaskTransition(initial, { ...next('dispatching'), revision: 3 }), /revision/)
  assert.throws(() => validateTaskTransition(record({ state: 'succeeded' }), next('running')), /transition/)
})

test('durable submit dedup includes instruction and optional origin presence, not current state', async t => {
  const { ledger } = await fixture(t)
  const initial = record({ originSessionId: 'origin-1' })
  await ledger.submit(initial)
  const advanced = await ledger.mutate(initial.taskId, draft => { draft.state = 'dispatching' })
  assert.deepEqual(await ledger.submit({ ...initial, createdAt: 200, updatedAt: 200 }), advanced)
  assert.equal((await ledger.eventsSince()).length, 2)
  for (const change of [{ instruction: 'different' }, { nodeId: 'other' }, { projectId: 'other' }, { originSessionId: 'other' }]) await assert.rejects(ledger.submit({ ...initial, ...change }), { code: 'TASK_DUPLICATE_MISMATCH' })
  const { originSessionId, ...noOrigin } = initial
  await assert.rejects(ledger.submit(noOrigin), { code: 'TASK_DUPLICATE_MISMATCH' })
  assert.equal((await ledger.get(initial.taskId)).revision, 2)
})

test('concurrent async mutations serialize unique revisions without lost writes, and failures roll back', async t => {
  const { ledger } = await fixture(t)
  await ledger.submit(record({ notification: { counter: 0 } }))
  const results = await Promise.all(Array.from({ length: 24 }, () => ledger.mutate('task-1', async draft => {
    await Promise.resolve()
    draft.notification.counter += 1
  })))
  assert.deepEqual(results.map(item => item.revision), Array.from({ length: 24 }, (_, i) => i + 2))
  assert.equal((await ledger.get('task-1')).notification.counter, 24)
  const before = await ledger.get('task-1')
  await assert.rejects(ledger.mutate('task-1', draft => { draft.instruction = 'wrong' }), /immutable/)
  await assert.rejects(ledger.mutate('task-1', draft => { draft.revision += 1 }), /owns revision/)
  await assert.rejects(ledger.mutate('task-1', () => { throw new Error('callback failed') }), /callback failed/)
  await assert.rejects(ledger.mutate('task-1', () => null), /plain object/)
  await assert.rejects(ledger.mutate('task-1', () => {}, { eventType: '__proto__' }), /event type/)
  assert.deepEqual(await ledger.get('task-1'), before)
  await ledger.mutate('task-1', draft => { draft.state = 'dispatching' })
  const detached = await ledger.get('task-1'); detached.state = 'failed'
  assert.equal((await ledger.get('task-1')).state, 'dispatching')
})

test('events replay in order and outbox plus transition plus custom event reload atomically', async t => {
  const { ledger, directory } = await fixture(t)
  await ledger.submit(record())
  await ledger.mutate('task-1', draft => {
    draft.state = 'dispatching'
    draft.outbox = { id: 'intent-1', type: 'dispatch', status: 'pending', attempts: 0, createdAt: 100, updatedAt: 100, payload: { taskId: 'task-1' } }
  }, { eventType: 'dispatch.pending', eventData: { id: 'intent-1' } })
  const event = await ledger.appendEvent('task-1', 'dispatch.attempt', { attempt: 1 })
  assert.equal(event.seq, 3)
  assert.equal((await ledger.get('task-1')).revision, 2)
  assert.deepEqual((await ledger.eventsSince(1, 1)).map(item => item.seq), [2])
  const events = await ledger.eventsSince()
  assert.deepEqual(events.map(item => item.seq), [1, 2, 3])
  await ledger.close()
  const loaded = new FileTaskLedger(directory)
  t.after(() => loaded.close())
  await loaded.init()
  assert.deepEqual(await loaded.eventsSince(), events)
  assert.equal((await loaded.get('task-1')).outbox.id, 'intent-1')
  assert.equal((await loaded.get('task-1')).state, 'dispatching')
  assert.deepEqual(await loaded.eventsSince(3), [])
  await assert.rejects(loaded.eventsSince(-1), /integer/)
  await assert.rejects(loaded.eventsSince(0, 1001), /integer/)
  await loaded.close()
})

test('process lock rejects a second writer and validates private storage permissions', async t => {
  const { ledger, directory } = await fixture(t)
  const second = new FileTaskLedger(directory)
  await assert.rejects(second.init(), { code: 'TASK_LEDGER_LOCKED' })
  await second.close()
  await ledger.close()
  const permissions = await fs.stat(path.join(directory, 'ledger.json'))
  assert.equal(permissions.mode & 0o777, 0o600)
  await fs.chmod(path.join(directory, 'ledger.json'), 0o644)
  const unsafe = new FileTaskLedger(directory)
  await assert.rejects(unsafe.init(), { code: 'TASK_UNSAFE_STORAGE' })
  await unsafe.close()
  await fs.chmod(path.join(directory, 'ledger.json'), 0o600)
  await fs.chmod(directory, 0o755)
  const publicLedger = new FileTaskLedger(directory)
  await assert.rejects(publicLedger.init(), { code: 'TASK_UNSAFE_STORAGE' })
  await publicLedger.close()
})

test('Linux lock identity recovers reused/container PIDs while legacy ambiguous live PID locks fail closed', async t => {
  const { directory, ledger } = await fixture(t)
  await ledger.submit(record())
  const lockPath = path.join(directory, 'ledger.lock')
  const old = JSON.parse(await fs.readFile(lockPath, 'utf8'))
  assert.equal(typeof old.startTime, 'string')
  await ledger.close()
  await fs.writeFile(lockPath, JSON.stringify({ ...old, startTime: '0' }), { mode: 0o600 })
  const recovered = new FileTaskLedger(directory)
  await recovered.init()
  assert.equal((await recovered.get('task-1')).instruction, record().instruction)
  await recovered.close()
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, nonce: 'legacy-owner', createdAt: 100 }), { mode: 0o600 })
  const ambiguous = new FileTaskLedger(directory)
  await assert.rejects(ambiguous.init(), { code: 'TASK_LEDGER_LOCKED' })
  await ambiguous.close()
})

test('symlink snapshots/locks/ancestors and hardlinks fail closed without touching their targets', async t => {
  const outer = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-links-'))
  t.after(() => fs.rm(outer, { recursive: true, force: true }))
  const target = path.join(outer, 'target')
  await fs.writeFile(target, 'untouched', { mode: 0o600 })
  for (const name of ['ledger.json', 'ledger.lock']) {
    const directory = path.join(outer, name.replace('.', '-'))
    await fs.mkdir(directory, { mode: 0o700 })
    await fs.symlink(target, path.join(directory, name))
    const ledger = new FileTaskLedger(directory)
    await assert.rejects(ledger.init())
    await ledger.close()
    assert.equal(await fs.readFile(target, 'utf8'), 'untouched')
  }
  const linked = path.join(outer, 'hardlinks')
  await fs.mkdir(linked, { mode: 0o700 })
  await fs.link(target, path.join(linked, 'ledger.json'))
  const hardLedger = new FileTaskLedger(linked)
  await assert.rejects(hardLedger.init(), { code: 'TASK_UNSAFE_STORAGE' })
  await hardLedger.close()
  await fs.symlink(linked, path.join(outer, 'alias'))
  const alias = new FileTaskLedger(path.join(outer, 'alias', 'nested'))
  await assert.rejects(alias.init(), { code: 'TASK_UNSAFE_STORAGE' })
  await alias.close()
})

test('corrupt or unknown snapshot data fails closed instead of resetting state', async t => {
  const { ledger, directory } = await fixture(t)
  await ledger.submit(record())
  await ledger.close()
  const file = path.join(directory, 'ledger.json')
  const good = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const value of ['{partial', JSON.stringify({ ...good, extra: true }), JSON.stringify({ ...good, lastSeq: 99 }), JSON.stringify({ ...good, tasks: [{ ...good.tasks[0], state: 'unknown' }] })]) {
    await fs.writeFile(file, value, { mode: 0o600 })
    const corrupt = new FileTaskLedger(directory)
    await assert.rejects(corrupt.init())
    await corrupt.close()
    assert.equal(await fs.readFile(file, 'utf8'), value)
  }
})

test('SIGKILL reload recovers dead writer lock, complete snapshot/outbox/events and ignores interrupted temp file', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-task-crash-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const moduleURL = pathToFileURL(path.resolve('src/tasks/ledger.js')).href
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { FileTaskLedger } from ${JSON.stringify(moduleURL)};
    const ledger = new FileTaskLedger(${JSON.stringify(directory)});
    await ledger.init();
    await ledger.submit(${JSON.stringify(record())});
    await ledger.mutate('task-1', draft => {
      draft.state = 'dispatching';
      draft.outbox = {id:'durable-1',type:'dispatch',status:'pending',attempts:0,createdAt:100,updatedAt:100};
    });
    process.stdout.write('READY');
    setInterval(() => {}, 10000);
  `], { stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  let stderr = ''; child.stderr.on('data', value => { stderr += value })
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve)
    child.once('error', reject)
    child.once('exit', (code, signal) => reject(new Error(`child exited ${code}/${signal}: ${stderr}`)))
  })
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
  await fs.writeFile(path.join(directory, '.ledger-abandoned.tmp'), '{incomplete', { mode: 0o600 })
  const loaded = new FileTaskLedger(directory)
  t.after(() => loaded.close())
  await loaded.init()
  const task = await loaded.get('task-1')
  assert.equal(task.revision, 2)
  assert.equal(task.state, 'dispatching')
  assert.equal(task.outbox.id, 'durable-1')
  assert.deepEqual((await loaded.eventsSince()).map(item => item.seq), [1, 2])
  await loaded.mutate('task-1', draft => { draft.state = 'running' })
  assert.deepEqual((await loaded.eventsSince()).map(item => item.seq), [1, 2, 3])
  await loaded.close()
})

test('close drains accepted writes, rejects new work and can be called twice', async t => {
  const { ledger } = await fixture(t)
  const submission = ledger.submit(record())
  const closing = ledger.close()
  await assert.rejects(ledger.list(), { code: 'TASK_LEDGER_CLOSED' })
  await submission
  await closing
  await ledger.close()
})
