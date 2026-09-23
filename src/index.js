import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const SCAN_ROUTE = '/api/dsh-server-hub/scan'
const STATUS_ROUTE = '/api/dsh-server-hub/status'
const OVERVIEW_ROUTE = '/api/dsh-server-hub/overview'
const MAX_PORTS = 256
const PROBE_CONCURRENCY = 24
const MAX_PROBE_BODY_BYTES = 256 * 1024
const STATUS_BODY_BYTES = 16 * 1024
const STATUS_POLL_MS = 1_500
const DISCOVERY_POLL_MS = 30_000

export const name = 'dsh-server-hub'
export const inject = ['webServer', 'connection', 'timer', 'sessions']

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

export function isLoopbackAddress(address) {
  const value = String(address || '').toLowerCase()
  return value === '127.0.0.1'
    || value === '::1'
    || value === '::ffff:127.0.0.1'
    || value === 'localhost'
}

export function deriveSessionRunning(events) {
  const entries = Array.isArray(events) ? events : []
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const type = entries[index] && entries[index].type
    if (type === 'turn/end') return false
    if (type === 'turn/start') return true
  }
  return false
}

export function createStatusTracker(initialRunning = [], epoch = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`) {
  const running = new Set(initialRunning.map(String))
  const waiting = new Map()
  let completionSeq = 0
  let waitingSeq = 0
  let revision = 0
  let lastOutcome = null
  let pendingOutcome = null
  let updatedAt = Date.now()

  const changed = () => {
    revision += 1
    updatedAt = Date.now()
  }

  return {
    setRunning(sessionId, value) {
      const id = String(sessionId)
      if (value) {
        if (running.has(id)) return
        running.add(id)
        changed()
        return
      }
      if (!running.delete(id)) return
      if (running.size === 0) {
        completionSeq += 1
        lastOutcome = pendingOutcome || 'completed'
        pendingOutcome = null
      }
      changed()
    },
    settle(outcome) {
      pendingOutcome = String(outcome || 'completed')
    },
    startWaiting(sessionId) {
      const id = String(sessionId || 'unknown')
      const totalBefore = [...waiting.values()].reduce((sum, count) => sum + count, 0)
      waiting.set(id, (waiting.get(id) || 0) + 1)
      if (totalBefore === 0) waitingSeq += 1
      changed()
    },
    stopWaiting(sessionId) {
      const id = String(sessionId || 'unknown')
      const count = waiting.get(id) || 0
      if (count <= 0) return
      if (count === 1) waiting.delete(id)
      else waiting.set(id, count - 1)
      changed()
    },
    disposeSession(sessionId) {
      const id = String(sessionId)
      const removedRunning = running.delete(id)
      const removedWaiting = waiting.delete(id)
      if (removedRunning || removedWaiting) changed()
    },
    snapshot() {
      let waitingCount = 0
      for (const count of waiting.values()) waitingCount += count
      return {
        version: 1,
        epoch,
        workingCount: running.size,
        waitingCount,
        completionSeq,
        waitingSeq,
        lastOutcome,
        revision,
        updatedAt,
      }
    },
  }
}

export function parseListenerPorts(text) {
  const ports = new Set()
  const add = (value) => {
    const port = Number(value)
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port)
  }

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^\d{1,5}$/.test(line)) {
      add(line)
      continue
    }
    if (!/LISTEN/i.test(line)) continue
    for (const token of line.split(/\s+/)) {
      const colon = token.match(/:(\d{1,5})$/)
      if (colon) add(colon[1])
      const dot = token.match(/\.(\d{1,5})$/)
      if (dot) add(dot[1])
    }
  }

  return [...ports].sort((a, b) => a - b)
}

async function listListeningPorts() {
  const platform = process.platform
  const commands = platform === 'win32'
    ? [
        {
          file: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-Command', 'Get-NetTCPConnection -State Listen | Select-Object -ExpandProperty LocalPort'],
          source: 'windows-powershell',
        },
        { file: 'netstat.exe', args: ['-ano', '-p', 'tcp'], source: 'windows-netstat' },
      ]
    : platform === 'darwin'
      ? [
          { file: 'lsof', args: ['-nP', '-iTCP', '-sTCP:LISTEN'], source: 'macos-lsof' },
          { file: 'netstat', args: ['-an', '-p', 'tcp'], source: 'macos-netstat' },
        ]
      : [
          { file: 'ss', args: ['-ltnH'], source: 'linux-ss' },
          { file: 'netstat', args: ['-ltn'], source: 'linux-netstat' },
        ]

  for (const command of commands) {
    try {
      const { stdout } = await execFile(command.file, command.args, {
        timeout: 5_000,
        maxBuffer: 512 * 1024,
        windowsHide: true,
      })
      const ports = parseListenerPorts(stdout).slice(0, MAX_PORTS)
      if (ports.length) return { ports, source: command.source }
    } catch {
      // Try the next platform-appropriate listener command.
    }
  }

  return { ports: [], source: 'unavailable' }
}

export function isDshResponse(status, body) {
  const text = String(body || '')
  return (status === 401 && text.includes('dsh web authentication required'))
    || text.includes('__DSH_BOOT__')
    || text.includes('DeepSeek Harness')
}

export async function readBodyPrefix(response, maxBytes = MAX_PROBE_BODY_BYTES) {
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  let capped = false
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      total += chunk.byteLength
      text += decoder.decode(chunk, { stream: total < maxBytes })
      if (chunk.byteLength < value.byteLength || total >= maxBytes) {
        capped = true
        break
      }
    }
    if (!capped) text += decoder.decode()
    return text
  } finally {
    if (capped) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function probeUrl(url, port) {
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(1_200),
    })
    const body = await readBodyPrefix(response)
    return isDshResponse(response.status, body)
      ? { id: `auto-${url}`, port, label: `DSH :${port}`, url, source: 'auto' }
      : null
  } catch {
    return null
  }
}

async function probePort(port) {
  const ipv4 = await probeUrl(`http://127.0.0.1:${port}/`, port)
  if (ipv4 !== null) return ipv4
  return await probeUrl(`http://[::1]:${port}/`, port)
}

