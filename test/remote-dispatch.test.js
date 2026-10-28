import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteDispatch } from '../src/remote/dispatch.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); promise.catch(() => {}); return { promise, resolve, reject } }
function fixture(native = true) {
  const records = new Map(), calls = [], receipts = [], checkpoints = []
  const parent = { id: 'parent' }, result = deferred()
  let disposed = 0
  const store = { get: async (_table, id) => structuredClone(records.get(id)) }
  const controller = { status: async (id, owner) => {
    const record = records.get(id)
    assert.equal(record.originSessionId, owner)
    return structuredClone(record)
  }, nativeSettled: async id => { checkpoints.push(id) } }
  const accept = (request, native) => {
    const input = JSON.parse(request.prompt[0].text)
    records.set(input.runId, { ...input, originSessionId: request.parent.id, state: 'running' })
    const run = { ...(native ? { childId: input.runId } : { id: input.runId }), result: result.promise, dispose: async () => { disposed++ } }
    receipts.push(run)
    return run
  }
  const subagents = native ? {
    startActivation: async spec => { calls.push(spec); return accept(spec.request, true) },
    start: () => assert.fail('new DSH must never enter the legacy start seam'),
  } : { start: async (name, request) => { calls.push({ name, request }); return accept(request, false) } }
  const dispatch = new RemoteDispatch({ subagents }, store, controller)
  const input = { runId: 'run-1', targetId: 'target', workspaceId: 'workspace', prompt: 'inspect', description: 'Check', background: true }
  return { records, calls, receipts, checkpoints, parent, result, store, controller, subagents, dispatch, input, disposed: () => disposed }
}

test('new DSH background execution owns parent delivery and teardown', async () => {
  const f = fixture(), signal = new AbortController()
  const ack = await f.dispatch.start(f.input, f.parent, signal.signal)
  assert.equal(ack.state, 'running')
  assert.equal(f.calls.length, 1)
  const spec = f.calls[0]
  assert.equal(spec.provider, 'server-hub-remote')
  assert.equal(spec.delivery, 'parent')
  assert.equal(spec.label, f.input.description)
  assert.equal(spec.request.parent, f.parent)
  assert.equal('signal' in spec.request, false)
  const input = JSON.parse(spec.request.prompt[0].text)
  assert.equal(input.background, true)
  assert.equal(input.resultDelivery, 'native')
  signal.abort()
  assert.equal(spec.signal.aborted, false, 'a finished dispatch tool no longer owns the activation lifetime')
  f.result.resolve({ stopReason: 'completed', output: [] })
  await tick()
  assert.deepEqual(f.checkpoints, [f.input.runId])
  assert.equal(f.disposed(), 0, 'the native manager, not dispatch, performs normal teardown')
})

test('new DSH foreground execution selects caller delivery and exposes only the fresh wait capability', async () => {
  const f = fixture(), input = { ...f.input, background: false }
  const first = await f.dispatch.start(input, f.parent)
  assert.equal(first.background, false)
  assert.equal(f.calls[0].delivery, 'caller')
  const request = JSON.parse(f.calls[0].request.prompt[0].text)
  assert.equal(request.background, false)
  assert.equal(request.resultDelivery, 'caller')
  assert.equal(first.execution.result, f.receipts[0].result)
  const reused = await f.dispatch.start({ ...input, background: true }, f.parent)
  assert.equal(reused.reused, true)
  assert.equal(reused.background, false, 'a new preference cannot change the active task mode')
  assert.equal('execution' in reused, false)
  await assert.rejects(f.dispatch.waitForResult(reused, f.parent), /fresh foreground/)
  f.result.resolve({ stopReason: 'completed', output: [] })
  await first.execution.result
  await tick()
  assert.equal(f.disposed(), 0, 'normal native cleanup stays owned by DSH')
  assert.equal(f.calls.length, 1)
})

test('legacy foreground execution waits for holder cleanup before returning the result', async () => {
  const f = fixture(false), drain = deferred()
  const first = await f.dispatch.start({ ...f.input, background: false }, f.parent)
  f.receipts[0].dispose = async () => { await drain.promise }
  let settled = false
  first.execution.result.then(() => { settled = true })
  f.result.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'Done' }] })
  await tick()
  assert.equal(settled, false)
  const disposal = first.execution.dispose()
  assert.equal(first.execution.dispose(), disposal)
  drain.resolve()
  assert.equal((await first.execution.result).output[0].text, 'Done')
  assert.equal(settled, true)
  assert.equal(first.background, false)
  assert.equal(JSON.parse(f.calls[0].request.prompt[0].text).resultDelivery, 'hub')
})

test('a duplicate background run ignores a later foreground preference', async () => {
  const f = fixture()
  await f.dispatch.start(f.input, f.parent)
  const duplicate = await f.dispatch.start({ ...f.input, background: false }, f.parent)
  assert.equal(duplicate.background, true)
  assert.equal(duplicate.reused, true)
  assert.equal('execution' in duplicate, false)
  assert.equal(f.calls.length, 1)
  f.result.resolve({ stopReason: 'completed', output: [] })
  await tick()
})

