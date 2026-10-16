import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { apply, inject } from '../src/remote/index.js'
import { RemoteStore } from '../src/remote/store.js'

test('Cordis injection metadata names services directly, not required/optional pseudo-services', () => {
  assert.ok(Array.isArray(inject))
  assert.deepEqual(inject, ['webServer', 'connection', 'storage', 'storage.backend.json', 'credentials',
    'workspaceRegistry', 'sessionController', 'sessions', 'tools', 'subagents'])
})

test('published entry and bundle retain the same direct service dependencies', async () => {
  const built = await import('../lib/remote/index.js')
  assert.deepEqual(built.inject, inject)
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const entry = patch.split('- id: dsh-server-hub-remote')[1]
  assert.ok(entry, 'default bundle must install the remote service')
  const declaration = entry.match(/inject:\s*\[([^\]]+)\]/)
  assert.ok(declaration, 'bundle must use direct array injection, not required/optional keys')
  assert.deepEqual(declaration[1].split(',').map(value => value.trim()), inject)
})

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const nativeCookie = port => `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}=v1.a.b`
async function bounded(promise) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test timeout')), 3000) })]) }
  finally { clearTimeout(timer) }
}

function assertBackgroundGuidance(message) {
  assert.match(message, /审批/)
  assert.match(message, /提问|问题/)
  assert.match(message, /完成|最终结果/)
  assert.match(message, /自动/)
  assert.match(message, /当前聊天/)
  assert.match(message, /独立工作/)
  assert.match(message, /结束本轮/)
  assert.match(message, /sleep/i)
  assert.match(message, /轮询|反复查询/)
  assert.match(message, /查询状态|remote_agent_status/)
  assert.match(message, /按需|询问进展|排障/)
}

function assertOverview(value, state) {
  assert.equal(value.state, state)
  for (const key of ['requests', 'output']) assert.equal(key in value, false, `model overview must omit ${key}`)
  assertBackgroundGuidance(value.message)
}

function assertResponseAck(value, runId, requestId) {
  assert.deepEqual(Object.keys(value).sort(), ['accepted', 'message', 'requestId', 'runId'])
  assert.equal(value.runId, runId)
  assert.equal(value.requestId, requestId)
  assert.equal(value.accepted, true)
  assert.match(value.message, /已|确认|成功/)
  assertBackgroundGuidance(value.message)
}

