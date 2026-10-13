import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { FileTaskLedger } from '../src/tasks/ledger.js'
import { RemoteTaskWorker } from '../src/tasks/worker.js'

const submit = (taskId, projectId = 'alpha', extra = {}) => ({ version: 1, taskId, nodeId: 'local', projectId, instruction: `Do ${taskId}`, ...extra })
const projects = [
  { id: 'alpha', root: '/projects/alpha', agentPreset: 'safe', resources: ['gpu'] },
  { id: 'beta', root: '/projects/beta', agentPreset: 'safe', resources: ['gpu'] },
  { id: 'gamma', root: '/projects/gamma', agentPreset: 'safe', resources: ['cpu'] },
]

async function harness(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'tasks-worker-'))
  const ledger = new FileTaskLedger(path.join(directory, 'ledger'))
  await ledger.init()
  let time = 1000
  const calls = { create: [], prompt: [], cancel: [], flush: [], observe: [], unobserve: [], kill: [], changed: 0 }
  const sessions = {
    async create(task, project) { calls.create.push({ task, project }); return { sessionId: task.remoteSessionId } },
    async prompt(task, phaseId, text) { calls.prompt.push({ task, phaseId, text }) },
    async cancel(sessionId) { calls.cancel.push(sessionId) },
    async flush(sessionId) { calls.flush.push(sessionId) },
    ...options.sessions,
  }
  const executions = {
    observe(executionId, callback, task) { calls.observe.push({ executionId, callback, task }); return () => calls.unobserve.push(executionId) },
    kill(id) { calls.kill.push(id) }, cancel(id) { calls.kill.push(id) },
    ...options.executions,
  }
  const config = { nodeId: 'local', projects: options.projects || projects }
  const events = { changed() { calls.changed += 1 } }
  const makeWorker = (nextConfig = config) => new RemoteTaskWorker({ config: nextConfig, ledger, events, sessions, executions, now: () => time, sessionIdForTask: (id) => `hub-${id}` })
  const worker = makeWorker()
  await worker.initialize()
  const workers = [worker]
  t.after(async () => {
    for (const worker of workers) await worker.close()
    await ledger.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { worker, ledger, calls, sessions, executions, config, workers, makeWorker, setTime(value) { time = value } }
}

async function waitFor(predicate) {
  for (let index = 0; index < 300; index += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.fail('timed out waiting for worker')
}
const running = (h, id) => waitFor(async () => (await h.ledger.get(id))?.state === 'running' && h.calls.prompt.some(call => call.task.taskId === id))
const settle = async worker => { await worker.queue; await Promise.all([...worker.background]); await worker.queue }
const success = { outcome: 'succeeded', summary: 'Verified output', evidence: ['tests passed'] }

test('strict admission, complete numeric revision-1 record and stable bounded session identity', async t => {
  const h = await harness(t)
  const first = await h.worker.accept(submit('one'))
  assert.equal(first.state, 'queued')
  assert.equal(first.revision, 1)
  assert.equal(first.createdAt, 1000)
  assert.equal(first.updatedAt, 1000)
  assert.equal(first.remoteSessionId, 'hub-one')
  assert.equal(first.notification.worker.stepLimit, 20)
  assert.equal(first.notification.worker.activeTimeoutMs, 600000)
  assert.match(first.notification.worker.configDigest, /^[a-f0-9]{64}$/)
  await assert.rejects(h.worker.accept(submit('bad', 'alpha', { cwd: '/evil' })), /unknown field/)
  await assert.rejects(h.worker.accept(submit('bad', 'alpha', { nodeId: 'other' })), /match this worker/)
  await assert.rejects(h.worker.accept(submit('bad', 'unknown')), /allowlisted/)
  await assert.rejects(h.worker.accept(submit('a'.repeat(125))), /remoteSessionId/)
  await h.worker.accept(submit('a'.repeat(124), 'gamma'))
  await settle(h.worker)
})

test('durable request and phase intents precede create and prompt; no idle completion', async t => {
  const h = await harness(t)
  h.sessions.create = async task => {
    const persisted = await h.ledger.get(task.taskId)
    assert.equal(persisted.state, 'dispatching')
    assert.equal(persisted.notification.worker.createIntent.status, 'pending')
    assert.equal(persisted.requestId, task.requestId)
    assert.equal(persisted.notification.worker.promptIntent.phaseId, task.notification.worker.phaseId)
    h.calls.create.push({ task })
    return { sessionId: task.remoteSessionId }
  }
  h.sessions.prompt = async (task, phaseId, text) => {
    const persisted = await h.ledger.get(task.taskId)
    assert.equal(persisted.state, 'running')
    assert.equal(persisted.notification.worker.promptIntent.status, 'pending')
    assert.equal(persisted.notification.worker.phaseId, phaseId)
    h.calls.prompt.push({ task, phaseId, text })
  }
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await settle(h.worker)
  assert.equal((await h.ledger.get('one')).state, 'running')
})

test('same project and resource are serial, while independent allowed project runs in parallel', async t => {
  const h = await harness(t)
  await Promise.all([h.worker.accept(submit('one')), h.worker.accept(submit('two')), h.worker.accept(submit('three', 'beta')), h.worker.accept(submit('four', 'gamma'))])
  await running(h, 'one')
  await running(h, 'four')
  await settle(h.worker)
  assert.equal((await h.ledger.get('two')).state, 'queued')
  assert.equal((await h.ledger.get('three')).state, 'queued')
  assert.deepEqual(h.calls.create.map(call => call.task.taskId).sort(), ['four', 'one'])
  await h.worker.finish('one', success)
  await running(h, 'two')
  assert.equal((await h.ledger.get('three')).state, 'queued')
})

test('waiting_execution and waiting_human retain leases and produce zero periodic prompts or steps', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Training already started' })
  await h.worker.accept(submit('two', 'beta'))
  const prompts = h.calls.prompt.length
  for (let index = 0; index < 3; index += 1) {
    assert.equal(await h.worker.beforeStep('hub-one'), false)
    await h.worker.pump()
  }
  await settle(h.worker)
  assert.equal(h.calls.prompt.length, prompts)
  assert.equal((await h.ledger.get('two')).state, 'queued')
  assert.equal((await h.ledger.get('one')).notification.worker.steps, 0)
  await assert.rejects(h.worker.finish('one', success), /running owned/)
})

test('duplicate submit is idempotent, mismatch rejects without relaunching', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one', 'alpha', { originSessionId: 'origin' }))
  await running(h, 'one')
  await settle(h.worker)
  const before = await h.ledger.get('one')
  const changed = h.calls.changed
  assert.deepEqual(await h.worker.accept(submit('one', 'alpha', { originSessionId: 'origin' })), before)
  await assert.rejects(h.worker.accept(submit('one', 'alpha', { instruction: 'Different', originSessionId: 'origin' })), { code: 'TASK_DUPLICATE_MISMATCH' })
  await assert.rejects(h.worker.accept(submit('one')), { code: 'TASK_DUPLICATE_MISMATCH' })
  await settle(h.worker)
  assert.equal(h.calls.changed, changed)
  assert.equal(h.calls.create.length, 1)
  assert.equal(h.calls.prompt.length, 1)
})

