import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { RemoteDispatch } from '../src/remote/dispatch.js'
import { RemoteController } from '../src/remote/controller.js'
import { cookieForEndpoint } from '../src/remote/auth.js'

// Opt in with DSH_TEST_RUNTIME=/path/to/node_modules/@deepseek-ai.
// Set DSH_TEST_LEGACY_RUNTIME to an older runtime's @deepseek-ai directory for start() compatibility.
// No dependency on, or access to, an online DSH instance or its credentials.
const runtime = process.env.DSH_TEST_RUNTIME
const legacyRuntime = process.env.DSH_TEST_LEGACY_RUNTIME
const nativeTest = (name, run) => test(name, { skip: !runtime }, run)
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Native integration test timed out')), 3000) })]) }
  finally { clearTimeout(timer) }
}
const load = (name, base = runtime) => import(pathToFileURL(resolve(base, name, 'lib/index.js')).href)

/**
 * Real Cordis, Session and SubagentRuntime, including the actual activation
 * manager, catalog, lifecycle, ownership, native notice and teardown paths.
 * Fakes stop at Agent/model execution (the parent admits messages into a real
 * Session), private persistence checkpoints, Hub's store and remote transport.
 * Neither startActivation nor the native manager implementation is replaced.
 */
async function fixture(t, { parentStatus = 'running', failNotice = false, holdDrain = false, holdYieldCommit = false, runtimeBase = runtime, managed = true } = {}) {
  const [{ Context }, { SubagentRuntime }, { Session }] = await Promise.all([
    load('cordis', runtimeBase), load('dsh-subagent', runtimeBase), load('dsh-session', runtimeBase),
  ])
  const ctx = new Context()
  const session = Session.create('native-test-parent')
  const nativeNotices = [], noticeAttempts = [], reports = [], flushes = [], lifecycle = [], calls = [], providerRuns = []
  const parent = { id: session.id, session, options: {}, status: parentStatus }
  const admit = (message, target) => {
    noticeAttempts.push(message)
    if (failNotice) throw new Error('test-only native parent admission failure')
    nativeNotices.push(message)
    session.append('agent/inbox/spliced', { target, start: nativeNotices.length - 1, inserted: [message] })
  }
  parent.steer = message => admit(message, 'next-step')
  parent.followup = message => admit(message, 'next-turn')
  parent.inject = message => admit(message, 'next-turn')
  ctx.provide('agents', { get: id => id === parent.id ? parent : undefined, list: () => [parent] })
  ctx.provide('workingDirectory', { ensure: async agent => { assert.equal(agent, parent); return process.cwd() } })
  ctx.provide('sessions', { get: id => id === parent.id ? session : undefined,
    flush: async value => { assert.equal(value, session); flushes.push(session.seq); return true } })
  ctx.provide('workspaceRegistry', { archivedSessionIds: [] })
  ctx.provide('sessionController', {
    inspect: async id => { assert.equal(id, parent.id); return { events: session.ownEvents() } },
    prompt: async input => { reports.push(input) },
  })
  for (const edge of ['start', 'end']) ctx.on(`subagent/${edge}`, info => { lifecycle.push({ edge, ...info }) })
  const nativeFiber = ctx.plugin(SubagentRuntime)
  await bounded(nativeFiber.await())
  assert.equal(nativeFiber.state, 2, 'real SubagentRuntime must be ACTIVE')
  assert.equal(typeof ctx.subagents.startActivation, managed ? 'function' : 'undefined', 'test the selected runtime API without replacing it')
  if (!managed) assert.equal(typeof ctx.subagents.start, 'function', 'legacy integration requires the real holder-owned start API')

  const input = { runId: 'remote-native-test-run', targetId: 'test-target', workspaceId: 'test-workspace',
    description: 'Native lifecycle integration', prompt: 'Return the test-only remote result' }
  const records = new Map(), changed = new EventEmitter()
  const yieldCommitting = deferred(), yieldCommit = deferred()
  if (!holdYieldCommit) yieldCommit.resolve()
  let tail = Promise.resolve(), providerStarts = 0, disposals = 0, remoteRun
  let failInterrupt = false, failDrain = false
  const serial = operation => { const next = tail.then(operation); tail = next.catch(() => {}); return next }
  const store = {
    get: (_table, id) => structuredClone(records.get(id)),
    list: () => [...records.values()].map(value => structuredClone(value)),
    put: (_table, id, value) => serial(() => { records.set(id, structuredClone(value)); changed.emit('changed'); return structuredClone(value) }),
    mutate: (_table, id, mutate) => serial(async () => {
      const previous = records.get(id)
      const next = await mutate(structuredClone(previous))
      if (next?.foregroundYield && !previous?.foregroundYield) {
        yieldCommitting.resolve()
        await yieldCommit.promise
      }
      if (next) { records.set(id, structuredClone(next)); changed.emit('changed') }
      return structuredClone(next)
    }),
  }
  const streams = new Set(), streamStarted = deferred(), draining = deferred(), drain = deferred()
  if (!holdDrain) drain.resolve()
  const envelope = () => `data: ${JSON.stringify({ version: 1, instanceId: 'test-worker', run: remoteRun })}\n\n`
  const emit = () => { for (const stream of streams) stream.enqueue(Buffer.from(envelope())) }
  const finish = (state = 'completed') => {
    remoteRun = { ...remoteRun, state, requests: [], revision: (remoteRun?.revision || 0) + 1,
      stopReason: state === 'interrupted' ? 'aborted' : state === 'completed' ? 'completed' : 'error',
      output: state === 'completed' ? [{ type: 'text', text: 'Test-only worker finished' }] : [] }
    emit()
  }
  const pending = requests => {
    remoteRun = { ...remoteRun, state: requests.some(request => request.kind === 'approval') ? 'waiting_approval' : 'waiting_input',
      requests: structuredClone(requests), revision: (remoteRun?.revision || 0) + 1 }
    emit()
  }
  const connections = {
    get: async () => ({ endpoint: 'http://127.0.0.1:1/', instanceId: 'test-worker', cookie: 'test-only-not-a-credential' }),
    request: async (targetId, path, options) => {
      assert.equal(targetId, input.targetId)
      calls.push({ path, options })
      if (path === '/runs') remoteRun = { runId: options.input.runId, state: 'running', revision: 1, output: [] }
      else if (path.endsWith('/interrupt')) {
        if (failInterrupt) throw new Error('Test-only interrupt transport failure')
        finish('interrupted')
      } else if (path.endsWith('/drain')) {
        draining.resolve()
        if (failDrain) throw new Error('Test-only drain transport failure')
        await drain.promise
      } else if (path.endsWith('/response')) {
        const requestId = decodeURIComponent(path.split('/').at(-2))
        remoteRun = { ...remoteRun, state: 'running', requests: remoteRun.requests.filter(request => request.id !== requestId), revision: remoteRun.revision + 1 }
        emit()
      } else assert.fail(`Unexpected remote path ${path}`)
      return { run: structuredClone(remoteRun) }
    },
  }
  const fetchImpl = async (_url, { signal }) => {
    const body = new ReadableStream({
      start(stream) {
        streams.add(stream)
        stream.enqueue(Buffer.from(envelope()))
        signal.addEventListener('abort', () => { if (streams.delete(stream)) stream.close() }, { once: true })
        streamStarted.resolve()
      },
      cancel() { streams.clear() },
    })
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
  }
  const controller = new RemoteController(ctx, store, connections, { fetchImpl })
  const provider = controller.provider(), originalStart = provider.start
  provider.start = async request => {
    providerStarts++
    const run = await originalStart(request)
    providerRuns.push(run)
    // Instrument only this external provider's release, not the native manager.
    return { ...run, dispose: () => { disposals++; return run.dispose() } }
  }
  ctx.subagents.registerProvider(provider)
  const dispatch = new RemoteDispatch(ctx, store, controller)
  const waitForRecord = predicate => bounded(new Promise(resolve => {
    const inspect = () => {
      const current = records.get(input.runId)
      if (current && predicate(current)) { changed.off('changed', inspect); resolve(structuredClone(current)) }
    }
    changed.on('changed', inspect); inspect()
  }))
  t.after(async () => {
    yieldCommit.resolve()
    drain.resolve()
    await bounded(ctx.fiber.dispose())
    await bounded(controller.close())
  })
  return { ctx, parent, input, controller, dispatch, records, store, calls, lifecycle, nativeNotices, noticeAttempts,
    reports, flushes, providerRuns, streamStarted, draining, drain, finish, pending, waitForRecord, yieldCommitting, yieldCommit,
    failTransport: ({ interrupt = false, drain = false } = {}) => { failInterrupt = interrupt; failDrain = drain },
    get providerStarts() { return providerStarts }, get disposals() { return disposals } }
}

