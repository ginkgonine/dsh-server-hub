import test from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
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
  const records = new Map(), reports = [], requests = [], parentEvents = [], flushes = []
  let tail = Promise.resolve()
  const serial = operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next }
  const store = { get: (_table, id) => structuredClone(records.get(id)), list: () => [...records.values()].map(value => structuredClone(value)),
    put: async (_table, id, value) => serial(() => { records.set(id, structuredClone(value)); return value }),
    mutate: async (_table, id, callback) => serial(async () => { const next = await callback(structuredClone(records.get(id))); if (next) records.set(id, structuredClone(next)); return next }) }
  const parentSession = { id: 'parent' }
  const ctx = { sessionController: { inspect: async () => ({ meta: { id: 'parent' }, events: structuredClone(parentEvents) }), prompt: async input => { reports.push(input) } },
    sessions: { get: () => parentSession, flush: async session => { flushes.push(session); return true } }, workspaceRegistry: { archivedSessionIds: [] } }
  const connections = { request: async (_target, path, options) => { requests.push({ path, options }); return { run: { runId: options.input.runId, state: 'completed', stopReason: 'completed', output: [{ type: 'text', text: 'Finished' }] } } },
    get: async () => ({ endpoint: 'http://127.0.0.1:3081/', instanceId: 'worker', cookie: 'private-cookie' }), ...overrides }
  const controller = new RemoteController(ctx, store, connections), automaticInteractions = []
  t.after(async () => { await controller.close(); assert.deepEqual(automaticInteractions, []) })
  const input = { runId: 'remote-run-1', targetId: 'target-1', workspaceId: 'workspace-1', prompt: 'inspect', description: 'Check', background: true }
  return { controller, ctx, store, records, input, reports, requests, automaticInteractions, parentEvents, parentSession, flushes }
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

const nativeNotice = (runId, type = 'user/message') => {
  const message = { source: { kind: 'subagent-settled', senderSessionId: runId } }
  return { type, data: type === 'user/message' ? message : { inserted: [message] } }
}

test('native delivery owns the run before remote submission and checkpoints only after native settlement', async t => {
  for (const type of ['user/message', 'agent/inbox/spliced']) {
    await t.test(type, async t => {
      const f = fixture(t)
      f.controller.connections.request = async (_target, path, options) => {
        f.requests.push({ path, options })
        assert.equal(f.controller.nativeOwners.has(f.input.runId), true, 'ownership precedes even instant remote completion')
        return { run: { runId: f.input.runId, state: 'completed', stopReason: 'completed', output: [{ type: 'text', text: 'Native finished' }] } }
      }
      const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
      assert.equal(f.controller.nativeOwners.has(f.input.runId), true)
      assert.deepEqual((await run.result).output, [{ type: 'text', text: 'Native finished' }])
      assert.equal(f.records.get(f.input.runId).nativeResultReady, true)
      await f.controller.report(f.records.get(f.input.runId))
      assert.equal(f.reports.length, 0, 'provider result must not preempt native manager delivery')
      assert.equal(f.flushes.length, 0)
      assert.equal(f.records.get(f.input.runId).reportDelivered, undefined)
      f.parentEvents.push(nativeNotice(f.input.runId, type))
      await Promise.all([f.controller.nativeSettled(f.input.runId), f.controller.nativeSettled(f.input.runId)])
      assert.equal(f.controller.nativeOwners.has(f.input.runId), false)
      assert.deepEqual(f.flushes, [f.parentSession])
      assert.equal(f.records.get(f.input.runId).reportDelivered, true)
      assert.equal(f.records.get(f.input.runId).reportSource, 'native')
      await f.controller.report(f.records.get(f.input.runId))
      await run.dispose()
      assert.equal(f.reports.length, 0)
      assert.deepEqual(f.requests.map(request => request.path), ['/runs'])
    })
  }
})