/** Fake DSH Agent/model services; real network, storage contracts and plugin code. */
async function fixture(t, cordis, plugin = { name: 'dsh-server-hub-remote', inject, apply }, nativeConnection) {
  const tools = new Map(), providers = new Map(), hooks = new Map(), agents = new Map(), sessions = new Map(), credentials = new Map()
  const effects = [], prompts = [], notices = new EventEmitter(), units = new Map(), creates = []
  let handler
  const server = http.createServer((req, res) => handler ? handler(req, res) : (res.writeHead(404), res.end()))
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  const port = server.address().port, endpoint = `http://127.0.0.1:${port}/`
  let cookie = nativeCookie(port)
  const workspace = { id: 'system', title: 'Server maintenance', path: '/project/system' }
  sessions.set('parent-1', { header: { id: 'parent-1', cwd: '/project/main' } })
  const parent = { id: 'parent-1', session: sessions.get('parent-1'), status: 'running' }
  const ctx = {
    get(name) { return ctx[name] },
    agents: { get: id => id === parent.id ? parent : agents.get(id), roots: () => [parent] },
    userQuestions: { ask: async request => { notices.emit('native-question', request); throw new Error('No question answerer') } },
    approval: { request: async request => { notices.emit('native-approval', request); return 'unavailable' } },
    effect(callback) { const dispose = callback(); effects.push(dispose); return dispose },
    provide(name, value) { ctx[name] = value },
    on(name, hook) { hooks.set(name, hook); return () => hooks.delete(name) },
    webServer: { port, register(route) { handler = route.handler; return () => { handler = undefined } } },
    connection: { requestRejection(req) {
      if (req.headers.origin && req.headers.origin !== endpoint.slice(0, -1)) return 403
      return String(req.headers.cookie || '').split(';').some(value => value.trim() === cookie) ? undefined : 401
    } },
    storage: { backend: { get(name) {
      assert.equal(name, 'json')
      return { kv: { open: async descriptor => {
        assert.equal(descriptor.name, `hub_remote_${port}`)
        const state = units.get(descriptor.name) || { tables: { runs: {}, masters: {} }, global: null }
        units.set(descriptor.name, state)
        return { loadAll: async () => structuredClone(state), setGlobal: async value => { state.global = structuredClone(value) },
          putRecord: async (table, id, value) => { state.tables[table][id] = structuredClone(value) }, close: async () => {} }
      } } }
    } } },
    credentials: { listRecords: async () => [...credentials].map(([key, record]) => ({ key, kind: record.kind })),
      readRecord: async key => structuredClone(credentials.get(key)),
      modifyRecord: async (key, mutate) => { const value = await mutate(credentials.get(key)); if (value) credentials.set(key, structuredClone(value)); return value },
      deleteRecord: async key => { credentials.delete(key) } },
    workspaceRegistry: { list: () => [workspace], get: id => id === workspace.id ? workspace : undefined,
      archivedSessionIds: [], archiveSession: async id => { ctx.workspaceRegistry.archivedSessionIds.push(id) } },
    sessions: { get: id => sessions.get(id), flush: async () => true },
    permissionPresets: { set() { assert.fail('Remote plugin must not reset permissions') } },
    sessionController: {
      inspect: async id => { if (!sessions.has(id)) throw new Error('Session not found'); return sessions.get(id) },
      create: async input => {
        creates.push(input)
        const events = [], idle = deferred(), scopedHooks = new Map(), guards = []
        const session = { header: { id: input.sessionId, cwd: input.cwd }, ownEvents: () => events }
        const agent = { id: input.sessionId, session, events, idle, status: 'idle', guards, scopedHooks,
          ctx: { tools: { guard: fn => guards.push(fn) }, on: (name, fn) => scopedHooks.set(name, fn) },
          whenIdle: () => idle.promise, cancel: () => { agent.status = 'idle'; idle.resolve() } }
        sessions.set(input.sessionId, session); agents.set(input.sessionId, agent)
        return { sessionId: input.sessionId }
      },
      // Actual current API shape, not the old alpha's incorrect { agent } mock.
      resolveAgent: async id => agents.get(id),
      prompt: async input => {
        prompts.push(input)
        if (input.sessionId === 'parent-1') notices.emit('report', input)
        else {
          const agent = agents.get(input.sessionId)
          agent.status = 'running'; agent.events.push({ type: 'turn/start', data: { turn: 1 } })
          notices.emit('worker-prompt', input)
        }
        return { accepted: true }
      },
    },
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    subagents: { registerProvider(provider) { providers.set(provider.name, provider); return () => providers.delete(provider.name) },
      start: async (name, request) => providers.get(name).start(request) },
  }
  // Also run this fixture through the actual installed Cordis when requested:
  // DSH_TEST_CORDIS=<absolute Cordis module path> node --test test/remote-plugin.test.js
  let runtime, assemblePrompt
  if (cordis) {
    const root = new cordis.Context()
    t.after(() => root.fiber.dispose())
    for (const name of inject) {
      if (name === 'connection' && nativeConnection) continue
      root.provide(name, name === 'storage.backend.json' ? {} : ctx[name])
    }
    if (nativeConnection) {
      await bounded(root.plugin(nativeConnection).await())
      const url = new URL(root.connection.authenticatedUrl(endpoint))
      // Mint test-only cookies using the real native token exchange. No live
      // profile secrets, launch tokens or browser authentication are inspected.
      root.connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: url.host } }, {
        writeHead(status, headers) { assert.equal(status, 303); cookie = headers['set-cookie'].split(';')[0] }, end() {},
      })
    }
    const fiber = root.plugin(plugin)
    await bounded(fiber.await())
    assert.equal(fiber.state, 2, 'plugin must become ACTIVE, not PENDING/FAILED')
    runtime = { ...root.serverHubRemote, dispose: () => fiber.dispose() }
    assemblePrompt = (assembly, context) => root.waterfall('system-prompt/assemble', assembly, context, () => Promise.resolve(assembly))
  } else {
    const dispose = await apply(ctx)
    assert.equal(typeof dispose, 'function', 'async apply must resolve to a valid Cordis disposer')
    runtime = { ...ctx.serverHubRemote, dispose }
    assemblePrompt = (assembly, context) => hooks.has('system-prompt/assemble')
      ? hooks.get('system-prompt/assemble')(assembly, context, () => Promise.resolve(assembly)) : Promise.resolve(assembly)
  }
  t.after(async () => { await runtime.dispose(); for (const cleanup of effects.reverse()) await cleanup?.() })
  const request = async (path, { method = 'GET', input, cookies = cookie, origin } = {}) => {
    const res = await fetch(`${endpoint}api/dsh-server-hub/remote${path}`, { method, headers: { cookie: cookies,
      ...(origin ? { origin } : {}), ...(input ? { 'content-type': 'application/json' } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) })
    return { status: res.status, value: await res.json().catch(() => undefined) }
  }
  const finish = (sessionId, output = 'Memory 40%, CPU 8%, Docker healthy') => {
    const agent = agents.get(sessionId)
    agent.events.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: output }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
    agent.status = 'idle'; agent.idle.resolve()
  }
  const assemble = ({ visibleTools = [...tools.values()], agent = parent } = {}) => assemblePrompt(
    { sections: [], contexts: [], tools: visibleTools, variables: {} }, { agent })
  return { ctx, runtime, tools, providers, cookie, endpoint, request, finish, prompts, notices, creates, credentials, agents, units, parent, hooks, assemble }
}

test('actual Cordis activates routes/tools and removes them on disposal', { skip: !process.env.DSH_TEST_CORDIS }, async t => {
  const cordis = await import(process.env.DSH_TEST_CORDIS)
  assert.deepEqual(Object.keys(cordis.Inject.resolve(inject)), inject)
  for (const plugin of [{ name: 'dsh-server-hub-remote', inject, apply }, await import('../lib/remote/index.js')]) {
    const f = await fixture(t, cordis, plugin)
    assert.equal((await f.request('/config')).status, 200)
    assert.equal((await f.request('/connections')).status, 200)
    assert.equal((await f.request('/activity')).status, 200)
    assert.equal(f.tools.size, 5)
    assert.equal(f.providers.size, 1)
    await f.runtime.dispose()
    assert.equal((await f.request('/config')).status, 404)
    assert.equal(f.tools.size, 0)
    assert.equal(f.providers.size, 0)
  }
})

