import test from 'node:test'
import assert from 'node:assert/strict'

let sequence = 0
const OPEN = 'dsh-hub-remote-settings/open'
const SAVED = 'dsh-hub-remote-settings/saved'
const CLOSED = 'dsh-hub-remote-settings/closed'
const config = { version: 1, instanceId: 'worker', enabled: false, workspaceIds: [], workspaces: [{ id: 'sr', title: 'SR project', path: '/projects/sr' }] }
const overview = {
  instances: [
    { port: 3080, url: 'http://127.0.0.1:3080/', source: 'local' },
    { port: 3081, url: 'http://127.0.0.1:3081/', source: 'auto' },
  ],
  states: { 'http://127.0.0.1:3081/': { online: true, supported: true, epoch: 'test', workingCount: 2, waitingCount: 0, completionSeq: 1 } },
}
const connection = { targetId: 'target-3081', endpoint: 'http://localhost:3081/', instanceId: 'worker', status: 'connected', workspaces: config.workspaces }
const tick = () => new Promise(resolve => setImmediate(resolve))

async function harness({ base = 'http://localhost:3080/', embedded = false, referrer = 'http://localhost:3080/', fetch: doFetch, initialConnections = [], names = {}, overviewData = overview } = {}) {
  let definition
  const listeners = new Map(), requests = [], disposers = [], slots = new Map(), effects = [], intervals = new Map()
  let intervalId = 0, removedStyle = false, savedConfig = structuredClone(config), savedConnections = structuredClone(initialConnections)
  const parent = { sent: [], postMessage(data, origin) { this.sent.push({ data, origin }) } }
  const win = {
    document: {
      title: 'DeepSeek Harness', baseURI: base, referrer: embedded ? referrer : '',
      createElement: () => ({ dataset: {}, remove() { removedStyle = true } }), head: { appendChild() {} },
    },
    localStorage: { getItem(key) { return key === 'dsh-server-hub.preferences.v1' ? JSON.stringify({ names, manualPorts: [] }) : null }, setItem() {} },
    addEventListener(type, callback) { listeners.set(type, callback) },
    removeEventListener(type, callback) { if (listeners.get(type) === callback) listeners.delete(type) },
    setInterval(callback) { intervals.set(++intervalId, callback); return intervalId },
    clearInterval(id) { intervals.delete(id) },
    __ModuleLoader__: { load(value) { definition = value } },
    async fetch(url, options) {
      requests.push({ url, resolved: new URL(url, base).href, options })
      if (doFetch) return doFetch(url, options)
      let value
      if (url.startsWith('api/dsh-server-hub/overview')) value = overviewData
      else if (url.endsWith('/config')) {
        if (options.method === 'PUT') savedConfig = { ...savedConfig, ...JSON.parse(options.body) }
        value = savedConfig
      } else if (url.endsWith('/connections') && options.method === 'POST') {
        const connected = { ...connection, endpoint: JSON.parse(options.body).endpoint }
        savedConnections = [connected]
        value = { connection: connected }
      } else if (url.endsWith('/connections')) value = { connections: savedConnections }
      else if (url.endsWith('/activity')) value = { runs: [{ runId: 'r1', sessionId: 's1', state: 'running', description: 'Check CPU' }] }
      else if (options.method === 'DELETE') { savedConnections = []; return { ok: true, status: 204 } }
      else throw new Error(`Unexpected fetch: ${url}`)
      return { ok: true, status: 200, json: async () => structuredClone(value) }
    },
  }
  win.parent = embedded ? parent : win
  globalThis.window = win
  await import(`../src/client.js?remote-test=${++sequence}`)
  const state = new Map()
  let current, stateIndex
  const React = {
    createElement(type, props, ...children) { return { type, props: { ...props, children } } },
    useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot() },
    useEffect(callback) { effects.push(callback) },
    useState(value) {
      const bucket = state.get(current) || []
      state.set(current, bucket)
      const index = stateIndex++
      if (!(index in bucket)) bucket[index] = typeof value === 'function' ? value() : value
      return [bucket[index], next => { bucket[index] = typeof next === 'function' ? next(bucket[index]) : next }]
    },
  }
  const client = definition.factory(name => { assert.equal(name, 'react'); return React })
  client.apply({
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
    layout: { selectPanel() {} },
    slots: {
      inject(_name, callback) { callback() },
      register(options, component) { slots.set(options.id || options.key, { options, component }); return () => {} },
    },
  })
  function render(component, props) { current = component; stateIndex = 0; return component(props) }
  function panel() { const node = slots.get('dsh-server-hub').component(); return render(node.type, node.props) }
  function modal() { return render(slots.get('dsh-server-hub-remote-settings').component) }
  async function mountMonitor() {
    const node = slots.get('dsh-server-hub-monitor').component()
    render(node.type, node.props)
    const cleanup = effects[0]()
    if (cleanup) disposers.push(cleanup)
    await tick()
  }
  function message(source, origin, type, extra = {}) { listeners.get('message')?.({ source, origin, data: { type, ...extra } }) }
  function cleanup() { for (const dispose of disposers.reverse()) dispose() }
  return { client, win, parent, listeners, requests, slots, intervals, panel, modal, mountMonitor, message, cleanup, styleRemoved: () => removedStyle }
}
function nodes(tree) {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  return [tree, ...nodes(tree.props?.children)]
}
function text(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree !== 'object') return String(tree)
  if (Array.isArray(tree)) return tree.map(text).join('')
  return text(tree.props?.children)
}
function button(tree, label) {
  const result = nodes(tree).find(node => node.type === 'button' && text(node) === label)
  assert.ok(result, `Missing button ${label}`)
  return result
}
function registerFrames(h) {
  const frames = nodes(h.panel()).filter(node => node.type === 'iframe')
  const children = frames.map(() => ({ sent: [], postMessage(data, origin) { this.sent.push({ data, origin }) } }))
  frames.forEach((frame, index) => { frame.props.ref({ contentWindow: children[index] }); frame.props.onLoad() })
  return { frames, children }
}
function selectWorker(h) {
  const tab = nodes(h.panel()).find(node => node.type === 'button' && node.props['data-dsh-hub-port'] === 3081)
  assert.ok(tab); tab.props.onClick(); return h.panel()
}
async function openWorker(h) { await button(selectWorker(h), '远控设置').props.onClick() }

