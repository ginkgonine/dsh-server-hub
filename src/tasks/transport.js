import { createHash, timingSafeEqual } from 'node:crypto'
import { EventEmitter } from 'node:events'

export const TASK_ROUTE = '/api/dsh-server-hub/tasks'
const MAX_BODY = 256 * 1024
const MAX_FRAME = 512 * 1024

export class TaskTransportError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.code = code
    this.status = status
  }
}

function authorized(req, token) {
  if (req.headers.origin !== undefined || !token || token.length < 32) return false
  const supplied = String(req.headers.authorization || '')
  if (!supplied.startsWith('Bearer ') || supplied.length > 4096) return false
  const digest = (value) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(supplied.slice(7)), digest(token))
}

function json(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(value))
}

async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(String(req.headers['content-type'] || ''))) {
    throw new TaskTransportError('CONTENT_TYPE', 'Send application/json', 415)
  }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > MAX_BODY) throw new TaskTransportError('BODY_LIMIT', 'Request body exceeds limit', 413)
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
    throw new TaskTransportError('JSON', 'Invalid JSON')
  }
}

/** Wake streams only on ledger writes; no recurring task/model polling. */
export class TaskEventHub extends EventEmitter {
  changed() { this.emit('changed') }
  close() { this.emit('closing'); this.removeAllListeners() }
}

/** Separate machine-authenticated API; never inherits the read-only status bridge. */
export function createTaskRoute({ nodeId, token, projects, ledger, events, accept, cancel, resume }) {
  return async (req, res) => {
    if (!authorized(req, token)) {
      json(res, 401, { version: 1, nodeId, error: { code: 'AUTH', message: 'Task authentication required' } })
      return
    }
    const envelope = (value) => ({ version: 1, nodeId, ...value })
    try {
      const url = new URL(req.url, 'http://localhost')
      const suffix = url.pathname.slice(TASK_ROUTE.length)
      if (req.method === 'GET' && suffix === '/identity') {
        json(res, 200, envelope({ ok: true, ...(projects ? { projects } : {}) }))
      } else if (req.method === 'POST' && suffix === '') {
        const value = await accept(await body(req))
        events.changed()
        json(res, 202, envelope({ task: value }))
      } else if (req.method === 'GET' && suffix === '/events') {
        const raw = url.searchParams.get('after') || '0'
        if (!/^\d{1,15}$/.test(raw)) throw new TaskTransportError('CURSOR', 'Invalid event cursor')
        let cursor = Number(raw)
        if (!Number.isSafeInteger(cursor)) throw new TaskTransportError('CURSOR', 'Invalid event cursor')
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        })
        res.write(`event: identity\ndata: ${JSON.stringify(envelope({ ok: true }))}\n\n`)
        let closed = false
        let draining = false
        let queued = false
        const cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(heartbeat)
          events.off('changed', drain)
          events.off('closing', stop)
        }
        const stop = () => { cleanup(); res.end() }
        const drain = async () => {
          if (closed) return
          if (draining) { queued = true; return }
          draining = true
          try {
            do {
              queued = false
              const entries = await ledger.eventsSince(cursor, 100)
              for (const entry of entries) {
                if (closed) break
                const encoded = JSON.stringify(envelope({ event: entry }))
                if (Buffer.byteLength(encoded) > MAX_FRAME) throw new Error('event exceeds stream limit')
                // Disconnect slow consumers. They reconnect with their durable cursor.
                if (!res.write(`id: ${entry.seq}\nevent: task\ndata: ${encoded}\n\n`)) {
                  stop()
                  break
                }
                cursor = entry.seq
              }
              if (entries.length === 100) queued = true
            } while (queued && !closed)
          } catch { stop() } finally { draining = false }
        }
        const heartbeat = setInterval(() => {
          if (!closed && !res.write(': heartbeat\n\n')) stop()
        }, 15000)
        heartbeat.unref?.()
        events.on('changed', drain)
        events.on('closing', stop)
        res.on('close', cleanup)
        void drain()
      } else {
        const match = suffix.match(/^\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})(\/(?:cancel|resume))?$/)
        if (!match) throw new TaskTransportError('ROUTE', 'Unknown task route', 404)
        if (req.method === 'GET' && !match[2]) {
          const task = await ledger.get(match[1])
          if (!task) throw new TaskTransportError('NOT_FOUND', 'Task not found', 404)
          json(res, 200, envelope({ task }))
        } else if (req.method === 'POST' && match[2]) {
          const input = await body(req)
          let task
          if (match[2] === '/cancel') {
            if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some((key) => key !== 'task')) throw new TaskTransportError('FIELDS', 'Cancel accepts only its original task envelope')
            task = await cancel(match[1], input.task)
          } else {
            if (!resume) throw new TaskTransportError('ROUTE', 'Resume is unavailable', 404)
            task = await resume(match[1], input)
          }
          events.changed()
          json(res, 200, envelope({ task }))
        } else {
          throw new TaskTransportError('METHOD', 'Method not allowed', 405)
        }
      }
    } catch (error) {
      if (res.headersSent) { res.end(); return }
      // Do not return stack traces, credentials, or filesystem errors.
      json(res, error.status || 400, envelope({ error: { code: error.code || 'TASK_ERROR', message: error.code ? error.message : 'Task request failed' } }))
    }
  }
}

