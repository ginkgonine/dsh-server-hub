import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { canonicalEndpoint, cookieForEndpoint, RemoteConnections } from '../src/remote/auth.js'

const endpoint = 'http://127.0.0.1:3081'
const audience = (value, legacy = false) => {
  const url = new URL(value)
  return !legacy && url.protocol === 'https:' ? url.origin : url.host
}
const nameForAudience = value => `dsh-auth-${createHash('sha256').update(value).digest('base64url')}`
const cookieName = (value, legacy = false) => nameForAudience(audience(value, legacy))
const nativeCookie = (value, label = 'test-only-cookie', legacy = false) => `${cookieName(value, legacy)}=v1.${Buffer.from(JSON.stringify({ authority: audience(value, legacy), label })).toString('base64url')}.dGVzdC1vbmx5LXNpZ25hdHVyZQ`
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

test('cookie selection supports current HTTP/HTTPS and legacy HTTPS with canonical audiences', async t => {
  for (const [target, host, legacy] of [
    [endpoint, '127.0.0.1:3080', false],
    ['https://127.0.0.1:3081', '127.0.0.1:3080', false],
    ['https://127.0.0.1:3081', '127.0.0.1:3080', true],
    ['http://localhost:80', 'localhost:3080', false],
    ['https://localhost:443', 'localhost:3080', false],
    ['https://localhost:443', 'localhost:3080', true],
    ['https://[::1]:3081', '[::1]:3080', false],
    ['https://[::1]:3081', '[::1]:3080', true],
  ]) await t.test(`${target} ${legacy ? 'legacy' : 'current'}`, async () => {
    const cookie = nativeCookie(target, 'test-only-target', legacy)
    const request = { headers: new Headers({ host, cookie: `unrelated=ignore; ${cookie}` }) }
    assert.equal(cookieForEndpoint(request, target), cookie)
    const f = fixture()
    const connected = await f.connections.connect(request, { endpoint: target })
    const [record] = f.records.values()
    assert.equal(`${record.payload.cookieName}=${record.payload.cookieValue}`, cookie)
    assert.deepEqual(await f.connections.get(connected.id), { endpoint: canonicalEndpoint(target), cookie, instanceId: 'worker-instance' })
    assert.deepEqual(await f.connections.list(), [connected])
    noPrivateFields(connected)
    await f.connections.request(connected.id, '/agents')
    assert.equal(f.calls.length, 2)
    for (const call of f.calls) assert.equal(call.options.headers.cookie, cookie)
  })
})

test('HTTPS prefers only the new audience when both browser cookie names exist, regardless of order', async t => {
  const target = 'https://127.0.0.1:3081'
  const current = nativeCookie(target, 'test-only-current')
  const legacy = nativeCookie(target, 'test-only-legacy', true)
  for (const cookies of [[legacy, current], [current, legacy]]) await t.test(cookies[0] === current ? 'current first' : 'legacy first', async () => {
    const request = { headers: { host: req().headers.host, cookie: cookies.join('; ') } }
    assert.equal(cookieForEndpoint(request, target), current)
    const f = fixture()
    const connected = await f.connections.connect(request, { endpoint: target })
    assert.equal((await f.connections.get(connected.id)).cookie, current)
    assert.equal(f.calls[0].options.headers.cookie, current)
  })
  // An invalid or duplicated *unselected* legacy cookie cannot override the current login.
  assert.equal(cookieForEndpoint({ headers: { host: req().headers.host, cookie: `${legacy}; ${legacy}; ${current}` } }, target), current)
  assert.equal(cookieForEndpoint({ headers: { host: req().headers.host, cookie: `${cookieName(target, true)}=v2.operator.signature; ${current}` } }, target), current)
})