test('toolbar has one remote entry; local controller explains self instead of a grey connection button', async () => {
  const h = await harness()
  const labels = nodes(h.panel()).filter(node => node.type === 'button').map(text)
  assert.equal(labels.filter(label => label === '执行端管理').length, 1)
  for (const old of ['主控', '远程 Agent', '远控配置', '连接远控', '远控目标']) assert.equal(labels.includes(old), false)
  assert.equal(h.requests.length, 0)
  await button(h.panel(), '执行端管理').props.onClick()
  assert.match(text(h.modal()), /主控 :3080 · 无需连接自己/)
  assert.equal(nodes(h.modal()).some(node => node.type === 'button' && /连接执行端/.test(text(node))), false)
  assert.equal(nodes(h.modal()).some(node => node.type === 'input'), false)
  assert.equal(nodes(h.modal()).find(node => node.type === 'h2').props.children[0], '执行端管理')
  h.cleanup()
})

function instanceTab(h, port) {
  const tab = nodes(h.panel()).find(node => node.type === 'button' && node.props['data-dsh-hub-port'] === port)
  assert.ok(tab, `Missing instance tab :${port}`)
  return tab
}

test('roles stay anchored to main page; labels preserve custom names and known connections appear before opening settings', async () => {
  const h = await harness({ initialConnections: [connection], names: { '3080': '开发主机', '3081': '维护实例' } })
  await h.mountMonitor(); registerFrames(h)
  const local = instanceTab(h, 3080), worker = instanceTab(h, 3081)
  assert.equal(local.props['data-dsh-hub-role'], 'controller')
  assert.match(text(local), /主控 · 开发主机 · 3080/)
  assert.equal(worker.props['data-dsh-hub-role'], 'worker')
  assert.match(text(worker), /执行端 · 维护实例 · 3081.*已连接/)
  assert.equal(worker.props['data-dsh-hub-connection'], '已连接')
  assert.equal(h.modal(), null, 'connection badge must work without opening settings')
  worker.props.onClick()
  assert.ok(button(h.panel(), '远控设置'))
  assert.equal(instanceTab(h, 3080).props['data-dsh-hub-role'], 'controller')
  await button(h.panel(), '远控设置').props.onClick()
  assert.match(text(h.modal()), /执行端 :3081 接受主控 :3080/)
  assert.match(text(h.modal()), /SR project/)
  assert.equal(nodes(h.modal()).some(node => node.type === 'button' && text(node).startsWith('连接执行端')), false)
  assert.ok(button(h.modal(), '修改工作区'))
  assert.ok(button(h.modal(), '断开连接'))
  assert.doesNotMatch(text(h.modal()), /本机尚未接入|已连接的执行端|尚未连接执行端|访问许可|登录/)
  instanceTab(h, 3080).props.onClick()
  await button(h.panel(), '执行端管理').props.onClick()
  assert.equal(nodes(h.modal()).find(node => node.type === 'h2').props.children[0], '执行端管理')
  assert.match(text(h.modal()), /已连接的执行端.*SR project/)
  assert.equal(nodes(h.modal()).some(node => node.type === 'input'), false)
  const records = nodes(h.modal()).find(node => node.type === 'details')
  assert.ok(records); assert.equal(records.props.open, undefined, 'task records default closed')
  h.cleanup()
})