test('native ownership forwards live approvals while provider result settles before native delivery', async t => {
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
  const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
  await tick()
  assert.equal(f.controller.nativeOwners.has(f.input.runId), true)
  assert.deepEqual(f.reports.map(report => report.requestId), [`hub-question-${f.input.runId}-request-approval`])
  const completed = { runId: f.input.runId, revision: 2, state: 'completed', requests: [], output: [{ type: 'text', text: 'SSE finished' }] }
  stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run: completed })}\n\n`))
  assert.deepEqual((await run.result).output, completed.output, 'raw result must not depend on receipt settlement or deadlock native disposal')
  await run.dispose()
  assert.equal(f.controller.nativeOwners.has(f.input.runId), true)
  assert.equal(f.reports.length, 1, 'only the approval was delivered by Hub')
  f.parentEvents.push(nativeNotice(f.input.runId))
  await f.controller.nativeSettled(f.input.runId)
  assert.equal(f.records.get(f.input.runId).reportSource, 'native')
  assert.equal(f.reports.length, 1)
  assert.deepEqual(f.requests.map(request => request.path), ['/runs'])
})

test('missing or unrelated native notice falls back to exactly one Hub result prompt', async t => {
  for (const events of [[], [nativeNotice('other-run')], [{ type: 'user/message', data: { source: { kind: 'user', senderSessionId: 'remote-run-1' } } }]]) {
    await t.test(JSON.stringify(events), async t => {
      const f = fixture(t)
      f.parentEvents.push(...events)
      const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
      await run.result
      assert.equal(f.reports.length, 0)
      await Promise.all([f.controller.nativeSettled(f.input.runId), f.controller.nativeSettled(f.input.runId)])
      await f.controller.report(f.records.get(f.input.runId))
      assert.equal(f.reports.length, 1)
      assert.equal(f.reports[0].requestId, `hub-result-${f.input.runId}`)
      assert.equal(f.reports[0].sessionId, 'parent')
      assert.equal(f.records.get(f.input.runId).reportDelivered, true)
      assert.equal(f.records.get(f.input.runId).reportSource, 'hub')
    })
  }
})

test('native notice with failed checkpoint never falls back and retries flushing before marking delivered', async t => {
  const f = fixture(t)
  let flushed = false
  f.ctx.sessions.flush = async session => { f.flushes.push(session); return flushed }
  const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
  await run.result
  f.parentEvents.push(nativeNotice(f.input.runId, 'agent/inbox/spliced'))
  await assert.rejects(f.controller.nativeSettled(f.input.runId), /Native report checkpoint/)
  assert.equal(f.records.get(f.input.runId).reportDelivered, undefined)
  await assert.rejects(f.controller.report(f.records.get(f.input.runId)), /Native report checkpoint/)
  assert.equal(f.reports.length, 0, 'an existing native inbox event cannot be replaced by another prompt')
  flushed = true
  await f.controller.report(f.records.get(f.input.runId))
  assert.equal(f.flushes.length, 3)
  assert.equal(f.records.get(f.input.runId).reportDelivered, true)
  assert.equal(f.records.get(f.input.runId).reportSource, 'native')
  assert.equal(f.reports.length, 0)
})

test('cold native recovery detects durable notices without restoring ownership or sending another result', async t => {
  for (const type of ['user/message', 'agent/inbox/spliced']) {
    await t.test(type, async t => {
      const f = fixture(t), record = seed(f, { resultDelivery: 'native', nativeResultReady: true, state: 'completed', requests: [], output: [{ type: 'text', text: 'Done' }] })
      f.controller.nativeOwners.add(record.runId)
      f.parentEvents.push(nativeNotice(record.runId, type))
      // Cold inspect can read durable events even when the session is not resident.
      f.ctx.sessions.get = () => undefined
      const restored = new RemoteController(f.ctx, f.store, f.controller.connections)
      t.after(() => restored.close())
      assert.equal(restored.nativeOwners.size, 0)
      await restored.initialize()
      await tick()
      assert.equal(f.records.get(record.runId).reportDelivered, true)
      assert.equal(f.records.get(record.runId).reportSource, 'native')
      assert.equal(f.reports.length, 0)
      assert.equal(f.requests.length, 0)
    })
  }
})

test('cold recovery does not mistake an aborted native observation notice for the eventual remote result', async t => {
  for (const type of ['user/message', 'agent/inbox/spliced']) {
    await t.test(type, async t => {
      const f = fixture(t)
      let stream
      const fetchImpl = async (_url, init) => new Response(new ReadableStream({ start(value) {
        stream = value
        init.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
      } }), { headers: { 'content-type': 'text/event-stream' } })
      f.controller.fetchImpl = fetchImpl
      f.controller.connections.request = async (_target, path, options) => {
        f.requests.push({ path, options })
        return { run: { runId: f.input.runId, revision: 1, state: 'running', requests: [] } }
      }
      const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
      await tick()
      assert.equal(f.controller.nativeOwners.has(f.input.runId), true)
      await f.controller.close()
      const aborted = await run.result
      assert.equal(aborted.stopReason, 'aborted')
      assert.match(aborted.diagnostic, /主控连接已停止/)
      assert.equal(f.records.get(f.input.runId).state, 'running')
      assert.notEqual(f.records.get(f.input.runId).nativeResultReady, true)
      // Native manager can announce only that local observation stopped here.
      f.parentEvents.push(nativeNotice(f.input.runId, type))
      await f.controller.nativeSettled(f.input.runId)
      const restored = new RemoteController(f.ctx, f.store, f.controller.connections, { fetchImpl })
      t.after(() => restored.close())
      await restored.initialize()
      await tick()
      const observing = restored.active.get(f.input.runId).done
      assert.equal(f.reports.length, 0)
      const completed = { runId: f.input.runId, revision: 2, state: 'completed', requests: [], output: [{ type: 'text', text: 'Actual remote result after reconnect' }] }
      stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run: completed })}\n\n`))
      assert.deepEqual((await observing).output, completed.output)
      assert.notEqual(f.records.get(f.input.runId).nativeResultReady, true, 'cold observation is not a native result owner')
      assert.equal(f.records.get(f.input.runId).reportDelivered, true)
      assert.equal(f.records.get(f.input.runId).reportSource, 'hub')
      assert.equal(f.reports.length, 1)
      assert.match(f.reports[0].content[0].text, /Actual remote result after reconnect/)
      await restored.report(f.records.get(f.input.runId))
      assert.equal(f.reports.length, 1)
      assert.deepEqual(f.requests.map(request => request.path), ['/runs'], 'recovery observes the original run and never resubmits')
    })
  }
})

