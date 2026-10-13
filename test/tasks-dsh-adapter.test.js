import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { DshTaskSessions } from '../src/tasks/dsh-adapter.js'
import { FileTaskLedger } from '../src/tasks/ledger.js'
import { RemoteTaskWorker } from '../src/tasks/worker.js'
import { validateProjectConfig } from '../src/tasks/config.js'

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-dsh-adapter-'))
  const stateDirectory = path.join(root, 'state')
  const projectRoot = path.join(root, 'project')
  await mkdir(stateDirectory, { mode: 0o700 })
  await mkdir(projectRoot)
  const project = { id: 'sr', root: projectRoot, agentPreset: 'worker', mode: 'workspace-write', approvalPolicy: 'ask', allowPartial: false }
  const session = { id: 'hub-task-1', header: { cwd: projectRoot } }
  const observed = []
  const scopedHooks = new Map()
  const guards = []
  const agent = { id: session.id, session, ctx: { on: (name, hook) => { scopedHooks.set(name, hook) }, tools: { guard: (hook) => { guards.push(hook) } } } }
  let created = false
  const record = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1', notification: {} }
  const ledger = { get: async () => record, mutate: async (_id, callback) => { callback(record); return record } }
  const ctx = {
    fs: { sandboxMode: 'workspace-write' }, shell: { sandboxMode: 'workspace-write' },
    sandbox: { confine: async () => ({ argv: ['/usr/bin/true'], enforcement: 'full' }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: projectRoot }) },
    permissionPresets: { names: ['danger', 'workspace'], current: () => 'workspace', resolve: (name) => name === 'workspace' ? { sandbox: 'workspace-write', approval: 'ask' } : { sandbox: 'danger-full-access', approval: 'never' }, set: (_session, name) => { observed.push(['preset', name]) } },
    sessionController: {
      create: async (input) => { created = true; observed.push(['create', input]); return { sessionId: input.sessionId } },
      resolveAgent: async () => ({ agent }),
      prompt: async (input) => { observed.push(['prompt', input]); return { accepted: true } },
      inspect: async (id) => {
        if (id === 'origin-1' || created) return { meta: session.header }
        throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      },
      cancel: (input) => { observed.push(['cancel', input]) },
    },
    sessions: { get: (id) => id === 'origin-1' || created ? session : undefined, flush: async () => { observed.push(['flush']); return true } },
    workspaceRegistry: { archivedSessionIds: [] },
  }
  const adapter = new DshTaskSessions(ctx, { stateDirectory, projects: [project] }, ledger)
  t.after(() => rm(root, { recursive: true, force: true }))
  return { root, adapter, ctx, project, observed, record, session, scopedHooks, guards, agent, ledger }
}

test('trusted adapter creates explicit independent cwd/preset and flushes before prompting', async (t) => {
  const { adapter, project, observed, record } = await fixture(t)
  await adapter.validateProjects()
  const task = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1' }
  await adapter.create(task, project)
  assert.deepEqual(observed[0], ['create', { sessionId: 'hub-task-1', cwd: project.root, agentPreset: 'worker' }])
  assert.deepEqual(observed[1], ['preset', 'workspace'])
  assert.deepEqual(observed[2], ['flush'])
  record.state = 'running'
  record.projectId = project.id
  record.notification.worker = { phaseId: 'phase-1' }
  await adapter.prompt(task, 'phase-1', 'instruction')
  assert.equal(observed[3][0], 'create')
  assert.deepEqual(observed[4], ['flush'])
  assert.equal(observed[5][1].mode, 'queue')
  assert.equal(observed[5][1].requestId, 'phase-1')
  assert.deepEqual(observed[6], ['flush'])
  assert.equal(observed.filter(([type]) => type === 'preset').length, 1)
})

test('existing unrelated sessions are never adopted, reconfigured, prompted or cancelled', async (t) => {
  const { adapter, ctx, project, observed, session } = await fixture(t)
  ctx.sessions.get = () => session
  const task = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1' }
  await assert.rejects(adapter.create(task, project), /unrelated existing session/)
  assert.equal(observed.length, 0)
})

