import test from 'node:test'
import assert from 'node:assert/strict'
import { PhaseDeadlines } from '../src/tasks/deadlines.js'
import { TaskEventHub } from '../src/tasks/transport.js'

test('nearest active deadline pauses through a program timer without any model check loop', async () => {
  const events = new TaskEventHub()
  let state = 'running'
  let calls = 0
  const started = Date.now()
  const task = () => ({ state, remoteSessionId: 'hub-1', notification: { worker: { phaseStartedAt: started, activeTimeoutMs: 20 } } })
  let resolve
  const paused = new Promise((done) => { resolve = done })
  const worker = { owns: () => true, beforeStep: async (id) => {
    assert.equal(id, 'hub-1')
    calls++
    state = 'waiting_human'
    events.changed()
    resolve()
    return false
  } }
  const deadlines = new PhaseDeadlines({ worker, ledger: { list: async () => [task()] }, events })
  let timeout
  try {
    await deadlines.schedule()
    await Promise.race([paused, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('deadline timeout')), 1000) })])
    assert.equal(calls, 1)
    assert.equal(state, 'waiting_human')
  } finally { clearTimeout(timeout); deadlines.close() }
})

test('waiting states have no active deadline timer, and closing removes subscriptions', async () => {
  const events = new TaskEventHub()
  const tasks = ['queued', 'waiting_execution', 'waiting_human', 'reconciling'].map((state) => ({ state, notification: { worker: { phaseStartedAt: 0, activeTimeoutMs: 1 } } }))
  const deadlines = new PhaseDeadlines({ worker: { owns: () => true, beforeStep: () => { throw new Error('waiting cannot admit a model step') } }, ledger: { list: async () => tasks }, events })
  await deadlines.schedule()
  assert.equal(deadlines.timer, undefined)
  assert.equal(events.listenerCount('changed'), 1)
  deadlines.close()
  assert.equal(events.listenerCount('changed'), 0)
})