test('controller identity follows the current main instance, not a hardcoded port or selected worker', async () => {
  const h = await harness({ base: 'http://localhost:3081/', overviewData: {
    ...overview, instances: [
      { port: 3081, url: 'http://127.0.0.1:3081/', source: 'local' },
      { port: 3080, url: 'http://127.0.0.1:3080/', source: 'auto' },
    ],
  } })
  await h.mountMonitor(); registerFrames(h)
  assert.equal(instanceTab(h, 3081).props['data-dsh-hub-role'], 'controller')
  assert.equal(instanceTab(h, 3080).props['data-dsh-hub-role'], 'worker')
  instanceTab(h, 3080).props.onClick()
  await button(h.panel(), '远控设置').props.onClick()
  assert.match(text(h.modal()), /执行端 :3080 接受主控 :3081/)
  assert.ok(button(h.modal(), '连接执行端 :3080'))
  h.cleanup()
})

test('connect/disconnect update tab badges immediately and task status remains separate', async () => {
  const h = await harness()
  await h.mountMonitor(); registerFrames(h)
  assert.equal(instanceTab(h, 3081).props['data-dsh-hub-connection'], '未连接')
  assert.match(instanceTab(h, 3081).props.title, /2 个 Agent 工作中/)
  await openWorker(h)
  await button(h.modal(), '连接执行端 :3081').props.onClick()
  assert.equal(instanceTab(h, 3081).props['data-dsh-hub-connection'], '已连接')
  await button(h.modal(), '断开连接').props.onClick()
  assert.equal(instanceTab(h, 3081).props['data-dsh-hub-connection'], '未连接')
  assert.match(instanceTab(h, 3081).props.title, /2 个 Agent 工作中/)
  h.cleanup()
})

test('connection status reads once at mount and explicit refresh, never on periodic overview polls', async () => {
  const h = await harness()
  await h.mountMonitor()
  const connectionReads = () => h.requests.filter(request => request.url.endsWith('/connections')).length
  assert.equal(connectionReads(), 1)
  for (const callback of h.intervals.values()) callback()
  await tick()
  assert.equal(connectionReads(), 1)
  await button(h.panel(), '↻').props.onClick()
  assert.equal(connectionReads(), 2)
  assert.ok(h.requests.every(request => request.options.method === 'GET'))
  h.cleanup()
})

test('failed connection read is unknown, not disconnected; late old read cannot rewind a new connection', async () => {
  const failed = await harness({ fetch: async url => url.includes('/overview')
    ? { ok: true, json: async () => overview }
    : { ok: false, status: 404 } })
  await failed.mountMonitor()
  assert.equal(instanceTab(failed, 3081).props['data-dsh-hub-connection'], '连接未知')
  failed.cleanup()
  let finish, reads = 0
  const h = await harness({ fetch: async (url, options) => {
    if (url.endsWith('/connections') && options.method === 'GET' && ++reads === 1) return new Promise(resolve => { finish = resolve })
    return { ok: true, status: 200, json: async () => url.includes('/overview') ? overview : options.method === 'POST' ? { connection } : url.endsWith('/connections') ? { connections: [] } : { runs: [] } }
  } })
  await h.mountMonitor(); registerFrames(h); await openWorker(h)
  await button(h.modal(), '连接执行端 :3081').props.onClick()
  finish({ ok: true, json: async () => ({ connections: [] }) })
  await tick()
  assert.equal(instanceTab(h, 3081).props['data-dsh-hub-connection'], '已连接')
  h.cleanup()
})