test('only an exact durable ownership claim permits cold/live session adoption on explicit resume', async (t) => {
  const { adapter, project, record } = await fixture(t)
  const task = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1' }
  await adapter.create(task, project)
  assert.equal(record.notification.dshSession.taskId, task.taskId)
  await adapter.create(task, project)
  record.notification.dshSession.taskId = 'other-task'
  await assert.rejects(adapter.create(task, project), /unrelated existing/)
})

test('Agent-owned tool/step guards survive module close and verified re-adoption rebinds them', async (t) => {
  const { adapter, ctx, project, ledger, scopedHooks, guards } = await fixture(t)
  const task = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1' }
  await adapter.create(task, project)
  assert.equal(guards[0]({ name: 'read' }), undefined)
  assert.match(guards[0]({ name: 'create_goal' }), /allowlist/)
  assert.match(guards[0]({ name: 'subagent' }), /allowlist/)
  adapter.close()
  assert.deepEqual(scopedHooks.get('agent/pre-step')({}, () => ({ kind: 'enter' })), { kind: 'reject' })
  assert.match(guards[0]({ name: 'read' }), /disabled/)
  const restored = new DshTaskSessions(ctx, adapter.config, ledger)
  await restored.create(task, project)
  assert.equal(guards.length, 1)
  assert.equal(guards[0]({ name: 'read' }), undefined)
  assert.deepEqual(scopedHooks.get('agent/pre-step')({}, () => ({ kind: 'enter' })), { kind: 'enter' })
})

test('a cold waiting_execution wake adopts durable ownership and installs Agent guards before prompting', async t => {
  let ledger, original, first, restored, second
  t.after(async () => {
    original?.close()
    restored?.close()
    await first?.close()
    await second?.close()
    await ledger?.close()
  })
  const f = await fixture(t)
  ledger = await new FileTaskLedger(f.adapter.config.stateDirectory).init()
  const config = { nodeId: 'v100', stateDirectory: f.adapter.config.stateDirectory, projects: [validateProjectConfig(f.project)] }
  let observer
  const executions = { observe(_id, callback) { observer = callback; return () => {} } }
  original = new DshTaskSessions(f.ctx, config, ledger)
  first = new RemoteTaskWorker({ config, ledger, sessions: original, executions, sessionIdForTask: () => 'hub-task-1' })
  await first.initialize()
  await first.accept({ version: 1, taskId: 'task-1', nodeId: 'v100', projectId: 'sr', instruction: 'Inspect training' })
  await first.pump()
  await Promise.all([...first.background])
  assert.equal((await ledger.get('task-1')).state, 'running')
  await first.park('task-1', { executionId: 'exec-1', reason: 'Long training' })
  original.close()
  await first.close()

  // Simulate a fresh process: cold persistence exists, but no Agent or guards do.
  let attached = false
  const coldGuards = []
  const coldHooks = new Map()
  const coldSession = { id: 'hub-task-1', header: { cwd: f.project.root } }
  const coldAgent = { id: coldSession.id, session: coldSession, ctx: {
    on: (name, hook) => coldHooks.set(name, hook), tools: { guard: hook => coldGuards.push(hook) },
  } }
  f.ctx.sessions.get = () => attached ? coldSession : undefined
  f.ctx.sessionController.create = async input => {
    const task = await ledger.get('task-1')
    assert.equal(task.notification.dshSession.sessionId, input.sessionId)
    assert.equal(input.cwd, f.project.root)
    attached = true
    f.observed.push(['adopt', input])
    return { sessionId: input.sessionId }
  }
  f.ctx.sessionController.resolveAgent = async () => ({ agent: coldAgent })
  const prompt = f.ctx.sessionController.prompt
  f.ctx.sessionController.prompt = async input => {
    assert.equal(coldGuards.length, 1)
    assert.equal(coldGuards[0]({ name: 'read' }), undefined)
    assert.match(coldGuards[0]({ name: 'create_goal' }), /allowlist/)
    assert.deepEqual(coldHooks.get('agent/pre-step')({}, () => ({ kind: 'enter' })), { kind: 'enter' })
    assert.equal(f.observed.at(-1)[0], 'flush')
    return prompt(input)
  }
  restored = new DshTaskSessions(f.ctx, config, ledger)
  second = new RemoteTaskWorker({ config, ledger, sessions: restored, executions })
  const prompts = f.observed.filter(([type]) => type === 'prompt').length
  await second.initialize()
  assert.equal((await ledger.get('task-1')).state, 'waiting_execution')
  assert.equal(coldGuards.length, 0)
  assert.equal(f.observed.filter(([type]) => type === 'prompt').length, prompts)
  await observer({ executionId: 'exec-1', status: 'ended', result: { exitCode: 0 } })
  await Promise.all([...second.background])
  await second.queue
  assert.equal((await ledger.get('task-1')).state, 'running')
  assert.equal(f.observed.filter(([type]) => type === 'prompt').length, prompts + 1)
  assert.equal(f.observed.filter(([type]) => type === 'preset').length, 1)
})

