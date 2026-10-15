import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteController, followRunEvents } from '../src/remote/controller.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const questions = (id = 'request-question') => ({ id, kind: 'questions', createdAt: 1,
  questions: [{ id: 'choice', question: 'Choose a mode', options: [{ label: 'A' }, { label: 'B' }] }] })
const approval = (id = 'request-approval') => ({ id, kind: 'approval', createdAt: 2,
  toolName: 'bash', callId: 'worker-call', reason: 'Needs permission', displayReason: { en: 'Remote permission' } })
const answer = { answers: [{ id: 'choice', selected: ['A'] }] }
function seed(f, extra = {}) {
  const record = { ...f.input, originSessionId: 'parent', state: 'waiting_input', requests: [questions()], revision: 1, ...extra }
  f.records.set(record.runId, record)
  return record
}
const planReview = (id = 'request-review') => {
  const review = questions(id)
  review.questions[0].detail = '# Remote plan'
  review.questions[0].intent = { kind: 'plan-review', approve: 'A', callId: 'worker-plan-call' }
  return review
}
function forbidAutomaticInteraction(f) {
  const unexpected = () => { f.automaticInteractions.push('unexpected native interaction'); throw new Error('No automatic interaction') }
  f.ctx.userQuestions = { ask: unexpected }
  f.ctx.approval = { request: unexpected }
  f.ctx.waterfall = unexpected
}

function fixture(t, overrides = {}) {
  const records = new Map(), reports = [], requests = []
  let tail = Promise.resolve()
  const serial = operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next }
  const store = { get: (_table, id) => structuredClone(records.get(id)), list: () => [...records.values()].map(value => structuredClone(value)),
    put: async (_table, id, value) => serial(() => { records.set(id, structuredClone(value)); return value }),
    mutate: async (_table, id, callback) => serial(async () => { const next = await callback(structuredClone(records.get(id))); if (next) records.set(id, structuredClone(next)); return next }) }
  const ctx = { sessionController: { inspect: async () => ({}), prompt: async input => { reports.push(input) } },
    sessions: { get: () => ({}), flush: async () => true }, workspaceRegistry: { archivedSessionIds: [] } }
  const connections = { request: async (_target, path, options) => { requests.push({ path, options }); return { run: { runId: options.input.runId, state: 'completed', stopReason: 'completed', output: [{ type: 'text', text: 'Finished' }] } } },
    get: async () => ({ endpoint: 'http://127.0.0.1:3081/', instanceId: 'worker', cookie: 'private-cookie' }), ...overrides }
  const controller = new RemoteController(ctx, store, connections), automaticInteractions = []
  t.after(async () => { await controller.close(); assert.deepEqual(automaticInteractions, []) })
  const input = { runId: 'remote-run-1', targetId: 'target-1', workspaceId: 'workspace-1', prompt: 'inspect', description: 'Check', background: true }
  return { controller, ctx, store, records, input, reports, requests, automaticInteractions }
}

test('even instant completion reports once; native run has no local shadow Agent', async t => {
  const f = fixture(t)
  const run = await f.controller.start(f.input, { id: 'parent' }, new AbortController().signal)
  assert.equal(run.localAgent, undefined)
  assert.equal((await run.result).stopReason, 'completed')
  assert.equal(f.reports.length, 1)
  await Promise.all([f.controller.report(f.records.get(f.input.runId)), f.controller.report(f.records.get(f.input.runId))])
  await run.dispose()
  assert.equal(f.reports.length, 1)
  assert.equal(f.requests.length, 1, 'disposing terminal run does not interrupt')
  assert.equal(f.reports[0].requestId, 'hub-result-remote-run-1')
  await assert.rejects(f.controller.start({ ...f.input, prompt: 'different' }, { id: 'parent' }, new AbortController().signal), /different task/)
})

test('foreground result does not inject a duplicate report into the parent', async t => {
  const f = fixture(t)
  const run = await f.controller.start({ ...f.input, background: false }, { id: 'parent' }, new AbortController().signal)
  assert.deepEqual((await run.result).output, [{ type: 'text', text: 'Finished' }])
  assert.equal(f.reports.length, 0)
})