test('finish requires strict explicit outcome and evidence; needs_input never completes', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  for (const result of [
    { summary: 'done', evidence: ['ok'] },
    { outcome: 'succeeded', summary: 'done', evidence: [] },
    { outcome: 'succeeded', summary: 'done', evidence: [''] },
    { ...success, unknown: true },
    { ...success, summary: 'x'.repeat(8193) },
    { ...success, evidence: Array(128).fill('x'.repeat(4096)) },
  ]) await assert.rejects(h.worker.finish('one', result))
  await assert.rejects(h.worker.finish('missing', success), { code: 'TASK_NOT_FOUND' })
  const task = await h.worker.finish('one', { outcome: 'needs_input', summary: 'Need approval', evidence: [] })
  assert.equal(task.state, 'waiting_human')
  assert.equal(await h.worker.beforeStep('hub-one'), false)
  await assert.rejects(h.worker.finish('one', success), { code: 'TASK_NOT_RUNNING' })
  await h.worker.accept(submit('two', 'gamma'))
  await running(h, 'two')
  const done = await h.worker.finish('two', success)
  assert.equal(done.state, 'succeeded')
  assert.deepEqual(done.result, success)
})

test('create and prompt asynchronous failures wait for humans, not false terminal success', async t => {
  for (const method of ['create', 'prompt']) {
    const h = await harness(t)
    h.sessions[method] = async () => { throw new Error('unresolved request') }
    await h.worker.accept(submit(`fail-${method}`))
    await waitFor(async () => (await h.ledger.get(`fail-${method}`)).state === 'waiting_human')
    const task = await h.ledger.get(`fail-${method}`)
    assert.equal(task.result, undefined)
    assert.equal(task.notification.worker.operatorNeeded, true)
    assert.equal(await h.worker.beforeStep(task.remoteSessionId), false)
  }
})

