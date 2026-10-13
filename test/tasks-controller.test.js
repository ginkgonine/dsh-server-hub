import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { TaskController } from '../src/tasks/controller.js'
import { FileTaskLedger } from '../src/tasks/ledger.js'
import { TaskEventHub } from '../src/tasks/transport.js'

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'hub-controller-'))
  const ledger = await new FileTaskLedger(path.join(directory, 'ledger')).init()
  const received = []
  const notified = []
  const config = { enabled: true, stateDirectory: path.join(directory, 'ledger'), nodes: [{ nodeId: 'v100', endpoint: 'http://127.0.0.1:3100/', token: 't'.repeat(48), projects: ['sr'] }] }
  const sessions = { notify: async (...args) => { notified.push(args) } }
  const remote = new Map()
  const request = async (_node, suffix, { input } = {}) => {
    received.push({ suffix, input })
    if (options.offline) throw new Error('offline')
    if (suffix === '') {
      const { version, ...submit } = input
      const now = Date.now()
      const task = remote.get(submit.taskId) || { ...submit, state: 'queued', revision: 1, createdAt: now, updatedAt: now }
      remote.set(task.taskId, task)
      return { version: 1, nodeId: 'v100', task }
    }
    const id = suffix.split('/')[1]
    const task = remote.get(id)
    if (!task) throw new Error('not found')
    if (suffix.endsWith('/cancel')) task.state = 'cancelled'
    return { task }
  }
  const controller = new TaskController({ config, ledger, events: new TaskEventHub(), sessions, request })
  t.after(async () => { await controller.close(); await ledger.close(); await rm(directory, { recursive: true, force: true }) })
  const submit = (extra = {}, origin = 'origin-1') => controller.submit({ nodeId: 'v100', projectId: 'sr', instruction: 'Check training', ...extra }, { sessionId: origin, callId: 'call-1' })
  return { controller, ledger, received, notified, remote, submit }
}

test('submit is session-owned, explicit-target-only and deduplicated by stable identity', async (t) => {
  const { submit, received, controller } = await fixture(t)
  const task = await submit()
  assert.equal(task.accepted, true)
  assert.equal(task.state, 'dispatching')
  assert.equal((await submit()).taskId, task.taskId)
  assert.equal(received.length, 1)
  await assert.rejects(submit({ instruction: 'Changed command' }), /different|immutable|conflict/i)
  await assert.rejects(submit({ cwd: '/' }), /unknown field/)
  await assert.rejects(submit({ projectId: 'unknown' }), /disallowed/)
  await assert.rejects(controller.status(task.taskId, 'someone-else'), /not found/)
})

test('offline submission stays a durable retry intent, never claims remote acceptance', async (t) => {
  const { submit, ledger, notified } = await fixture(t, { offline: true })
  const task = await submit()
  assert.equal(task.accepted, false)
  const record = await ledger.get(task.taskId)
  assert.equal(record.outbox.status, 'pending')
  assert.equal(record.outbox.attempts, 1)
  assert.equal(record.outbox.nextAttemptAt > Date.now(), true)
  assert.equal(notified.length, 0)
})

test('fast completion creates one stable summary delivery, not periodic Agent checks', async (t) => {
  const { submit, controller, remote, notified, ledger } = await fixture(t)
  const task = await submit()
  const record = remote.get(task.taskId)
  record.state = 'succeeded'
  record.revision = 3
  record.result = { outcome: 'succeeded', summary: 'Training complete', evidence: ['step=100000'] }
  await controller.sync(task.taskId, record)
  await controller.deliver(task.taskId)
  assert.equal(notified.length, 1)
  assert.equal(notified[0][0], 'origin-1')
  assert.match(notified[0][2], /step=100000/)
  assert.equal((await ledger.get(task.taskId)).outbox.status, 'sent')
  await controller.sync(task.taskId, record)
  await controller.deliver(task.taskId)
  assert.equal(notified.length, 1)
})

test('stale revisions cannot rewind task state or trigger another human notice', async (t) => {
  const { submit, controller, remote, notified } = await fixture(t)
  const task = await submit()
  const first = { ...remote.get(task.taskId), state: 'waiting_human', revision: 3 }
  await controller.sync(task.taskId, first)
  await controller.deliver(task.taskId)
  assert.equal(notified.length, 1)
  await controller.sync(task.taskId, { ...first, state: 'running', revision: 2 })
  assert.equal((await controller.status(task.taskId, 'origin-1')).state, 'waiting_human')
})

test('concurrent state synchronization cannot rewind a newer remote revision', async (t) => {
  const { submit, controller, remote } = await fixture(t)
  const task = await submit()
  const base = remote.get(task.taskId)
  await Promise.all([
    controller.sync(task.taskId, { ...base, state: 'running', revision: 4 }),
    controller.sync(task.taskId, { ...base, state: 'waiting_human', revision: 3 }),
  ])
  assert.equal((await controller.status(task.taskId, 'origin-1')).state, 'running')
})

test('a distinct second human question is delivered once even if intermediate running snapshots were skipped', async (t) => {
  const { submit, controller, remote, notified } = await fixture(t)
  const task = await submit()
  const base = remote.get(task.taskId)
  const first = { ...base, state: 'waiting_human', revision: 3, result: { outcome: 'needs_input', summary: 'First question', evidence: [] } }
  await controller.sync(task.taskId, first)
  await controller.deliver(task.taskId)
  const second = { ...first, revision: 6, result: { ...first.result, summary: 'Second question' } }
  await controller.sync(task.taskId, second)
  await controller.deliver(task.taskId)
  await controller.sync(task.taskId, { ...second, revision: 7 })
  await controller.deliver(task.taskId)
  assert.equal(notified.length, 2)
  assert.match(notified[1][2], /Second question/)
})

test('master requires explicit evidence and stays independent of other plugin integrations', async (t) => {
  const { submit, controller, remote, notified } = await fixture(t)
  await assert.rejects(submit({ todoId: 'note-1' }), /unknown field/)
  const task = await submit()
  const record = { ...remote.get(task.taskId), state: 'succeeded', revision: 3 }
  await assert.rejects(controller.sync(task.taskId, record), /explicit result evidence/)
  record.result = { outcome: 'succeeded', summary: 'Done', evidence: ['report'] }
  await controller.sync(task.taskId, record)
  await controller.deliver(task.taskId)
  assert.match(notified[0][2], /remote_task_report/)
  assert.doesNotMatch(notified[0][2], /todo_note|todoAction|QQ/)
})