test('a terminal response arriving after raw observation aborted cannot authenticate its stale native notice', async t => {
  const f = fixture(t)
  f.controller.fetchImpl = async (_url, init) => new Response(new ReadableStream({ start(value) {
    init.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } })
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: f.input.runId, revision: 1, state: 'running', requests: [] } }
  }
  const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
  await tick()
  await f.controller.close()
  assert.equal((await run.result).stopReason, 'aborted')
  assert.equal(f.controller.nativeOwners.has(f.input.runId), true, 'receipt teardown has not released ownership yet')
  // An already-in-flight HTTP response may arrive after the raw result was captured.
  await f.controller.accept(f.records.get(f.input.runId), { runId: f.input.runId, revision: 2,
    state: 'completed', requests: [], output: [{ type: 'text', text: 'Late real output' }] })
  assert.notEqual(f.records.get(f.input.runId).nativeResultReady, true, 'only the captured raw result can attest native result readiness')
  f.parentEvents.push(nativeNotice(f.input.runId))
  await f.controller.nativeSettled(f.input.runId)
  const restored = new RemoteController(f.ctx, f.store, f.controller.connections)
  t.after(() => restored.close())
  await restored.initialize()
  await tick()
  assert.equal(f.records.get(f.input.runId).reportSource, 'hub')
  assert.equal(f.reports.length, 1)
  assert.match(f.reports[0].content[0].text, /Late real output/)
  assert.deepEqual(f.requests.map(request => request.path), ['/runs'])
})

test('cold native recovery reports an undelivered result once without re-dispatching', async t => {
  const f = fixture(t), record = seed(f, { resultDelivery: 'native', state: 'completed', requests: [], output: [{ type: 'text', text: 'Unsent' }] })
  f.controller.nativeOwners.add(record.runId)
  const restored = new RemoteController(f.ctx, f.store, f.controller.connections)
  t.after(() => restored.close())
  await restored.initialize()
  await tick()
  assert.equal(f.reports.length, 1)
  assert.match(f.reports[0].content[0].text, /Unsent/)
  assert.equal(f.records.get(record.runId).reportDelivered, true)
  assert.equal(f.records.get(record.runId).reportSource, 'hub')
  const again = new RemoteController(f.ctx, f.store, f.controller.connections)
  t.after(() => again.close())
  await again.initialize()
  await tick()
  assert.equal(f.reports.length, 1)
  assert.equal(f.requests.length, 0)
})