test('native result rejection still releases report ownership for recovery', async () => {
  const f = fixture()
  await f.dispatch.start(f.input, f.parent)
  f.result.reject(new Error('Native capture failed'))
  await tick()
  assert.deepEqual(f.checkpoints, [f.input.runId])
  assert.equal(f.disposed(), 0)
})

test('old DSH uses one legacy run and disposes it after asynchronous completion or rejection', async () => {
  for (const failure of [false, true]) {
    const f = fixture(false)
    const ack = await f.dispatch.start(f.input, f.parent)
    assert.equal(ack.state, 'running')
    assert.equal(f.calls[0].name, 'server-hub-remote')
    assert.equal(JSON.parse(f.calls[0].request.prompt[0].text).resultDelivery, 'hub')
    assert.equal(f.disposed(), 0)
    if (failure) f.result.reject(new Error('Legacy result failed'))
    else f.result.resolve({ stopReason: 'completed', output: [] })
    await tick()
    assert.equal(f.disposed(), 1)
    assert.deepEqual(f.checkpoints, [])
  }
})

test('simultaneous duplicates reserve one activation before the provider journals its intent', async () => {
  const f = fixture(), gate = deferred(), original = f.subagents.startActivation
  f.subagents.startActivation = async spec => { await gate.promise; return original(spec) }
  const first = f.dispatch.start(f.input, f.parent)
  const second = f.dispatch.start(f.input, f.parent)
  await tick()
  assert.equal(f.records.size, 0)
  gate.resolve()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.runId, b.runId)
  assert.equal(b.reused, true)
  assert.equal(f.calls.length, 1)
  assert.equal(f.dispatch.starting.size, 0)
  f.result.resolve({ stopReason: 'completed', output: [] })
  await tick()
})

test('a duplicate with different work never borrows the first activation, including during startup', async () => {
  const f = fixture(), gate = deferred(), original = f.subagents.startActivation
  f.subagents.startActivation = async spec => { await gate.promise; return original(spec) }
  const first = f.dispatch.start(f.input, f.parent)
  const wrong = assert.rejects(f.dispatch.start({ ...f.input, prompt: 'different task' }, f.parent), /different task/)
  gate.resolve()
  await first; await wrong
  for (const patch of [{ targetId: 'other' }, { workspaceId: 'other' }, { prompt: 'other' }]) {
    await assert.rejects(f.dispatch.start({ ...f.input, ...patch }, f.parent), /different task/)
  }
  await assert.rejects(f.dispatch.start(f.input, { id: 'other-parent' }), /different task/)
  assert.equal(f.calls.length, 1)
  f.result.resolve({ stopReason: 'completed', output: [] })
  await tick()
})

test('completed and cold-restored tasks are reused without another native activation or remote POST', async () => {
  for (const state of ['running', 'waiting_approval', 'connection_lost', 'completed', 'error', 'interrupted']) {
    const f = fixture()
    f.records.set(f.input.runId, { ...f.input, originSessionId: f.parent.id, resultDelivery: 'native', state })
    const ack = await f.dispatch.start(f.input, f.parent)
    assert.equal(ack.state, state)
    assert.equal(ack.reused, true)
    assert.equal(f.calls.length, 0)
    assert.deepEqual(f.checkpoints, [])
  }
})

test('pre-aborted and startup-aborted dispatches do not leave cancellation ownership attached', async () => {
  const f = fixture(), ac = new AbortController()
  ac.abort()
  await assert.rejects(f.dispatch.start(f.input, f.parent, ac.signal), /cancelled/)
  assert.equal(f.calls.length, 0)
  const during = new AbortController(), entered = deferred()
  let requestSignal
  f.subagents.startActivation = spec => {
    requestSignal = spec.signal; entered.resolve()
    return new Promise((resolve, reject) => spec.signal.addEventListener('abort', () => reject(new Error('startup cancelled')), { once: true }))
  }
  const pending = assert.rejects(f.dispatch.start(f.input, f.parent, during.signal), /startup cancelled/)
  await entered.promise
  during.abort()
  await pending
  assert.equal(requestSignal.aborted, true)
  assert.deepEqual(f.checkpoints, [f.input.runId])
  assert.equal(f.dispatch.starting.size, 0)
})

test('failed native admission releases ownership but a durable accepted task is never submitted again', async () => {
  const f = fixture()
  f.subagents.startActivation = async spec => {
    const input = JSON.parse(spec.request.prompt[0].text)
    f.records.set(input.runId, { ...input, originSessionId: f.parent.id, state: 'interrupted' })
    f.calls.push(spec)
    throw new Error('Catalog admission failed after provider start')
  }
  await assert.rejects(f.dispatch.start(f.input, f.parent), /Catalog admission/)
  assert.deepEqual(f.checkpoints, [f.input.runId])
  const retry = await f.dispatch.start(f.input, f.parent)
  assert.equal(retry.reused, true)
  assert.equal(retry.state, 'interrupted')
  assert.equal(f.calls.length, 1)
})

test('an unsupported runtime fails before creating a task intent', async () => {
  const f = fixture()
  delete f.subagents.startActivation; delete f.subagents.start
  await assert.rejects(f.dispatch.start(f.input, f.parent), /缺少受支持/)
  assert.equal(f.records.size, 0)
})