nativeTest('actual native boot compatibility accepts supported DSH releases but rejects old and future prereleases', async () => {
  const { evaluatePluginCompatibility } = await load('dsh-app-boot')
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  for (const version of ['0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-alpha.3', '0.2.1-rc.2', '0.2.1']) {
    assert.equal(evaluatePluginCompatibility(manifest, {}, version), undefined, `supported runtime ${version}`)
  }
  for (const version of ['0.1.7', '0.3.0-rc.1']) {
    const issue = evaluatePluginCompatibility(manifest, {}, version)
    assert.ok(issue, `unsupported runtime ${version}`)
    assert.equal(issue.runtimeVersion, version)
    assert.equal(issue.exempted, false)
  }
})

nativeTest('actual target browser authentication can be reused over HTTP and HTTPS', async t => {
  for (const protocol of ['http:', 'https:']) await t.test(protocol, async t => {
    const [{ Context }, connection] = await Promise.all([load('cordis'), load('dsh-client-connection')])
    const ctx = new Context(), records = new Map()
    t.after(() => ctx.fiber.dispose())
    ctx.provide('credentials', {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, update) => { const value = await update(records.get(key)); if (value) records.set(key, value); return value },
    })
    ctx.provide('webServer', { protocol, port: 3081, register: () => () => {} })
    await ctx.plugin(connection).await()
    const endpoint = `${protocol}//127.0.0.1:3081/`
    const launch = new URL(ctx.connection.authenticatedUrl(endpoint))
    let cookie
    ctx.connection.authorizeIndex({ method: 'GET', url: launch.pathname + launch.search, headers: { host: launch.host } }, {
      writeHead(status, headers) { assert.equal(status, 303); cookie = headers['set-cookie'].split(';')[0] }, end() {},
    })
    const reused = cookieForEndpoint({ headers: { host: '127.0.0.1:3080', cookie } }, endpoint)
    assert.equal(reused, cookie)
    assert.equal(ctx.connection.requestRejection({ method: 'GET', headers: { host: launch.host, cookie: reused } }), undefined)
  })
})

