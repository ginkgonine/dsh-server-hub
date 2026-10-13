import test from 'node:test'
import assert from 'node:assert/strict'

let loadSequence = 0

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
