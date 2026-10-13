import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { apply, inject } from '../src/remote/index.js'

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
  const ctx = {
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
  let runtime
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
  } else {
    const dispose = await apply(ctx)
    assert.equal(typeof dispose, 'function', 'async apply must resolve to a valid Cordis disposer')
    runtime = { ...ctx.serverHubRemote, dispose }
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
  return { ctx, runtime, tools, providers, cookie, endpoint, request, finish, prompts, notices, creates, credentials, agents }
}

test('actual Cordis activates routes/tools and removes them on disposal', { skip: !process.env.DSH_TEST_CORDIS }, async t => {
  const cordis = await import(process.env.DSH_TEST_CORDIS)
  assert.deepEqual(Object.keys(cordis.Inject.resolve(inject)), inject)
  for (const plugin of [{ name: 'dsh-server-hub-remote', inject, apply }, await import('../lib/remote/index.js')]) {
    const f = await fixture(t, cordis, plugin)
    assert.equal((await f.request('/config')).status, 200)
    assert.equal((await f.request('/connections')).status, 200)
    assert.equal((await f.request('/activity')).status, 200)
    assert.equal(f.tools.size, 4)
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
  for (const [path, method, input] of [['/catalog', 'GET'], ['/config', 'PUT', { enabled: true, workspaceIds: ['system'] }], ['/runs/r1/events', 'GET'], ['/connections', 'POST', { endpoint: f.endpoint }]]) {
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
  assert.equal(main.creates.length, 0, 'no shadow/local worker Agent')
  assert.equal(worker.creates.length, 1)
  assert.deepEqual(Object.keys(worker.creates[0]).sort(), ['cwd', 'sessionId'])
  assert.equal(worker.prompts.length, 1, 'no additional prompts while waiting')
  worker.finish(worker.creates[0].sessionId)
  const [notice] = await bounded(report)
  assert.equal(notice.sessionId, 'parent-1')
  assert.match(notice.content[0].text, /Memory 40%, CPU 8%, Docker healthy/)
  const result = await main.tools.get('remote_agent_status').execute({ runId: submit.runId }, { agent: { id: 'parent-1' } })
  assert.equal(result.state, 'completed')
  assert.equal('prompt' in result, false)
  const activity = await main.request('/activity')
  assert.equal(activity.value.runs[0].runId, submit.runId)
  assert.equal(activity.value.runs[0].state, 'completed')
  assert.equal('prompt' in activity.value.runs[0], false)
  await assert.rejects(main.tools.get('remote_agent_status').execute({ runId: submit.runId }, { agent: { id: 'another-parent' } }), /belong/)
  await main.runtime.controller.report(await main.runtime.store.get('masters', submit.runId))
  assert.equal(main.prompts.length, 1)
  assert.equal(worker.prompts.length, 1)
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
  await main.tools.get('remote_agent_interrupt').execute({ runId: first.runId }, exec)
  assert.equal((await worker.runtime.worker.get(first.runId)).state, 'interrupted')
})