nativeTest('actual native manager owns one remote result notice and automatically disposes the provider', async t => {
  for (const parentStatus of ['running', 'idle']) await t.test(parentStatus, async t => {
    const f = await fixture(t, { parentStatus })
    const status = await bounded(f.dispatch.start(f.input, f.parent))
    assert.equal(status.runId, f.input.runId)
    assert.equal(f.controller.nativeOwners.has(f.input.runId), true)
    assert.equal(f.providerStarts, 1)
    assert.equal(f.disposals, 0)
    f.finish()
    const delivered = await f.waitForRecord(record => record.reportDelivered)
    assert.equal(delivered.reportSource, 'native')
    assert.equal(f.nativeNotices.length, 1)
    assert.equal(f.nativeNotices[0].source.kind, 'subagent-settled')
    assert.equal(f.nativeNotices[0].source.senderSessionId, f.input.runId)
    assert.match(JSON.stringify(f.nativeNotices[0].content), /Test-only worker finished/)
    assert.equal(f.disposals, 1, 'the actual manager automatically releases the external run')
    assert.equal(f.reports.length, 0, 'Hub must not prompt the parent after native delivery')
    assert.ok(f.flushes.length > 0, 'native evidence must be checkpointed before marking delivery')
    assert.deepEqual(f.lifecycle.map(value => value.edge), ['start', 'end'])
    assert.equal(f.controller.nativeOwners.size, 0)
    const catalog = f.parent.session.ownEvents().filter(event => event.type === 'subagent/catalog')
    assert.equal(catalog.length, 1)
    assert.equal(catalog[0].data.mode, 'external')
    assert.equal(catalog[0].data.childId, f.input.runId)
    const inbox = f.parent.session.ownEvents().find(event => event.type === 'agent/inbox/spliced')
    assert.equal(inbox.data.target, parentStatus === 'idle' ? 'next-turn' : 'next-step')
    await f.controller.report(delivered)
    await f.ctx.subagents.drainChildren(f.parent, [f.input.runId])
    assert.equal(f.disposals, 1)
    assert.equal(f.nativeNotices.length, 1)
    assert.equal(f.reports.length, 0)
    assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
  })
})

