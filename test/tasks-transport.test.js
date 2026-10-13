import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { createTaskRoute, TaskEventHub, taskRequest, followTaskEvents, TASK_ROUTE } from '../src/tasks/transport.js'

async function fixture(t) {
  const token = 't'.repeat(48)
  const events = new TaskEventHub()
  const records = new Map()
  const history = []
  const ledger = {
    get: async (id) => records.get(id),
    eventsSince: async (after, limit) => history.filter((e) => e.seq > after).slice(0, limit),
  }
  const add = (id) => {
    const task = { taskId: id, state: 'queued' }
    records.set(id, task)
    history.push({ seq: history.length + 1, taskId: id, type: 'task.updated', data: task, createdAt: new Date().toISOString() })
    events.changed()
    return task
  }
  const handler = createTaskRoute({ nodeId: 'v100', token, ledger, events, accept: async (value) => add(value.taskId), cancel: async (id) => ({ taskId: id, state: 'cancelled' }) })
  const server = http.createServer(handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const endpoint = `http://127.0.0.1:${server.address().port}/`
  t.after(async () => { events.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) })
  return { endpoint, token, node: { nodeId: 'v100', endpoint, token }, events, add, history }
}

test('machine task endpoints require a token and reject browser origins', async (t) => {
  const { endpoint, token, node } = await fixture(t)
  const route = `${endpoint.slice(0, -1)}${TASK_ROUTE}/identity`
  assert.equal((await fetch(route)).status, 401)
  assert.equal((await fetch(route, { headers: { authorization: `Bearer ${token}`, origin: endpoint } })).status, 401)
  assert.equal((await fetch(route, { headers: { authorization: `Bearer ${'x'.repeat(48)}` } })).status, 401)
  assert.deepEqual(await taskRequest(node, '/identity'), { version: 1, nodeId: 'v100', ok: true })
  await assert.rejects(taskRequest({ ...node, nodeId: 'imposter' }, '/identity'), /identity/)
})

test('submit and query preserve node identity and reject unsupported methods', async (t) => {
  const { endpoint, node } = await fixture(t)
  const reply = await taskRequest(node, '', { method: 'POST', input: { taskId: 'task-1' } })
  assert.equal(reply.task.taskId, 'task-1')
  assert.equal((await taskRequest(node, '/task-1')).task.state, 'queued')
  assert.equal((await taskRequest(node, '/task-1/cancel', { method: 'POST', input: {} })).task.state, 'cancelled')
  await assert.rejects(taskRequest(node, '/missing'), /HTTP 404/)
  assert.equal((await fetch(`${endpoint}api/dsh-server-hub/tasks/task-1`, { method: 'PUT', headers: { authorization: `Bearer ${node.token}` } })).status, 405)
  await assert.rejects(taskRequest(node, '/task-1/cancel', { method: 'POST', input: { killUnrelated: true } }), /HTTP 400/)
})

test('SSE replays a durable cursor then receives new events without task polling', async (t) => {
  const { node, add } = await fixture(t)
  add('task-1')
  add('task-2')
  const abort = new AbortController()
  const received = []
  const follow = followTaskEvents(node, 1, async (event) => {
    received.push(event.seq)
    if (event.seq === 2) add('task-3')
    if (event.seq === 3) abort.abort()
  }, { signal: abort.signal }).catch((error) => {
    if (!abort.signal.aborted) throw error
  })
  await follow
  assert.deepEqual(received, [2, 3])
})

test('client rejects redirected endpoints and mismatched stream identities', async () => {
  const node = { nodeId: 'v100', endpoint: 'https://example.test/mount/', token: 't'.repeat(48) }
  let observed
  await taskRequest(node, '/identity', { fetchImpl: async (url, options) => {
    observed = url.href
    assert.equal(options.redirect, 'error')
    return Response.json({ version: 1, nodeId: 'v100', ok: true })
  } })
  assert.equal(observed, 'https://example.test/mount/api/dsh-server-hub/tasks/identity')
  await assert.rejects(followTaskEvents(node, 0, async () => {}, {
    fetchImpl: async () => new Response('event: identity\ndata: {"version":1,"nodeId":"other"}\n\n', { headers: { 'content-type': 'text/event-stream' } }),
  }), /identity/)
})
