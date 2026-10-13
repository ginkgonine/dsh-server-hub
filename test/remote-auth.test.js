import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalEndpoint, cookieForEndpoint, RemoteConnections } from '../src/remote/auth.js'

const endpoint = 'http://127.0.0.1:3081'
const cookieName = value => `dsh-auth-${createHash('sha256').update(new URL(value).host).digest('base64url')}`
const nativeCookie = (value, label = 'test-only-cookie') => `${cookieName(value)}=v1.${Buffer.from(JSON.stringify({ authority: new URL(value).host, label })).toString('base64url')}.dGVzdC1vbmx5LXNpZ25hdHVyZQ`
const expectedCookie = nativeCookie(endpoint)
const req = () => ({ headers: { host: '127.0.0.1:3080', cookie: `${nativeCookie('http://127.0.0.1:3080', 'main')}; ${expectedCookie}; unrelated=do-not-forward` } })
const defaultCatalog = () => ({ version: 1, instanceId: 'worker-instance', enabled: true, workspaces: [{ id: 'maintenance', title: 'Maintenance', path: '/srv/maintenance' }] })
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })

function fixture({ port = 3080, fetchImpl } = {}) {
  const records = new Map()
  const calls = []
  const ctx = {
    webServer: { port },
    credentials: {
      async listRecords() { return [...records].map(([key, value]) => ({ key, kind: value.kind })) },
      async readRecord(key) { return structuredClone(records.get(key)) },
      async modifyRecord(key, mutate) {
        const next = await mutate(structuredClone(records.get(key)))
        if (next !== undefined) records.set(key, structuredClone(next))
        return structuredClone(records.get(key))
      },
      async deleteRecord(key) { records.delete(key) },
    },
  }
  const connections = new RemoteConnections(ctx, { fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return fetchImpl ? fetchImpl(url, options) : response(url.endsWith('/catalog') ? defaultCatalog() : { version: 1, instanceId: 'worker-instance', accepted: true })
  } })
  return { ctx, records, calls, connections }
}
function noPrivateFields(value) {
  const json = JSON.stringify(value)
  assert.doesNotMatch(json, /cookie|signature|do-not-forward|test-only|secret|token/i)
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code)

test('remote endpoint accepts canonical root loopback and refuses aliases or URL escape', () => {
  for (const [input, output] of [
    ['http://127.0.0.1:3081/', `${endpoint}/`], ['https://localhost:3081/', 'https://localhost:3081/'],
    ['http://[::1]:3081/', 'http://[::1]:3081/'], ['http://127.12.34.56:3081', 'http://127.12.34.56:3081/'],
  ]) assert.equal(canonicalEndpoint(input), output)
  for (const input of [
    'http://127.1:3081', 'http://2130706433:3081', 'http://0x7f000001:3081', 'http://127.000.0.1:3081',
    'http://192.168.1.2:3081', 'https://example.com', 'http://localhost.evil:3081',
    'http://user:password@localhost:3081', 'http://localhost:3081/proxy/', 'http://localhost:3081?token=x',
    'http://localhost:3081#x', 'http://localhost:3081?', 'file:///tmp/worker', ' http://localhost:3081',
    'http:\\localhost:3081', 'http://localhost:99999',
  ]) assert.throws(() => canonicalEndpoint(input), error => error.code === 'REMOTE_ENDPOINT', input)
})

test('explicit connection extracts only the target authority native cookie, without browser JS access', () => {
  assert.equal(cookieForEndpoint(req(), endpoint), expectedCookie)
  const headers = new Headers(req().headers)
  assert.equal(cookieForEndpoint({ headers }, endpoint), expectedCookie)
  const ipv6 = 'http://[::1]:3081'
  assert.equal(cookieForEndpoint({ headers: { host: '[::1]:3080', cookie: nativeCookie(ipv6) } }, ipv6), nativeCookie(ipv6))
  assert.throws(() => cookieForEndpoint(req(), 'http://localhost:3081'), error => error.code === 'REMOTE_HOSTNAME')
  assert.throws(() => cookieForEndpoint({ headers: { host: '127.0.0.1:3080', cookie: nativeCookie('http://127.0.0.1:3080') } }, endpoint), error => error.code === 'REMOTE_LOGIN_REQUIRED')
  assert.throws(() => cookieForEndpoint({ headers: { host: '127.0.0.1:3080', cookie: `${expectedCookie}; ${expectedCookie}` } }, endpoint), error => error.code === 'REMOTE_LOGIN_REQUIRED')
})