test('workspace selection/save alone enables access, clearing all disables; settings requests stay local', async () => {
  const h = await harness({ base: 'http://localhost:3081/', embedded: true })
  h.message(h.parent, 'http://localhost:3080', OPEN)
  await tick()
  assert.equal(h.requests[0].resolved, 'http://localhost:3081/api/dsh-server-hub/remote/config')
  assert.equal(h.requests[0].options.credentials, 'same-origin')
  const inputs = nodes(h.modal()).filter(node => node.type === 'input')
  assert.equal(inputs.length, 1, 'no separate enable checkbox')
  inputs[0].props.onChange({ target: { checked: true } })
  assert.equal(h.requests.length, 1, 'checkbox must not autosave')
  await button(h.modal(), '保存工作区').props.onClick()
  let request = h.requests.at(-1)
  assert.equal(request.options.method, 'PUT')
  assert.equal(request.resolved, 'http://localhost:3081/api/dsh-server-hub/remote/config')
  assert.equal(request.options.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(request.options.body), { enabled: true, workspaceIds: ['sr'] })
  assert.equal(h.modal(), null)
  h.message(h.parent, 'http://localhost:3080', OPEN)
  await tick()
  nodes(h.modal()).find(node => node.type === 'input').props.onChange({ target: { checked: false } })
  await button(h.modal(), '保存工作区').props.onClick()
  request = h.requests.at(-1)
  assert.deepEqual(JSON.parse(request.options.body), { enabled: false, workspaceIds: [] })
  h.cleanup()
})

test('embedded settings accept only exact loopback parent/source; save is explicit and registers no Hub', async () => {
  const h = await harness({ base: 'http://localhost:3081/', embedded: true })
  assert.deepEqual([...h.slots.keys()], ['dsh-server-hub-remote-settings'])
  assert.equal(h.requests.length, 0); assert.equal(h.intervals.size, 0)
  for (const [source, origin, type, extra] of [
    [{}, 'http://localhost:3080', OPEN, {}], [h.parent, 'http://localhost:3999', OPEN, {}],
    [h.parent, 'http://127.0.0.1:3080', OPEN, {}], [h.parent, 'http://evil.test:3080', OPEN, {}],
    [h.parent, 'http://localhost:3080', 'dsh-hub-remote-settings/save', {}],
    [h.parent, 'http://localhost:3080', OPEN, { enabled: true }],
  ]) h.message(source, origin, type, extra)
  await tick(); assert.equal(h.requests.length, 0)
  h.message(h.parent, 'http://localhost:3080', OPEN)
  await tick()
  assert.equal(h.requests[0].resolved, 'http://localhost:3081/api/dsh-server-hub/remote/config')
  assert.equal(h.requests[0].options.credentials, 'same-origin')
  assert.match(text(h.modal()), /执行端 :3081 接受主控 :3080/)
  nodes(h.modal()).find(node => node.type === 'input').props.onChange({ target: { checked: true } })
  assert.equal(h.requests.length, 1)
  await button(h.modal(), '保存工作区').props.onClick()
  assert.deepEqual(JSON.parse(h.requests[1].options.body), { enabled: true, workspaceIds: ['sr'] })
  assert.equal(h.modal(), null)
  assert.deepEqual(h.parent.sent, [{ data: { type: SAVED }, origin: 'http://localhost:3080' }])
  h.cleanup(); assert.equal(h.listeners.size, 0); assert.equal(h.styleRemoved(), true)
})

test('embedded absent/untrusted referrer rejects requests', async () => {
  for (const referrer of ['', 'https://evil.test/', 'http://127.0.0.1:3080/']) {
    const h = await harness({ base: 'http://localhost:3081/', embedded: true, referrer })
    h.message(h.parent, 'http://localhost:3080', OPEN)
    await tick(); assert.equal(h.requests.length, 0); h.cleanup()
  }
})