test('definitive rejection has a terminal record and no reconnect observer', async t => {
  const f = fixture(t, { request: async () => { throw Object.assign(new Error('Rejected'), { code: 'REMOTE_HTTP', remoteStatus: 400 }) } })
  await assert.rejects(f.controller.start(f.input, { id: 'parent' }, new AbortController().signal), /拒绝派单/)
  assert.equal(f.records.get(f.input.runId).state, 'error')
  assert.equal(f.controller.active.size, 0)
  assert.equal(f.reports.length, 0)
})

test('lost submit response stays unknown; reconnection never sends another POST or calls a model', async t => {
  let posts = 0, streamAttempts = 0
  const f = fixture(t, { request: async () => { posts++; throw Object.assign(new Error('Disconnected'), { code: 'REMOTE_TRANSPORT' }) } })
  f.controller.fetchImpl = async () => { streamAttempts++; throw new Error('Disconnected') }
  await assert.rejects(f.controller.start(f.input, { id: 'parent' }, new AbortController().signal), /尚未确认/)
  assert.equal(f.records.get(f.input.runId).state, 'connection_lost')
  await f.controller.close()
  assert.equal(posts, 1)
  assert.ok(streamAttempts <= 1)
  assert.equal(f.reports.length, 0)
})

test('startup cancellation sends an independent interrupt and drain, without claiming another task', async t => {
  const ac = new AbortController(), paths = []
  const f = fixture(t, { request: async (_target, path, options) => {
    paths.push(path)
    if (path === '/runs') { ac.abort(); throw Object.assign(new Error('aborted'), { code: 'REMOTE_TRANSPORT' }) }
    assert.equal(options?.signal, undefined, 'cleanup must not inherit the already-aborted submit signal')
    return { run: { runId: 'remote-run-1', state: 'interrupted', stopReason: 'aborted', output: [] } }
  } })
  await assert.rejects(f.controller.start(f.input, { id: 'parent' }, ac.signal), /已取消提交/)
  assert.deepEqual(paths, ['/runs', '/runs/remote-run-1/interrupt', '/runs/remote-run-1/drain'])
  assert.equal(f.records.get(f.input.runId).state, 'interrupted')
  assert.equal(f.reports.length, 0)
  const status = await f.controller.status(f.input.runId, 'parent')
  assert.equal(Object.values(status).includes(undefined), false)
})

test('native disposal waits for cancellation drain without a model-check loop', async t => {
  let release
  const drain = new Promise(resolve => { release = resolve })
  const paths = []
  const f = fixture(t, { request: async (_target, path, options) => {
    paths.push(path)
    if (path.endsWith('/drain')) await drain
    return { run: { runId: options?.input?.runId || 'remote-run-1', state: 'interrupted', stopReason: 'aborted', output: [] } }
  } })
  const run = await f.controller.start({ ...f.input, background: false }, { id: 'parent' }, new AbortController().signal)
  await run.result
  let disposed = false
  const disposing = run.dispose().then(() => { disposed = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(disposed, false)
  release()
  await disposing
  assert.deepEqual(paths, ['/runs', '/runs/remote-run-1/drain'])
  assert.equal(f.reports.length, 0)
})

test('failed report checkpoint can be retried with the same admission ID, not another conversation', async t => {
  const f = fixture(t)
  let flushed = false
  f.ctx.sessions.flush = async () => flushed
  const run = await f.controller.start(f.input, { id: 'parent' }, new AbortController().signal)
  await run.result
  assert.equal(f.records.get(f.input.runId).reportDelivered, undefined)
  flushed = true
  await f.controller.report(f.records.get(f.input.runId))
  assert.equal(f.records.get(f.input.runId).reportDelivered, true)
  assert.ok(f.reports.every(report => report.sessionId === 'parent' && report.requestId === 'hub-result-remote-run-1'))
})

test('archived/missing parent does not create a replacement session', async t => {
  const f = fixture(t)
  f.ctx.workspaceRegistry.archivedSessionIds = ['parent']
  const run = await f.controller.start(f.input, { id: 'parent' }, new AbortController().signal)
  await run.result
  assert.equal(f.reports.length, 0)
  assert.equal(f.records.get(f.input.runId).reportDelivered, undefined)
})

test('foreground requests are returned to tools, without queued prompts or automatic dialogs', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'waiting_approval',
    requests: [questions(), approval(), planReview()], prompt: 'PRIVATE-PROMPT', origin: 'PRIVATE-ORIGIN' })
  forbidAutomaticInteraction(f)
  await f.controller.accept(record, { ...record, revision: 2 })
  const pending = await f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal)
  assert.deepEqual(pending, await f.controller.status(record.runId, 'parent'))
  assert.deepEqual(pending.requests, record.requests)
  assert.ok(!/PRIVATE-|originSessionId|nativeRequestIds|prompt/.test(JSON.stringify(pending)))
  await tick()
  assert.equal(f.reports.length, 0)
  assert.equal(f.requests.length, 0)
})

