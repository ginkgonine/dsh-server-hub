import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { RemoteStore } from '../src/remote/store.js'
import { createRemoteRoute, REMOTE_ROUTE } from '../src/remote/routes.js'

let loadSequence = 0

function remoteConfigFixture(global) {
  const snapshot = { global: structuredClone(global), tables: { runs: { running: { runId: 'running', state: 'running' } }, masters: {} } }
  let writes = 0
  const unit = {
    loadAll: async () => structuredClone(snapshot),
    setGlobal: async config => { writes++; snapshot.global = structuredClone(config) },
    close: async () => {},
  }
  const ctx = {
    storage: { backend: { get: () => ({ kv: { open: async () => unit } }) } },
    webServer: { port: 3080 },
    connection: { requestRejection: () => undefined },
    workspaceRegistry: { list: () => [{ id: 'project', path: '/project' }], get: id => id === 'project' },
  }
  return { ctx, snapshot, writes: () => writes }
}

test('reply mode preserves old true/false settings and defaults missing fields without migration', async () => {
  for (const mode of [undefined, true, false]) {
    const global = { instanceId: 'existing', enabled: true, workspaceIds: ['project'], ...(mode === undefined ? {} : { waitForResult: mode }) }
    const f = remoteConfigFixture(global)
    const store = await RemoteStore.open(f.ctx)
    const expected = { ...global, waitForResult: mode === true }
    assert.deepEqual(store.getConfig(), expected)
    assert.deepEqual(f.snapshot.global, global, 'opening must not rewrite old records')
    assert.equal(f.writes(), 0)
    for (const waitForResult of [true, false, true]) {
      assert.deepEqual(await store.setConfig({ waitForResult }), { ...expected, waitForResult })
      assert.deepEqual(f.snapshot.global, { ...expected, waitForResult })
    }
    assert.deepEqual(await store.setConfig({ enabled: false, workspaceIds: [] }), { ...expected, enabled: false, workspaceIds: [], waitForResult: true })
    assert.deepEqual(store.get('runs', 'running'), { runId: 'running', state: 'running' })
    assert.deepEqual(f.snapshot.tables.runs.running, { runId: 'running', state: 'running' })
    await store.close()
    const reopened = await RemoteStore.open(f.ctx)
    assert.equal(reopened.getConfig().waitForResult, true)
    assert.equal(f.writes(), 4, 'reopening must not migrate the saved true setting')
    await reopened.close()
  }
})

test('new remote config persists the default disabled reply mode', async () => {
  const f = remoteConfigFixture(undefined)
  const store = await RemoteStore.open(f.ctx)
  assert.equal(store.getConfig().waitForResult, false)
  assert.equal(store.getConfig().enabled, false)
  assert.deepEqual(store.getConfig().workspaceIds, [])
  assert.deepEqual(f.snapshot.global, store.getConfig())
  assert.equal(f.writes(), 1)
  await store.close()
})

test('config PUT persists either boolean reply mode without changing permissions or existing tasks', async () => {
  const f = remoteConfigFixture({ instanceId: 'existing', enabled: true, workspaceIds: ['project'], waitForResult: true })
  const store = await RemoteStore.open(f.ctx)
  // Any unexpected worker/controller side effect fails: configuration must not stop tasks.
  const forbidden = new Proxy({}, { get() { throw new Error('config must not control existing tasks') } })
  const route = createRemoteRoute({ ctx: f.ctx, store, worker: forbidden, controller: forbidden })
  async function request(method, input) {
    const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
    Object.assign(req, { method, url: `${REMOTE_ROUTE}/config`, headers: { 'content-type': 'application/json' } })
    let status, value
    const res = { writeHead(code) { status = code }, end(data) { value = JSON.parse(data) } }
    await route(req, res)
    return { status, value }
  }
  for (const mode of [true, false]) {
    const result = await request('PUT', { waitForResult: mode })
    assert.equal(result.status, 200)
    assert.equal(result.value.waitForResult, mode)
    assert.equal((await request('GET')).value.waitForResult, mode)
    assert.equal(f.snapshot.global.waitForResult, mode)
    assert.equal(result.value.enabled, true)
    assert.deepEqual(result.value.workspaceIds, ['project'])
  }
  const changed = await request('PUT', { enabled: false, workspaceIds: [], waitForResult: true })
  assert.equal(changed.status, 200)
  assert.equal(changed.value.enabled, false)
  assert.deepEqual(changed.value.workspaceIds, [])
  assert.equal(changed.value.waitForResult, true)
  assert.equal((await request('GET')).value.waitForResult, true)
  const workspaceOnly = await request('PUT', { enabled: true, workspaceIds: ['project'] })
  assert.equal(workspaceOnly.value.waitForResult, true, 'workspace changes must preserve reply mode')
  const beforeInvalid = store.getConfig()
  for (const input of [{ waitForResult: 'true' }, { waitForResult: null }, { waitForResult: 0 }, {}, { enabled: true }, { workspaceIds: ['project'] }, { waitForResult: true, extra: 1 }]) {
    assert.equal((await request('PUT', input)).status, 400)
  }
  assert.deepEqual(store.getConfig(), beforeInvalid)
  assert.deepEqual(store.get('runs', 'running'), { runId: 'running', state: 'running' })
  await store.close()
})