async function connected(t, cordis, nativeConnection) {
  const main = await fixture(t, cordis, undefined, nativeConnection), worker = await fixture(t, cordis, undefined, nativeConnection)
  await worker.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['system'] } })
  const response = await main.request('/connections', { method: 'POST', cookies: `${main.cookie}; ${worker.cookie}`, input: { endpoint: worker.endpoint } })
  assert.equal(response.status, 200)
  return { main, worker, connection: response.value.connection }
}

test('real native DSH token exchange admits explicit cross-port connection without new credentials', {
  skip: !process.env.DSH_TEST_CORDIS || !process.env.DSH_TEST_CONNECTION,
}, async t => {
  const cordis = await import(process.env.DSH_TEST_CORDIS)
  const native = await import(process.env.DSH_TEST_CONNECTION)
  const { main, worker, connection } = await connected(t, cordis, native)
  assert.equal(connection.status, 'connected')
  assert.equal(connection.workspaces[0].id, 'system')
  assert.equal((await main.request('/connections')).value.connections.length, 1)
  assert.equal((await main.request('/connections', { method: 'POST', cookies: main.cookie, input: { endpoint: worker.endpoint } })).value.code, 'REMOTE_LOGIN_REQUIRED')
  assert.equal(main.creates.length, 0)
  assert.equal(worker.creates.length, 0)
})

test('connection errors explain disabled access, empty selection, missing permission and self without starting work', async t => {
  const main = await fixture(t), worker = await fixture(t)
  const connect = cookies => main.request('/connections', { method: 'POST', cookies, input: { endpoint: worker.endpoint } })
  const cookies = `${main.cookie}; ${worker.cookie}`
  let result = await connect(cookies)
  assert.equal(result.status, 400)
  assert.equal(result.value.code, 'REMOTE_DISABLED')
  await worker.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: [] } })
  assert.equal((await connect(cookies)).value.code, 'REMOTE_WORKSPACES_EMPTY')
  await worker.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['system'] } })
  assert.equal((await connect(main.cookie)).value.code, 'REMOTE_LOGIN_REQUIRED')
  result = await connect(cookies)
  assert.equal(result.status, 200)
  assert.equal(result.value.connection.status, 'connected')
  const self = await main.request('/connections', { method: 'POST', input: { endpoint: main.endpoint } })
  assert.equal(self.value.code, 'REMOTE_SELF')
  assert.equal(main.creates.length, 0)
  assert.equal(worker.creates.length, 0)
})

test('remote execution starts off; config exposes registered workspaces, never arbitrary paths', async t => {
  const f = await fixture(t)
  const catalog = await f.request('/catalog')
  assert.equal(catalog.value.enabled, false)
  assert.deepEqual(catalog.value.workspaces, [])
  const config = await f.request('/config')
  assert.equal(config.value.workspaces[0].id, 'system')
  assert.equal((await f.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['unknown'] } })).status, 400)
  assert.equal((await f.request('/runs', { method: 'POST', input: { runId: 'r1', workspaceId: 'system', prompt: 'inspect', description: 'inspect' } })).status, 400)
  assert.equal(f.creates.length, 0)
})

test('every route including SSE and config mutations requires native DSH admission', async t => {
  const f = await fixture(t)
  for (const [path, method, input] of [['/catalog', 'GET'], ['/config', 'PUT', { enabled: true, workspaceIds: ['system'] }], ['/config', 'PUT', { waitForResult: true }], ['/connections/remote-0123456789abcdef01234567', 'PUT', { name: '197服务器' }], ['/runs/r1/events', 'GET'], ['/runs/r1/requests/request-q1/response', 'POST', { response: { answers: [] }, human: true }], ['/delegated/r1/requests/request-q1/response', 'POST', { response: { outcome: 'allowed-once' } }], ['/connections', 'POST', { endpoint: f.endpoint }]]) {
    assert.equal((await f.request(path, { method, input, cookies: '' })).status, 401)
    assert.equal((await f.request(path, { method, input, origin: 'https://untrusted.example' })).status, 403)
  }
  assert.equal(f.creates.length, 0)
})