test('waitForInteraction sees requests already present before registration and arriving during registration', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  assert.deepEqual((await f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal)).requests, [questions()])
  await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'running', requests: [] })
  const waiting = f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal)
  await f.controller.accept(record, { runId: record.runId, revision: 3, state: 'waiting_approval', requests: [approval()] })
  assert.deepEqual((await waiting).requests, [approval()])
  assert.equal(f.reports.length, 0)
})

test('waitForInteraction ignores withdrawn and unrelated requests until this run has pending input', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'running', requests: [] })
  const other = { ...record, runId: 'other-run' }
  f.records.set(other.runId, other)
  let settled = false
  const waiting = f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal).then(value => { settled = true; return value })
  await tick()
  await f.controller.accept(other, { runId: other.runId, revision: 2, state: 'waiting_input', requests: [questions()] })
  await f.controller.accept(record, { runId: record.runId, revision: 3, state: 'running', requests: [] })
  await tick()
  assert.equal(settled, false)
  await f.controller.accept(record, { runId: record.runId, revision: 4, state: 'waiting_input', requests: [planReview()] })
  assert.deepEqual((await waiting).requests, [planReview()])
})

test('waitForInteraction cancellation does not respond to or interrupt the remote run', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
  const ac = new AbortController()
  const waiting = f.controller.waitForInteraction(record.runId, 'parent', ac.signal)
  const rejected = assert.rejects(waiting)
  await tick()
  ac.abort()
  await rejected
  await assert.rejects(f.controller.waitForInteraction(record.runId, 'parent', ac.signal))
  await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'waiting_input', requests: [questions()] })
  assert.deepEqual((await f.controller.status(record.runId, 'parent')).requests, [questions()])
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
})

test('waitForInteraction returns null on each terminal state, including terminal before waiting', async t => {
  for (const state of ['completed', 'error', 'interrupted']) {
    await t.test(state, async t => {
      const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
      const waiting = f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal)
      await tick()
      await f.controller.accept(record, { runId: record.runId, revision: 2, state, requests: [] })
      assert.equal(await waiting, null)
      assert.equal(await f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal), null)
      assert.equal(f.requests.length, 0)
      assert.equal(f.reports.length, 0)
    })
  }
})

test('waitForInteraction and yieldForInput enforce ownership before exposing or changing a run', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  const before = structuredClone(record)
  for (const runId of [record.runId, 'missing-run']) {
    await assert.rejects(f.controller.waitForInteraction(runId, 'intruder', new AbortController().signal), /belong/)
    await assert.rejects(f.controller.yieldForInput(runId, 'intruder'), /belong/)
  }
  assert.deepEqual(f.records.get(record.runId), before)
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
})

test('yieldForInput returns pending requests and deduplicates those notifications, not future requests', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'waiting_approval', requests: [questions(), approval(), planReview()] })
  forbidAutomaticInteraction(f)
  const pending = await f.controller.yieldForInput(record.runId, 'parent')
  assert.deepEqual(pending, await f.controller.status(record.runId, 'parent'))
  assert.deepEqual(pending.requests, record.requests)
  assert.equal(f.records.get(record.runId).background, true)
  assert.deepEqual([...f.records.get(record.runId).notifiedRequests].sort(), record.requests.map(request => request.id).sort())
  await f.controller.yieldForInput(record.runId, 'parent')
  await f.controller.accept(record, { ...record, revision: 2 })
  await tick()
  assert.equal(f.reports.length, 0, 'requests already returned by the tool must not queue another prompt')
  const next = approval('request-next')
  await f.controller.accept(record, { ...record, revision: 3, requests: [...record.requests, next] })
  await tick()
  assert.deepEqual(f.reports.map(report => report.requestId), ['hub-question-remote-run-1-request-next'])
  assert.equal(f.requests.length, 0)
})

