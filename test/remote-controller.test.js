import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteController, followRunEvents } from '../src/remote/controller.js'

// Exercise installed DSH's actual services and Cordis waterfalls, not a mocked
// ctx.waterfall signature. Portable installs without DSH skip only native tests.
const installed = '/home/ubuntu/.nvm/versions/node/v24.21.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
const nativeRuntime = await Promise.all(['cordis', 'dsh-scope', 'dsh-user-questions', 'dsh-user-approval']
  .map(name => import(`${installed}/${name}/lib/index.js`))).catch(error => {
    if (error.code === 'ERR_MODULE_NOT_FOUND') return undefined
    throw error
  })
const tick = () => new Promise(resolve => setImmediate(resolve))
const questions = (id = 'request-question') => ({ id, kind: 'questions', requiresHuman: false, createdAt: 1,
  questions: [{ id: 'choice', question: 'Choose a mode', options: [{ label: 'A' }, { label: 'B' }] }] })
const approval = (id = 'request-approval') => ({ id, kind: 'approval', requiresHuman: true, createdAt: 2,
  toolName: 'bash', callId: 'worker-call', reason: 'Needs permission', displayReason: { en: 'Remote permission' } })
const answer = { answers: [{ id: 'choice', selected: ['A'] }] }
function seed(f, extra = {}) {
  const record = { ...f.input, originSessionId: 'parent', state: 'waiting_input', requests: [questions()], revision: 1, ...extra }
  f.records.set(record.runId, record)
  return record
}
async function nativeFixture(t, request) {
  const [{ Context }, { createScope, isScopeCarrier, carrierKeyOf }, { UserQuestionService }, { ApprovalService }] = nativeRuntime
  const f = fixture(t)
  const ctx = new Context(), log = [{ type: 'turn/start' }]
  const parent = { id: 'parent', session: { get seq() { return log.length }, eventAt: index => log[index],
    append: (type, data) => log.push({ type, data }) } }
  ctx.provide('agents', { get: id => id === parent.id ? parent : undefined, roots: () => [parent] })
  for (const key of ['sessionController', 'sessions', 'workspaceRegistry']) ctx.provide(key, f.ctx[key])
  new UserQuestionService(ctx)
  new ApprovalService(ctx, { policy: 'ask' })
  ctx.on('internal/dispatch', (mode, event, args, carrier) => {
    if (!['user-questions/request', 'approval/request'].includes(event)) return
    assert.equal(mode, 'waterfall')
    assert.equal(isScopeCarrier(carrier), true)
    assert.equal(carrierKeyOf(carrier), parent)
    assert.equal(args[0].agent, parent)
  }, { global: true })
  const scoped = createScope(ctx, parent), unrelated = createScope(ctx, {})
  let wrongScope = 0
  for (const event of ['user-questions/request', 'approval/request']) unrelated.ctx.on(event, () => { wrongScope++; throw new Error('Wrong scope') })
  t.after(async () => { await scoped.dispose(); await unrelated.dispose() })
  f.controller.ctx = ctx
  let stream
  f.controller.fetchImpl = async (_url, init) => new Response(new ReadableStream({ start(value) {
    stream = value
    init.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } })
  let remote = { runId: f.input.runId, state: request.kind === 'approval' ? 'waiting_approval' : 'waiting_input', revision: 1, requests: [request] }
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    if (path.endsWith('/response')) remote = { ...remote, state: 'running', requests: [], revision: remote.revision + 1 }
    if (path.endsWith('/interrupt')) remote = { ...remote, state: 'interrupted', requests: [], revision: remote.revision + 1 }
    return { run: remote }
  }
  const emit = run => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run })}\n\n`))
  return { ...f, ctx, parent, scoped: scoped.ctx, log, emit, wrongScope: () => wrongScope }
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
  const controller = new RemoteController(ctx, store, connections)
  t.after(() => controller.close())
  const input = { runId: 'remote-run-1', targetId: 'target-1', workspaceId: 'workspace-1', prompt: 'inspect', description: 'Check', background: true }
  return { controller, ctx, store, records, input, reports, requests }
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

test('foreground questions use the exact parent native waterfall and respond in the same run', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, questions())
  let native, respond
  f.scoped.on('user-questions/request', request => { native = request; return new Promise(resolve => { respond = resolve }) })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  assert.equal(native.agent, f.parent)
  assert.deepEqual(native.questions, questions().questions)
  assert.equal(f.requests.length, 1)
  respond(answer)
  await tick()
  assert.equal(f.requests[1].path, `/runs/${f.input.runId}/requests/request-question/response`)
  assert.deepEqual(f.requests[1].options.input, { response: answer, human: true })
  assert.equal(f.records.get(f.input.runId).state, 'running')
  f.emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [], output: [{ type: 'text', text: 'Done' }] })
  assert.equal((await run.result).stopReason, 'completed')
  assert.equal(f.reports.length, 0)
  assert.equal(f.wrongScope(), 0)
  assert.equal(f.requests.filter(item => item.path === '/runs').length, 1)
})

test('foreground approval uses actual audited native waterfall, never a fabricated model answer', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, approval())
  let native, respond
  f.scoped.on('approval/request', request => { native = request; return new Promise(resolve => { respond = resolve }) })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  assert.equal(native.agent, f.parent)
  assert.equal(native.toolName, 'bash')
  assert.deepEqual(native.displayReason, { en: 'Remote permission' })
  assert.equal(f.log[1].type, 'approval/asked')
  respond('allowed-once')
  await tick()
  assert.equal(f.log[2].type, 'approval/decided')
  assert.equal(f.log[2].data.outcome, 'allowed-once')
  assert.deepEqual(f.requests[1].options.input, { response: { outcome: 'allowed-once' }, human: true })
  f.emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [] })
  await run.result
  assert.equal(f.reports.length, 0)
  assert.equal(f.wrongScope(), 0)
})

test('foreground plan-review preserves native presentation intent and requires human bridge', { skip: !nativeRuntime }, async t => {
  const review = questions('request-review')
  review.requiresHuman = true
  review.questions[0].detail = '# Reviewed remote plan'
  review.questions[0].intent = { kind: 'plan-review', approve: 'A', callId: 'worker-plan-call' }
  const f = await nativeFixture(t, review)
  f.scoped.on('user-questions/request', request => {
    assert.deepEqual(request.questions[0].intent, review.questions[0].intent)
    assert.equal(request.questions[0].detail, review.questions[0].detail)
    return answer
  })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  assert.deepEqual(f.requests[1].options.input, { response: answer, human: true })
  f.emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [] })
  await run.result
})

test('a human Hub response withdraws the concurrent native approval without a second response', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, approval())
  let native
  f.scoped.on('approval/request', request => { native = request; return new Promise(resolve => {
    request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }) })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  await f.controller.respond(f.input.runId, 'request-approval', { outcome: 'rejected' }, 'parent', { human: true })
  await tick()
  assert.equal(native.signal.aborted, true)
  assert.equal(f.requests.filter(item => item.path.endsWith('/response')).length, 1)
  assert.equal(f.controller.bridges.size, 0)
  f.emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [] })
  await run.result
})

test('SSE withdrawal/completion is not blocked by a pending native question', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, questions())
  let native
  f.scoped.on('user-questions/request', request => { native = request; return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('withdrawn')), { once: true })
  }) })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  f.emit({ runId: f.input.runId, revision: 2, state: 'running', requests: [] })
  await tick()
  assert.equal(native.signal.aborted, true)
  assert.equal(f.controller.bridges.size, 0)
  assert.equal(f.requests.length, 1)
  f.emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [] })
  await run.result
})

test('foreground cancellation withdraws local approval immediately even if interrupt fails', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, approval())
  let native
  f.scoped.on('approval/request', request => { native = request; return new Promise(resolve => {
    request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })
  }) })
  const signal = new AbortController()
  await f.controller.start({ ...f.input, background: false }, f.parent, signal.signal)
  await tick()
  f.controller.connections.request = async () => { throw new Error('Network unavailable') }
  signal.abort()
  assert.equal(native.signal.aborted, true)
  await tick()
  assert.equal(f.controller.bridges.size, 0)
  assert.equal(f.controller.parents.size, 0)
  assert.equal(f.records.get(f.input.runId).requests.length, 1, 'unconfirmed cancellation preserves the remote request')
  assert.equal(f.requests.length, 1, 'cancelled native result is never submitted as a response')
})

test('interrupt terminal acknowledgement settles foreground and native cleanup without waiting for SSE', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, questions())
  let native
  f.scoped.on('user-questions/request', request => { native = request; return new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
  }) })
  const run = await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  const status = await f.controller.interrupt(f.input.runId, 'parent')
  assert.equal(status.state, 'interrupted')
  assert.equal(native.signal.aborted, true)
  assert.equal((await run.result).stopReason, 'aborted')
  assert.equal(f.controller.bridges.size, 0)
  assert.equal(f.requests.filter(item => item.path.endsWith('/response')).length, 0)
})

test('background notification is durable, stable and deduplicated across snapshots and recovery', async t => {
  const f = fixture(t)
  const record = seed(f, { requests: [questions(), approval()], prompt: 'PRIVATE-PROMPT', origin: 'PRIVATE-ORIGIN',
    responseReceipts: { secret: 'PRIVATE-RECEIPT' } })
  f.ctx.userQuestions = { ask: () => { throw new Error('No background native questions') } }
  f.ctx.approval = { request: () => { throw new Error('No background native approvals') } }
  await Promise.all([f.controller.accept(record, { ...record, revision: 2 }), f.controller.accept(record, { ...record, revision: 2 })])
  await tick()
  assert.equal(f.reports.length, 1)
  assert.deepEqual(f.records.get(record.runId).notifiedRequests, ['request-question'])
  assert.deepEqual(f.reports.map(item => item.requestId), ['hub-question-remote-run-1-request-question'])
  assert.ok(f.reports.every(item => item.sessionId === 'parent' && item.mode === 'queue'))
  assert.ok(f.reports.every(item => !/PRIVATE-|private-cookie/.test(JSON.stringify(item))))
  const restored = new RemoteController(f.ctx, f.store, { ...f.controller.connections, get: async () => undefined })
  t.after(() => restored.close())
  await restored.initialize()
  await tick()
  assert.equal(f.reports.length, 1)
  assert.equal(f.requests.length, 0, 'initialize recovery only observes, never re-dispatches')
  const publicValue = await restored.status(record.runId, 'parent')
  assert.deepEqual(publicValue.requests, record.requests)
  assert.equal(publicValue.revision, 2)
  assert.ok(!/PRIVATE-|notifiedRequests|originSessionId|responseReceipts|prompt/.test(JSON.stringify(publicValue)))
})

test('human-only background requests route to the owning Web chat without waking a model or entering native answerers', async t => {
  const f = fixture(t), review = questions('request-review')
  review.questions[0].detail = '# Remote plan'
  review.questions[0].intent = { kind: 'plan-review', approve: 'A' }
  review.requiresHuman = true
  const record = seed(f, { state: 'waiting_approval', requests: [approval(), review] })
  f.ctx.userQuestions = { ask: () => assert.fail('Background review must be answered in Web UI') }
  f.ctx.approval = { request: () => assert.fail('Idle parent must not run an approval waterfall') }
  await f.controller.accept(record, { ...record, revision: 2 })
  await tick()
  await f.controller.notify(record, record.requests[0])
  assert.equal(f.reports.length, 0)
  const [activity] = await f.controller.activity()
  assert.equal(activity.originSessionId, 'parent')
  assert.deepEqual(activity.requests, record.requests)
  assert.deepEqual(activity.nativeRequestIds, [])
  assert.equal(f.controller.bridges.size, 0)
  assert.equal((await f.controller.status(record.runId, 'parent')).originSessionId, undefined, 'only Web activity receives chat routing data')
})

test('Web activity excludes a request already presented through a live native bridge, then restores fallback when bridge is released', { skip: !nativeRuntime }, async t => {
  const f = await nativeFixture(t, approval())
  f.scoped.on('approval/request', request => new Promise(resolve => request.signal.addEventListener('abort', () => resolve('cancelled'), { once: true })))
  await f.controller.start({ ...f.input, background: false }, f.parent, new AbortController().signal)
  await tick()
  assert.deepEqual((await f.controller.activity())[0].nativeRequestIds, ['request-approval'])
  f.controller.releaseParent(f.input.runId)
  assert.deepEqual((await f.controller.activity())[0].nativeRequestIds, [])
  assert.deepEqual((await f.controller.activity())[0].requests, [approval()])
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

test('respond enforces owner, human-only approval/review and interaction validation before any POST', async t => {
  const f = fixture(t), review = questions('request-review')
  review.requiresHuman = true
  review.questions[0].detail = '# Proposed plan'
  review.questions[0].intent = { kind: 'plan-review', approve: 'A' }
  const record = seed(f, { background: false, requests: [questions(), approval(), review] })
  await assert.rejects(f.controller.respond(record.runId, 'request-question', answer, 'intruder', { human: true }), /belong/)
  await assert.rejects(f.controller.respond(record.runId, 'request-approval', { outcome: 'allowed-once' }, 'parent'), { code: 'REMOTE_HUMAN_REQUIRED' })
  await assert.rejects(f.controller.respond(record.runId, 'request-review', answer, 'parent'), { code: 'REMOTE_HUMAN_REQUIRED' })
  await assert.rejects(f.controller.respond(record.runId, 'request-question', { answers: [{ id: 'choice', selected: ['unknown'] }] }, 'parent'), { code: 'REMOTE_INPUT' })
  await assert.rejects(f.controller.respond(record.runId, 'request-missing', answer, 'parent'), { code: 'REMOTE_REQUEST_EXPIRED' })
  assert.equal(f.requests.length, 0)
  const signal = new AbortController().signal
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: f.records.get(record.runId).revision + 1,
      state: 'waiting_input', requests: f.records.get(record.runId).requests.filter(request => !path.includes(request.id)) } }
  }
  const status = await f.controller.respond(record.runId, 'request-question', answer, 'parent', { signal })
  assert.deepEqual(f.requests[0].options.input, { response: answer, human: false })
  assert.equal(f.requests[0].options.signal, signal)
  assert.equal(status.requests.length, 2)
  await f.controller.respond(record.runId, 'request-approval', { outcome: 'rejected' }, 'parent', { human: true })
  await f.controller.respond(record.runId, 'request-review', answer, 'parent', { human: true })
  assert.equal(f.requests.length, 3)
  assert.deepEqual(f.requests[1].options.input, { response: { outcome: 'rejected' }, human: true })
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
  await assert.rejects(f.controller.accept(record, { ...record, revision: 6, requests: [{ ...questions(), requiresHuman: true }] }), { code: 'REMOTE_INPUT' })
  await f.controller.accept(record, { runId: record.runId, revision: 7, state: 'completed', requests: [] })
  await f.controller.accept(record, { ...record, revision: 8 })
  assert.equal(f.records.get(record.runId).state, 'completed')
})

test('restored foreground requests remain UI-answerable without a fabricated native parent or re-dispatch', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  f.controller.connections.get = async () => undefined
  f.ctx.userQuestions = { ask: () => { throw new Error('Cannot reconstruct a parent') } }
  await f.controller.initialize()
  await tick()
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
  assert.equal(f.controller.bridges.size, 0)
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: 2, state: 'completed', requests: [] } }
  }
  await f.controller.respond(record.runId, 'request-question', answer, 'parent', { human: true })
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].options.input.human, true)
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
