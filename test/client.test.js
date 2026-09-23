import test from 'node:test'
import assert from 'node:assert/strict'

let loadSequence = 0

async function loadClientModule() {
  let definition
  const localStorage = new Map()
  const windowStub = {
    document: { title: 'DeepSeek Harness' },
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
  const React = {
    createElement() {},
    useEffect() {},
    useState(value) { return [typeof value === 'function' ? value() : value, () => {}] },
  }
  const client = definition.factory((name) => {
    assert.equal(name, 'react')
    return React
  })
  return { client, definition, windowStub }
}

test('exports a top-level Hub client package', async () => {
  const { client, definition } = await loadClientModule()
  assert.equal(definition.id, 'dsh-server-hub')
  assert.deepEqual(client.inject, ['slots', 'layout'])
  assert.equal(typeof client.apply, 'function')
})

test('embedded remote pages skip the Hub UI', async () => {
  const { client, windowStub } = await loadClientModule()
  windowStub.parent = {}
  client.apply({
    effect() { throw new Error('embedded mode must not register effects') },
    slots: { inject() { throw new Error('embedded mode must not register slots') } },
  })
})