test('interrupt acknowledgement settles a pending foreground interaction wait without SSE', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
  const waiting = f.controller.waitForInteraction(record.runId, 'parent', new AbortController().signal)
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: 2, state: 'interrupted', stopReason: 'aborted', requests: [] } }
  }
  const status = await f.controller.interrupt(record.runId, 'parent')
  assert.equal(status.state, 'interrupted')
  assert.equal(await waiting, null)
  assert.deepEqual(f.requests.map(item => item.path), ['/runs/remote-run-1/interrupt'])
})

test('background notification is durable, stable and deduplicated across snapshots and recovery', async t => {
  const f = fixture(t)
  const record = seed(f, { requests: [questions(), approval()], prompt: 'PRIVATE-PROMPT', origin: 'PRIVATE-ORIGIN',
    responseReceipts: { secret: 'PRIVATE-RECEIPT' } })
  forbidAutomaticInteraction(f)
  await Promise.all([f.controller.accept(record, { ...record, revision: 2 }), f.controller.accept(record, { ...record, revision: 2 })])
  await tick()
  assert.equal(f.reports.length, 2)
  assert.deepEqual([...f.records.get(record.runId).notifiedRequests].sort(), ['request-approval', 'request-question'])
  assert.deepEqual(f.reports.map(item => item.requestId).sort(), ['hub-question-remote-run-1-request-approval', 'hub-question-remote-run-1-request-question'])
  assert.ok(f.reports.every(item => item.sessionId === 'parent' && item.mode === 'queue'))
  assert.ok(f.reports.every(item => !/PRIVATE-|private-cookie/.test(JSON.stringify(item))))
  const restored = new RemoteController(f.ctx, f.store, { ...f.controller.connections, get: async () => undefined })
  t.after(() => restored.close())
  await restored.initialize()
  await tick()
  assert.equal(f.reports.length, 2)
  assert.equal(f.requests.length, 0, 'initialize recovery only observes, never re-dispatches')
  const publicValue = await restored.status(record.runId, 'parent')
  assert.deepEqual(publicValue.requests, record.requests)
  assert.equal(publicValue.revision, 2)
  assert.ok(!/PRIVATE-|notifiedRequests|originSessionId|responseReceipts|prompt/.test(JSON.stringify(publicValue)))
})

test('every background approval and plan-review notifies the owning model with human-relay guidance', async t => {
  const f = fixture(t), record = seed(f, { state: 'waiting_approval', requests: [approval(), planReview()] })
  forbidAutomaticInteraction(f)
  await f.controller.accept(record, { ...record, revision: 2 })
  await tick()
  assert.equal(f.reports.length, 2)
  assert.deepEqual(f.reports.map(report => report.requestId).sort(), record.requests.map(request => `hub-question-${record.runId}-${request.id}`).sort())
  for (const report of f.reports) {
    assert.equal(report.sessionId, 'parent')
    assert.equal(report.mode, 'queue')
    const text = report.content.map(block => block.text || '').join('\n')
    assert.match(text, /remote_agent_respond/)
    assert.match(text, /用户|人类|human/i)
    if (report.requestId.endsWith('request-approval')) {
      assert.match(text, /allowed-once/)
      assert.match(text, /rejected/)
      assert.match(text, /cancelled/)
    } else assert.match(text, /answers/)
    assert.doesNotMatch(text, /Hub UI|Web UI|网页|GUI/)
  }
  assert.equal(f.requests.length, 0)
  assert.deepEqual(await f.controller.activity(), [await f.controller.status(record.runId, 'parent')])
})