test('explicit existing-login connection and native one-shot provider report final output to original parent over HTTP/SSE', async t => {
  const { main, worker, connection } = await connected(t)
  assert.equal(connection.targetId.startsWith('remote-'), true)
  assert.equal(JSON.stringify(connection).includes('v1.a.b'), false)
  const targets = await main.tools.get('remote_agent_targets').execute({}, { agent: { id: 'parent-1' } })
  assert.equal(targets.targets[0].online, true)
  assert.equal(targets.targets[0].workspaces[0].id, 'system')
  const report = once(main.notices, 'report')
  const submit = await main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: 'Server check', prompt: 'Inspect memory, CPU and Docker without changing anything' },
    { agent: { id: 'parent-1' }, callId: 'call-1', signal: new AbortController().signal })
  assert.equal(submit.accepted, true)
  assertBackgroundGuidance(submit.message)
  const exec = { agent: { id: 'parent-1' } }
  const running = await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, exec)
  assertOverview(running, 'running')
  const internalRunning = await main.runtime.controller.status(submit.runId, 'parent-1')
  assert.deepEqual(internalRunning.requests, [])
  assert.deepEqual(internalRunning.output, [])
  assert.equal(main.creates.length, 0, 'no shadow/local worker Agent')
  assert.equal(worker.creates.length, 1)
  assert.deepEqual(Object.keys(worker.creates[0]).sort(), ['cwd', 'sessionId'])
  assert.equal(worker.prompts.length, 1, 'no additional prompts while waiting')
  worker.finish(worker.creates[0].sessionId)
  const [notice] = await bounded(report)
  assert.equal(notice.sessionId, 'parent-1')
  assert.match(notice.content[0].text, /Memory 40%, CPU 8%, Docker healthy/)
  const result = await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, { agent: { id: 'parent-1' } })
  assertOverview(result, 'completed')
  assert.equal('prompt' in result, false)
  const internalResult = await main.runtime.controller.status(submit.runId, 'parent-1')
  assert.match(internalResult.output[0].text, /Memory 40%, CPU 8%, Docker healthy/)
  assert.deepEqual(internalResult.requests, [])
  const activity = await main.request('/activity')
  assert.equal(activity.value.runs[0].runId, submit.runId)
  assert.equal(activity.value.runs[0].state, 'completed')
  assert.deepEqual(activity.value.runs[0].output, internalResult.output)
  assert.deepEqual(activity.value.runs[0].requests, internalResult.requests)
  assert.equal('prompt' in activity.value.runs[0], false)
  const workerResult = await worker.request(`/runs/${submit.runId}`)
  assert.deepEqual(workerResult.value.run.output, internalResult.output)
  assert.deepEqual(workerResult.value.run.requests, [])
  await assert.rejects(main.tools.get('remote_agent_status').execute({ runId: submit.runId }, { agent: { id: 'another-parent' } }), /belong/)
  await main.runtime.controller.report(await main.runtime.store.get('masters', submit.runId))
  assert.equal(main.prompts.length, 1)
  assert.equal(worker.prompts.length, 1)
})

test('model status omits requests and output in every cached lifecycle state while internal/UI snapshots retain them', async t => {
  const f = await fixture(t)
  const approval = { id: 'request-cached', createdAt: 1, kind: 'approval', toolName: 'write', reason: 'Cached approval payload' }
  const question = { id: 'request-question', createdAt: 1, kind: 'questions', ...questionPayload() }
  for (const state of ['running', 'waiting_approval', 'waiting_input', 'completed', 'error', 'interrupted']) {
    const runId = `cached-${state}`
    const requests = state === 'waiting_approval' ? [approval] : state === 'waiting_input' ? [question] : []
    const output = [{ type: 'text', text: `Private cached output: ${state}` }]
    await f.runtime.store.put('masters', runId, { runId, targetId: 'cached-target', workspaceId: 'system', description: 'Cached task',
      originSessionId: f.parent.id, background: false, state, createdAt: 1, updatedAt: 2, requests, output })
    const overview = await f.tools.get('remote_agent_status').execute({ runId }, { agent: f.parent })
    assertOverview(overview, state)
    assert.equal(overview.runId, runId)
    assert.equal(overview.updatedAt, 2)
    const internal = await f.runtime.controller.status(runId, f.parent.id)
    assert.deepEqual(internal.requests, requests)
    assert.deepEqual(internal.output, output)
    const ui = (await f.request('/activity')).value.runs.find(run => run.runId === runId)
    assert.deepEqual(ui.requests, requests)
    assert.deepEqual(ui.output, output)
  }
  assert.equal(f.prompts.length, 0, 'cached status reads must not dispatch notifications or invoke a model')
})

test('single-turn config persists independently of workspace changes and migrates old snapshots', async t => {
  const f = await fixture(t)
  assert.equal((await f.request('/config')).value.waitForResult, false)
  assert.equal((await f.request('/config', { method: 'PUT', input: { waitForResult: true } })).status, 200)
  await f.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['system'] } })
  assert.equal((await f.request('/config')).value.waitForResult, true)
  const reopened = await RemoteStore.open(f.ctx)
  t.after(() => reopened.close())
  assert.equal(reopened.getConfig().waitForResult, true)
  assert.deepEqual(reopened.getConfig().workspaceIds, ['system'])
  for (const input of [{}, { waitForResult: 'true' }, { enabled: true }, { workspaceIds: ['system'] }, { waitForResult: true, extra: 1 }]) {
    assert.equal((await f.request('/config', { method: 'PUT', input })).status, 400)
  }
  const state = f.units.values().next().value
  delete state.global.waitForResult
  const legacy = await RemoteStore.open(f.ctx)
  t.after(() => legacy.close())
  assert.equal(legacy.getConfig().waitForResult, false)
  assert.deepEqual(legacy.getConfig().workspaceIds, ['system'])
})

test('single-turn switch overrides explicit background and returns remote output without queuing another parent turn', async t => {
  const { main, worker, connection } = await connected(t)
  await main.request('/config', { method: 'PUT', input: { waitForResult: true } })
  const started = once(worker.notices, 'worker-prompt')
  let settled = false
  const result = main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: 'Check', prompt: 'inspect', run_in_background: true },
    { agent: { id: 'parent-1' }, callId: 'wait-1', signal: new AbortController().signal }).then(value => { settled = true; return value })
  await bounded(started)
  assert.equal(settled, false, 'current tool call must remain waiting')
  assert.equal(main.prompts.length, 0)
  await main.request('/config', { method: 'PUT', input: { waitForResult: false } })
  worker.finish(worker.creates[0].sessionId, 'Training progress inspected')
  const answer = await bounded(result)
  assert.equal(answer.stopReason, 'completed')
  assert.match(answer.output[0].text, /Training progress inspected/)
  assert.equal(main.prompts.length, 0, 'no sessionController.prompt means no extra report turn')
  assert.equal(worker.prompts.length, 1, 'no model polling during waiting')
  assert.equal(main.runtime.store.get('masters', answer.runId).background, false)
})

