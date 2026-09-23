import test from 'node:test'
import assert from 'node:assert/strict'
import { isDshResponse, parseListenerPorts } from '../src/index.js'

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