test('legacy requiresHuman metadata never suppresses background approval or plan-review notifications', async t => {
  const f = fixture(t), record = seed(f, { state: 'waiting_approval',
    requests: [{ ...approval(), requiresHuman: true }, { ...planReview(), requiresHuman: true }] })
  forbidAutomaticInteraction(f)
  await f.controller.accept(record, { ...record, revision: 2 })
  await tick()
  assert.equal(f.reports.length, 2)
  const status = await f.controller.status(record.runId, 'parent')
  assert.deepEqual(status.requests, [approval(), planReview()])
  assert.deepEqual(await f.controller.activity(), [status])
})

test('failed notification checkpoint retries the same admission ID and missing parent stays pending', async t => {
  const f = fixture(t), record = seed(f)
  let flushed = false
  f.ctx.sessions.flush = async () => flushed
  await assert.rejects(f.controller.notify(record, record.requests[0]), /checkpoint/)
  assert.equal(f.records.get(record.runId).notifiedRequests, undefined)
  flushed = true
  await f.controller.notify(record, record.requests[0])
  assert.equal(f.reports.length, 2)
  assert.equal(f.reports[0].requestId, f.reports[1].requestId)
  f.ctx.workspaceRegistry.archivedSessionIds = ['parent']
  const other = questions('request-other')
  f.records.get(record.runId).requests.push(other)
  await f.controller.notify(record, other)
  assert.equal(f.reports.length, 2)
  assert.ok(!f.records.get(record.runId).notifiedRequests.includes(other.id))
})

test('respond validates owner, original request and answers before any POST, without a human flag', async t => {
  const f = fixture(t), record = seed(f, { background: false, requests: [questions(), approval(), planReview()] })
  forbidAutomaticInteraction(f)
  for (const request of record.requests) {
    await assert.rejects(f.controller.respond(record.runId, request.id, request.kind === 'approval' ? { outcome: 'allowed-once' } : answer, 'intruder'), /belong/)
  }
  await assert.rejects(f.controller.respond('missing-run', 'request-question', answer, 'parent'), /belong/)
  await assert.rejects(f.controller.status(record.runId, 'intruder'), /belong/)
  await assert.rejects(f.controller.interrupt(record.runId, 'intruder'), /belong/)
  await assert.rejects(f.controller.respond(record.runId, 'request-approval', { outcome: 'allowed-always' }, 'parent'), { code: 'REMOTE_INPUT' })
  await assert.rejects(f.controller.respond(record.runId, 'request-question', { answers: [{ id: 'choice', selected: ['unknown'] }] }, 'parent'), { code: 'REMOTE_INPUT' })
  await assert.rejects(f.controller.respond(record.runId, 'request-review', { answers: [{ id: 'choice', selected: ['unknown'] }] }, 'parent'), { code: 'REMOTE_INPUT' })
  await assert.rejects(f.controller.respond(record.runId, 'request-question', { answers: [{ id: 'other-question', selected: ['A'] }] }, 'parent'), { code: 'REMOTE_INPUT' })
  await assert.rejects(f.controller.respond(record.runId, 'request-missing', answer, 'parent'), { code: 'REMOTE_REQUEST_EXPIRED' })
  assert.equal(f.requests.length, 0)
  const signal = new AbortController().signal
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: f.records.get(record.runId).revision + 1,
      state: 'waiting_input', requests: f.records.get(record.runId).requests.filter(request => !path.includes(request.id)) } }
  }
  const status = await f.controller.respond(record.runId, 'request-question', answer, 'parent', { signal })
  assert.deepEqual(f.requests[0].options.input, { response: answer })
  assert.equal(f.requests[0].options.signal, signal)
  assert.equal(status.requests.length, 2)
  await f.controller.respond(record.runId, 'request-approval', { outcome: 'rejected' }, 'parent')
  await f.controller.respond(record.runId, 'request-review', answer, 'parent')
  assert.equal(f.requests.length, 3)
  assert.deepEqual(f.requests[1].options.input, { response: { outcome: 'rejected' } })
  assert.deepEqual(f.requests[2].options.input, { response: answer })
  await assert.rejects(f.controller.respond(record.runId, 'request-review', answer, 'parent'), { code: 'REMOTE_REQUEST_EXPIRED' })
  assert.equal(f.requests.length, 3, 'an answered request cannot be posted again')
  assert.equal(f.reports.length, 0)
})