test('legacy foreground result does not inject a duplicate report into the parent', async t => {
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

test('native disposal shares one promise and waits for cancellation drain without a model-check loop', async t => {
  let release
  const drain = new Promise(resolve => { release = resolve })
  const paths = []
  const f = fixture(t, { request: async (_target, path, options) => {
    paths.push(path)
    if (path.endsWith('/drain')) await drain
    return { run: { runId: options?.input?.runId || 'remote-run-1', state: 'interrupted', stopReason: 'aborted', output: [] } }
  } })
  const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
  await run.result
  let disposed = false
  const disposal = run.dispose()
  assert.equal(run.dispose(), disposal, 'concurrent disposal returns the exact same promise')
  const disposing = disposal.then(() => { disposed = true })
  await tick()
  assert.equal(disposed, false)
  release()
  await disposing
  assert.equal(run.dispose(), disposal, 'completed disposal remains idempotent')
  assert.deepEqual(paths, ['/runs', '/runs/remote-run-1/drain'])
  assert.equal(f.reports.length, 0)
})

test('native disposal also drains failed worker startup before releasing its resources', async t => {
  let release
  const drain = new Promise(resolve => { release = resolve }), paths = []
  const f = fixture(t, { request: async (_target, path) => {
    paths.push(path)
    if (path.endsWith('/drain')) await drain
    return { run: { runId: 'remote-run-1', state: 'error', stopReason: 'error', output: [] } }
  } })
  const run = await f.controller.start({ ...f.input, resultDelivery: 'native' }, { id: 'parent' }, new AbortController().signal)
  assert.equal((await run.result).stopReason, 'error')
  let disposed = false
  const disposal = run.dispose()
  assert.equal(run.dispose(), disposal)
  disposal.then(() => { disposed = true })
  await tick()
  assert.equal(disposed, false)
  assert.deepEqual(paths, ['/runs', '/runs/remote-run-1/drain'], 'terminal failures need quiescence, not another interrupt')
  release()
  await disposal
  assert.equal(disposed, true)
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

test('legacy non-background requests stay visible in status without automatic prompts or dialogs', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'waiting_approval',
    requests: [questions(), approval(), planReview()], prompt: 'PRIVATE-PROMPT', origin: 'PRIVATE-ORIGIN' })
  forbidAutomaticInteraction(f)
  await f.controller.accept(record, { ...record, revision: 2 })
  const status = await f.controller.status(record.runId, 'parent')
  assert.deepEqual(status.requests, record.requests)
  assert.ok(!/PRIVATE-|originSessionId|nativeRequestIds|prompt/.test(JSON.stringify(status)))
  await tick()
  assert.equal(f.reports.length, 0)
  assert.equal(f.requests.length, 0)
})

test('status enforces ownership before exposing legacy pending requests', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  const before = structuredClone(record)
  for (const runId of [record.runId, 'missing-run']) {
    await assert.rejects(f.controller.status(runId, 'intruder'), /belong/)
  }
  assert.deepEqual(f.records.get(record.runId), before)
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
})

test('interrupt acknowledgement updates cached status without waiting for SSE', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: record.runId, revision: 2, state: 'interrupted', stopReason: 'aborted', requests: [] } }
  }
  const status = await f.controller.interrupt(record.runId, 'parent')
  assert.equal(status.state, 'interrupted')
  assert.deepEqual(await f.controller.status(record.runId, 'parent'), status)
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