nativeTest('parent tool cancellation after native publication cannot cancel the remote execution', async t => {
  const f = await fixture(t), tool = new AbortController()
  await bounded(f.dispatch.start(f.input, f.parent, tool.signal))
  await bounded(f.streamStarted.promise)
  tool.abort(new Error('test-only parent tool completed'))
  await tick()
  assert.equal(f.providerRuns.length, 1)
  assert.equal(f.calls[0].options.signal.aborted, false, 'published native provider lifetime is independent of its parent tool')
  assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
  assert.equal(f.disposals, 0)
  f.finish()
  await f.waitForRecord(record => record.reportDelivered)
  assert.equal(f.nativeNotices.length, 1)
  assert.equal(f.reports.length, 0)
})

nativeTest('actual manager manual disposal interrupts once work is live and waits for worker drain without deadlock', async t => {
  const f = await fixture(t, { holdDrain: true })
  await bounded(f.dispatch.start(f.input, f.parent))
  await bounded(f.streamStarted.promise)
  let settled = false
  const disposing = f.ctx.subagents.drainChildren(f.parent, [f.input.runId]).then(() => { settled = true })
  await bounded(f.draining.promise)
  await tick()
  assert.equal(settled, false, 'native disposal must await remote quiescence, not just interruption acknowledgement')
  assert.equal(f.disposals, 1)
  assert.ok(f.calls.some(call => call.path.endsWith('/interrupt')))
  assert.equal(f.nativeNotices.length, 0, 'native result notice is delivered only after worker drain')
  f.drain.resolve()
  await bounded(disposing)
  const record = await f.waitForRecord(record => record.reportDelivered)
  assert.equal(record.state, 'interrupted')
  assert.equal(record.reportSource, 'native')
  assert.equal(f.nativeNotices.length, 1)
  assert.equal(f.reports.length, 0)
  assert.equal(f.calls.filter(call => call.path.endsWith('/drain')).length, 1)
  await bounded(f.ctx.subagents.drainChildren(f.parent, [f.input.runId]))
  assert.equal(f.disposals, 1)
})