test('delivery mode of an existing background task does not change when the single-turn setting changes', async t => {
  const { main, worker, connection } = await connected(t)
  const args = { targetId: connection.targetId, workspaceId: 'system', description: 'Check', prompt: 'inspect', idempotencyKey: 'same-mode' }
  const exec = { agent: { id: 'parent-1' }, callId: 'bg-1', signal: new AbortController().signal }
  const first = await main.tools.get('remote_agent').execute(args, exec)
  await main.request('/config', { method: 'PUT', input: { waitForResult: true } })
  const retry = await bounded(main.tools.get('remote_agent').execute(args, exec))
  assert.equal(retry.accepted, true)
  assert.equal(retry.runId, first.runId)
  assert.equal(worker.creates.length, 1)
  const report = once(main.notices, 'report')
  worker.finish(worker.creates[0].sessionId)
  await bounded(report)
  assert.equal(main.prompts.length, 1)
})

test('name updates need only main admission and are visible to target lookup without reconnecting or dispatching', async t => {
  const { main, worker, connection } = await connected(t)
  const before = structuredClone([...main.credentials.values()])
  const path = `/connections/${connection.targetId}`
  let rename = await main.request(path, { method: 'PUT', input: { name: '197服务器' } })
  assert.equal(rename.status, 200)
  assert.equal(rename.value.connection.name, '197服务器')
  assert.equal(rename.value.connection.targetId, connection.targetId)
  let targets = await main.tools.get('remote_agent_targets').execute({}, { agent: { id: 'parent-1' } })
  assert.equal(targets.targets[0].name, '197服务器')
  const current = [...main.credentials.values()][0]
  assert.equal(current.payload.cookieValue, before[0].payload.cookieValue)
  rename = await main.request(path, { method: 'PUT', input: { name: 'old browser', onlyIfUnset: true } })
  assert.equal(rename.value.connection.name, '197服务器')
  assert.equal((await main.request(path, { method: 'PUT', input: { name: '', onlyIfUnset: 'true' } })).status, 400)
  assert.equal((await main.request(path, { method: 'PUT', input: { name: 'x', endpoint: worker.endpoint } })).status, 400)
  main.runtime.connections.fetchImpl = async () => { throw new Error('offline') }
  targets = await main.tools.get('remote_agent_targets').execute({}, { agent: { id: 'parent-1' } })
  assert.equal(targets.targets[0].online, false)
  assert.equal(targets.targets[0].name, '197服务器')
  assert.equal(main.creates.length, 0)
  assert.equal(worker.creates.length, 0)
  assert.equal(JSON.stringify(rename.value).includes('v1.a.b'), false)
})

test('model tool descriptions explain automatic delivery, ending the turn and on-demand status', async t => {
  const f = await fixture(t)
  for (const name of ['remote_agent', 'remote_agent_status', 'remote_agent_respond']) {
    const description = f.tools.get(name).description
    assert.match(description, /approvals?/i)
    assert.match(description, /questions?/i)
    assert.match(description, /complet|final (?:results?|output)/i)
    assert.match(description, /automatic/i)
    assert.match(description, /(?:current|original|this) chat/i)
    assert.match(description, /independent work/i)
    assert.match(description, /end (?:the |your |this )?(?:current )?turn/i)
    assert.match(description, /sleep/i)
    assert.match(description, /poll/i)
    if (name !== 'remote_agent_respond') assert.match(description, /on[- ]demand|progress|troubleshoot/i)
  }
  const status = f.tools.get('remote_agent_status').description
  assert.match(status, /overview/i)
  const respond = f.tools.get('remote_agent_respond').description
  assert.match(respond, /acknowledg/i)
})

const instanceContext = assembly => assembly.contexts.find(section => section.name === 'server-hub:remote-instances')
const instanceText = assembly => instanceContext(assembly) ? assembly.variables.server_hub_remote_instances : ''

test('instance context is absent without connections and follows connect, rename, disconnect and reconnect', async t => {
  const main = await fixture(t), worker = await fixture(t)
  assert.equal(instanceText(await main.assemble()), '')
  await worker.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['system'] } })
  const connect = () => main.request('/connections', { method: 'POST', cookies: `${main.cookie}; ${worker.cookie}`,
    input: { endpoint: worker.endpoint, name: '197服务器' } })
  const result = await connect()
  assert.equal(result.status, 200)
  const path = `/connections/${result.value.connection.targetId}`
  const expectedPrefix = name => new RegExp(`^Hub 已连接远程实例（1 个）：\\n- ${name}\\n\\n用户要求在这些实例上执行任务时，使用 remote_agent_targets 查询目标和工作区，再通过 remote_agent 派发任务。`)
  let assembly = await main.assemble()
  assert.match(instanceText(assembly), expectedPrefix('197服务器'))
  assertBackgroundGuidance(instanceText(assembly))
  assert.equal(instanceContext(assembly).text, '{{server_hub_remote_instances}}')
  assert.equal((await main.request(path, { method: 'PUT', input: { name: '训练服务器' } })).status, 200)
  assembly = await main.assemble()
  assert.match(instanceText(assembly), expectedPrefix('训练服务器'))
  assertBackgroundGuidance(instanceText(assembly))
  assert.equal(assembly.contexts.length, 1)
  assert.equal((await main.request(path, { method: 'DELETE' })).status, 200)
  assembly = await main.assemble()
  assert.deepEqual(assembly.contexts, [])
  assert.deepEqual(assembly.variables, {})
  assert.equal((await connect()).status, 200)
  const reconnected = instanceText(await main.assemble())
  assert.match(reconnected, expectedPrefix('197服务器'))
  assertBackgroundGuidance(reconnected)
  assert.equal(main.prompts.length, 0)
  assert.equal(worker.creates.length, 0)
  await main.runtime.dispose()
  assert.equal(instanceText(await main.assemble()), '')
})

