import test from 'node:test'
import assert from 'node:assert/strict'
import {
  apply,
  createStatusTracker,
  deriveSessionRunning,
  isDshResponse,
  isLoopbackAddress,
  parseListenerPorts,
  readBodyPrefix,
} from '../src/index.js'

test('parses Linux ss listeners', () => {
  const ports = parseListenerPorts([
    'LISTEN 0 511 0.0.0.0:3080 0.0.0.0:*',
    'LISTEN 0 128 [::1]:4100 [::]:*',
  ].join('\n'))
  assert.deepEqual(ports, [3080, 4100])
})

test('parses PowerShell port output', () => {
  assert.deepEqual(parseListenerPorts('3080\r\n4100\r\n3080\r\n'), [3080, 4100])
})

test('recognizes authenticated and unauthenticated DSH pages', () => {
  assert.equal(isDshResponse(401, 'dsh web authentication required; reopen the URL printed by dsh web.'), true)
  assert.equal(isDshResponse(200, '<script>window.__DSH_BOOT__ = {}</script>'), true)
  assert.equal(isDshResponse(200, '<html>another app</html>'), false)
})

test('caps probe response bodies before buffering them', async () => {
  const bytes = new TextEncoder().encode('x'.repeat(32 * 1024))
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }))
  const body = await readBodyPrefix(response, 1024)
  assert.equal(new TextEncoder().encode(body).byteLength, 1024)
})

test('accepts only loopback status callers', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('192.168.1.20'), false)
})

test('derives running state from the latest turn boundary', () => {
  assert.equal(deriveSessionRunning([{ type: 'turn/start' }]), true)
  assert.equal(deriveSessionRunning([{ type: 'turn/start' }, { type: 'turn/end' }]), false)
  assert.equal(deriveSessionRunning([{ type: 'user/message' }]), false)
})

test('tracks working, waiting, and settlement transitions', () => {
  const tracker = createStatusTracker(['session-a'], 'epoch-test')
  tracker.startWaiting('session-a')
  tracker.startWaiting('session-a')
  tracker.stopWaiting('session-a')
  tracker.settle('completed')
  tracker.setRunning('session-a', false)

  assert.deepEqual(tracker.snapshot(), {
    version: 1,
    epoch: 'epoch-test',
    workingCount: 0,
    waitingCount: 1,
    completionSeq: 1,
    waitingSeq: 1,
    lastOutcome: 'completed',
    revision: 4,
    updatedAt: tracker.snapshot().updatedAt,
  })
})

function responseRecorder() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    end(value = '') { this.body += String(value) },
  }
}

test('marks completion only when the whole server becomes idle', () => {
  const tracker = createStatusTracker(['session-a', 'session-b'], 'epoch-test')
  tracker.settle('completed')
  tracker.setRunning('session-a', false)
  assert.equal(tracker.snapshot().completionSeq, 0)
  assert.equal(tracker.snapshot().workingCount, 1)

  tracker.settle('completed')
  tracker.setRunning('session-b', false)
  assert.equal(tracker.snapshot().completionSeq, 1)
  assert.equal(tracker.snapshot().workingCount, 0)
})

test('status bridge rejects browser origins and non-loopback callers', () => {
  const routes = new Map()
  const ctx = {
    webServer: {
      port: 3080,
      register(route) {
        routes.set(route.path, route.handler)
        return () => {}
      },
    },
    connection: { requestRejection: () => undefined },
    sessions: {
      list: () => [{ id: 'session-running', ownEvents: () => [{ type: 'turn/start' }] }],
    },
    get: () => undefined,
    on: () => () => true,
    effect(callback) { return callback() },
    interval: () => () => {},
  }
  apply(ctx)
  const handler = routes.get('/api/dsh-server-hub/status')
  assert.equal(typeof handler, 'function')

  const originResponse = responseRecorder()
  handler({ method: 'GET', headers: { origin: 'http://127.0.0.1:3080' }, socket: { remoteAddress: '127.0.0.1' } }, originResponse)
  assert.equal(originResponse.statusCode, 403)

  const remoteResponse = responseRecorder()
  handler({ method: 'GET', headers: {}, socket: { remoteAddress: '192.168.1.20' } }, remoteResponse)
  assert.equal(remoteResponse.statusCode, 403)

  const loopbackResponse = responseRecorder()
  handler({ method: 'GET', headers: {}, socket: { remoteAddress: '::1' } }, loopbackResponse)
  assert.equal(loopbackResponse.statusCode, 200)
  const status = JSON.parse(loopbackResponse.body)
  assert.equal(status.version, 1)
  assert.equal(typeof status.epoch, 'string')
  assert.equal(status.workingCount, 1)
})