test('iframe endpoints normalize page hostname without losing original overview status', async () => {
  for (const hostname of ['localhost', '127.0.0.1', '127.0.0.2', '[::1]']) {
    const h = await harness({ base: `http://${hostname}:3080/` })
    await h.mountMonitor()
    const { frames } = registerFrames(h)
    assert.deepEqual(frames.map(frame => frame.props.src), [`http://${hostname}:3080/`, `http://${hostname}:3081/`])
    assert.ok(frames.every(frame => frame.props['data-dsh-hub-endpoint'] === frame.props.src && frame.props.referrerPolicy === 'origin'))
    const tab = nodes(h.panel()).find(node => node.type === 'button' && node.props['data-dsh-hub-port'] === 3081)
    assert.match(tab.props.title, /2 个 Agent 工作中/)
    assert.equal(h.requests.length, 2, 'overview and one initial connection read only'); h.cleanup()
  }
})

test('selected target shows direction; explicit settings click bridges locally and trusted save returns to panel without connecting', async () => {
  const h = await harness()
  await h.mountMonitor()
  const { frames, children } = registerFrames(h)
  await openWorker(h)
  assert.match(text(h.modal()), /执行端 :3081 接受主控 :3080/)
  assert.ok(children.every(child => child.sent.length === 0))
  const reads = h.requests.length
  button(h.modal(), '选择可执行工作区').props.onClick()
  assert.equal(h.modal(), null, 'parent overlay must not cover child settings')
  assert.deepEqual(children[1].sent, [{ data: { type: OPEN }, origin: 'http://localhost:3081' }])
  assert.equal(h.requests.length, reads, 'no cross-port config fetch')
  const initial = text(h.panel())
  h.message({}, 'http://localhost:3081', SAVED)
  h.message(children[1], 'http://localhost:3999', SAVED)
  h.message(children[1], 'http://127.0.0.1:3081', SAVED)
  assert.equal(text(h.panel()), initial)
  h.message(children[1], 'http://localhost:3081', SAVED)
  await tick()
  assert.match(text(h.modal()), /执行端工作区已保存/)
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0)
  frames[1].props.ref(null)
  const after = text(h.panel())
  h.message(children[1], 'http://localhost:3081', CLOSED)
  assert.equal(text(h.panel()), after)
  h.cleanup(); assert.equal(h.listeners.size, 0); assert.equal(h.intervals.size, 0)
})

test('connect is explicit same-origin POST; shows connected rather than disabled and never reads browser cookies', async () => {
  const h = await harness()
  Object.defineProperty(h.win.document, 'cookie', { get() { throw new Error('cookie reads forbidden') } })
  await h.mountMonitor(); registerFrames(h); await openWorker(h)
  assert.equal(h.requests.filter(request => request.options.method === 'POST').length, 0)
  await button(h.modal(), '连接执行端 :3081').props.onClick()
  const request = h.requests.at(-1)
  assert.equal(request.url, 'api/dsh-server-hub/remote/connections')
  assert.equal(request.options.method, 'POST'); assert.equal(request.options.credentials, 'same-origin')
  assert.deepEqual(JSON.parse(request.options.body), { endpoint: 'http://localhost:3081/' })
  assert.match(text(h.modal()), /SR project/)
  assert.match(text(h.modal()), /已连接/)
  assert.doesNotMatch(text(h.modal()), /远控未启用|登录/)
  assert.equal(nodes(h.modal()).filter(node => node.type === 'input').length, 0)
  await button(h.modal(), '断开连接').props.onClick()
  assert.equal(h.requests.at(-1).url, 'api/dsh-server-hub/remote/connections/target-3081')
  assert.equal(h.requests.at(-1).options.method, 'DELETE')
  assert.match(text(h.modal()), /未连接/)
  h.cleanup()
})

test('listing is once per open/refresh with no remote polling and no model/session side effects', async () => {
  const h = await harness()
  await button(h.panel(), '执行端管理').props.onClick()
  assert.deepEqual(h.requests.map(request => request.url), ['api/dsh-server-hub/remote/connections', 'api/dsh-server-hub/remote/activity'])
  assert.match(text(h.modal()), /Check CPU · running/)
  assert.equal(h.intervals.size, 0)
  await tick(); assert.equal(h.requests.length, 2)
  await button(h.modal(), '刷新').props.onClick()
  assert.equal(h.requests.length, 4)
  assert.ok(h.requests.every(request => request.options.method === 'GET'))
  h.cleanup()
})