test('legacy non-background SSE withdrawal and completion stay live without answering a pending request', async t => {
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
  assert.deepEqual((await f.controller.status(f.input.runId, 'parent')).requests, [approval()])
  const emit = remote => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run: remote })}\n\n`))
  emit({ runId: f.input.runId, revision: 2, state: 'running', requests: [] })
  await tick()
  assert.deepEqual((await f.controller.status(f.input.runId, 'parent')).requests, [])
  await assert.rejects(f.controller.respond(f.input.runId, 'request-approval', { outcome: 'allowed-once' }, 'parent'), { code: 'REMOTE_REQUEST_EXPIRED' })
  emit({ runId: f.input.runId, revision: 3, state: 'completed', requests: [], output: [{ type: 'text', text: 'Done' }] })
  assert.deepEqual((await run.result).output, [{ type: 'text', text: 'Done' }])
  assert.equal(f.reports.length, 0)
  assert.deepEqual(f.requests.map(item => item.path), ['/runs'])
})

function assertWaitClean(controller, signal) {
  assert.equal(controller.events.listenerCount('changed'), 0)
  assert.equal(controller.events.listenerCount('closed'), 0)
  if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0)
}

function toolResult(runId, requestIds, { callId = 'dispatch-call', isError = false } = {}) {
  return { type: 'tool/result', data: { message: { callId, isError,
    content: [{ type: 'text', text: JSON.stringify({ runId, requests: requestIds.map(id => ({ id })) }) }] } } }
}

function yieldedRecord(f, extra = {}) {
  return seed(f, { background: true, resultDelivery: 'caller',
    foregroundYield: { id: 'yield-marker', callId: 'dispatch-call', requestIds: ['request-question'] },
    notifiedRequests: ['request-prior', 'request-question'], ...extra })
}

function liveStream(f) {
  let stream
  f.controller.fetchImpl = async (_url, init) => new Response(new ReadableStream({ start(value) {
    stream = value
    init.signal.addEventListener('abort', () => { try { value.close() } catch {} }, { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } })
  return run => stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ version: 1, instanceId: 'worker', run })}\n\n`))
}

test('foreground wait returns existing or later input and cleans all listeners', async t => {
  for (const existing of [true, false]) {
    await t.test(existing ? 'existing input' : 'later input', async t => {
      const f = fixture(t), record = seed(f, { background: false,
        state: existing ? 'waiting_input' : 'running', requests: existing ? [questions()] : [] })
      const abort = new AbortController()
      const waiting = f.controller.waitForInteraction(record.runId, 'parent', abort.signal)
      if (!existing) {
        await tick()
        assert.equal(f.controller.events.listenerCount('changed'), 1)
        assert.equal(f.controller.events.listenerCount('closed'), 1)
        assert.equal(getEventListeners(abort.signal, 'abort').length, 1)
        f.controller.events.emit('changed', 'unrelated-run')
        await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'waiting_input', requests: [questions('request-later')] })
      }
      const current = await waiting
      assert.deepEqual(current, await f.controller.status(record.runId, 'parent'))
      assertWaitClean(f.controller, abort.signal)
      assert.equal(f.reports.length, 0)
      assert.equal(f.requests.length, 0)
    })
  }
})

test('foreground wait ignores withdrawn input and resolves null only on terminal state', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  await f.controller.accept(record, { runId: record.runId, revision: 2, state: 'running', requests: [] })
  const abort = new AbortController()
  let settled = false
  const waiting = f.controller.waitForInteraction(record.runId, 'parent', abort.signal).then(value => { settled = true; return value })
  await tick()
  assert.equal(settled, false, 'withdrawn request must not wake the waiting caller')
  await f.controller.accept(record, { runId: record.runId, revision: 3, state: 'completed', requests: [] })
  assert.equal(await waiting, null)
  assertWaitClean(f.controller, abort.signal)
  assert.equal(await f.controller.waitForInteraction(record.runId, 'parent', abort.signal), null, 'already terminal is immediate')
  assertWaitClean(f.controller, abort.signal)
  assert.equal(f.reports.length, 0)
})

test('foreground wait rejects wrong owners and missing records without leaking listeners', async t => {
  const f = fixture(t), record = seed(f, { background: false })
  for (const [runId, owner] of [[record.runId, 'intruder'], ['missing-run', 'parent']]) {
    const abort = new AbortController()
    await assert.rejects(f.controller.waitForInteraction(runId, owner, abort.signal), /belong/)
    assertWaitClean(f.controller, abort.signal)
  }
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
})

test('foreground wait abort and controller close reject promptly and remove listeners', async t => {
  for (const action of ['abort-before', 'abort-after', 'close-before', 'close-after']) {
    await t.test(action, async t => {
      const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
      const abort = new AbortController()
      if (action === 'abort-before') abort.abort()
      if (action === 'close-before') await f.controller.close()
      const waiting = f.controller.waitForInteraction(record.runId, 'parent', abort.signal)
      const rejected = assert.rejects(waiting, { code: 'REMOTE_CANCELLED' })
      if (action.endsWith('after')) {
        await tick()
        if (action === 'abort-after') abort.abort()
        else await f.controller.close()
      }
      await rejected
      assertWaitClean(f.controller, abort.signal)
      assert.equal(f.requests.length, 0, 'waiting cancellation must not dispatch or interrupt a worker')
      assert.equal(f.reports.length, 0)
    })
  }
})