test('pump and admission never wait for a session/model call', async t => {
  let release
  const pending = new Promise(resolve => { release = resolve })
  const h = await harness(t, { sessions: { async create() { await pending } } })
  await h.worker.accept(submit('one'))
  await h.worker.pump()
  assert.equal((await h.ledger.get('one')).state, 'dispatching')
  await h.worker.accept(submit('two', 'gamma'))
  await h.worker.pump()
  assert.equal((await h.ledger.get('two')).state, 'dispatching')
  await h.worker.close()
  release()
  await settle(h.worker)
  assert.equal(h.calls.prompt.length, 0)
  assert.ok(h.calls.cancel.includes('hub-one'))
  assert.ok(h.calls.cancel.includes('hub-two'))
})

test('cold restart reconciles running and dispatching; waiting execution remains waiting with no LLM replay', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('active'))
  await running(h, 'active')
  await h.worker.accept(submit('waiting', 'gamma'))
  await running(h, 'waiting')
  await h.worker.park('waiting', { executionId: 'execution-waiting', reason: 'Long training' })
  await settle(h.worker)
  await h.worker.close()
  const count = h.calls.prompt.length
  const worker = h.makeWorker()
  h.workers.push(worker)
  await worker.initialize()
  assert.equal((await h.ledger.get('active')).state, 'reconciling')
  assert.equal((await h.ledger.get('active')).notification.worker.operatorNeeded, true)
  assert.equal((await h.ledger.get('waiting')).state, 'waiting_execution')
  assert.equal(h.calls.prompt.length, count)
  assert.equal(await worker.beforeStep('hub-active'), false)
  assert.equal(await worker.beforeStep('hub-waiting'), false)
  assert.equal(h.calls.observe.length, 2)

  // Persisted create/prompt intent is equally ambiguous even before session receipt.
  await h.ledger.mutate('active', task => { task.state = 'dispatching' })
  await worker.close()
  const again = h.makeWorker()
  h.workers.push(again)
  await again.initialize()
  assert.equal((await h.ledger.get('active')).state, 'reconciling')
  assert.equal(h.calls.prompt.length, count)
})

test('configuration is pinned and changed project pauses queued/waiting tasks', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.park('one', { executionId: 'execution-one', reason: 'Training' })
  await h.worker.accept(submit('two'))
  await h.worker.close()
  const worker = h.makeWorker({ nodeId: 'local', projects: projects.map(project => ({ ...project, root: `${project.root}-changed` })) })
  h.workers.push(worker)
  await worker.initialize()
  assert.equal((await h.ledger.get('one')).state, 'reconciling')
  assert.equal((await h.ledger.get('two')).state, 'reconciling')
  assert.equal(h.calls.prompt.length, 1)
})

test('wake validates execution identity, deduplicates concurrent and repeated terminal events and gates a fresh phase', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  assert.equal(await h.worker.beforeStep('hub-one'), true)
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Training' })
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'wrong', exitCode: 0 }), false)
  const data = { executionId: 'exec-one', resultId: 'result-one', status: 'ended', exitCode: 2, stderr: 'untrusted diagnostics' }
  const results = await Promise.all([h.worker.wakeExecution('one', data), h.worker.wakeExecution('one', data)])
  assert.deepEqual(results.sort(), [false, true])
  await waitFor(() => h.calls.prompt.length === 2)
  const task = await h.ledger.get('one')
  assert.equal(task.state, 'running')
  assert.equal(task.result, undefined)
  assert.equal(task.notification.worker.steps, 0)
  assert.equal(task.notification.worker.failureDiagnosticUsed, true)
  assert.equal(h.calls.prompt[1].task.notification.worker.phaseNumber, 2)
  assert.notEqual(h.calls.prompt[0].phaseId, h.calls.prompt[1].phaseId)
  assert.match(h.calls.prompt[1].text, /NOT instructions or task success/)
  assert.match(h.calls.prompt[1].text, /"exitCode":2/)
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Do not duplicate event' })
  assert.equal(await h.worker.wakeExecution('one', { ...data, eventId: 'another-event' }), false)
  await settle(h.worker)
  assert.equal(h.calls.prompt.length, 2)
})

