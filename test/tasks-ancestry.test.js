import test from 'node:test'
import assert from 'node:assert/strict'
import { taskForAgent } from '../src/tasks/ancestry.js'

const task = { taskId: 'one', remoteSessionId: 'root' }
const worker = { taskForSession: async (id) => id === 'root' ? task : undefined }

test('task ancestry follows live and cold subagents but not ordinary forks', async () => {
  const headers = new Map([['middle', { origin: 'subagent', parentSession: 'root' }], ['root', {}]])
  const ctx = { sessions: { get: (id) => headers.has(id) ? { header: headers.get(id) } : undefined },
    sessionController: { inspect: async (id) => ({ meta: headers.get(id) }) } }
  assert.equal(await taskForAgent(ctx, worker, { id: 'root' }), task)
  assert.equal(await taskForAgent(ctx, worker, { id: 'child', session: { header: { origin: 'subagent', parentSession: 'middle' } } }), task)
  ctx.sessions.get = () => undefined
  assert.equal(await taskForAgent(ctx, worker, { id: 'child', session: { header: { origin: 'subagent', parentSession: 'middle' } } }), task)
  assert.equal(await taskForAgent(ctx, worker, { id: 'fork', session: { header: { parentSession: 'root', isSeeded: true } } }), undefined)
})

test('cycles and inaccessible ancestors fail closed', async () => {
  const ctx = { sessions: { get: () => ({ header: { origin: 'subagent', parentSession: 'child' } }) } }
  await assert.rejects(taskForAgent(ctx, worker, { id: 'child', session: { header: { origin: 'subagent', parentSession: 'child' } } }), /Cyclic/)
  ctx.sessions.get = () => undefined
  ctx.sessionController = { inspect: async () => { throw new Error('not available') } }
  await assert.rejects(taskForAgent(ctx, worker, { id: 'child', session: { header: { origin: 'subagent', parentSession: 'unknown' } } }), /not available/)
})