test('approval allowed-once, rejected and cancelled are relayed without GUI or human capability flags', async t => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled']) {
    await t.test(outcome, async t => {
      const f = fixture(t), record = seed(f, { background: false, state: 'waiting_approval', requests: [approval()] })
      forbidAutomaticInteraction(f)
      const signal = new AbortController().signal
      f.controller.connections.request = async (_target, path, options) => {
        f.requests.push({ path, options })
        return { run: { runId: record.runId, revision: 2, state: 'running', requests: [] } }
      }
      const status = await f.controller.respond(record.runId, 'request-approval', { outcome }, 'parent', { signal })
      assert.deepEqual(f.requests.map(item => item.path), ['/runs/remote-run-1/requests/request-approval/response'])
      assert.deepEqual(f.requests[0].options.input, { response: { outcome } })
      assert.equal(f.requests[0].options.signal, signal)
      assert.equal(f.requests[0].options.method, 'POST')
      assert.equal(status.state, 'running')
      assert.deepEqual(status.requests, [])
      assert.equal(f.reports.length, 0)
    })
  }
})

test('respond transport failure retains request and explicit retry targets only the same response endpoint', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  let attempts = 0
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options }); attempts++
    if (attempts === 1) throw new Error('Network failed')
    return { run: { runId: record.runId, revision: 2, state: 'running', requests: [] } }
  }
  await assert.rejects(f.controller.respond(record.runId, 'request-question', answer, 'parent'), /Network failed/)
  assert.deepEqual((await f.controller.status(record.runId, 'parent')).requests, record.requests)
  await f.controller.respond(record.runId, 'request-question', answer, 'parent')
  assert.equal(f.requests.length, 2)
  assert.ok(f.requests.every(item => item.path === '/runs/remote-run-1/requests/request-question/response'))
  assert.equal(f.records.get(record.runId).requests.length, 0)
})

test('old snapshots never roll back revisions, answered requests, or terminal states', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  await f.controller.accept(record, { runId: record.runId, revision: 5, state: 'running', requests: [] })
  await f.controller.accept(record, { ...record, revision: 4 })
  await f.controller.accept(record, { ...record, revision: 5 })
  await f.controller.accept(record, { ...record, revision: undefined })
  assert.equal(f.records.get(record.runId).state, 'running')
  assert.equal(f.records.get(record.runId).revision, 5)
  assert.deepEqual(f.records.get(record.runId).requests, [])
  f.records.get(record.runId).state = 'connection_lost'
  await f.controller.accept(record, { runId: record.runId, revision: 4, state: 'waiting_input', requests: [questions()] })
  assert.equal(f.records.get(record.runId).state, 'connection_lost')
  await f.controller.accept(record, { runId: record.runId, revision: 5, state: 'running', requests: [] })
  assert.equal(f.records.get(record.runId).state, 'running', 'same latest snapshot clears only the local connection overlay')
  await assert.rejects(f.controller.accept(record, { ...record, revision: -1 }), /Invalid/)
  await assert.rejects(f.controller.accept(record, { ...record, revision: 6, requests: [{ ...questions(), id: 'invalid-request-id' }] }), { code: 'REMOTE_INPUT' })
  await f.controller.accept(record, { runId: record.runId, revision: 7, state: 'completed', requests: [] })
  await f.controller.accept(record, { ...record, revision: 8 })
  assert.equal(f.records.get(record.runId).state, 'completed')
})

test('cold recovery converts unfinished foreground runs to background and notifies the original session without re-dispatch', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'waiting_approval', requests: [questions(), approval(), planReview()] })
  f.controller.connections.get = async () => undefined
  forbidAutomaticInteraction(f)
  await f.controller.initialize()
  await tick()
  assert.equal(f.records.get(record.runId).background, true)
  assert.equal(f.requests.length, 0, 'recovery must not submit a new task')
  assert.equal(f.reports.length, 3)
  assert.ok(f.reports.every(report => report.sessionId === 'parent' && report.mode === 'queue'))
  assert.deepEqual(f.reports.map(report => report.requestId).sort(), record.requests.map(request => `hub-question-${record.runId}-${request.id}`).sort())
  const restored = new RemoteController(f.ctx, f.store, { ...f.controller.connections, get: async () => undefined })
  t.after(() => restored.close())
  await restored.initialize()
  await tick()
  assert.equal(f.reports.length, 3, 'another recovery does not re-notify existing requests')
  assert.equal(f.requests.length, 0)
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: 2, state: 'running', requests: [] } }
  }
  await f.controller.respond(record.runId, 'request-approval', { outcome: 'allowed-once' }, 'parent')
  assert.deepEqual(f.requests.map(item => item.path), ['/runs/remote-run-1/requests/request-approval/response'])
  assert.deepEqual(f.requests[0].options.input, { response: { outcome: 'allowed-once' } })
})

