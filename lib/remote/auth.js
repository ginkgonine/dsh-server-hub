import { createHash } from 'node:crypto'

const SCOPE = 'dsh-server-hub/'
const ROUTE = '/api/dsh-server-hub/remote'
const MAX_RESPONSE_BYTES = 512 * 1024
const ID = /^remote-[a-f0-9]{24}$/
const COOKIE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

function fail(code, message, properties) {
  const error = new Error(message)
  error.code = code
  if (properties) Object.assign(error, properties)
  throw error
}
function text(value, max = 4096) { return typeof value === 'string' && value.length > 0 && value.length <= max }
function hash(value) { return createHash('sha256').update(value).digest('hex').slice(0, 24) }
function idFor(endpoint) { return `remote-${hash(endpoint)}` }
function header(req, name) {
  const headers = req?.headers
  if (typeof headers?.get === 'function') return headers.get(name)
  const value = headers?.[name]
  return typeof value === 'string' ? value : undefined
}
function cookieName(endpoint) {
  return `dsh-auth-${createHash('sha256').update(new URL(endpoint).host).digest('base64url')}`
}
function validCookie(value) { return text(value) && COOKIE.test(value) }
function connectionName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) || value.trim().length > 40) {
    fail('REMOTE_NAME', 'Connection name must be a string of at most 40 characters without control characters')
  }
  return value.trim()
}