test('prompt adoption rejects lost ownership, changed permissions and cancellation/close during its checkpoint', async t => {
  for (const scenario of ['ownership', 'missing session', 'permissions', 'cancelled', 'closed', 'superseded phase']) {
    await t.test(scenario, async t => {
      const f = await fixture(t)
      const task = { taskId: 'task-1', nodeId: 'v100', remoteSessionId: 'hub-task-1' }
      await f.adapter.create(task, f.project)
      f.record.state = 'running'
      f.record.projectId = f.project.id
      f.record.notification.worker = { phaseId: 'phase-1' }
      const presets = f.observed.filter(([type]) => type === 'preset').length
      if (scenario === 'ownership') f.record.notification.dshSession.taskId = 'another-task'
      if (scenario === 'missing session') {
        f.ctx.sessions.get = () => undefined
        f.ctx.sessionController.inspect = async () => { throw Object.assign(new Error('missing'), { code: 'session/not-found' }) }
      }
      if (scenario === 'permissions') f.ctx.permissionPresets.current = () => 'danger'
      if (['cancelled', 'closed', 'superseded phase'].includes(scenario)) {
        f.ctx.sessions.flush = async () => {
          if (scenario === 'closed') f.adapter.close()
          else if (scenario === 'cancelled') f.record.state = 'cancelled'
          else f.record.notification.worker.phaseId = 'phase-2'
          return true
        }
      }
      await assert.rejects(f.adapter.prompt(task, 'phase-1', 'must not wake'))
      assert.equal(f.observed.some(([type]) => type === 'prompt'), false)
      assert.equal(f.observed.filter(([type]) => type === 'preset').length, presets)
    })
  }
})

test('symlink project roots and state under writable workspace fail closed', async (t) => {
  const { root, adapter, project } = await fixture(t)
  const alias = path.join(root, 'alias')
  await symlink(project.root, alias)
  adapter.config.projects = [{ ...project, root: alias }]
  await assert.rejects(adapter.validateProjects(), /canonical/)
  adapter.config.projects = [project]
  adapter.config.stateDirectory = project.root
  await assert.rejects(adapter.validateProjects(), /separate/)
})

test('partial enforcement and unavailable permission presets require explicit deployment handling', async (t) => {
  const { adapter, ctx, project } = await fixture(t)
  ctx.sandbox.confine = async () => ({ argv: [], enforcement: 'partial' })
  await assert.rejects(adapter.validateProjects(), /partial/)
  project.allowPartial = true
  await adapter.validateProjects()
  ctx.permissionPresets.names = ['danger']
  await assert.rejects(adapter.validateProjects(), /permission preset/)
})

test('reporting never creates a replacement session and refuses archived destinations', async (t) => {
  const { adapter, ctx, observed } = await fixture(t)
  await adapter.notify('origin-1', 'report-1', 'summary')
  assert.equal(observed.some(([type]) => type === 'create'), false)
  ctx.workspaceRegistry.archivedSessionIds = ['origin-1']
  await assert.rejects(adapter.notify('origin-1', 'report-2', 'summary'), /unavailable/)
  adapter.cancel('hub-task-1')
  assert.deepEqual(observed.at(-1), ['cancel', { sessionId: 'hub-task-1' }])
})