test('foreground yield atomically uses latest input, suppresses it once and returns that precise payload', async t => {
  const f = fixture(t), record = seed(f, { background: false, requests: [questions('request-old')], notifiedRequests: ['request-prior'] })
  const latest = questions('request-new')
  latest.questions[0].question = 'Latest question payload'
  const update = f.controller.accept(record, { runId: record.runId, revision: 2, state: 'waiting_approval', requests: [latest, approval()] })
  const yielding = f.controller.yieldForInput(record.runId, 'parent', 'dispatch-call')
  const concurrent = f.controller.yieldForInput(record.runId, 'parent', 'competing-call')
  await update
  const result = await yielding
  assert.equal(result.yielded, true)
  assert.deepEqual(result.run.requests, [latest, approval()])
  assert.equal(result.run.revision, 2)
  assert.equal((await concurrent).yielded, false, 'only one caller may transition foreground to background')
  const stored = f.records.get(record.runId)
  assert.equal(stored.background, true)
  assert.equal(stored.foregroundYield.callId, 'dispatch-call')
  assert.equal(typeof stored.foregroundYield.id, 'string')
  assert.ok(stored.foregroundYield.id.length)
  assert.deepEqual(stored.foregroundYield.requestIds, ['request-new', 'request-approval'])
  assert.deepEqual(stored.notifiedRequests, ['request-prior', 'request-new', 'request-approval'])
  assert.ok(!/foregroundYield|notifiedRequests|originSessionId|prompt/.test(JSON.stringify(result.run)))
  await f.controller.accept(stored, { runId: record.runId, revision: 3, state: 'running', requests: [] })
  assert.deepEqual(result.run.requests, [latest, approval()], 'later withdrawal cannot mutate the yielded reply payload')
  await tick()
  assert.equal(f.reports.length, 0, 'direct tool reply owns only the exact suppressed requests')
  assert.equal(f.requests.length, 0)
})

test('foreground yield does not switch withdrawn, terminal or already-background runs and checks ownership', async t => {
  const f = fixture(t)
  for (const extra of [
    { background: false, state: 'running', requests: [] },
    { background: false, state: 'completed', requests: [] },
    { background: false, state: 'error', requests: [] },
    { background: false, state: 'interrupted', requests: [] },
    { background: true, state: 'waiting_input', requests: [questions()] },
  ]) {
    const record = seed(f, extra), before = structuredClone(record)
    const result = await f.controller.yieldForInput(record.runId, 'parent', 'dispatch-call')
    assert.equal(result.yielded, false)
    assert.deepEqual(result.run, await f.controller.status(record.runId, 'parent'))
    assert.deepEqual(f.records.get(record.runId), before)
  }
  const before = structuredClone(f.records.get(f.input.runId))
  await assert.rejects(f.controller.yieldForInput(f.input.runId, 'intruder', 'dispatch-call'), { code: 'REMOTE_OWNER' })
  await assert.rejects(f.controller.yieldForInput('missing-run', 'parent', 'dispatch-call'), { code: 'REMOTE_OWNER' })
  assert.deepEqual(f.records.get(f.input.runId), before)
  assert.equal(f.requests.length, 0)
  assert.equal(f.reports.length, 0)
})

test('caller-delivered ordinary foreground completion never injects a Hub final report', async t => {
  const f = fixture(t)
  const run = await f.controller.start({ ...f.input, background: false, resultDelivery: 'caller' }, { id: 'parent' }, new AbortController().signal)
  assert.deepEqual((await run.result).output, [{ type: 'text', text: 'Finished' }])
  assert.equal(f.controller.nativeOwners.has(run.id), true)
  await Promise.all([f.controller.nativeSettled(run.id), f.controller.nativeSettled(run.id)])
  await f.controller.report(f.records.get(run.id))
  await run.dispose()
  assert.equal(f.controller.nativeOwners.has(run.id), false)
  assert.equal(f.reports.length, 0)
  assert.equal(f.records.get(run.id).reportDelivered, undefined)
  assert.deepEqual(f.requests.map(request => request.path), ['/runs'])
})