function remoteURL(node, suffix = '') {
  // Configuration validation owns endpoint trust, including TLS/loopback policy.
  return new URL(`api/dsh-server-hub/tasks${suffix}`, node.endpoint.endsWith('/') ? node.endpoint : `${node.endpoint}/`)
}

async function readBounded(response, limit) {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > limit) throw new TaskTransportError('RESPONSE_LIMIT', 'Task response exceeds limit', 502)
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function verify(node, value) {
  if (!value || value.version !== 1 || value.nodeId !== node.nodeId) {
    throw new TaskTransportError('IDENTITY', 'Remote node identity/protocol mismatch', 502)
  }
  if (value.error) throw new TaskTransportError(value.error.code, value.error.message, 502)
  return value
}

export async function taskRequest(node, suffix, { method = 'GET', input, signal, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(remoteURL(node, suffix), {
    method,
    headers: { authorization: `Bearer ${node.token}`, accept: 'application/json', ...(input !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  })
  if (!response.ok) {
    await readBounded(response, MAX_FRAME)
    const error = new TaskTransportError('HTTP', `Remote task request returned HTTP ${response.status}`, 502)
    error.remoteStatus = response.status
    throw error
  }
  return verify(node, JSON.parse(await readBounded(response, MAX_FRAME)))
}

/** Event-driven transport. Consumers persist their cursor before returning. */
export async function followTaskEvents(node, after, consume, { signal, fetchImpl = fetch, inactivityMs = 45000 } = {}) {
  const idle = new AbortController()
  let timer
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => idle.abort(new TaskTransportError('IDLE_STREAM', 'Task event heartbeat expired', 502)), inactivityMs)
    timer.unref?.()
  }
  touch()
  try {
    return await followTaskEventsInner(node, after, consume, { fetchImpl, touch, signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal })
  } finally { clearTimeout(timer) }
}

async function followTaskEventsInner(node, after, consume, { signal, fetchImpl, touch }) {
  const response = await fetchImpl(remoteURL(node, `/events?after=${after}`), {
    headers: { authorization: `Bearer ${node.token}`, accept: 'text/event-stream' },
    redirect: 'error', signal,
  })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
    await response.body?.cancel().catch(() => {})
    const error = new TaskTransportError('STREAM', 'Remote task event stream rejected', 502)
    error.remoteStatus = response.status
    throw error
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let identified = false
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      touch()
      buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
      if (Buffer.byteLength(buffer) > MAX_FRAME) throw new TaskTransportError('FRAME_LIMIT', 'Event frame exceeds limit', 502)
      let end
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        const data = frame.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).join('\n')
        if (!data) continue
        const message = verify(node, JSON.parse(data))
        if (frame.includes('event: identity')) { identified = true; continue }
        if (!identified) throw new TaskTransportError('IDENTITY', 'Stream has not identified its node', 502)
        if (message.event) await consume(message.event)
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