test('instance context lists all names, falls back to endpoint, and never probes or exposes credentials', async t => {
  const { main, worker, connection } = await connected(t)
  const second = await fixture(t)
  await second.request('/config', { method: 'PUT', input: { enabled: true, workspaceIds: ['system'] } })
  assert.equal((await main.request('/connections', { method: 'POST', cookies: `${main.cookie}; ${second.cookie}`,
    input: { endpoint: second.endpoint, name: '197服务器' } })).status, 200)
  main.runtime.connections.fetchImpl = async () => assert.fail('prompt assembly must not contact a remote')
  let text = instanceText(await main.assemble())
  assert.match(text, /^Hub 已连接远程实例（2 个）：/)
  assert.ok(text.includes(`- ${worker.endpoint}\n- 197服务器`))
  assert.doesNotMatch(text, /v1\.a\.b|\/project\/system|targetId|workspaceId|别名|不保证/)
  await main.request(`/connections/${connection.targetId}`, { method: 'PUT', input: { name: '197服务器' } })
  text = instanceText(await main.assemble())
  assert.equal(text.split('\n').filter(line => line === '- 197服务器').length, 2, 'do not hide duplicate names')
})

test('instance context is omitted when dispatch tools are unavailable, in child/worker agents or on storage failure', async t => {
  const { main } = await connected(t)
  for (const hidden of ['remote_agent', 'remote_agent_targets']) {
    assert.equal(instanceText(await main.assemble({ visibleTools: [...main.tools.values()].filter(tool => tool.name !== hidden) })), '')
  }
  assert.equal(instanceText(await main.assemble({ agent: { session: { header: { origin: 'subagent' } } } })), '')
  const workerAgent = { id: 'remote-context-test' }
  main.runtime.worker.live.set('context-test', { agent: workerAgent })
  try { assert.equal(instanceText(await main.assemble({ agent: workerAgent })), '') }
  finally { main.runtime.worker.live.delete('context-test') }
  main.ctx.credentials.listRecords = async () => { throw new Error('storage unavailable') }
  assert.equal(instanceText(await main.assemble()), '')
})

test('real Cordis assembly hook renders instance names literally and is removed on disposal', {
  skip: !process.env.DSH_TEST_CORDIS || !process.env.DSH_TEST_SYSTEM_PROMPT,
}, async t => {
  const cordis = await import(process.env.DSH_TEST_CORDIS)
  const { renderContextSnapshot } = await import(process.env.DSH_TEST_SYSTEM_PROMPT)
  const { main, connection } = await connected(t, cordis)
  const name = '训练{{unknown_variable}}服务器'
  assert.equal((await main.request(`/connections/${connection.targetId}`, { method: 'PUT', input: { name } })).status, 200)
  const assembly = await main.assemble()
  assert.ok(renderContextSnapshot(assembly).includes(`- ${name}`))
  await main.runtime.dispose()
  assert.equal(instanceText(await main.assemble()), '')
})

const questionPayload = () => ({ questions: [{ id: 'scope', question: '选择检查范围', options: [{ label: 'GPU进程' }, { label: '全部' }] }] })
const questionAnswer = () => ({ answers: [{ id: 'scope', selected: ['GPU进程'] }] })
async function controllerState(controller, runId, state) {
  if ((await controller.status(runId, 'parent-1')).state === state) return controller.status(runId, 'parent-1')
  return bounded(new Promise(resolve => {
    const changed = async id => {
      if (id !== runId) return
      const value = await controller.status(runId, 'parent-1')
      if (value.state === state) { controller.events.off('changed', changed); resolve(value) }
    }
    controller.events.on('changed', changed)
    void changed(runId)
  }))
}