test('proxy page preserves Hub/local settings but does not generate/reuse remote connections', async () => {
  const h = await harness({ base: 'https://example.test/dsh/' })
  await h.mountMonitor()
  const { children } = registerFrames(h)
  await openWorker(h)
  assert.equal(h.requests.length, 1)
  assert.match(text(h.modal()), /loopback/)
  assert.equal(button(h.modal(), '连接执行端 :3081').props.disabled, true)
  assert.ok(children.every(child => child.sent.length === 0)); h.cleanup()
})

test('HTTP 400 displays specific safe connection causes, not a generic status or private error body', async () => {
  for (const [code, pattern] of [
    ['REMOTE_DISABLED', /执行端尚未开放工作区/], ['REMOTE_WORKSPACES_EMPTY', /至少勾选/],
    ['REMOTE_LOGIN_REQUIRED', /访问许可/], ['REMOTE_HOSTNAME', /主机名不一致/], ['REMOTE_STORAGE', /无法保存连接信息/],
  ]) {
    const h = await harness({ fetch: async (url, options) => options.method === 'POST'
      ? { ok: false, status: 400, json: async () => ({ code, error: 'private v1.secret.signature' }) }
      : { ok: true, status: 200, json: async () => url.includes('/overview') ? overview : url.endsWith('/connections') ? { connections: [] } : { runs: [] } } })
    await h.mountMonitor(); registerFrames(h); await openWorker(h)
    const count = h.requests.length
    await button(h.modal(), '连接执行端 :3081').props.onClick()
    assert.match(text(h.modal()), pattern)
    assert.doesNotMatch(text(h.modal()), /private|v1\.secret/)
    assert.equal(h.requests.length, count + 1, 'never automatically retry a failed POST')
    h.cleanup()
  }
})

test('upstream status and unknown/HTML errors never expose arbitrary server response text', async () => {
  for (const [failure, pattern] of [
    [{ code: 'REMOTE_HTTP', remoteStatus: 403, error: 'private v1.secret' }, /执行端接口返回 HTTP 403/],
    [{ code: 'UNKNOWN_ERROR', error: 'private v1.secret' }, /HTTP 400/],
    [null, /HTTP 400/],
  ]) {
    const h = await harness({ fetch: async (url, options) => options.method === 'POST'
      ? { ok: false, status: 400, json: async () => { if (!failure) throw new Error('HTML response'); return failure } }
      : { ok: true, status: 200, json: async () => url.includes('/overview') ? overview : url.endsWith('/connections') ? { connections: [] } : { runs: [] } } })
    await h.mountMonitor(); registerFrames(h); await openWorker(h)
    await button(h.modal(), '连接执行端 :3081').props.onClick()
    assert.match(text(h.modal()), pattern)
    assert.doesNotMatch(text(h.modal()), /private|v1\.secret|正在将执行端/)
    h.cleanup()
  }
})

test('401 and missing service 404 have distinct actionable messages', async () => {
  for (const [status, pattern] of [[401, /访问许可/], [404, /远控服务未加载（HTTP 404）.*pending\/failed.*重启/]]) {
    const h = await harness({ fetch: async () => ({ ok: false, status }) })
    await button(h.panel(), '执行端管理').props.onClick()
    assert.match(text(h.modal()), pattern)
    assert.equal(nodes(h.modal()).some(node => node.type === 'button' && text(node) === '保存工作区'), false)
    assert.ok(h.requests.every(request => request.options.method === 'GET')); h.cleanup()
  }
})

test('late embedded settings response cannot reopen a closed or disposed modal', async () => {
  let finish
  const h = await harness({ base: 'http://localhost:3081/', embedded: true, fetch: () => new Promise(resolve => { finish = resolve }) })
  h.message(h.parent, 'http://localhost:3080', OPEN)
  button(h.modal(), '关闭').props.onClick()
  assert.deepEqual(h.parent.sent.map(entry => entry.data.type), [CLOSED])
  finish({ ok: true, status: 200, json: async () => config })
  await tick(); assert.equal(h.modal(), null)
  h.cleanup(); assert.equal(h.listeners.size, 0)
})