test('connect validates enabled catalog before privately persisting the exact target native login', async () => {
  const f = fixture()
  const connected = await f.connections.connect(req(), { endpoint: `${endpoint}/` })
  assert.match(connected.id, /^remote-[a-f0-9]{24}$/)
  assert.equal(connected.instanceId, 'worker-instance')
  assert.equal(connected.endpoint, `${endpoint}/`)
  assert.equal(connected.targetId, connected.id)
  noPrivateFields(connected)
  const listed = await f.connections.list()
  assert.deepEqual(listed, [connected])
  noPrivateFields(listed)
  const [key, record] = [...f.records][0]
  assert.match(key, /^dsh-server-hub\/remote-3080-[a-f0-9]{24}$/)
  assert.equal(record.kind, 'grant')
  assert.equal(`${record.payload.cookieName}=${record.payload.cookieValue}`, expectedCookie)
  assert.deepEqual(await f.connections.get(connected.id), { endpoint: `${endpoint}/`, cookie: expectedCookie, instanceId: 'worker-instance' })
  assert.equal(f.calls[0].url, `${endpoint}/api/dsh-server-hub/remote/catalog`)
  assert.equal(f.calls[0].options.redirect, 'error')
  assert.deepEqual(f.calls[0].options.headers, { cookie: expectedCookie, accept: 'application/json' })
  assert.ok(f.calls[0].options.signal instanceof AbortSignal)
})

test('private-store failure produces a safe actionable code instead of leaking the native cookie', async () => {
  const f = fixture()
  f.ctx.credentials.modifyRecord = async () => { throw new Error(`write denied for ${expectedCookie}`) }
  await assert.rejects(f.connections.connect(req(), { endpoint }), error => {
    assert.equal(error.code, 'REMOTE_STORAGE')
    assert.match(error.message, /无法保存连接信息/)
    assert.doesNotMatch(error.message, /v1\.|dsh-auth-/)
    return true
  })
  assert.equal(f.records.size, 0)
})

test('credentials remain own-port and own-scope; discovery/list never collects cookies or contacts targets', async () => {
  const f = fixture()
  assert.deepEqual(await f.connections.list(), [])
  assert.equal(f.calls.length, 0)
  const connected = await f.connections.connect(req(), { endpoint })
  const [key, record] = [...f.records][0]
  f.records.set(key.replace('remote-3080-', 'remote-3082-'), record)
  f.records.set(key.replace('dsh-server-hub/', 'other-plugin/'), record)
  const callCount = f.calls.length
  assert.deepEqual(await f.connections.list(), [connected])
  assert.equal(f.calls.length, callCount)
  await f.connections.forget(connected.id)
  assert.deepEqual(await f.connections.list(), [])
  assert.equal(f.records.size, 2)
  await rejectsCode(f.connections.get(connected.id), 'REMOTE_CONNECTION_MISSING')
})

test('missing login, disabled access and malformed catalogs never persist a connection', async t => {
  await t.test('missing target login', async () => {
    const f = fixture()
    await rejectsCode(f.connections.connect({ headers: { host: '127.0.0.1:3080' } }, { endpoint }), 'REMOTE_LOGIN_REQUIRED')
    assert.equal(f.calls.length, 0)
    assert.equal(f.records.size, 0)
  })
  for (const [label, value, code] of [
    ['disabled', { ...defaultCatalog(), enabled: false }, 'REMOTE_DISABLED'],
    ['empty selection', { ...defaultCatalog(), workspaces: [] }, 'REMOTE_WORKSPACES_EMPTY'],
    ['wrong version', { ...defaultCatalog(), version: 2 }, 'REMOTE_BAD_RESPONSE'],
    ['missing identity', { ...defaultCatalog(), instanceId: '' }, 'REMOTE_BAD_RESPONSE'],
    ['wrong workspaces', { ...defaultCatalog(), workspaces: 'invalid' }, 'REMOTE_BAD_RESPONSE'],
    ['missing path', { ...defaultCatalog(), workspaces: [{ id: 'x', title: 'X' }] }, 'REMOTE_BAD_RESPONSE'],
    ['duplicate workspace', { ...defaultCatalog(), workspaces: [defaultCatalog().workspaces[0], defaultCatalog().workspaces[0]] }, 'REMOTE_BAD_RESPONSE'],
  ]) await t.test(label, async () => {
    const f = fixture({ fetchImpl: async () => response(value) })
    await rejectsCode(f.connections.connect(req(), { endpoint }), code)
    assert.equal(f.records.size, 0)
  })
})

test('401 is a login-required error, never an implicit refresh or replay; response secrets are not echoed', async () => {
  let rejected = false
  const f = fixture({ fetchImpl: async () => rejected ? response({ secret: 'do-not-forward' }, 401) : response(defaultCatalog()) })
  const { id } = await f.connections.connect(req(), { endpoint })
  rejected = true
  const before = f.calls.length
  await assert.rejects(f.connections.request(id, '/agents'), error => {
    assert.equal(error.code, 'REMOTE_LOGIN_REQUIRED')
    assert.equal(error.remoteStatus, 401)
    assert.doesNotMatch(error.message, /do-not-forward|v1\./)
    return true
  })
  assert.equal(f.calls.length, before + 1)
  const other = fixture({ fetchImpl: async () => response({}, 401) })
  await rejectsCode(other.connections.connect(req(), { endpoint }), 'REMOTE_LOGIN_REQUIRED')
  assert.equal(other.records.size, 0)
})