nativeTest('actual manager drains a failed remote worker before emitting its native error result', async t => {
  const f = await fixture(t, { holdDrain: true })
  await bounded(f.dispatch.start(f.input, f.parent))
  f.finish('error')
  await bounded(f.draining.promise)
  assert.equal(f.nativeNotices.length, 0)
  assert.equal(f.disposals, 1)
  assert.equal(f.calls.some(call => call.path.endsWith('/interrupt')), false, 'the worker already cancelled its failed startup')
  f.drain.resolve()
  const record = await f.waitForRecord(record => record.reportDelivered)
  assert.equal(record.state, 'error')
  assert.equal(record.reportSource, 'native')
  assert.equal(f.nativeNotices.length, 1)
  assert.equal(f.reports.length, 0)
  assert.equal(f.calls.filter(call => call.path.endsWith('/drain')).length, 1)
})

nativeTest('native manager notice admission failure falls back to one durable Hub report', async t => {
  const f = await fixture(t, { failNotice: true })
  await bounded(f.dispatch.start(f.input, f.parent))
  f.finish()
  const record = await f.waitForRecord(record => record.reportDelivered)
  assert.equal(f.noticeAttempts.length, 1, 'the real manager attempted its native settlement notice')
  assert.equal(f.nativeNotices.length, 0)
  assert.equal(f.disposals, 1)
  assert.equal(record.reportSource, 'hub')
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].sessionId, f.parent.id)
  assert.equal(f.reports[0].requestId, `hub-result-${f.input.runId}`)
  assert.match(JSON.stringify(f.reports[0].content), /Test-only worker finished/)
  await Promise.all([f.controller.nativeSettled(f.input.runId), f.controller.report(record)])
  assert.equal(f.reports.length, 1)
})

nativeTest('duplicate dispatch calls never create another native activation or remote submission, even after settlement', async t => {
  const f = await fixture(t)
  const started = await bounded(Promise.all([
    f.dispatch.start(f.input, f.parent), f.dispatch.start(f.input, f.parent), f.dispatch.start(f.input, f.parent),
  ]))
  assert.equal(started.filter(value => value.reused).length, 2)
  assert.equal(f.providerStarts, 1)
  assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
  f.finish()
  await f.waitForRecord(record => record.reportDelivered)
  assert.equal((await f.dispatch.start(f.input, f.parent)).reused, true)
  await assert.rejects(f.dispatch.start({ ...f.input, prompt: 'A different task' }, f.parent), /different task/)
  await assert.rejects(f.dispatch.start(f.input, { ...f.parent, id: 'another-parent' }), /different task/)
  assert.equal(f.providerStarts, 1)
  assert.equal(f.disposals, 1)
  assert.equal(f.nativeNotices.length, 1)
  assert.equal(f.reports.length, 0)
  assert.deepEqual(f.lifecycle.map(value => value.edge), ['start', 'end'])
})

test('actual legacy SubagentRuntime.start returns running work and delivers exactly one Hub report', { skip: !legacyRuntime }, async t => {
  const f = await fixture(t, { runtimeBase: legacyRuntime, managed: false }), tool = new AbortController()
  const started = await bounded(Promise.all([
    f.dispatch.start(f.input, f.parent, tool.signal), f.dispatch.start(f.input, f.parent),
  ]))
  assert.ok(started.every(value => value.state === 'running'), 'legacy dispatch returns while the remote task is still running')
  assert.equal(started.filter(value => value.reused).length, 1)
  assert.equal(f.records.get(f.input.runId).resultDelivery, 'hub')
  assert.equal(f.controller.nativeOwners.size, 0)
  assert.equal(f.providerStarts, 1)
  assert.equal(f.disposals, 0)
  assert.equal(f.reports.length, 0)
  await bounded(f.streamStarted.promise)
  tool.abort(new Error('test-only legacy parent tool completed'))
  await tick()
  assert.equal(f.calls[0].options.signal.aborted, false, 'published legacy work also outlives its parent tool signal')
  assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
  f.finish()
  const delivered = await f.waitForRecord(record => record.reportDelivered)
  await bounded(f.providerRuns[0].result)
  await tick() // The legacy dispatcher releases the holder-owned run after result settlement.
  assert.equal(delivered.state, 'completed')
  assert.equal(delivered.reportSource, 'hub')
  assert.equal(f.reports.length, 1)
  assert.equal(f.reports[0].sessionId, f.parent.id)
  assert.equal(f.reports[0].requestId, `hub-result-${f.input.runId}`)
  assert.match(JSON.stringify(f.reports[0].content), /Test-only worker finished/)
  assert.equal(f.noticeAttempts.length, 0, 'old runtime has no automatic external activation notice')
  assert.equal(f.nativeNotices.length, 0)
  assert.equal(f.disposals, 1, 'legacy dispatcher releases the real holder-owned run once')
  assert.deepEqual(f.lifecycle.map(value => value.edge), ['start', 'end'])
  assert.equal((await f.dispatch.start(f.input, f.parent)).reused, true)
  await f.controller.report(delivered)
  assert.equal(f.providerStarts, 1)
  assert.equal(f.disposals, 1)
  assert.equal(f.reports.length, 1)
  assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
})

