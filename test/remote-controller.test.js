import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteController, followRunEvents } from '../src/remote/controller.js'

function fixture(t, overrides = {}) {
  const records = new Map(), reports = [], requests = []
  const store = { get: (_table, id) => structuredClone(records.get(id)), list: () => [...records.values()].map(value => structuredClone(value)),
    put: async (_table, id, value) => { records.set(id, structuredClone(value)); return value },
    mutate: async (_table, id, callback) => { const next = await callback(structuredClone(records.get(id))); if (next) records.set(id, structuredClone(next)); return next } }
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
