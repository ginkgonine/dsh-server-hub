import { execFile as execFileCallback } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const SCAN_ROUTE = '/api/dsh-server-hub/scan'
const MAX_PORTS = 256
const PROBE_CONCURRENCY = 24
const MAX_PROBE_BODY_BYTES = 256 * 1024

export const name = 'dsh-server-hub'
export const inject = ['webServer', 'connection']

function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
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

export function apply(ctx) {
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
        const candidatePorts = discovery.ports.filter((port) => port !== ctx.webServer.port)
        const instances = await detectDshInstances(candidatePorts)
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