test('yielded caller activation retains original task and Hub reports final once after native ownership releases', async t => {
  const f = fixture(t), emit = liveStream(f)
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return { run: { runId: f.input.runId, revision: 1, state: 'waiting_input', requests: [questions()] } }
  }
  const run = await f.controller.start({ ...f.input, background: false, resultDelivery: 'caller' }, { id: 'parent' }, new AbortController().signal)
  await tick()
  const result = await f.controller.yieldForInput(run.id, 'parent', 'dispatch-call')
  assert.equal(result.yielded, true)
  f.parentEvents.push(toolResult(run.id, ['request-question']))
  await f.controller.reconcileYield(f.records.get(run.id))
  assert.equal(f.reports.length, 0)
  const completed = { runId: run.id, revision: 2, state: 'completed', requests: [], output: [{ type: 'text', text: 'Original caller task finished' }] }
  emit(completed)
  assert.deepEqual((await run.result).output, completed.output)
  assert.equal(f.records.get(run.id).resultDelivery, 'caller', 'activation delivery is immutable across the yield')
  assert.equal(f.reports.length, 0, 'Hub waits for native activation ownership to release')
  await Promise.all([f.controller.nativeSettled(run.id), f.controller.nativeSettled(run.id)])
  await f.controller.report(f.records.get(run.id))
  await run.dispose()
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].requestId, `hub-result-${run.id}`)
  assert.equal(f.records.get(run.id).reportSource, 'hub')
  assert.equal(f.records.get(run.id).reportDelivered, true)
  assert.deepEqual(f.requests.map(request => request.path), ['/runs'], 'no replacement task or interrupt was sent')
})

test('cold yield recovery verifies direct tool logs or restores missing questions exactly once', async t => {
  for (const delivered of [true, false]) {
    await t.test(delivered ? 'durable direct reply' : 'lost direct reply', async t => {
      const f = fixture(t), record = yieldedRecord(f)
      f.controller.connections.get = async () => undefined
      if (delivered) f.parentEvents.push(toolResult(record.runId, ['request-question']))
      await f.controller.initialize()
      await tick()
      assert.equal(f.records.get(record.runId).foregroundYield, undefined)
      assert.equal(f.controller.restoredYields.has(record.runId), false)
      assert.deepEqual(f.records.get(record.runId).notifiedRequests, ['request-prior', 'request-question'])
      assert.equal(f.reports.length, delivered ? 0 : 1)
      if (!delivered) assert.equal(f.reports[0].requestId, `hub-question-${record.runId}-request-question`)
      await f.controller.close()
      const restored = new RemoteController(f.ctx, f.store, f.controller.connections)
      t.after(() => restored.close())
      await restored.initialize()
      await tick()
      assert.equal(f.reports.length, delivered ? 0 : 1, 'second cold recovery must not duplicate the question')
      assert.equal(f.requests.length, 0)
    })
  }
})

test('live yield reconciliation waits for the matching turn end or force and never double-notifies', async t => {
  for (const force of [false, true]) {
    await t.test(force ? 'explicit force' : 'matching turn end', async t => {
      const f = fixture(t), record = yieldedRecord(f)
      f.parentEvents.push({ type: 'tool/call', data: { callId: 'dispatch-call', turn: 'dispatch-turn' } },
        { type: 'turn/end', data: { turn: 'unrelated-turn' } })
      await f.controller.reconcileYield(record)
      f.controller.syncInteractions(f.records.get(record.runId))
      await tick()
      assert.deepEqual(f.records.get(record.runId).foregroundYield, record.foregroundYield)
      assert.equal(f.reports.length, 0, 'in-flight direct reply must not trigger a concurrent Hub question')
      if (!force) f.parentEvents.push({ type: 'turn/end', data: { turn: 'dispatch-turn' } })
      await Promise.all([f.controller.reconcileYield(record, { force }), f.controller.reconcileYield(record, { force })])
      await tick()
      assert.equal(f.records.get(record.runId).foregroundYield, undefined)
      assert.deepEqual(f.records.get(record.runId).notifiedRequests, ['request-prior', 'request-question'])
      assert.equal(f.reports.length, 1)
      assert.equal(f.reports[0].requestId, `hub-question-${record.runId}-request-question`)
      await f.controller.reconcileYield(record, { force: true })
      f.controller.syncInteractions(f.records.get(record.runId))
      await tick()
      assert.equal(f.reports.length, 1)
      assert.equal(f.requests.length, 0)
    })
  }
})