async function detectDshInstances(ports) {
  const detected = []
  for (let index = 0; index < ports.length; index += PROBE_CONCURRENCY) {
    const batch = ports.slice(index, index + PROBE_CONCURRENCY)
    const results = await Promise.all(batch.map(probePort))
    for (const result of results) if (result !== null) detected.push(result)
  }
  return detected
}

export function identifyLocalInstance(instance, localPort) {
  if (instance.port !== localPort) return instance
  return Object.assign({}, instance, {
    id: `local-${instance.url}`,
    label: `主控 :${instance.port}`,
    source: 'local',
  })
}

export function apply(ctx) {
  const initialRunning = []
  for (const session of ctx.sessions.list()) {
    if (deriveSessionRunning(session.ownEvents())) initialRunning.push(String(session.id))
  }
  const tracker = createStatusTracker(initialRunning)

  ctx.on('api-session/status', (sessionId, running) => {
    tracker.setRunning(sessionId, running)
  }, { global: true })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') tracker.settle(event.data.reason.kind)
  }, { global: true })
  ctx.on('agent/disposed', (payload) => {
    tracker.disposeSession(payload.agent.id)
  }, { global: true })
  ctx.on('approval/request', async (request, next) => {
    const sessionId = request.agent.id
    tracker.startWaiting(sessionId)
    try {
      return await next()
    } finally {
      tracker.stopWaiting(sessionId)
    }
  }, { prepend: true, global: true })
  ctx.on('user-questions/request', async (request, next) => {
    if (!request.agent) return await next()
    const sessionId = request.agent.id
    tracker.startWaiting(sessionId)
    try {
      return await next()
    } finally {
      tracker.stopWaiting(sessionId)
    }
  }, { prepend: true, global: true })

  let monitorStarted = false
  let monitorStartPromise = null
  let monitorInstances = []
  let monitorStates = {}
  let manualPorts = []
  let discoveryState = { source: 'unavailable', scannedPorts: 0, warning: '尚未扫描。' }
  let scanning = false
  let pollPromise = null
  let pollQueued = false

  const mergeInstances = (automatic) => {
    const autoPorts = new Set(automatic.map((item) => item.port))
    const manual = manualPorts
      .filter((port) => !autoPorts.has(port))
      .map((port) => ({
        id: `manual-http://127.0.0.1:${port}/`,
        port,
        label: `DSH :${port}`,
        url: `http://127.0.0.1:${port}/`,
        source: 'manual',
      }))
    monitorInstances = automatic.concat(manual)
    const liveUrls = new Set(monitorInstances.map((item) => item.url))
    monitorStates = Object.fromEntries(Object.entries(monitorStates).filter(([url]) => liveUrls.has(url)))
  }

  const refreshDiscovery = async () => {
    if (scanning) return
    scanning = true
    try {
      const discovery = await listListeningPorts()
      const candidatePorts = discovery.ports
      const automatic = (await detectDshInstances(candidatePorts))
        .map((instance) => identifyLocalInstance(instance, ctx.webServer.port))
      mergeInstances(automatic)
      discoveryState = {
        source: discovery.source,
        scannedPorts: candidatePorts.length,
        warning: candidatePorts.length === 0
          ? '没有读到本机监听端口；仍可手动添加端口。'
          : automatic.length === 0
            ? '发现了监听端口，但没有识别出 DSH；可手动添加隧道端口。'
            : null,
      }
    } catch (error) {
      discoveryState = {
        source: 'failed',
        scannedPorts: 0,
        warning: error instanceof Error ? error.message : String(error),
      }
    } finally {
      scanning = false
    }
  }

  const pollRemoteStatus = async (instance) => {
    const statusUrl = new URL(STATUS_ROUTE, instance.url).toString()
    try {
      const response = await fetch(statusUrl, {
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: AbortSignal.timeout(1_200),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = await readBodyPrefix(response, STATUS_BODY_BYTES)
      const value = JSON.parse(body)
      if (!value || value.version !== 1 || typeof value.epoch !== 'string' || value.epoch.length > 100) {
        throw new Error('unsupported status protocol')
      }
      const workingCount = Number(value.workingCount)
      const waitingCount = Number(value.waitingCount)
      const completionSeq = Number(value.completionSeq)
      const waitingSeq = Number(value.waitingSeq)
      if (![workingCount, waitingCount, completionSeq, waitingSeq].every(Number.isSafeInteger)) {
        throw new Error('invalid status response')
      }
      return {
        online: true,
        supported: true,
        epoch: value.epoch,
        workingCount,
        waitingCount,
        completionSeq,
        waitingSeq,
        lastOutcome: typeof value.lastOutcome === 'string' ? value.lastOutcome : null,
        revision: Number.isSafeInteger(Number(value.revision)) ? Number(value.revision) : 0,
        remoteUpdatedAt: Number.isFinite(Number(value.updatedAt)) ? Number(value.updatedAt) : 0,
        polledAt: Date.now(),
        error: null,
      }
    } catch (error) {
      const previous = monitorStates[instance.url]
      return {
        online: false,
        supported: previous ? previous.supported : false,
        epoch: previous ? previous.epoch : null,
        workingCount: previous ? previous.workingCount : 0,
        waitingCount: previous ? previous.waitingCount : 0,
        completionSeq: previous ? previous.completionSeq : 0,
        waitingSeq: previous ? previous.waitingSeq : 0,
        lastOutcome: previous ? previous.lastOutcome : null,
        revision: previous ? previous.revision : 0,
        remoteUpdatedAt: previous ? previous.remoteUpdatedAt : 0,
        polledAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  const pollRemoteStatuses = (force = false) => {
    if (force) pollQueued = true
    if (pollPromise !== null) return pollPromise
    pollPromise = (async () => {
      do {
        pollQueued = false
        const instances = monitorInstances.slice()
        if (instances.length === 0) {
          monitorStates = {}
          continue
        }
        const entries = await Promise.all(instances.map(async (instance) => [
          instance.url,
          await pollRemoteStatus(instance),
        ]))
        const liveUrls = new Set(monitorInstances.map((instance) => instance.url))
        monitorStates = Object.fromEntries(entries.filter(([url]) => liveUrls.has(url)))
      } while (pollQueued)
    })().finally(() => {
      pollPromise = null
    })
    return pollPromise
  }

  const ensureMonitoring = async () => {
    if (monitorStartPromise !== null) return await monitorStartPromise
    monitorStarted = true
    monitorStartPromise = (async () => {
      await refreshDiscovery()
      await pollRemoteStatuses()
      ctx.effect(() => {
        const stopDiscovery = ctx.interval(() => { void refreshDiscovery() }, DISCOVERY_POLL_MS)
        const stopPolling = ctx.interval(() => { void pollRemoteStatuses() }, STATUS_POLL_MS)
        return () => {
          stopDiscovery()
          stopPolling()
        }
      }, 'dsh-server-hub: remote status monitor')
    })()
    return await monitorStartPromise
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: STATUS_ROUTE,
    handler: (req, res) => {
      if (req.headers.origin !== undefined) {
        res.statusCode = 403
        res.end()
        return
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405
        res.setHeader('allow', 'GET, HEAD')
        res.end()
        return
      }
      const remoteAddress = req.socket && req.socket.remoteAddress
      if (!isLoopbackAddress(remoteAddress)) {
        res.statusCode = 403
        res.end()
        return
      }
      if (req.method === 'HEAD') {
        res.statusCode = 204
        res.setHeader('cache-control', 'no-store')
        res.end()
        return
      }
      sendJson(res, 200, tracker.snapshot())
    },
  }), `dsh-server-hub: GET ${STATUS_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: OVERVIEW_ROUTE,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }

      const requestUrl = new URL(req.url || OVERVIEW_ROUTE, 'http://localhost')
      const nextManualPorts = [...new Set(String(requestUrl.searchParams.get('ports') || '')
        .split(',')
        .map((value) => Number(value.trim()))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))]
        .slice(0, 64)
        .sort((a, b) => a - b)
      const manualChanged = nextManualPorts.join(',') !== manualPorts.join(',')
      if (manualChanged) {
        manualPorts = nextManualPorts
        mergeInstances(monitorInstances.filter((item) => item.source !== 'manual'))
      }

      await ensureMonitoring()
      if (requestUrl.searchParams.get('refresh') === '1') await refreshDiscovery()
      if (manualChanged || requestUrl.searchParams.get('refresh') === '1') await pollRemoteStatuses(true)

      sendJson(res, 200, {
        version: 1,
        monitoring: monitorStarted,
        instances: monitorInstances,
        states: monitorStates,
        discovery: discoveryState.source,
        scannedPorts: discoveryState.scannedPorts,
        warning: discoveryState.warning,
        scanning,
        polledAt: Date.now(),
      })
    },
  }), `dsh-server-hub: GET ${OVERVIEW_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SCAN_ROUTE,
    handler: async (req, res) => {
      const rejection = connectionOf(ctx).requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.setHeader('allow', 'GET')
        res.end()
        return
      }

      try {
        const discovery = await listListeningPorts()
        const candidatePorts = discovery.ports
        const instances = (await detectDshInstances(candidatePorts))
          .map((instance) => identifyLocalInstance(instance, ctx.webServer.port))
        sendJson(res, 200, {
          instances,
          scannedPorts: candidatePorts.length,
          discovery: discovery.source,
          warning: candidatePorts.length === 0
            ? '没有读到本机监听端口；仍可手动添加端口。'
            : instances.length === 0
              ? '发现了监听端口，但没有识别出 DSH；可手动添加隧道端口。'
              : null,
        })
      } catch (error) {
        sendJson(res, 500, {
          code: 'scan-failed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }), `dsh-server-hub: GET ${SCAN_ROUTE}`)
}