const foregroundQuestion = () => ({ id: 'request-question', kind: 'questions', createdAt: 1,
  questions: [{ id: 'choice', question: 'Choose', options: [{ label: 'A' }, { label: 'B' }] }] })
const foregroundApproval = () => ({ id: 'request-approval', kind: 'approval', createdAt: 2,
  toolName: 'bash', callId: 'worker-call', reason: 'Needs permission', displayReason: { en: 'Remote permission' } })
const foregroundPlan = () => {
  const request = foregroundQuestion()
  request.id = 'request-plan'
  request.questions[0].detail = '# Proposed remote plan'
  request.questions[0].intent = { kind: 'plan-review', approve: 'A', callId: 'worker-plan' }
  return request
}
const assertNoWaitListeners = controller => {
  assert.equal(controller.events.listenerCount('changed'), 0)
  assert.equal(controller.events.listenerCount('closed'), 0)
}

for (const [version, runtimeBase, managed] of [['native caller', runtime, true], ['legacy holder', legacyRuntime, false]]) {
  test(`actual ${version} foreground completion returns once after teardown without parent notifications`, { skip: !runtimeBase }, async t => {
    for (const beforeWait of [false, true]) await t.test(beforeWait ? 'completion before wait' : 'completion during wait', async t => {
      const f = await fixture(t, { runtimeBase, managed }), tool = new AbortController()
      const started = await bounded(f.dispatch.start({ ...f.input, background: false }, f.parent, tool.signal))
      assert.equal(started.background, false)
      assert.ok(started.execution)
      assert.equal(f.records.get(f.input.runId).resultDelivery, managed ? 'caller' : 'hub')
      await bounded(f.streamStarted.promise)
      if (beforeWait) f.finish()
      const waiting = f.dispatch.waitForResult(started, f.parent, tool.signal, 'parent-call')
      if (!beforeWait) f.finish()
      const { result } = await bounded(waiting)
      assert.equal(result.stopReason, 'completed')
      assert.match(JSON.stringify(result.output), /Test-only worker finished/)
      assert.equal(f.disposals, 1)
      assert.equal(f.providerStarts, 1)
      assert.deepEqual(f.lifecycle.map(value => value.edge), ['start', 'end'])
      assert.equal(f.nativeNotices.length, 0)
      assert.equal(f.noticeAttempts.length, 0)
      assert.equal(f.reports.length, 0)
      assert.equal(f.records.get(f.input.runId).background, false)
      assertNoWaitListeners(f.controller)
      tool.abort()
      await tick()
      assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
    })
  })

  test(`actual ${version} foreground error waits for worker drain`, { skip: !runtimeBase }, async t => {
    const f = await fixture(t, { runtimeBase, managed, holdDrain: true })
    const started = await bounded(f.dispatch.start({ ...f.input, background: false }, f.parent))
    let settled = false
    const waiting = f.dispatch.waitForResult(started, f.parent).then(value => { settled = true; return value })
    f.finish('error')
    await bounded(f.draining.promise)
    await tick()
    assert.equal(settled, false, 'terminal snapshots cannot bypass native or legacy cleanup')
    assert.equal(f.reports.length, 0)
    assert.equal(f.nativeNotices.length, 0)
    f.drain.resolve()
    assert.equal((await bounded(waiting)).result.stopReason, 'error')
    assert.equal(f.disposals, 1)
    assert.equal(f.calls.filter(call => call.path.endsWith('/drain')).length, 1)
    assert.equal(f.calls.filter(call => call.path.endsWith('/interrupt')).length, 0)
    assertNoWaitListeners(f.controller)
  })

  test(`actual ${version} foreground questions, approvals and plan reviews yield without redispatch`, { skip: !runtimeBase }, async t => {
    for (const makeRequest of [foregroundQuestion, foregroundApproval, foregroundPlan]) await t.test(makeRequest.name, async t => {
      const f = await fixture(t, { runtimeBase, managed }), tool = new AbortController(), request = makeRequest()
      const started = await bounded(f.dispatch.start({ ...f.input, background: false }, f.parent, tool.signal))
      await bounded(f.streamStarted.promise)
      // Already-pending requests must be visible to a waiter registered later.
      f.pending([request])
      await f.waitForRecord(record => record.requests?.some(item => item.id === request.id))
      const next = await bounded(f.dispatch.waitForResult(started, f.parent, tool.signal, 'yield-call'))
      assert.deepEqual(next.pending.requests, [request])
      const record = f.records.get(f.input.runId)
      assert.equal(record.background, true)
      assert.equal(record.resultDelivery, managed ? 'caller' : 'hub')
      assert.deepEqual(record.notifiedRequests, [request.id])
      assert.equal(f.reports.length, 0, 'the question was returned through the tool, not prompted twice')
      assert.equal(f.disposals, 0)
      assertNoWaitListeners(f.controller)
      tool.abort()
      await tick()
      assert.deepEqual(f.calls.map(call => call.path), ['/runs'], 'yield transfers lifetime away from the original tool')
      await f.controller.respond(f.input.runId, request.id, request.kind === 'approval'
        ? { outcome: 'allowed-once' } : { answers: [{ id: 'choice', selected: ['A'] }] }, f.parent.id)
      f.finish()
      const delivered = await f.waitForRecord(value => value.reportDelivered)
      await bounded(started.execution.result)
      assert.equal(delivered.reportSource, 'hub')
      assert.equal(f.reports.length, 1)
      assert.equal(f.reports[0].requestId, `hub-result-${f.input.runId}`)
      assert.equal(f.nativeNotices.length, 0)
      assert.equal(f.noticeAttempts.length, 0)
      assert.equal(f.providerStarts, 1)
      assert.equal(f.disposals, 1)
      assert.equal(f.calls.filter(call => call.path === '/runs').length, 1)
      await f.controller.report(delivered)
      assert.equal(f.reports.length, 1)
    })
  })

  test(`actual ${version} reused foreground runs cannot lend wait or cancellation ownership`, { skip: !runtimeBase }, async t => {
    const f = await fixture(t, { runtimeBase, managed }), duplicateTool = new AbortController()
    const [started, reused] = await bounded(Promise.all([
      f.dispatch.start({ ...f.input, background: false }, f.parent),
      f.dispatch.start({ ...f.input, background: true }, f.parent, duplicateTool.signal),
    ]))
    assert.equal(reused.reused, true)
    assert.equal(reused.background, false, 'a new mode cannot change an existing run')
    assert.equal(reused.execution, undefined)
    await assert.rejects(f.dispatch.waitForResult(reused, f.parent, duplicateTool.signal), /fresh foreground/)
    duplicateTool.abort()
    await tick()
    assert.equal(f.providerStarts, 1)
    assert.equal(f.disposals, 0)
    const waiting = f.dispatch.waitForResult(started, f.parent)
    f.finish()
    assert.equal((await bounded(waiting)).result.stopReason, 'completed')
    const completed = await bounded(f.dispatch.start({ ...f.input, background: true }, f.parent))
    assert.equal(completed.reused, true)
    assert.equal(completed.background, false)
    assert.equal(completed.execution, undefined)
    assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
    assert.equal(f.reports.length, 0)
    assert.equal(f.nativeNotices.length, 0)
    assertNoWaitListeners(f.controller)
  })
}