test('yield proof requires matching tool call, run and every request, not errors or malformed results', async t => {
  const invalid = [
    ['other call', toolResult('remote-run-1', ['request-question'], { callId: 'other-call' })],
    ['other run', toolResult('other-run', ['request-question'])],
    ['missing request', toolResult('remote-run-1', ['request-other'])],
    ['tool error', toolResult('remote-run-1', ['request-question'], { isError: true })],
    ['invalid JSON', { type: 'tool/result', data: { message: { callId: 'dispatch-call', content: [{ type: 'text', text: 'not JSON' }] } } }],
    ['not tool result', { ...toolResult('remote-run-1', ['request-question']), type: 'user/message' }],
  ]
  for (const [label, event] of invalid) {
    await t.test(label, async t => {
      const f = fixture(t), record = yieldedRecord(f)
      f.parentEvents.push(event)
      await f.controller.reconcileYield(record)
      assert.deepEqual(f.records.get(record.runId).foregroundYield, record.foregroundYield, 'invalid proof must not confirm the direct reply')
      await f.controller.reconcileYield(record, { force: true })
      await tick()
      assert.equal(f.reports.length, 1, 'question must remain recoverable after invalid proof')
      assert.equal(f.records.get(record.runId).foregroundYield, undefined)
      await f.controller.reconcileYield(record, { force: true })
      await tick()
      assert.equal(f.reports.length, 1)
    })
  }
})

test('valid direct result clears the yield marker without Hub duplication even after the turn ended', async t => {
  const f = fixture(t), record = yieldedRecord(f, { requests: [questions(), approval()],
    foregroundYield: { id: 'yield-marker', callId: 'dispatch-call', requestIds: ['request-question', 'request-approval'] },
    notifiedRequests: ['request-prior', 'request-question', 'request-approval'] })
  f.parentEvents.push({ type: 'tool/call', data: { callId: 'dispatch-call', turn: 7 } },
    toolResult(record.runId, ['request-question', 'request-approval']), { type: 'turn/end', data: { turn: 7 } })
  await f.controller.reconcileYield(record, { force: true })
  f.controller.syncInteractions(f.records.get(record.runId))
  await tick()
  assert.equal(f.records.get(record.runId).foregroundYield, undefined)
  assert.deepEqual(f.records.get(record.runId).notifiedRequests, ['request-prior', 'request-question', 'request-approval'])
  assert.equal(f.reports.length, 0)
  assert.equal(f.requests.length, 0)
})

test('concurrent interrupts share one POST and a failed attempt can be explicitly retried', async t => {
  const f = fixture(t), record = seed(f, { background: false, state: 'running', requests: [] })
  let fail
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return new Promise((_resolve, reject) => { fail = reject })
  }
  const attempts = [f.controller.interrupt(record.runId, 'parent'), f.controller.interrupt(record.runId, 'parent')]
  const rejected = Promise.all(attempts.map(promise => assert.rejects(promise, /Temporary disconnect/)))
  await tick()
  assert.equal(f.requests.length, 1)
  await assert.rejects(f.controller.interrupt(record.runId, 'intruder'), /belong/)
  assert.equal(f.requests.length, 1, 'ownership is checked even while another interrupt is pending')
  fail(new Error('Temporary disconnect'))
  await rejected
  assert.equal(f.controller.interrupting.size, 0)
  assert.equal(f.records.get(record.runId).state, 'running')
  let finish
  f.controller.connections.request = async (_target, path, options) => {
    f.requests.push({ path, options })
    return new Promise(resolve => { finish = resolve })
  }
  const retried = [f.controller.interrupt(record.runId, 'parent'), f.controller.interrupt(record.runId, 'parent')]
  await tick()
  assert.equal(f.requests.length, 2)
  finish({ run: { runId: record.runId, revision: 2, state: 'interrupted', stopReason: 'aborted', requests: [] } })
  const results = await Promise.all(retried)
  assert.deepEqual(results[0], results[1])
  assert.equal(results[0].state, 'interrupted')
  assert.equal(f.controller.interrupting.size, 0)
  assert.deepEqual(await f.controller.interrupt(record.runId, 'parent'), results[0])
  assert.equal(f.requests.length, 2, 'completed interrupt is read-only and does not POST again')
  assert.ok(f.requests.every(request => request.path === `/runs/${record.runId}/interrupt` && request.options.method === 'POST'))
  assert.equal(f.reports.length, 0)
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