test('HTTP failures expose only status and cancel their unread bodies before rejection', async t => {
  for (const status of [400, 401, 403, 408, 429, 503]) await t.test(String(status), async () => {
    let cancelled = 0
    let readAttempts = 0
    const body = new ReadableStream({
      start(controller) { controller.enqueue(Buffer.from(`private response: ${expectedCookie}`)) },
      cancel() { cancelled += 1 },
    })
    const rejected = new Response(body, { status })
    Object.defineProperty(rejected.body, 'getReader', { value: () => { readAttempts += 1; throw new Error('Failure bodies must not be read') } })
    const f = fixture({ fetchImpl: async () => rejected })
    await assert.rejects(f.connections.connect(req(), { endpoint }), error => {
      assert.equal(error.code, status === 401 ? 'REMOTE_LOGIN_REQUIRED' : 'REMOTE_HTTP')
      assert.equal(error.remoteStatus, status)
      assert.equal(cancelled, 1)
      assert.equal(error.message.includes(expectedCookie), false)
      assert.doesNotMatch(error.message, /private response|v1\.|dsh-auth-/)
      return true
    })
    assert.equal(readAttempts, 0)
    assert.equal(f.records.size, 0)
  })
})

test('a disconnected target does not replay requests or include its stored cookie in the error', async () => {
  let disconnected = false
  const f = fixture({ fetchImpl: async () => {
    if (disconnected) throw new Error(`socket closed while sending ${expectedCookie}`)
    return response(defaultCatalog())
  } })
  const { targetId } = await f.connections.connect(req(), { endpoint })
  disconnected = true
  const before = f.calls.length
  await assert.rejects(f.connections.request(targetId, '/runs'), error => {
    assert.equal(error.code, 'REMOTE_TRANSPORT')
    assert.equal(error.message.includes(expectedCookie), false)
    assert.doesNotMatch(error.message, /v1\.|signature|dsh-auth-/)
    return true
  })
  assert.equal(f.calls.length, before + 1)
})

test('request remains inside remote API and carries only saved target auth and caller input', async () => {
  const f = fixture()
  const { id } = await f.connections.connect(req(), { endpoint })
  const signal = new AbortController().signal
  const input = { workspaceId: 'maintenance', prompt: 'Inspect memory and CPU only' }
  const value = await f.connections.request(id, '/agents', { method: 'POST', input, signal })
  assert.equal(value.accepted, true)
  const { url, options } = f.calls.at(-1)
  assert.equal(url, `${endpoint}/api/dsh-server-hub/remote/agents`)
  assert.equal(options.method, 'POST')
  assert.equal(options.body, JSON.stringify(input))
  assert.deepEqual(options.headers, { cookie: expectedCookie, accept: 'application/json', 'content-type': 'application/json' })
  assert.equal(options.redirect, 'error')
  for (const path of ['https://evil.example', '//evil.example', '/../session/create', '/agents/../approve', '/%2e%2e/approve', '/agents?token=x', '/agents\\approve']) {
    await rejectsCode(f.connections.request(id, path), 'REMOTE_PATH')
  }
  await rejectsCode(f.connections.request(id, '/agents', { method: 'PUT' }), 'REMOTE_METHOD')
})

test('saved instance identity cannot silently change, including explicit reconnect before forget', async () => {
  let instanceId = 'worker-instance'
  const f = fixture({ fetchImpl: async () => response({ ...defaultCatalog(), instanceId }) })
  const { id } = await f.connections.connect(req(), { endpoint })
  instanceId = 'replacement-instance'
  await rejectsCode(f.connections.request(id, '/catalog'), 'REMOTE_INSTANCE_CHANGED')
  await rejectsCode(f.connections.connect(req(), { endpoint }), 'REMOTE_INSTANCE_CHANGED')
  assert.equal((await f.connections.get(id)).instanceId, 'worker-instance')
  await f.connections.forget(id)
  assert.equal((await f.connections.connect(req(), { endpoint })).instanceId, 'replacement-instance')
})

test('redirects and transport failures do not persist or reveal authentication', async t => {
  for (const [label, fetchImpl, code] of [
    ['redirect response', async () => new Response(null, { status: 302, headers: { location: 'http://evil.example/' } }), 'REMOTE_HTTP'],
    ['fetch rejected redirect', async () => { throw new Error(`redirect included ${expectedCookie}`) }, 'REMOTE_TRANSPORT'],
    ['already redirected response', async () => { const value = response(defaultCatalog()); Object.defineProperty(value, 'redirected', { value: true }); return value }, 'REMOTE_TRANSPORT'],
  ]) await t.test(label, async () => {
    const f = fixture({ fetchImpl })
    await assert.rejects(f.connections.connect(req(), { endpoint }), error => {
      assert.equal(error.code, code)
      assert.doesNotMatch(error.message, /v1\.|evil\.example/)
      return true
    })
    assert.equal(f.records.size, 0)
    assert.equal(f.calls.length, 1)
    assert.equal(f.calls[0].options.redirect, 'error')
  })
})