nativeTest('actual caller foreground abort exits without awaiting interrupt or drain success', async t => {
  for (const failure of ['none', 'interrupt', 'drain']) await t.test(failure, async t => {
    const f = await fixture(t, { holdDrain: true }), tool = new AbortController()
    const started = await bounded(f.dispatch.start({ ...f.input, background: false }, f.parent, tool.signal))
    await bounded(f.streamStarted.promise)
    f.failTransport({ interrupt: failure === 'interrupt', drain: failure === 'drain' })
    const waiting = f.dispatch.waitForResult(started, f.parent, tool.signal)
    const rejected = assert.rejects(waiting, { code: 'REMOTE_CANCELLED' })
    tool.abort()
    await bounded(rejected)
    assertNoWaitListeners(f.controller)
    // Let detached cleanup reach the transport before checking admission counts.
    await tick()
    assert.equal(f.calls.filter(call => call.path.endsWith('/interrupt')).length, 1)
    assert.equal(f.calls.filter(call => call.path === '/runs').length, 1)
    assert.equal(f.nativeNotices.length, 0)
    assert.equal(f.reports.length, 0)
    assert.equal(f.records.get(f.input.runId).background, false)
    // Restore the fake remote boundary so test teardown does not strand a live activation.
    f.failTransport()
    f.finish()
    f.drain.resolve()
    await bounded(started.execution.result)
    assert.equal(f.disposals, 1)
    assert.equal(f.nativeNotices.length, 0)
    assert.equal(f.reports.length, 0)
  })
})