test('background questions cross real HTTP/SSE and ordinary reply resumes one original worker waterfall', async t => {
  const { main, worker, connection } = await connected(t)
  const exec = { agent: main.parent, callId: 'question-background', signal: new AbortController().signal }
  const submit = await main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: '检查GPU', prompt: 'inspect GPU' }, exec)
  const agent = worker.agents.get(worker.creates[0].sessionId)
  const notice = once(main.notices, 'report')
  const original = worker.hooks.get('user-questions/request')({ agent, ...questionPayload(), signal: new AbortController().signal }, () => assert.fail('worker must own the question'))
  const status = await controllerState(main.runtime.controller, submit.runId, 'waiting_input')
  const [notification] = await bounded(notice)
  assert.match(notification.content[0].text, /选择检查范围/)
  assert.ok(notification.requestId.includes(status.requests[0].id))
  const overview = await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, exec)
  assertOverview(overview, 'waiting_input')
  const activity = await main.request('/activity')
  assert.deepEqual(activity.value.runs[0].requests, status.requests)
  assert.deepEqual(activity.value.runs[0].output, status.output)
  await assert.rejects(main.tools.get('remote_agent_respond').execute({ runId: submit.runId, requestId: status.requests[0].id, ...questionAnswer() }, { agent: { id: 'another' } }), /belong/)
  const response = await main.tools.get('remote_agent_respond').execute({ runId: submit.runId, requestId: status.requests[0].id, ...questionAnswer() }, exec)
  assertResponseAck(response, submit.runId, status.requests[0].id)
  assert.deepEqual(await bounded(original), questionAnswer())
  assert.equal(worker.creates.length, 1)
  assert.equal(worker.prompts.length, 1)
  const final = once(main.notices, 'report')
  worker.finish(agent.id, 'GPU inspected')
  await bounded(final)
  assert.equal(main.prompts.length, 2, 'one request notification and one final result')
  const publicStatus = await main.runtime.controller.status(submit.runId, main.parent.id)
  for (const key of ['prompt', 'originSessionId', 'responseReceipts', 'interactionNotifications']) assert.equal(key in publicStatus, false)
})

test('background write approval reaches the controller chat and its Agent can relay allow, reject or cancel without a GUI', async t => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled']) {
    const { main, worker, connection } = await connected(t)
    const exec = { agent: main.parent, callId: `write-${outcome}`, signal: new AbortController().signal }
    main.ctx.userQuestions.ask = () => assert.fail('No automatic ask bridge')
    main.ctx.approval.request = () => assert.fail('No local escalation bridge')
    const submit = await main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: '写入配置', prompt: 'write config' }, exec)
    const agent = worker.agents.get(worker.creates[0].sessionId)
    const notice = once(main.notices, 'report')
    const original = worker.hooks.get('approval/request')({ agent, toolName: 'write', callId: 'write-call', reason: 'Write outside the workspace sandbox', signal: new AbortController().signal }, () => assert.fail('worker must own approval'))
    const status = await controllerState(main.runtime.controller, submit.runId, 'waiting_approval')
    const [notification] = await bounded(notice)
    assert.equal(notification.sessionId, main.parent.id)
    assert.match(notification.content[0].text, /write/)
    assert.match(notification.content[0].text, /正常回复询问/)
    assert.match(notification.content[0].text, /remote_agent_respond/)
    assert.doesNotMatch(notification.content[0].text, /Hub UI|requiresHuman|必须由人类/)
    assert.equal('requiresHuman' in status.requests[0], false)
    assertOverview(await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, exec), 'waiting_approval')
    const activity = await main.request('/activity')
    assert.deepEqual(activity.value.runs[0].requests, status.requests)
    assert.deepEqual(activity.value.runs[0].output, status.output)
    const args = { runId: submit.runId, requestId: status.requests[0].id, outcome }
    await assert.rejects(main.tools.get('remote_agent_respond').execute(args, { agent: { id: 'other-parent' } }), /belong/)
    const response = await main.tools.get('remote_agent_respond').execute(args, exec)
    assertResponseAck(response, submit.runId, status.requests[0].id)
    assert.equal(await bounded(original), outcome)
    assert.equal(worker.creates.length, 1)
    assert.equal(worker.prompts.length, 1)
    worker.finish(agent.id)
    await controllerState(main.runtime.controller, submit.runId, 'completed')
  }
})

test('busy-parent fixture keeps queued approvals in original notifications; status is inert and respond only acknowledges', async t => {
  const { main, worker, connection } = await connected(t)
  // This fixture records queue admissions, not real DSH inbox consumption/model turns.
  main.parent.status = 'running'
  const exec = { agent: main.parent, callId: 'busy-parent', signal: new AbortController().signal }
  const submit = await main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: '两次写入', prompt: 'write two configs' }, exec)
  const agent = worker.agents.get(worker.creates[0].sessionId)
  const checkpoint = deferred()
  main.ctx.sessions.flush = async () => { await checkpoint.promise; return true }
  const originals = [], requests = []
  try {
    for (const toolName of ['write-first', 'write-second']) {
      const notice = once(main.notices, 'report')
      originals.push(worker.hooks.get('approval/request')({ agent, toolName, reason: `Approve ${toolName}`, signal: new AbortController().signal }, () => assert.fail('worker must own approval')))
      const [notification] = await bounded(notice)
      assert.equal(notification.mode, 'queue')
      assert.equal(notification.sessionId, main.parent.id)
      // The request identity/payload comes from its original notification, never status.
      const request = JSON.parse(notification.content[0].text.split('\n').at(-1))
      assert.equal(request.toolName, toolName)
      assert.ok(notification.requestId.endsWith(request.id))
      requests.push(request)
    }
    const before = await main.runtime.store.get('masters', submit.runId)
    assert.deepEqual(before.notifiedRequests || [], [], 'queued admissions have not passed the blocked checkpoint')
    for (let i = 0; i < 2; i++) {
      assertOverview(await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, exec), 'waiting_approval')
    }
    assert.equal(main.parent.status, 'running', 'fixture parent is still busy; no queued prompt was consumed')
    assert.equal(main.prompts.length, 2, 'status must not submit another prompt')
    assert.deepEqual((await main.runtime.store.get('masters', submit.runId)).notifiedRequests || [], before.notifiedRequests || [], 'status must not mark queued notifications as handled')
  } finally { checkpoint.resolve() }

  const first = await main.tools.get('remote_agent_respond').execute({ runId: submit.runId, requestId: requests[0].id, outcome: 'allowed-once' }, exec)
  assertResponseAck(first, submit.runId, requests[0].id)
  assert.equal(JSON.stringify(first).includes(requests[1].id), false, 'ack must not leak another queued approval')
  assert.equal(await bounded(originals[0]), 'allowed-once')
  const internal = await main.runtime.controller.status(submit.runId, main.parent.id)
  assert.equal(internal.state, 'waiting_approval')
  assert.deepEqual(internal.requests, [requests[1]], 'internal status retains the other approval')
  assert.deepEqual((await main.request('/activity')).value.runs[0].requests, [requests[1]], 'UI data retains the other approval')
  assertOverview(await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, exec), 'waiting_approval')
  assert.equal(main.prompts.length, 2, 'neither status nor respond duplicates admitted notifications')
  const second = await main.tools.get('remote_agent_respond').execute({ runId: submit.runId, requestId: requests[1].id, outcome: 'rejected' }, exec)
  assertResponseAck(second, submit.runId, requests[1].id)
  assert.equal(await bounded(originals[1]), 'rejected')
  const final = once(main.notices, 'report')
  worker.finish(agent.id, 'Both approval decisions received')
  const [notification] = await bounded(final)
  assert.match(notification.content[0].text, /Both approval decisions received/)
  assert.equal(main.prompts.length, 3, 'two original approvals and one eventual result')
  assert.equal(worker.prompts.length, 1, 'same original remote model turn')
})