test('ambiguous, malformed and non-browser cookies fail closed without a legacy downgrade or network access', async t => {
  const target = 'https://127.0.0.1:3081'
  const current = nativeCookie(target)
  const legacy = nativeCookie(target, 'test-only-legacy', true)
  for (const [label, cookie] of [
    ['duplicate current', `${current}; ${current}; ${legacy}`],
    ['conflicting current', `${current}; ${nativeCookie(target, 'test-only-other')}; ${legacy}`],
    ['empty current', `${cookieName(target)}=; ${legacy}`],
    ['malformed current', `${cookieName(target)}=invalid; ${legacy}`],
    ['operator current cannot downgrade', `${cookieName(target)}=v2.operator.signature; ${legacy}`],
    ['duplicate legacy', `${legacy}; ${legacy}`],
    ['operator legacy', `${cookieName(target, true)}=v2.operator.signature`],
    ['bearer is not a browser login', ''],
    ['cookie prefix is not exact', `${cookieName(target)}-suffix=v1.payload.signature`],
    ['cookie value delimiter', `${cookieName(target)}=v1.payload.signature=extra`],
    ['cookie value injection', `${cookieName(target)}=v1.payload.signature\r\nInjected: value`],
  ]) await t.test(label, async () => {
    const f = fixture()
    const request = { headers: { host: req().headers.host, cookie, authorization: 'Bearer v2.operator.signature' } }
    await rejectsCode(f.connections.connect(request, { endpoint: target }), 'REMOTE_LOGIN_REQUIRED')
    assert.equal(f.calls.length, 0)
    assert.equal(f.records.size, 0)
  })
})