test('cold recovery also backgrounds running foreground work, but not completed foreground results', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
  const finished = { ...record, runId: 'finished-run', state: 'completed' }
  f.records.set(finished.runId, finished)
  f.controller.connections.get = async () => undefined
  forbidAutomaticInteraction(f)
  await f.controller.initialize()
  await tick()
  assert.equal(f.records.get(record.runId).background, true)
  assert.equal(f.records.get(finished.runId).background, false)
  assert.equal(f.reports.length, 0)
  await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'waiting_approval', requests: [approval()] })
  await tick()
  assert.deepEqual(f.reports.map(report => report.requestId), ['hub-question-remote-run-1-request-approval'])
  assert.equal(f.reports[0].sessionId, 'parent')
  assert.equal(f.requests.length, 0)
})

test('foreground SSE withdrawal and completion stay live without answering a pending request', async t => {
  const f = fixture(t)
  forbidAutomaticInteraction(f)
  let stream
  f.controller.fetchImpl = async (_url, init) => new Response(new ReadableStream({ start(value) {
    stream = value
    init.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } })
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: f.input.runId, revision: 1, state: 'waiting_approval', requests: [approval()] } }
  }
  const run = await f.controller.start({ ...f.input, background: false }, { id: 'parent' }, new AbortController().signal)
  await tick()
  assert.deepEqual((await f.controller.waitForInteraction(f.input.runId, 'parent', new AbortController().signal)).requests, [approval()])
  const emit = remote => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run: remote })}\n\n`))
  emit({ runId: f.input.runId, revision: 2, state: 'running', requests: [] })
  await tick()
  assert.deepEqual((await f.controller.status(f.input.runId, 'parent')).requests, [])
  await assert.rejects(f.controller.respond(f.input.runId, 'request-approval', { outcome: 'allowed-once' }, 'parent'), { code: 'REMOTE_REQUEST_EXPIRED' })
  const waiting = f.controller.waitForInteraction(f.input.runId, 'parent', new AbortController().signal)
  emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [], output: [{ type: 'text', text: 'Done' }] })
  assert.equal(await waiting, null)
  assert.deepEqual((await run.result).output, [{ type: 'text', text: 'Done' }])
  assert.equal(f.reports.length, 0)
  assert.deepEqual(f.requests.map(item => item.path), ['/runs'])
})

test('snapshot-first SSE accepts completion, checks identity and releases its reader', async () => {
  const connection = { endpoint: 'http://127.0.0.1:3081/', cookie: 'private-cookie', instanceId: 'worker' }
  for (const instanceId of ['worker', 'replacement']) {
    const envelope = { version: 1, instanceId, run: { runId: 'run1', state: 'completed' } }
    let cancelled = false, requested
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`: heartbeat\n\nevent: run\ndata: ${JSON.stringify(envelope)}\n\n`)) }, cancel() { cancelled = true } })
    const receive = []
    const promise = followRunEvents(connection, 'run1', run => receive.push(run), { signal: new AbortController().signal,
      fetchImpl: async (url, init) => { requested = { url, init }; return new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) } })
    if (instanceId === 'worker') { await promise; assert.equal(receive[0].state, 'completed') }
    else await assert.rejects(promise, /identity changed/)
    assert.equal(cancelled, true)
    assert.equal(String(requested.url), 'http://127.0.0.1:3081/api/dsh-server-hub/remote/runs/run1/events')
    assert.deepEqual(requested.init.headers, { cookie: 'private-cookie', accept: 'text/event-stream' })
    assert.equal(requested.init.redirect, 'error')
  }
})