test('foreground questions and approvals return control to the Agent instead of waiting on a GUI or deadlocking', async t => {
  for (const kind of ['questions', 'approval']) {
    const { main, worker, connection } = await connected(t)
    await main.request('/config', { method: 'PUT', input: { waitForResult: true } })
    main.ctx.userQuestions.ask = () => assert.fail('The controller Agent chooses how to ask the user')
    main.ctx.approval.request = () => assert.fail('No native escalation forwarding')
    const started = once(worker.notices, 'worker-prompt')
    const ac = new AbortController()
    const result = main.tools.get('remote_agent').execute({ targetId: connection.targetId, workspaceId: 'system', description: '交互巡检', prompt: 'inspect', run_in_background: true },
      { agent: main.parent, callId: `foreground-${kind}`, signal: ac.signal })
    await bounded(started)
    const agent = worker.agents.get(worker.creates[0].sessionId)
    const original = worker.hooks.get(kind === 'questions' ? 'user-questions/request' : 'approval/request')({ agent, signal: new AbortController().signal,
      ...(kind === 'questions' ? questionPayload() : { toolName: 'write', reason: 'Write config' }) }, () => assert.fail('must capture'))
    const pending = await bounded(result)
    assert.equal(pending.requests[0].kind, kind)
    assert.match(pending.message, /当前聊天/)
    assert.equal(main.prompts.length, 0, 'the waiting tool returns the request, without also queueing another notification')
    assert.equal((await worker.runtime.worker.get(pending.runId)).state, kind === 'questions' ? 'waiting_input' : 'waiting_approval')
    ac.abort() // Completion of the old tool call must not cancel the yielded task.
    const reply = kind === 'questions' ? questionAnswer() : { outcome: 'allowed-once' }
    await main.tools.get('remote_agent_respond').execute({ runId: pending.runId, requestId: pending.requests[0].id, ...reply },
      { agent: main.parent, callId: 'reply', signal: new AbortController().signal })
    assert.deepEqual(await bounded(original), kind === 'questions' ? questionAnswer() : 'allowed-once')
    const final = once(main.notices, 'report')
    worker.finish(agent.id)
    await bounded(final)
    assert.equal(main.prompts.length, 1, 'only the eventual completion is reported in a new parent turn')
    assert.equal(worker.prompts.length, 1)
  }
})

test('same task identity deduplicates at both ends; revoked workspace cannot start new work', async t => {
  const { main, worker, connection } = await connected(t)
  const args = { targetId: connection.targetId, workspaceId: 'system', description: 'Check', prompt: 'inspect', idempotencyKey: 'same-task' }
  const exec = { agent: { id: 'parent-1' }, signal: new AbortController().signal, callId: 'call-a' }
  const first = await main.tools.get('remote_agent').execute(args, exec)
  const second = await main.tools.get('remote_agent').execute(args, { ...exec, callId: 'call-b' })
  assert.equal(first.runId, second.runId)
  assert.equal(worker.creates.length, 1)
  assert.equal(worker.prompts.length, 1)
  await worker.request('/config', { method: 'PUT', input: { enabled: false, workspaceIds: [] } })
  await assert.rejects(main.tools.get('remote_agent').execute({ ...args, idempotencyKey: 'different-task' }, exec), /拒绝派单/)
  assert.equal(worker.creates.length, 1)
  assert.equal(worker.prompts.length, 1)
  const interrupted = await main.tools.get('remote_agent_interrupt').execute({ runId: first.runId }, exec)
  assertOverview(interrupted, 'interrupted')
  assertOverview(await main.tools.get('remote_agent_status').execute({ runId: first.runId }, exec), 'interrupted')
  const internal = await main.runtime.controller.status(first.runId, 'parent-1')
  assert.deepEqual(internal.requests, [])
  assert.ok(Array.isArray(internal.output))
  assert.equal((await worker.runtime.worker.get(first.runId)).state, 'interrupted')
})