test('a stale phase rejection does not cancel a newly awakened Agent turn', async t => {
  const h = await harness(t)
  let rejectOld
  h.sessions.prompt = async (task, phaseId, text) => {
    h.calls.prompt.push({ task, phaseId, text })
    if (h.calls.prompt.length === 1) await new Promise((resolve, reject) => { rejectOld = reject })
  }
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Long run' })
  await h.worker.wakeExecution('one', { executionId: 'exec-one', exitCode: 0 })
  await waitFor(() => h.calls.prompt.length === 2)
  rejectOld(new Error('old turn cancelled'))
  await settle(h.worker)
  assert.equal((await h.ledger.get('one')).state, 'running')
  assert.deepEqual(h.calls.cancel, [])
})

test('one failure diagnostic per task including nested runner outcomes; uncertain receipt needs humans', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Run' })
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'exec-one', result: { executionId: 'wrong', exitCode: 2 } }), false)
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'exec-one', status: 'running' }), false)
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'exec-one', status: 'ended', result: { executionId: 'exec-one', exitCode: 2 } }), true)
  await waitFor(() => h.calls.prompt.length === 2)
  await h.worker.park('one', { executionId: 'exec-two', reason: 'Another failed execution' })
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'exec-two', status: 'ended', exitCode: 2 }), false)
  assert.equal((await h.ledger.get('one')).state, 'waiting_human')
  assert.equal(h.calls.prompt.length, 2)
  await h.worker.accept(submit('two', 'gamma'))
  await running(h, 'two')
  await h.worker.park('two', { executionId: 'uncertain', reason: 'Need receipt' })
  assert.equal(await h.worker.wakeExecution('two', { executionId: 'uncertain', status: 'unknown' }), false)
  assert.equal((await h.ledger.get('two')).state, 'waiting_human')
  assert.equal(h.calls.prompt.length, 3)
})

test('20-step default and active deadline are durable; cap pauses and cancels once after callback', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  for (let index = 0; index < 20; index += 1) assert.equal(await h.worker.beforeStep('hub-one'), true)
  assert.equal((await h.ledger.get('one')).notification.worker.steps, 20)
  assert.equal(await h.worker.beforeStep('hub-one'), false)
  assert.equal(await h.worker.beforeStep('hub-one'), false)
  await waitFor(() => h.calls.cancel.includes('hub-one'))
  assert.equal(h.calls.cancel.filter(id => id === 'hub-one').length, 1)
  assert.equal((await h.ledger.get('one')).state, 'waiting_human')
  await h.worker.accept(submit('two', 'gamma'))
  await running(h, 'two')
  h.setTime(601000)
  assert.equal(await h.worker.beforeStep('hub-two'), false)
  assert.equal((await h.ledger.get('two')).state, 'waiting_human')
  assert.equal(await h.worker.beforeStep('unrelated'), false)
})

test('worker metadata preserves controller notification metadata, and changed fires for every committed revision', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await settle(h.worker)
  await h.ledger.mutate('one', task => { task.notification.remoteRevisionHint = 'keep'; task.notification.reportedState = 'keep' })
  const count = h.calls.changed
  const revision = (await h.ledger.get('one')).revision
  await h.worker.beforeStep('hub-one')
  await h.worker.park('one', { reason: 'External manual observation' })
  const task = await h.ledger.get('one')
  assert.equal(task.notification.remoteRevisionHint, 'keep')
  assert.equal(task.notification.reportedState, 'keep')
  assert.equal(h.calls.changed - count, task.revision - revision)
})

