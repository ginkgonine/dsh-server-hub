import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once, EventEmitter } from 'node:events'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from '../src/tasks/index.js'

function context(projectRoot) {
  const tools = new Map()
  const hooks = new Map()
  const effects = []
  const notices = new EventEmitter()
  const live = new Map([['origin-1', { id: 'origin-1', header: { cwd: projectRoot } }]])
  const agents = new Map()
  let handler
  const prompts = []
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    effect(callback) { const cleanup = callback(); effects.push(cleanup); return cleanup },
    on(event, listener) { hooks.set(event, listener); return () => {} },
    provide() {},
    webServer: { register(route) { handler = route.handler; return () => { handler = undefined } } },
    fs: { sandboxMode: 'workspace-write' }, shell: { sandboxMode: 'workspace-write' },
    sandbox: { confine: async () => ({ argv: [process.execPath], enforcement: 'full' }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: projectRoot }) },
    permissionPresets: { names: ['workspace'], current: () => 'workspace', resolve: () => ({ sandbox: 'workspace-write', approval: 'ask' }), set() {} },
    workspaceRegistry: { archivedSessionIds: [] },
    sessions: { get: (id) => live.get(id), flush: async () => true },
    sessionController: {
      create: async (input) => { live.set(input.sessionId, { id: input.sessionId, header: { cwd: input.cwd } }); return { sessionId: input.sessionId } },
      resolveAgent: async (id) => {
        if (!agents.has(id)) agents.set(id, { id, session: live.get(id), ctx: { on() {}, tools: { guard() {} } } })
        return { agent: agents.get(id) }
      },
      inspect: async (id) => live.get(id),
      prompt: async (input) => { prompts.push(input); notices.emit('prompt', input); if (input.sessionId === 'origin-1') notices.emit('report', input); return { accepted: true } },
      cancel() {},
    },
  }
  return { ctx, tools, hooks, notices, prompts, handler: (req, res) => handler ? handler(req, res) : (res.statusCode = 404, res.end()) }
}

async function withTimeout(promise, ms = 3000) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('test timeout')), ms) })]) }
  finally { clearTimeout(timer) }
}

test('task runtime remains completely disabled without explicit configuration', async () => {
  const result = await apply({ effect() { throw new Error('disabled module must not install effects') } })
  assert.equal(result, undefined)
})

test('paired master and worker complete over real HTTP/SSE and report only to original session', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'hub-plugin-'))
  const projectRoot = path.join(root, 'project')
  await mkdir(projectRoot)
  const remote = context(projectRoot)
  const main = context(projectRoot)
  const server = http.createServer(remote.handler)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const token = 'p'.repeat(48)
  let workerRuntime
  let masterRuntime
  t.after(async () => {
    await masterRuntime?.dispose()
    await workerRuntime?.dispose()
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    await rm(root, { recursive: true, force: true })
  })
  workerRuntime = await apply(remote.ctx, { enabled: true, stateDirectory: path.join(root, 'worker-state'), nodeId: 'v100', token,
    projects: [{ id: 'sr', root: projectRoot, agentPreset: 'worker' }] })
  masterRuntime = await apply(main.ctx, { enabled: true, stateDirectory: path.join(root, 'master-state'), nodes: [{ nodeId: 'v100', endpoint: `http://127.0.0.1:${server.address().port}/`, token, projects: ['sr'] }] })
  const targets = await main.tools.get('remote_task_targets').execute({}, { agent: { id: 'origin-1' } })
  assert.deepEqual(targets, [{ nodeId: 'v100', projects: ['sr'], online: true }])
  const submitted = await main.tools.get('remote_task_submit').execute({ nodeId: 'v100', projectId: 'sr', instruction: 'Summarize existing training' }, { agent: { id: 'origin-1', session: { ownEvents: () => [{ type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-task-1' } } }] } }, callId: 'call-1' })
  assert.equal(submitted.accepted, true)
  const task = await workerRuntime.ledger.get(submitted.taskId)
  // Wait on the deterministic worker pump, not an LLM/task polling loop.
  await workerRuntime.worker.queue
  await Promise.all([...workerRuntime.worker.background])
  assert.equal((await workerRuntime.ledger.get(task.taskId)).state, 'running')
  const exec = { agent: { id: task.remoteSessionId } }
  const gate = remote.hooks.get('agent/pre-step')
  assert.deepEqual(await gate({ agent: { id: 'delegated-child', session: { header: { origin: 'subagent', parentSession: task.remoteSessionId } } } }, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  assert.deepEqual(await gate(exec, async () => ({ kind: 'enter', messages: [] })), { kind: 'enter', messages: [] })
  const question = once(main.notices, 'report')
  await remote.tools.get('remote_task_finish').execute({ outcome: 'needs_input', summary: 'Which report should I produce?', evidence: [] }, exec)
  await withTimeout(question)
  const resumedPrompt = once(remote.notices, 'prompt')
  await main.tools.get('remote_task_resume').execute({ taskId: task.taskId, instruction: 'Summarize the latest checkpoint metrics' }, { agent: { id: 'origin-1', session: { ownEvents: () => [{ type: 'user/message', data: { source: { kind: 'user', rpcId: 'human-resume-1' } } }] } }, callId: 'resume-call-1' })
  await withTimeout(resumedPrompt)
  await workerRuntime.worker.queue
  await Promise.all([...workerRuntime.worker.background])
  assert.equal((await workerRuntime.ledger.get(task.taskId)).state, 'running')
  const report = once(main.notices, 'report')
  await remote.tools.get('remote_task_finish').execute({ outcome: 'succeeded', summary: 'Step 100000 reached', evidence: ['checkpoint:step-100000', 'PSNR:31.2'] }, exec)
  assert.deepEqual(await gate(exec, async () => ({ kind: 'enter', messages: [] })), { kind: 'reject' })
  const [message] = await withTimeout(report)
  assert.equal(message.sessionId, 'origin-1')
  assert.match(message.content[0].text, /PSNR:31.2/)
  assert.equal(main.prompts.filter((input) => input.sessionId === 'origin-1').length, 2)
  const status = await main.tools.get('remote_task_status').execute({ taskId: task.taskId }, { agent: { id: 'origin-1' } })
  assert.equal(status.state, 'succeeded')
  await assert.rejects(main.tools.get('remote_task_status').execute({ taskId: task.taskId }, { agent: { id: 'other-session' } }), /not found/)
  await assert.rejects(remote.tools.get('remote_task_finish').execute({ outcome: 'succeeded', summary: 'fake', evidence: ['fake'] }, { agent: { id: 'other-session' } }), /assigned remote/)
})