nativeTest('actual caller abort during yield journal commit preserves work and restores its question', async t => {
  const f = await fixture(t, { holdYieldCommit: true }), tool = new AbortController(), request = foregroundApproval()
  const started = await bounded(f.dispatch.start({ ...f.input, background: false }, f.parent, tool.signal))
  await bounded(f.streamStarted.promise)
  const waiting = f.dispatch.waitForResult(started, f.parent, tool.signal, 'cancelled-yield-call')
  f.pending([request])
  await bounded(f.yieldCommitting.promise)
  const rejected = assert.rejects(waiting, { code: 'REMOTE_CANCELLED' })
  tool.abort()
  await bounded(rejected)
  assertNoWaitListeners(f.controller)
  assert.equal(f.disposals, 0, 'an uncommitted handoff defers the cancellation decision')
  f.yieldCommit.resolve()
  await f.waitForRecord(record => record.background && !record.foregroundYield && record.notifiedRequests?.includes(request.id))
  assert.equal(f.disposals, 0, 'committed background work must not be cancelled')
  assert.deepEqual(f.calls.map(call => call.path), ['/runs'])
  assert.equal(f.reports.length, 1, 'cancelled tool delivery is replaced by one parent question')
  assert.equal(f.reports[0].requestId, `hub-question-${f.input.runId}-${request.id}`)
  await f.controller.respond(f.input.runId, request.id, { outcome: 'allowed-once' }, f.parent.id)
  f.finish()
  await f.waitForRecord(record => record.reportDelivered)
  await bounded(started.execution.result)
  assert.equal(f.reports.length, 2)
  assert.equal(f.reports[1].requestId, `hub-result-${f.input.runId}`)
  assert.equal(f.nativeNotices.length, 0)
  assert.equal(f.disposals, 1)
  assert.equal(f.providerStarts, 1)
  assert.equal(f.calls.filter(call => call.path === '/runs').length, 1)
})