test('cookie candidates never include another target port, hostname or HTTP origin audience', async t => {
  for (const [target, cookie] of [
    [endpoint, nativeCookie('http://127.0.0.1:3082')],
    [endpoint, `${nameForAudience(new URL(endpoint).origin)}=v1.payload.signature`],
    [endpoint, nativeCookie('https://127.0.0.1:3081')],
    ['https://127.0.0.1:3081', nativeCookie('https://127.0.0.1:3082')],
    ['https://127.0.0.1:3081', nativeCookie('https://127.0.0.1:3082', 'test-only-other-port', true)],
    ['https://127.0.0.1:3081', nativeCookie('https://localhost:3081')],
    ['https://127.0.0.1:3081', nativeCookie('https://localhost:3081', 'test-only-other-host', true)],
  ]) await t.test(`${target} rejects ${cookie.split('=')[0]}`, async () => {
    const f = fixture()
    await rejectsCode(f.connections.connect({ headers: { host: req().headers.host, cookie } }, { endpoint: target }), 'REMOTE_LOGIN_REQUIRED')
    assert.equal(f.calls.length, 0)
    assert.equal(f.records.size, 0)
  })
  assert.throws(() => cookieForEndpoint({ headers: { host: 'localhost:3080', cookie: nativeCookie('https://127.0.0.1:3081') } }, 'https://127.0.0.1:3081'), error => error.code === 'REMOTE_HOSTNAME')
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

test('previously saved host-only HTTPS grants survive recreation and migrate only on explicit reconnect', async () => {
  const target = 'https://127.0.0.1:3081/'
  const legacy = nativeCookie(target, 'test-only-saved', true)
  const current = nativeCookie(target, 'test-only-current')
  const suffix = createHash('sha256').update(target).digest('hex').slice(0, 24)
  const id = `remote-${suffix}`
  const key = `dsh-server-hub/remote-3080-${suffix}`
  const f = fixture()
  const { instanceId, workspaces } = defaultCatalog()
  const saved = { kind: 'grant', payload: { version: 1, endpoint: target, instanceId, workspaces,
    cookieName: cookieName(target, true), cookieValue: legacy.slice(legacy.indexOf('=') + 1), name: 'Saved worker' } }
  f.records.set(key, structuredClone(saved))
  // These private records must never be consulted to find or refresh this target's login.
  f.records.set(key.replace('remote-3080-', 'remote-3082-'), structuredClone(saved))
  f.records.set('other-plugin/private', { kind: 'grant', payload: { secret: 'do-not-forward' } })
  const reads = []
  const readRecord = f.ctx.credentials.readRecord
  f.ctx.credentials.readRecord = async key => { reads.push(key); return readRecord(key) }
  const [connected] = await f.connections.list()
  assert.equal(connected.id, id)
  assert.equal(connected.name, 'Saved worker')
  assert.deepEqual(reads, [key])
  assert.deepEqual(await f.connections.get(id), { endpoint: target, cookie: legacy, instanceId })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(f.records.get(key), saved)
  const recreated = new RemoteConnections(f.ctx, { fetchImpl: f.connections.fetchImpl })
  await recreated.request(id, '/agents')
  assert.equal(f.calls.at(-1).options.headers.cookie, legacy)
  assert.deepEqual(f.records.get(key), saved)
  const request = { headers: { host: req().headers.host, cookie: `${legacy}; ${current}` } }
  assert.deepEqual(await recreated.connect(request, { endpoint: target }), connected)
  assert.equal((await recreated.get(id)).cookie, current)
  assert.equal(f.records.get(key).payload.cookieName, cookieName(target))
  assert.equal(f.records.get(key).payload.name, 'Saved worker')
  assert.deepEqual(f.records.get(key.replace('remote-3080-', 'remote-3082-')), saved)
  assert.ok(reads.every(read => read === key))
  assert.deepEqual(await new RemoteConnections(f.ctx).list(), [connected])
  await recreated.request(id, '/agents')
  assert.equal(f.calls.at(-1).options.headers.cookie, current)
  // Explicitly connecting an older runtime still stores the actual legacy pair.
  assert.deepEqual(await recreated.connect({ headers: { host: req().headers.host, cookie: legacy } }, { endpoint: target }), connected)
  assert.equal((await recreated.get(id)).cookie, legacy)
})

test('HTTPS reconnect never retries a rejected preferred cookie or modifies an existing grant on failure', async t => {
  const target = 'https://127.0.0.1:3081'
  const legacy = nativeCookie(target, 'test-only-saved', true)
  const current = nativeCookie(target, 'test-only-new')
  for (const [label, failure, code] of [
    ['unauthorized', () => response({}, 401), 'REMOTE_LOGIN_REQUIRED'],
    ['transport', () => { throw new Error('test-only connection failure') }, 'REMOTE_TRANSPORT'],
    ['identity changed', () => response({ ...defaultCatalog(), instanceId: 'other-instance' }), 'REMOTE_INSTANCE_CHANGED'],
  ]) await t.test(label, async () => {
    let fail = false
    const f = fixture({ fetchImpl: async () => fail ? failure() : response(defaultCatalog()) })
    const connected = await f.connections.connect({ headers: { host: req().headers.host, cookie: legacy } }, { endpoint: target })
    const before = structuredClone([...f.records])
    fail = true
    await rejectsCode(f.connections.connect({ headers: { host: req().headers.host, cookie: `${legacy}; ${current}` } }, { endpoint: target }), code)
    assert.equal(f.calls.length, 2)
    assert.equal(f.calls.at(-1).options.headers.cookie, current)
    assert.deepEqual([...f.records], before)
    assert.equal((await f.connections.get(connected.id)).cookie, legacy)
  })
})

test('stored grants accept only their own protocol-specific names and v1 browser values', async t => {
  const secure = 'https://127.0.0.1:3081'
  for (const [label, target, changes] of [
    ['HTTPS other port current name', secure, { cookieName: cookieName('https://127.0.0.1:3082') }],
    ['HTTPS other port legacy name', secure, { cookieName: cookieName('https://127.0.0.1:3082', true) }],
    ['HTTPS other hostname', secure, { cookieName: cookieName('https://localhost:3081') }],
    ['HTTP cannot use HTTPS name', endpoint, { cookieName: cookieName(secure) }],
    ['HTTP cannot use origin hash', endpoint, { cookieName: nameForAudience(new URL(endpoint).origin) }],
    ['unrelated cookie', secure, { cookieName: 'operator-auth' }],
    ['operator value', secure, { cookieValue: 'v2.operator.signature' }],
    ['malformed browser value', secure, { cookieValue: 'v1.payload.signature=extra' }],
    ['renamed endpoint', secure, { endpoint: 'https://127.0.0.1:3082/' }],
  ]) await t.test(label, async () => {
    const f = fixture()
    const connected = await f.connections.connect({ headers: { host: req().headers.host, cookie: nativeCookie(target) } }, { endpoint: target })
    const [key, record] = [...f.records][0]
    Object.assign(record.payload, changes)
    f.records.set(key, record)
    await rejectsCode(f.connections.get(connected.id), 'REMOTE_CONNECTION_INVALID')
    await rejectsCode(f.connections.list(), 'REMOTE_CONNECTION_INVALID')
    await rejectsCode(f.connections.request(connected.id, '/agents'), 'REMOTE_CONNECTION_INVALID')
    assert.equal(f.calls.length, 1)
    assert.deepEqual(f.records.get(key), record)
  })
})

test('legacy records omit name until explicitly renamed, including after reconnect', async () => {
  const f = fixture()
  const connected = await f.connections.connect(req(), { endpoint })
  assert.equal(Object.hasOwn(connected, 'name'), false)
  const [key, record] = [...f.records][0]
  assert.equal(Object.hasOwn(record.payload, 'name'), false)
  assert.deepEqual(await f.connections.list(), [connected])
  assert.deepEqual(await f.connections.connect(req(), { endpoint }), connected)
  assert.deepEqual(await f.connections.get(connected.targetId), { endpoint: `${endpoint}/`, cookie: expectedCookie, instanceId: connected.instanceId })
  const renamed = await f.connections.rename(connected.targetId, '  Legacy worker  ')
  assert.deepEqual(renamed, { ...connected, name: 'Legacy worker' })
  assert.equal(f.records.get(key).payload.name, 'Legacy worker')
})

test('connect trims and persists optional names without changing identity; duplicate names are allowed', async () => {
  const f = fixture()
  const connected = await f.connections.connect(req(), { endpoint, name: '  工作节点 A  ' })
  assert.equal(connected.name, '工作节点 A')
  assert.equal([...f.records.values()][0].payload.name, connected.name)
  assert.deepEqual(await f.connections.list(), [connected])
  noPrivateFields(connected)
  const secondEndpoint = 'http://127.0.0.1:3082'
  const second = await f.connections.connect({ headers: { host: req().headers.host, cookie: nativeCookie(secondEndpoint) } }, { endpoint: secondEndpoint, name: connected.name })
  assert.equal(second.name, connected.name)
  assert.notEqual(second.targetId, connected.targetId)
  assert.notEqual(second.endpoint, connected.endpoint)
  const unnamed = fixture()
  const original = await unnamed.connections.connect(req(), { endpoint })
  assert.deepEqual(connected, { ...original, name: '工作节点 A' })
  assert.equal((await f.connections.connect(req(), { endpoint, name: '  ' })).name, '')
  assert.equal([...f.records.values()][0].payload.name, '')
  assert.equal((await f.connections.connect(req(), { endpoint, name: 'x'.repeat(40) })).name.length, 40)
})

test('rename and clear persist across manager recreation using only modifyRecord, without changing private payload or identity', async () => {
  const f = fixture()
  const original = await f.connections.connect(req(), { endpoint, name: 'Original' })
  const [key, record] = [...f.records][0]
  record.payload.extra = { token: 'private-sentinel', future: true }
  record.metadata = { future: 'preserve' }
  f.records.set(key, record)
  const readRecord = f.ctx.credentials.readRecord
  let modifications = 0
  const modifyRecord = f.ctx.credentials.modifyRecord
  f.ctx.credentials.modifyRecord = async (...args) => { modifications += 1; return modifyRecord(...args) }
  f.ctx.credentials.readRecord = async () => { throw new Error('rename must not read credentials separately') }
  f.ctx.credentials.listRecords = async () => { throw new Error('rename must not list credentials') }
  f.connections.get = async () => { throw new Error('rename must not retrieve target cookies') }
  f.connections.fetchImpl = async () => { throw new Error('rename must not contact target') }
  const callsBefore = f.calls.length
  const renamed = await f.connections.rename(original.targetId, '  New worker  ')
  assert.deepEqual(renamed, { ...original, name: 'New worker' })
  assert.deepEqual(f.records.get(key), { ...record, payload: { ...record.payload, name: 'New worker' } })
  noPrivateFields(renamed)
  const cleared = await f.connections.rename(original.targetId, '')
  assert.deepEqual(cleared, { ...original, name: '' })
  assert.equal(Object.hasOwn(cleared, 'name'), true)
  assert.deepEqual(f.records.get(key), { ...record, payload: { ...record.payload, name: '' } })
  noPrivateFields(cleared)
  assert.equal(modifications, 2)
  assert.equal(f.calls.length, callsBefore)
  f.ctx.credentials.readRecord = readRecord
  f.ctx.credentials.listRecords = async () => [...f.records].map(([key, value]) => ({ key, kind: value.kind }))
  const recreated = new RemoteConnections(f.ctx, { fetchImpl: async () => { throw new Error('listing must not contact target') } })
  assert.deepEqual(await recreated.list(), [cleared])
  assert.deepEqual(await recreated.get(original.targetId), { endpoint: original.endpoint, cookie: expectedCookie, instanceId: original.instanceId })
})

test('onlyIfUnset migrates missing names locally but never overwrites named or explicitly cleared records', async t => {
  for (const [label, input] of [
    ['missing', { endpoint }], ['existing', { endpoint, name: 'Current worker' }], ['cleared', { endpoint, name: '' }],
  ]) await t.test(label, async () => {
    const f = fixture()
    const original = await f.connections.connect(req(), input)
    const [key, record] = [...f.records][0]
    let writes = 0
    f.ctx.credentials.modifyRecord = async (key, mutate) => {
      const next = await mutate(structuredClone(f.records.get(key)))
      if (next !== undefined) { writes += 1; f.records.set(key, structuredClone(next)) }
      return structuredClone(f.records.get(key))
    }
    f.ctx.credentials.readRecord = async () => { throw new Error('migration must only use modifyRecord') }
    f.ctx.credentials.listRecords = async () => { throw new Error('migration must not list credentials') }
    f.connections.get = async () => { throw new Error('migration must not retrieve target cookies') }
    f.connections.fetchImpl = async () => { throw new Error('migration must not contact target') }
    const migrated = await f.connections.rename(original.targetId, '  Legacy cache  ', { onlyIfUnset: true })
    const hasName = Object.hasOwn(record.payload, 'name')
    assert.deepEqual(migrated, hasName ? original : { ...original, name: 'Legacy cache' })
    assert.deepEqual(f.records.get(key), hasName ? record : { ...record, payload: { ...record.payload, name: 'Legacy cache' } })
    assert.equal(writes, hasName ? 0 : 1)
    noPrivateFields(migrated)
    const repeated = await f.connections.rename(original.targetId, 'Stale browser cache', { onlyIfUnset: true })
    assert.deepEqual(repeated, migrated)
    assert.equal(writes, hasName ? 0 : 1)
    const explicit = await f.connections.rename(original.targetId, 'Manual rename', { onlyIfUnset: false })
    assert.deepEqual(explicit, { ...original, name: 'Manual rename' })
    assert.equal(f.records.get(key).payload.name, 'Manual rename')
    assert.equal(writes, hasName ? 1 : 2)
    assert.equal(f.calls.length, 1)
  })
})

test('onlyIfUnset checks the latest payload inside modifyRecord rather than an earlier browser snapshot', async t => {
  for (const latestName of ['New browser name', '']) await t.test(latestName || 'cleared by another browser', async () => {
    const f = fixture()
    const original = await f.connections.connect(req(), { endpoint })
    const [key, record] = [...f.records][0]
    f.ctx.credentials.readRecord = async () => { throw new Error('migration must not read a stale snapshot') }
    f.connections.fetchImpl = async () => { throw new Error('migration must not contact target') }
    f.ctx.credentials.modifyRecord = async (key, mutate) => {
      const latest = { ...record, payload: { ...record.payload, name: latestName } }
      f.records.set(key, latest)
      assert.equal(await mutate(structuredClone(latest)), undefined)
      return structuredClone(latest)
    }
    const result = await f.connections.rename(original.targetId, 'Old browser cache', { onlyIfUnset: true })
    assert.deepEqual(result, { ...original, name: latestName })
    assert.deepEqual(f.records.get(key), { ...record, payload: { ...record.payload, name: latestName } })
    noPrivateFields(result)
    assert.equal(f.calls.length, 1)
  })
})

test('reconnect keeps saved names when omitted and replaces or clears them only when explicit', async () => {
  const f = fixture()
  const connected = await f.connections.connect(req(), { endpoint, name: 'First' })
  await f.connections.rename(connected.targetId, 'Renamed')
  assert.deepEqual(await f.connections.connect(req(), { endpoint }), { ...connected, name: 'Renamed' })
  const changed = await f.connections.connect(req(), { endpoint, name: '  Replacement  ' })
  assert.deepEqual(changed, { ...connected, name: 'Replacement' })
  const cleared = await f.connections.connect(req(), { endpoint, name: '' })
  assert.deepEqual(cleared, { ...connected, name: '' })
  assert.deepEqual(await f.connections.connect(req(), { endpoint }), cleared)
  assert.equal([...f.records.values()][0].payload.name, '')
})

test('connect and rename reject invalid name types, trimmed length and control characters before network or writes', async t => {
  for (const [label, name] of [
    ['undefined', undefined], ['null', null], ['number', 12], ['boolean', false], ['object', {}], ['array', []],
    ['too long', 'x'.repeat(41)], ['too long after trimming', ` ${'x'.repeat(41)} `],
    ['nul', 'a\u0000b'], ['newline before trim', '\nworker'], ['tab after trim', 'worker\t'],
    ['carriage return', 'a\rb'], ['DEL', 'a\u007fb'], ['C1 control', 'a\u0085b'],
  ]) await t.test(label, async () => {
    const f = fixture()
    const connected = await f.connections.connect(req(), { endpoint, name: 'Unchanged' })
    const before = structuredClone([...f.records])
    const callsBefore = f.calls.length
    f.ctx.credentials.modifyRecord = async () => { throw new Error('Invalid name must fail before touching storage') }
    await rejectsCode(f.connections.connect(req(), { endpoint, name }), 'REMOTE_NAME')
    await rejectsCode(f.connections.rename(connected.targetId, name), 'REMOTE_NAME')
    assert.deepEqual([...f.records], before)
    assert.equal(f.calls.length, callsBefore)
  })
})

test('stored validates optional names while accepting absent and explicitly empty names', async t => {
  for (const name of [undefined, null, 1, {}, 'x'.repeat(41), 'a\u0000b', 'a\u009fb', ' not trimmed ']) await t.test(String(name), async () => {
    const f = fixture()
    const connected = await f.connections.connect(req(), { endpoint })
    const [key, record] = [...f.records][0]
    record.payload.name = name
    f.records.set(key, record)
    await rejectsCode(f.connections.list(), 'REMOTE_CONNECTION_INVALID')
    await rejectsCode(f.connections.rename(connected.targetId, 'Valid'), 'REMOTE_CONNECTION_INVALID')
    assert.deepEqual(f.records.get(key), record)
  })
  const f = fixture()
  const connected = await f.connections.connect(req(), { endpoint, name: '' })
  assert.deepEqual(await f.connections.list(), [connected])
  assert.equal(Object.hasOwn(connected, 'name'), true)
})

test('rename refuses missing connections without creating records or contacting targets', async () => {
  const f = fixture()
  const missing = `remote-${'0'.repeat(24)}`
  await rejectsCode(f.connections.rename(missing, 'Worker'), 'REMOTE_CONNECTION_MISSING')
  await rejectsCode(f.connections.rename('alias', 'Worker'), 'REMOTE_CONNECTION_MISSING')
  assert.equal(f.records.size, 0)
  assert.equal(f.calls.length, 0)
})

test('rename storage errors are safe even after mutation validation and do not leak private error properties', async t => {
  for (const afterMutation of [false, true]) await t.test(afterMutation ? 'after mutation callback' : 'before mutation callback', async () => {
    const f = fixture()
    const connected = await f.connections.connect(req(), { endpoint, name: 'Unchanged' })
    const before = structuredClone([...f.records])
    f.ctx.credentials.modifyRecord = async (key, mutate) => {
      if (afterMutation) await mutate(structuredClone(f.records.get(key)))
      throw Object.assign(new Error(`write failed: ${expectedCookie}`), { code: 'REMOTE_UNTRUSTED_STORAGE', cookie: expectedCookie })
    }
    await assert.rejects(f.connections.rename(connected.targetId, 'Changed'), error => {
      assert.equal(error.code, 'REMOTE_STORAGE')
      assert.match(error.message, /无法保存连接信息/)
      assert.doesNotMatch(error.message, /v1\.|dsh-auth-/)
      assert.deepEqual(Object.keys(error), ['code'])
      return true
    })
    assert.deepEqual([...f.records], before)
    assert.equal(f.calls.length, 1)
  })
})

test('private-store failure produces a safe actionable code instead of leaking the native cookie', async t => {
  for (const [label, storageError] of [
    ['ordinary error', new Error(`write denied for ${expectedCookie}`)],
    ['untrusted remote code', Object.assign(new Error(`write denied for ${expectedCookie}`), { code: 'REMOTE_STORAGE' })],
    ['null error', null], ['undefined error', undefined],
  ]) await t.test(label, async () => {
    const f = fixture()
    f.ctx.credentials.modifyRecord = async () => { throw storageError }
    for (const action of [
      () => f.connections.connect(req(), { endpoint }),
      () => f.connections.rename(`remote-${'0'.repeat(24)}`, 'Worker'),
    ]) await assert.rejects(action(), error => {
      assert.equal(error.code, 'REMOTE_STORAGE')
      assert.match(error.message, /无法保存连接信息/)
      assert.doesNotMatch(error.message, /v1\.|dsh-auth-/)
      return true
    })
    assert.equal(f.records.size, 0)
  })
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