test('cancel and close affect only task Agents/observers, never kill persistent training or unrelated sessions', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.park('one', { executionId: 'exec-one', reason: 'Persistent training' })
  await h.worker.cancel('one')
  assert.equal((await h.ledger.get('one')).state, 'cancelled')
  assert.deepEqual(h.calls.cancel, ['hub-one'])
  assert.deepEqual(h.calls.flush, ['hub-one'])
  assert.deepEqual(h.calls.unobserve, ['exec-one'])
  assert.deepEqual(h.calls.kill, [])
  assert.equal(await h.worker.wakeExecution('one', { executionId: 'exec-one', exitCode: 0 }), false)
  await h.worker.accept(submit('two'))
  await running(h, 'two')
  await h.worker.park('two', { executionId: 'exec-two', reason: 'Persistent training' })
  await h.worker.close()
  assert.deepEqual(h.calls.kill, [])
  assert.ok(h.calls.unobserve.includes('exec-two'))
  assert.deepEqual(h.calls.cancel, ['hub-one', 'hub-two'])
  assert.equal(await h.worker.beforeStep('hub-two'), false)
  await assert.rejects(h.worker.accept(submit('three')), { code: 'TASK_WORKER_CLOSED' })
})

test('cancellation tombstone prevents a delayed unacknowledged submit from ever starting an Agent', async t => {
  const h = await harness(t)
  const original = submit('late', 'alpha', { originSessionId: 'origin-1' })
  const cancelled = await h.worker.cancel('late', original)
  assert.equal(cancelled.state, 'cancelled')
  const late = await h.worker.accept(original)
  await settle(h.worker)
  assert.equal(late.state, 'cancelled')
  assert.equal(h.calls.create.length, 0)
  assert.equal(h.calls.prompt.length, 0)
  await assert.rejects(h.worker.cancel('wrong', original), /identity mismatch/)
  await assert.rejects(h.worker.accept({ ...original, instruction: 'different' }), /differ|mismatch/i)
})

test('explicit resume is idempotent, cannot bypass live approval, and invalidates stale deferred cancellation', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  await h.worker.approvalWaiting('hub-one', true)
  await assert.rejects(h.worker.resume('one', { instruction: 'ignore approval', requestId: 'resume-blocked' }), /cannot approve or bypass/)
  await h.worker.approvalWaiting('hub-one', false)
  await h.worker.finish('one', { outcome: 'needs_input', summary: 'Which checkpoint?', evidence: [] })
  await h.worker.resume('one', { instruction: 'Use step 100000', requestId: 'resume-1' })
  await settle(h.worker)
  await new Promise((resolve) => setImmediate(resolve))
  await settle(h.worker)
  assert.equal((await h.ledger.get('one')).state, 'running')
  assert.equal(h.calls.prompt.length, 2)
  assert.equal(h.calls.cancel.length, 0)
  await h.worker.resume('one', { instruction: 'Use step 100000', requestId: 'resume-1' })
  await settle(h.worker)
  assert.equal(h.calls.prompt.length, 2)
  await assert.rejects(h.worker.resume('one', { instruction: 'Use another checkpoint', requestId: 'resume-1' }), /different input/)
})

test('live human waits pause once, count overlapping callbacks and exclude waiting time without new prompts', async t => {
  const h = await harness(t)
  await h.worker.accept(submit('one'))
  await running(h, 'one')
  assert.equal(await h.worker.beforeStep('hub-one'), true)
  assert.equal(await h.worker.approvalWaiting('hub-one', true), true)
  assert.equal(await h.worker.approvalWaiting('hub-one', true), true)
  assert.equal(await h.worker.beforeStep('hub-one'), false)
  h.setTime(900000)
  await h.worker.approvalWaiting('hub-one', false)
  assert.equal((await h.ledger.get('one')).state, 'waiting_human')
  await h.worker.approvalWaiting('hub-one', false)
  assert.equal((await h.ledger.get('one')).state, 'running')
  assert.equal(await h.worker.beforeStep('hub-one'), true)
  assert.equal((await h.ledger.get('one')).notification.worker.steps, 2)
  assert.equal(h.calls.prompt.length, 1)
  assert.equal(await h.worker.approvalWaiting('unrelated', true), false)
  await h.worker.approvalWaiting('hub-one', true)
  await h.worker.close()
  const worker = h.makeWorker()
  h.workers.push(worker)
  await worker.initialize()
  assert.equal(await worker.approvalWaiting('hub-one', false), false)
  assert.equal((await h.ledger.get('one')).state, 'waiting_human')
})