async function loadClientModule() {
  let definition
  const localStorage = new Map()
  const windowStub = {
    document: {
      title: 'DeepSeek Harness', baseURI: 'http://127.0.0.1:3080/', referrer: '',
      createElement: () => ({ dataset: {}, remove() {} }), head: { appendChild() {} },
    },
    addEventListener() {},
    removeEventListener() {},
    localStorage: {
      getItem(key) { return localStorage.has(key) ? localStorage.get(key) : null },
      setItem(key, value) { localStorage.set(key, String(value)) },
    },
    __ModuleLoader__: {
      load(value) { definition = value },
    },
  }
  windowStub.parent = windowStub
  globalThis.window = windowStub
  loadSequence += 1
  await import(`../src/client.js?test=${loadSequence}`)
  const effects = []
  const React = {
    createElement(type, props) { return { type, props } },
    useEffect(callback) { effects.push(callback) },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
  }
  const client = definition.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  return { client, definition, windowStub, effects }
}

test('exports a top-level Hub client package', async () => {
  const { client, definition } = await loadClientModule()
  assert.equal(definition.id, 'dsh-server-hub')
  assert.deepEqual(client.inject, ['slots', 'layout'])
  assert.equal(typeof client.apply, 'function')
})

test('embedded remote pages register only the settings bridge and overlay, without the Hub UI', async () => {
  const { client, windowStub } = await loadClientModule()
  windowStub.parent = {}
  const labels = []
  const registered = []
  client.apply({
    effect(callback, label) { labels.push(label); return callback() },
    slots: {
      inject(name, callback) { assert.equal(name, 'shell.overlay'); callback() },
      register(options) { registered.push(options.id); return () => {} },
    },
  })
  assert.deepEqual(registered, ['dsh-server-hub-remote-settings'])
  assert.deepEqual(labels, ['dsh-server-hub: remote settings bridge', 'dsh-server-hub: styles'])
})

test('registers compatible slots and polls within root and proxy mounts', async () => {
  for (const base of ['http://localhost:3080/', 'https://example.test/dsh/']) {
    const { client, windowStub, effects } = await loadClientModule()
    const slots = new Map()
    const injected = []
    const selected = []
    let requested
    let cleared = false
    windowStub.document.baseURI = base
    windowStub.document.createElement = () => ({ dataset: {}, remove() {} })
    windowStub.document.head = { appendChild() {} }
    windowStub.setInterval = () => 1
    windowStub.clearInterval = () => { cleared = true }
    windowStub.fetch = async (url, options) => {
      requested = new URL(url, windowStub.document.baseURI).href
      assert.equal(options.credentials, 'same-origin')
      return { ok: true, json: async () => ({ instances: [], states: {} }) }
    }
    client.apply({
      effect(callback) { return callback() },
      layout: { selectPanel(id) { selected.push(id) } },
      slots: {
        inject(name, callback) { injected.push(name); callback() },
        register(options, component) { slots.set(options.name, { options, component }); return () => {} },
      },
    })
    assert.deepEqual(injected, ['shell.overlay', 'shell.overlay', 'sidebar.panellist', 'main'])
    assert.equal(slots.get('main').options.key, slots.get('sidebar.panellist').options.id)
    const monitor = slots.get('shell.overlay').component()
    monitor.type(monitor.props)
    const cleanup = effects[0]()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(requested, `${base}api/dsh-server-hub/overview?`)
    cleanup()
    assert.equal(cleared, true)
    assert.deepEqual(selected, [])
  }
})

test('browser title uses animated working and colored attention glyphs', async () => {
  const { client } = await loadClientModule()
  const item = { id: 'server', label: 'V100服务器' }
  const snapshot = { instances: [item], states: { server: { online: true, workingCount: 1, waitingCount: 0 } } }
  const first = client.formatDocumentTitle(snapshot, 'DeepSeek Harness', 0)
  const second = client.formatDocumentTitle(snapshot, 'DeepSeek Harness', 1)
  assert.notEqual(first, second)
  assert.match(first, /\[V100服务器\] working$/)

  snapshot.states.server = { online: true, workingCount: 1, waitingCount: 1 }
  assert.match(client.formatDocumentTitle(snapshot, 'DeepSeek Harness'), /^❗/)
  snapshot.states.server = { online: true, workingCount: 0, waitingCount: 0, completedUnread: true }
  assert.match(client.formatDocumentTitle(snapshot, 'DeepSeek Harness'), /^✅/)
})