/** V1 connects only root-mounted literal loopback endpoints, including SSH forwards. */
export function canonicalEndpoint(input) {
  if (!text(input, 2048) || input !== input.trim() || /[\s\\\u0000-\u001f\u007f]/.test(input)) fail('REMOTE_ENDPOINT', 'Select a root-mounted loopback DSH instance')
  let url
  try { url = new URL(input) } catch { fail('REMOTE_ENDPOINT', 'Select a valid loopback DSH URL') }
  const authority = input.match(/^https?:\/\/([^/?#]+)/i)?.[1]
  const rawHost = authority?.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority?.split(':')[0]
  const hostname = url.hostname.toLowerCase()
  const ipv4 = /^127(?:\.\d{1,3}){3}$/.test(hostname) && hostname.split('.').every(part => Number(part) <= 255)
  if (!['http:', 'https:'].includes(url.protocol) || !authority || rawHost?.toLowerCase() !== hostname ||
      !(hostname === 'localhost' || hostname === '[::1]' || ipv4) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash || /[?#]/.test(input)) {
    fail('REMOTE_ENDPOINT', 'Only canonical root-mounted loopback DSH URLs are supported')
  }
  return `${url.origin}/`
}

/** Call only from an authenticated, explicit user connection action; never discovery. */
export function cookieForEndpoint(req, input) {
  const endpoint = canonicalEndpoint(input)
  let source
  try { source = new URL(`http://${header(req, 'host') || ''}`) } catch { fail('REMOTE_HOSTNAME', 'A valid authenticated main-instance request is required') }
  if (source.username || source.password || source.pathname !== '/' || source.search || source.hash || source.hostname !== new URL(endpoint).hostname) {
    fail('REMOTE_HOSTNAME', 'Open both DSH instances using the same hostname before connecting')
  }
  const name = cookieName(endpoint)
  const matches = String(header(req, 'cookie') || '').split(';').map(segment => segment.trim()).filter(segment => segment.startsWith(`${name}=`))
  const value = matches.length === 1 ? matches[0].slice(name.length + 1) : undefined
  if (!validCookie(value)) fail('REMOTE_LOGIN_REQUIRED', 'Open and log in to the target DSH instance, then explicitly connect again')
  return `${name}=${value}`
}

function catalog(value) {
  if (!value || value.version !== 1 || !text(value.instanceId, 200) || typeof value.enabled !== 'boolean' ||
      !Array.isArray(value.workspaces) || value.workspaces.length > 256) fail('REMOTE_BAD_RESPONSE', 'Target returned an invalid remote catalog')
  const ids = new Set()
  const workspaces = value.workspaces.map(workspace => {
    if (!workspace || !text(workspace.id, 200) || !text(workspace.title, 500) || !text(workspace.path) || ids.has(workspace.id)) {
      fail('REMOTE_BAD_RESPONSE', 'Target returned an invalid workspace catalog')
    }
    ids.add(workspace.id)
    return { id: workspace.id, title: workspace.title, path: workspace.path }
  })
  return { instanceId: value.instanceId, enabled: value.enabled, workspaces }
}

async function jsonResponse(response) {
  if (response.redirected) {
    await response.body?.cancel().catch(() => {})
    fail('REMOTE_TRANSPORT', 'Remote redirects are not accepted; no authentication was refreshed')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if (response.status === 401) fail('REMOTE_LOGIN_REQUIRED', 'Target DSH login expired or is missing; log in and explicitly connect again', { remoteStatus: response.status })
    fail('REMOTE_HTTP', `Target DSH request failed (HTTP ${response.status})`, { remoteStatus: response.status })
  }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) fail('REMOTE_BAD_RESPONSE', 'Target did not return a remote JSON response')
  let bytes = 0
  const chunks = []
  const reader = response.body?.getReader()
  if (!reader) fail('REMOTE_BAD_RESPONSE', 'Target returned an empty remote response')
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) fail('REMOTE_BAD_RESPONSE', 'Target remote response exceeds the limit')
      chunks.push(Buffer.from(chunk.value))
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { fail('REMOTE_BAD_RESPONSE', 'Target returned invalid remote JSON') }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Explicit user-authorized reuse of native DSH login, stored only as a private grant. */
export class RemoteConnections {
  constructor(ctx, { fetchImpl = fetch, port = ctx.webServer?.port } = {}) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) fail('REMOTE_CONFIG', 'A listening main-instance port is required')
    this.ctx = ctx
    this.fetchImpl = fetchImpl
    this.prefix = `${SCOPE}remote-${port}-`
  }

  key(id) {
    if (!ID.test(String(id))) fail('REMOTE_CONNECTION_MISSING', 'Select a known remote connection')
    return `${this.prefix}${id.slice('remote-'.length)}`
  }

  stored(record, id) {
    const value = record?.kind === 'grant' && record.payload
    let endpoint
    try { endpoint = canonicalEndpoint(value?.endpoint) } catch { fail('REMOTE_CONNECTION_INVALID', 'Saved remote connection is invalid; disconnect and explicitly reconnect') }
    if (value.version !== 1 || endpoint !== value.endpoint || idFor(endpoint) !== id || !text(value.instanceId, 200) ||
        value.cookieName !== cookieName(endpoint) || !validCookie(value.cookieValue)) {
      fail('REMOTE_CONNECTION_INVALID', 'Saved remote connection is invalid; disconnect and explicitly reconnect')
    }
    if (Object.hasOwn(value, 'name')) {
      try {
        if (connectionName(value.name) !== value.name) throw new Error('Noncanonical name')
      } catch { fail('REMOTE_CONNECTION_INVALID', 'Saved remote connection is invalid; disconnect and explicitly reconnect') }
    }
    const info = catalog({ version: 1, instanceId: value.instanceId, enabled: true, workspaces: value.workspaces })
    return { ...value, ...info }
  }

  public(value) {
    return { targetId: idFor(value.endpoint), id: idFor(value.endpoint), endpoint: value.endpoint, instanceId: value.instanceId,
      ...(Object.hasOwn(value, 'name') ? { name: value.name } : {}),
      status: 'connected', workspaces: value.workspaces.map(({ id, title, path }) => ({ id, title, path })) }
  }

  async list() {
    const entries = await this.ctx.credentials.listRecords()
    const result = []
    for (const entry of entries) {
      if (entry.kind !== 'grant' || typeof entry.key !== 'string' || !entry.key.startsWith(this.prefix)) continue
      const id = `remote-${entry.key.slice(this.prefix.length)}`
      if (!ID.test(id)) continue
      const record = await this.ctx.credentials.readRecord(this.key(id))
      if (!record) continue
      result.push(this.public(this.stored(record, id)))
    }
    return result
  }

  async connect(req, input) {
    const endpoint = canonicalEndpoint(input?.endpoint)
    const hasName = Object.hasOwn(input, 'name')
    const requestedName = hasName ? connectionName(input.name) : undefined
    const cookie = cookieForEndpoint(req, endpoint)
    const remote = catalog(await this.fetchJson(endpoint, '/catalog', cookie))
    if (!remote.enabled) fail('REMOTE_DISABLED', '远程尚未开放工作区；请选择可执行工作区并保存，再接入主控。')
    if (!remote.workspaces.length) fail('REMOTE_WORKSPACES_EMPTY', '远程没有开放任何工作区；请至少勾选一个工作区并保存。')
    const id = idFor(endpoint)
    const name = cookieName(endpoint)
    const payload = { version: 1, endpoint, cookieName: name, cookieValue: cookie.slice(name.length + 1),
      instanceId: remote.instanceId, workspaces: remote.workspaces }
    let businessError
    try {
      await this.ctx.credentials.modifyRecord(this.key(id), async previous => {
        try {
          const saved = previous ? this.stored(previous, id) : undefined
          if (saved && saved.instanceId !== remote.instanceId) fail('REMOTE_INSTANCE_CHANGED', 'The target instance changed; disconnect and confirm the new instance before reconnecting')
          if (hasName) payload.name = requestedName
          else if (saved && Object.hasOwn(saved, 'name')) payload.name = saved.name
          return { kind: 'grant', payload }
        } catch (error) {
          businessError = error
          throw error
        }
      })
    } catch (error) {
      if (businessError && error === businessError) throw error
      fail('REMOTE_STORAGE', '主控无法保存连接信息；请检查 DSH 私有凭据存储是否可写。')
    }
    return this.public(payload)
  }

  /** Rename an existing grant locally; never read browser cookies or contact its target. */
  async rename(id, name, { onlyIfUnset = false } = {}) {
    const normalized = connectionName(name)
    const key = this.key(id)
    let connection
    let businessError
    try {
      await this.ctx.credentials.modifyRecord(key, async previous => {
        try {
          if (!previous) fail('REMOTE_CONNECTION_MISSING', 'Select a known remote connection')
          const saved = this.stored(previous, id)
          if (onlyIfUnset && Object.hasOwn(saved, 'name')) {
            connection = this.public(saved)
            return undefined
          }
          connection = this.public({ ...saved, name: normalized })
          return { ...previous, payload: { ...previous.payload, name: normalized } }
        } catch (error) {
          businessError = error
          throw error
        }
      })
    } catch (error) {
      if (businessError && error === businessError) throw error
      fail('REMOTE_STORAGE', '主控无法保存连接信息；请检查 DSH 私有凭据存储是否可写。')
    }
    return connection
  }

  async get(id) {
    const record = await this.ctx.credentials.readRecord(this.key(id))
    if (!record) fail('REMOTE_CONNECTION_MISSING', 'Connect this DSH instance explicitly before dispatching')
    const value = this.stored(record, id)
    return { endpoint: value.endpoint, cookie: `${value.cookieName}=${value.cookieValue}`, instanceId: value.instanceId }
  }

  async forget(id) { await this.ctx.credentials.deleteRecord(this.key(id)); return { targetId: id, id, disconnected: true } }

  async request(id, path, options = {}) {
    const connection = await this.get(id)
    const value = await this.fetchJson(connection.endpoint, path, connection.cookie, options)
    if (!value || value.version !== 1 || value.instanceId !== connection.instanceId) {
      fail('REMOTE_INSTANCE_CHANGED', 'Remote instance identity changed; reconnect explicitly before continuing')
    }
    return value
  }

  async fetchJson(endpoint, path, cookie, { method = 'GET', input, signal } = {}) {
    if (typeof path !== 'string' || !/^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(path)) fail('REMOTE_PATH', 'Only remote-control API paths are supported')
    if (!['GET', 'POST', 'DELETE'].includes(method) || (method === 'GET' && input !== undefined)) fail('REMOTE_METHOD', 'Unsupported remote-control request method')
    const url = new URL(`${ROUTE}${path}`, endpoint).href
    let response
    try {
      response = await this.fetchImpl(url, { method, redirect: 'error',
        headers: { cookie, accept: 'application/json', ...(input !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) })
    } catch {
      fail('REMOTE_TRANSPORT', 'Remote connection failed; no authentication was refreshed and no request was automatically replayed')
    }
    return jsonResponse(response)
  }
}
