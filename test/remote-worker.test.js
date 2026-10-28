import test from 'node:test'
import assert from 'node:assert/strict'
import { RemoteWorker } from '../src/remote/worker.js'

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

function fixture(t, records = []) {
  const data = new Map(records.map(record => [record.runId, structuredClone(record)]))
  const writes = [], creates = [], prompts = [], cancels = [], archives = [], hooks = new Map(), agents = new Map()
  const archived = deferred()
  const config = { enabled: true, workspaceIds: ['sr'] }
  const store = {
    getConfig: () => structuredClone(config),
    list: () => [...data.values()].map(value => structuredClone(value)),
    get: (_space, key) => data.has(key) ? structuredClone(data.get(key)) : undefined,
    put: async (_space, key, value) => { writes.push(structuredClone(value)); data.set(key, structuredClone(value)) },
  }
  const ctx = {
    on: (name, hook) => { hooks.set(name, hook); return () => hooks.delete(name) },
    sessions: { flush: async () => true },
    workspaceRegistry: {
      get: id => id === 'sr' ? { id, name: 'SR training', path: '/workspace/sr' } : undefined,
      archiveSession: async id => { archives.push(id); archived.resolve() },
    },
    sessionController: {
      create: async input => {
        creates.push(structuredClone(input))
        assert.ok(writes.some(record => record.sessionId === input.sessionId), 'intent must precede session creation')
        const events = [], idle = deferred(), scopedHooks = new Map(), guards = []
        const agent = {
          id: input.sessionId, status: 'idle', events, idle, scopedHooks, guards,
          session: { header: { cwd: input.cwd, agentPreset: 'worker-default' }, ownEvents: () => events },
          ctx: { on: (name, hook) => scopedHooks.set(name, hook), tools: { guard: hook => guards.push(hook) } },
          whenIdle: () => idle.promise,
          cancel: cause => { cancels.push({ id: input.sessionId, cause }); agent.status = 'idle'; idle.resolve() },
        }
        agents.set(input.sessionId, agent)
        return { sessionId: input.sessionId, agentPreset: 'worker-default' }
      },
      // Real DSH returns the Agent, not {agent}.
      resolveAgent: async id => agents.get(id),
      prompt: async input => {
        prompts.push(structuredClone(input))
        const agent = agents.get(input.sessionId)
        agent.status = 'running'
        agent.events.push({ type: 'turn/start', data: { turn: 1 } })
        return { accepted: true }
      },
    },
    permissionPresets: { set: () => assert.fail('Worker must not reset deployment permissions') },
  }
  const worker = new RemoteWorker(ctx, store)
  t.after(() => worker.close())
  const input = { runId: 'run-1', workspaceId: 'sr', prompt: 'Inspect server memory, CPU and Docker without modifying anything', description: 'Read-only server inspection' }
  const finish = (sessionId, reason = { kind: 'completed' }, text = 'Memory 1 GiB, CPU 10%, Docker healthy') => {
    const agent = agents.get(sessionId)
    agent.events.push({ type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text }] } } })
    agent.events.push({ type: 'turn/end', data: { turn: 1, reason } })
    agent.status = 'idle'
    agent.idle.resolve()
  }
  return { worker, input, finish, ctx, store, config, data, writes, creates, prompts, cancels, archives, archived, hooks, agents }
}

function changed(worker, state) {
  return new Promise(resolve => {
    const listener = async runId => {
      const run = await worker.get(runId)
      if (run?.state === state) { worker.events.off('changed', listener); resolve(run) }
    }
    worker.events.on('changed', listener)
  })
}

test('catalog exposes only enabled registered workspace IDs and no credentials or paths', async t => {
  const { worker, config } = fixture(t)
  config.workspaceIds.push('missing')
  assert.deepEqual(await worker.catalog(), { enabled: true, workspaces: [{ workspaceId: 'sr', name: 'SR training' }] })
  config.enabled = false
  assert.deepEqual(await worker.catalog(), { enabled: false, workspaces: [] })
})

test('durable one-shot ordinary session uses worker defaults and returns only final output', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  assert.equal(run.state, 'running')
  assert.equal(f.creates.length, 1)
  assert.deepEqual(f.creates[0], { sessionId: run.sessionId, cwd: '/workspace/sr' })
  assert.deepEqual(Object.keys(f.prompts[0]).sort(), ['content', 'mode', 'requestId', 'sessionId'])
  assert.equal(f.prompts[0].content[0].text, f.input.prompt)
  assert.equal(f.prompts[0].mode, 'queue')
  assert.equal(f.prompts[0].requestId, 'remote-run-1')
  assert.equal(f.worker.live.get(run.runId).agent.session.header.origin, undefined)
  const done = f.worker.done(run.runId)
  f.finish(run.sessionId)
  const result = await done
  assert.equal(result.state, 'completed')
  assert.equal(result.stopReason, 'completed')
  assert.deepEqual(result.output, [{ type: 'text', text: 'Memory 1 GiB, CPU 10%, Docker healthy' }])
  assert.equal('prompt' in result, false)
  assert.equal('digest' in result, false)
  await f.archived.promise
  assert.deepEqual(f.archives, [run.sessionId])
  await f.worker.cancel(run.runId)
  assert.equal(f.cancels.length, 0, 'disposing a completed run must not cancel its finished agent')
})

test('final remote answer is bounded with an explicit truncation notice, leaving worker history intact', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  const text = '指标'.repeat(40000)
  f.finish(run.sessionId, { kind: 'completed' }, text)
  const result = await f.worker.done(run.runId)
  assert.equal(result.output[0].text.length, 32768)
  assert.match(result.output[0].text, /Remote output truncated/)
  const original = f.agents.get(run.sessionId).events.find(event => event.type === 'assistant/message')
  assert.equal(original.data.message.content[0].text, text)
})

test('concurrent duplicate run IDs do not create or prompt twice; mismatch rejects', async t => {
  const f = fixture(t)
  const [a, b] = await Promise.all([f.worker.start(f.input), f.worker.start(f.input)])
  assert.equal(a.sessionId, b.sessionId)
  assert.equal(f.creates.length, 1)
  assert.equal(f.prompts.length, 1)
  await assert.rejects(f.worker.start({ ...f.input, prompt: 'different work' }), { code: 'REMOTE_DUPLICATE' })
  f.finish(a.sessionId)
  await f.worker.done(a.runId)
  assert.equal((await f.worker.start(f.input)).state, 'completed')
  assert.equal(f.prompts.length, 1)
})

test('disabled or unselected workspaces reject before side effects', async t => {
  const f = fixture(t)
  await assert.rejects(f.worker.start({ ...f.input, workspaceId: 'unselected' }), { code: 'REMOTE_WORKSPACE' })
  f.config.enabled = false
  await assert.rejects(f.worker.start(f.input), { code: 'REMOTE_DISABLED' })
  assert.equal(f.creates.length, 0)
  assert.equal(f.writes.length, 0)
})

test('a registered missing-dir workspace is rejected without recreating its directory or a session', async t => {
  const f = fixture(t)
  f.ctx.workspaceRegistry.get = () => ({ id: 'sr', path: '/workspace/sr', status: async () => 'missing-dir' })
  await assert.rejects(f.worker.start(f.input), { code: 'REMOTE_WORKSPACE' })
  assert.equal(f.creates.length, 0)
  assert.equal(f.writes.length, 0)
})

test('legacy status-only fixtures use existing answerers; overlapping waits produce no further prompts', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  const agent = f.agents.get(run.sessionId)
  const first = deferred(), second = deferred()
  const waiting = changed(f.worker, 'waiting_approval')
  const question = f.hooks.get('user-questions/request')({ agent }, () => first.promise)
  await waiting
  const approval = f.hooks.get('approval/request')({ agent }, () => second.promise)
  // Ordinary Promise awaits only; no timed Agent polling while answerers wait.
  await f.worker.tail
  assert.equal((await f.worker.get(run.runId)).state, 'waiting_approval')
  assert.equal(f.prompts.length, 1)
  assert.deepEqual(f.archives, [])
  first.resolve('user clarification')
  assert.equal(await question, 'user clarification')
  assert.equal((await f.worker.get(run.runId)).state, 'waiting_approval')
  const resumed = changed(f.worker, 'running')
  second.resolve('approved')
  assert.equal(await approval, 'approved')
  await resumed
  assert.equal(f.prompts.length, 1)
  f.finish(run.sessionId)
  await f.worker.done(run.runId)
})

test('only the task agent gets a one-turn guard and recursive remote dispatch denial', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  const agent = f.agents.get(run.sessionId)
  const guard = agent.guards[0], step = agent.scopedHooks.get('agent/pre-step')
  assert.equal(guard({ name: 'bash' }), undefined)
  assert.match(guard({ name: 'remote_agent' }), /recursively/)
  assert.deepEqual(step({}, () => ({ kind: 'enter' })), { kind: 'enter' })
  // A scheduling/plugin wake cannot turn this one-shot into a second model turn.
  f.finish(run.sessionId)
  agent.events.push({ type: 'turn/start', data: { turn: 2 } })
  assert.deepEqual(step({}, () => assert.fail('second turn must not call the model')), { kind: 'reject' })
  agent.events.push({ type: 'turn/end', data: { turn: 2, reason: { kind: 'blocked' } } })
  const result = await f.worker.done(run.runId)
  assert.equal(result.stopReason, 'completed', 'a denied later wake must not replace the task result')
  assert.deepEqual(step({}, () => assert.fail('ended task must reject')), { kind: 'reject' })
})

test('terminal turn mapping preserves error, refusal and token cap instead of idle-as-success', async t => {
  for (const [kind, state, stopReason] of [['error', 'error', 'error'], ['blocked', 'error', 'refusal'], ['max-tokens', 'error', 'max-tokens'], ['aborted', 'interrupted', 'aborted']]) {
    await t.test(kind, async t => {
      const f = fixture(t)
      const run = await f.worker.start(f.input)
      f.finish(run.sessionId, { kind, ...(kind === 'error' ? { error: { message: 'Model unavailable', code: 'TRANSPORT' } } : {}) }, 'Partial answer')
      const result = await f.worker.done(run.runId)
      assert.equal(result.state, state)
      assert.equal(result.stopReason, stopReason)
      assert.equal(result.output[0].text, 'Partial answer')
      if (kind === 'error') assert.equal(result.diagnostic, 'Model unavailable')
    })
  }
})

test('idle without turn/end is an error and never a false completed task', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  f.agents.get(run.sessionId).idle.resolve()
  const result = await f.worker.done(run.runId)
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /without a task turn result/)
})

test('cancel and module close stop only owned Agent turns, not external processes', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  const done = f.worker.done(run.runId)
  assert.equal((await f.worker.cancel(run.runId)).state, 'interrupted')
  assert.equal((await done).stopReason, 'aborted')
  assert.deepEqual(f.cancels.map(value => value.id), [run.sessionId])
  await f.worker.cancel(run.runId)
  assert.equal(f.cancels.length, 1)
  const second = await f.worker.start({ ...f.input, runId: 'run-2' })
  await f.worker.close()
  assert.equal((await f.worker.done(second.runId)).state, 'interrupted')
  assert.deepEqual(f.cancels.map(value => value.id), [run.sessionId, second.sessionId])
  await assert.rejects(f.worker.start({ ...f.input, runId: 'run-3' }), { code: 'REMOTE_DISABLED' })
})

test('cancel acknowledges immediately but drain awaits the owned Agent becoming quiescent', async t => {
  const f = fixture(t)
  const run = await f.worker.start(f.input)
  const agent = f.agents.get(run.sessionId)
  agent.cancel = cause => { f.cancels.push({ id: agent.id, cause }) }
  assert.equal((await f.worker.cancel(run.runId)).state, 'interrupted')
  assert.equal(agent.status, 'running')
  let drained = false
  const drain = f.worker.drain(run.runId).then(result => { drained = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(drained, false)
  assert.equal(f.worker.stopping.size, 1)
  assert.equal(f.archives.length, 0)
  await f.worker.close() // Module close must not await a still-stopping model request.
  assert.equal(drained, false)
  agent.status = 'idle'
  agent.idle.resolve()
  assert.equal((await drain).state, 'interrupted')
  assert.equal(f.worker.stopping.size, 0)
  assert.deepEqual(f.archives, [run.sessionId])
  const creates = f.creates.length, prompts = f.prompts.length
  assert.equal((await f.worker.drain(run.runId)).state, 'interrupted')
  assert.equal(f.creates.length, creates)
  assert.equal(f.prompts.length, prompts)
})

test('cancel before acceptance persists a tombstone that prevents late submission, including restart', async t => {
  const f = fixture(t)
  const cancelled = await f.worker.cancel(f.input.runId)
  assert.equal(cancelled.state, 'interrupted')
  assert.equal((await f.worker.drain(f.input.runId)).state, 'interrupted')
  await assert.rejects(f.worker.start(f.input), { code: 'REMOTE_CANCELLED' })
  const restored = fixture(t, [...f.data.values()])
  await assert.rejects(restored.worker.start(f.input), { code: 'REMOTE_CANCELLED' })
  assert.equal(f.creates.length, 0)
  assert.equal(restored.creates.length, 0)
  assert.equal(f.prompts.length, 0)
})

test('cold recovery marks unfinished intents interrupted without recreating or replaying sessions', async t => {
  const original = { runId: 'run-old', sessionId: 'remote-old', workspaceId: 'sr', description: 'old task', digest: 'opaque', state: 'waiting_approval', createdAt: 1, updatedAt: 1 }
  const f = fixture(t, [original])
  await f.worker.initialize()
  const result = await f.worker.done(original.runId)
  assert.equal(result.state, 'interrupted')
  assert.match(result.diagnostic, /will not be replayed/)
  assert.equal(f.creates.length, 0)
  assert.equal(f.prompts.length, 0)
})

test('startup and checkpoint failures settle once and do not retry model admission', async t => {
  for (const phase of ['create', 'checkpoint']) await t.test(phase, async t => {
    const f = fixture(t)
    if (phase === 'create') f.ctx.sessionController.create = async () => { throw new Error('private deployment detail') }
    else f.ctx.sessions.flush = async () => false
    const result = await f.worker.start(f.input)
    assert.equal(result.state, 'error')
    assert.equal(result.stopReason, 'error')
    assert.equal(result.diagnostic.includes('private deployment detail'), false)
    assert.equal((await f.worker.done(result.runId)).state, 'error')
    const duplicate = await f.worker.start(f.input)
    assert.equal(duplicate.state, 'error')
    assert.equal(f.prompts.length, 0)
  })
})

test('failed checkpoint or prompt publishes error immediately while drain waits for cancelled Agent idle', async t => {
  for (const phase of ['checkpoint-before-prompt', 'checkpoint-after-prompt', 'prompt']) await t.test(phase, async t => {
    const f = fixture(t), create = f.ctx.sessionController.create, prompt = f.ctx.sessionController.prompt
    f.ctx.sessionController.create = async input => {
      const created = await create(input), agent = f.agents.get(created.sessionId)
      agent.cancel = cause => { f.cancels.push({ id: agent.id, cause }) }
      return created
    }
    let checkpoints = 0
    f.ctx.sessions.flush = async () => {
      checkpoints++
      return phase === 'prompt' || (phase === 'checkpoint-after-prompt' && checkpoints === 1)
    }
    f.ctx.sessionController.prompt = async input => {
      await prompt(input)
      if (phase === 'prompt') throw new Error('private prompt failure detail')
      return { accepted: true }
    }
    let publishedStop
    f.worker.events.on('changed', runId => {
      if (f.data.get(runId)?.state === 'error') publishedStop = f.worker.stopping.get(runId)
    })
    const result = await f.worker.start(f.input), agent = f.agents.get(result.sessionId)
    assert.equal(result.state, 'error', 'failure admission must not wait for Agent idle')
    assert.equal(result.stopReason, 'error')
    assert.doesNotMatch(result.diagnostic, /private prompt failure detail/)
    assert.equal(f.cancels.length, 1)
    const stopping = f.worker.stopping.get(result.runId)
    assert.ok(stopping)
    assert.equal(publishedStop, stopping, 'drain barrier is registered before publishing the terminal error')
    assert.equal(f.archives.length, 0)
    let drained = false
    const drain = f.worker.drain(result.runId).then(run => { drained = true; return run })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(drained, false)
    assert.equal((await f.worker.done(result.runId)).state, 'error')
    assert.equal((await f.worker.start(f.input)).state, 'error', 'duplicate admission never retries the model')
    // The unrelated durable tombstone proves idle waiting does not hold serial().
    assert.equal((await f.worker.cancel('unrelated-run')).cancelledBeforeStart, true)
    assert.equal(drained, false)
    await f.worker.close()
    assert.equal(drained, false, 'module close does not block on cancelled model quiescence')
    agent.status = 'idle'
    agent.idle.resolve()
    assert.equal((await drain).state, 'error')
    assert.equal(f.worker.stopping.size, 0)
    assert.deepEqual(f.archives, [result.sessionId])
    assert.equal(f.creates.length, 1)
    assert.equal(f.prompts.length, phase === 'checkpoint-before-prompt' ? 0 : 1)
  })
})

test('failed startup with an already-idle cancelled Agent archives only after the error journal', async t => {
  const f = fixture(t)
  f.ctx.sessions.flush = async () => false
  const result = await f.worker.start(f.input)
  assert.equal(result.state, 'error')
  assert.equal((await f.worker.drain(result.runId)).state, 'error')
  assert.deepEqual(f.archives, [result.sessionId])
  assert.equal(f.worker.stopping.size, 0)
})

test('archive presentation failures cannot change a completed task outcome', async t => {
  const f = fixture(t)
  const archiving = deferred()
  f.ctx.workspaceRegistry.archiveSession = async () => { archiving.resolve(); throw new Error('archive unavailable') }
  const run = await f.worker.start(f.input)
  f.finish(run.sessionId)
  assert.equal((await f.worker.done(run.runId)).state, 'completed')
  await archiving.promise
  assert.equal((await f.worker.get(run.runId)).state, 'completed')
})

test('unrelated agent approvals are not observed or changed', async t => {
  const f = fixture(t)
  const answer = await f.hooks.get('approval/request')({ agent: { id: 'human-chat' } }, async () => 'rejected')
  assert.equal(answer, 'rejected')
  assert.equal(f.writes.length, 0)
})

test('late session creation after cancellation is never prompted', async t => {
  const f = fixture(t)
  const created = deferred(), release = deferred()
  const original = f.ctx.sessionController.create
  f.ctx.sessionController.create = async input => { created.resolve(input); await release.promise; return original(input) }
  const start = f.worker.start(f.input)
  const input = await created.promise
  assert.equal((await f.worker.cancel(f.input.runId)).state, 'interrupted')
  release.resolve()
  const result = await start
  assert.equal(result.state, 'interrupted')
  await f.archived.promise
  assert.equal(f.prompts.length, 0)
  assert.deepEqual(f.cancels.map(value => value.id), [input.sessionId])
})

const questionRequest = agent => ({ agent, questions: [{ id: 'mode', question: 'Which mode?', detail: 'Choose safely',
  options: [{ label: 'Safe', description: 'Read only' }, { label: 'Fast' }], multiSelect: false }] })
const approvalRequest = agent => ({ agent, toolName: 'bash', callId: 'remote-call', reason: 'Needs permission',
  displayReason: { en: 'Allow?', 'zh-CN': '允许？' } })
const safeAnswer = () => ({ answers: [{ id: 'mode', selected: ['Safe'] }] })
const interactionChange = (worker, count, state) => new Promise(resolve => {
  const listener = async runId => {
    const run = await worker.get(runId)
    if (run.requests.length === count && (!state || run.state === state)) {
      worker.events.off('changed', listener); resolve(run)
    }
  }
  worker.events.on('changed', listener)
})

test('real ordinary question is claimed, whitelisted and answered through its original deferred, not another prompt', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const cycle = {}; cycle.self = cycle
  const request = { ...questionRequest(agent), signal: new AbortController().signal, extra: cycle }
  request.questions[0].extra = cycle
  const waiting = interactionChange(f.worker, 1, 'waiting_input')
  const answer = f.hooks.get('user-questions/request')(request, () => assert.fail('owned question must not reach remote UI'))
  const snapshot = await waiting, [pending] = snapshot.requests
  assert.match(pending.id, /^request-/)
  assert.deepEqual(pending.questions, questionRequest(agent).questions)
  assert.equal('requiresHuman' in pending, false)
  assert.equal('agent' in pending, false)
  assert.equal('signal' in pending, false)
  assert.ok(snapshot.revision > run.revision)
  const resumed = await f.worker.respond(run.runId, pending.id, safeAnswer())
  assert.equal(resumed.state, 'running')
  assert.deepEqual(resumed.requests, [])
  assert.deepEqual(await answer, safeAnswer())
  assert.equal(f.creates.length, 1)
  assert.equal(f.prompts.length, 1)
  assert.ok(resumed.revision > snapshot.revision)
  assert.equal('responseReceipts' in resumed, false)
})

test('overlapping real questions and approval prioritize approval and accept an ordinary controller decision', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const first = interactionChange(f.worker, 1, 'waiting_input')
  const question = f.hooks.get('user-questions/request')(questionRequest(agent), () => assert.fail('no remote UI'))
  const questionId = (await first).requests[0].id
  const second = interactionChange(f.worker, 2, 'waiting_approval')
  const approval = f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no remote UI'))
  const snapshot = await second
  const pendingApproval = snapshot.requests.find(request => request.kind === 'approval')
  const approvalId = pendingApproval.id
  assert.equal('requiresHuman' in pendingApproval, false)
  assert.equal(snapshot.requests.length, 2)
  const remaining = await f.worker.respond(run.runId, approvalId, { outcome: 'allowed-once' })
  assert.equal(await approval, 'allowed-once')
  assert.equal(remaining.state, 'waiting_input')
  await f.worker.respond(run.runId, questionId, safeAnswer())
  assert.deepEqual(await question, safeAnswer())
  assert.equal((await f.worker.get(run.runId)).state, 'running')
  assert.equal(f.prompts.length, 1)
})

test('approval outcomes are returned directly through the ordinary controller reply channel', async t => {
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) await t.test(outcome, async t => {
    const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
    const waiting = interactionChange(f.worker, 1, 'waiting_approval')
    const answer = f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no remote UI'))
    const [pending] = (await waiting).requests
    assert.equal('requiresHuman' in pending, false)
    const resumed = await f.worker.respond(run.runId, pending.id, { outcome })
    assert.equal(await answer, outcome)
    assert.equal(resumed.state, 'running')
    assert.deepEqual(resumed.requests, [])
    assert.equal(f.prompts.length, 1)
  })
})

test('intent-bearing questions retain native detail and intent and accept ordinary controller replies', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const request = questionRequest(agent)
  request.questions[0].intent = { kind: 'plan-review', approve: 'Safe', callId: 'plan-call' }
  const waiting = interactionChange(f.worker, 1)
  const answer = f.hooks.get('user-questions/request')(request, () => assert.fail('no next'))
  const [pending] = (await waiting).requests
  assert.equal('requiresHuman' in pending, false)
  assert.deepEqual(pending.questions[0].intent, request.questions[0].intent)
  await f.worker.respond(run.runId, pending.id, safeAnswer())
  assert.deepEqual(await answer, safeAnswer())
})

test('response receipts durably deduplicate identical concurrent answers and reject conflicts, including after restart', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const waiting = interactionChange(f.worker, 1)
  const answer = f.hooks.get('user-questions/request')(questionRequest(agent), () => assert.fail('no next'))
  const [pending] = (await waiting).requests
  const [first, duplicate] = await Promise.all([
    f.worker.respond(run.runId, pending.id, safeAnswer()), f.worker.respond(run.runId, pending.id, safeAnswer()),
  ])
  assert.equal(first.revision, duplicate.revision)
  assert.deepEqual(await answer, safeAnswer())
  assert.equal(typeof f.data.get(run.runId).responseReceipts[pending.id].digest, 'string')
  await assert.rejects(f.worker.respond(run.runId, pending.id, { answers: [{ id: 'mode', selected: ['Fast'] }] }), { code: 'REMOTE_CONFLICT' })
  const restored = fixture(t, [...f.data.values()])
  const replay = await restored.worker.respond(run.runId, pending.id, safeAnswer())
  assert.equal(replay.state, 'interrupted')
  assert.deepEqual(replay.requests, [])
  assert.equal(restored.prompts.length, 0)
})

test('request signal abort immediately withdraws questions and approvals and rejects stale authorization', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const questionSignal = new AbortController(), approvalSignal = new AbortController()
  const waiting = interactionChange(f.worker, 2, 'waiting_approval')
  const question = f.hooks.get('user-questions/request')({ ...questionRequest(agent), signal: questionSignal.signal }, () => assert.fail('no next'))
  const rejected = assert.rejects(question, { name: 'UserQuestionError', code: 'ASK_ABORTED' })
  const approval = f.hooks.get('approval/request')({ ...approvalRequest(agent), signal: approvalSignal.signal }, () => assert.fail('no next'))
  const snapshot = await waiting
  questionSignal.abort()
  approvalSignal.abort()
  await rejected
  assert.equal(await approval, 'cancelled')
  await f.worker.tail
  assert.deepEqual((await f.worker.get(run.runId)).requests, [])
  for (const request of snapshot.requests) await assert.rejects(f.worker.respond(run.runId, request.id,
    request.kind === 'approval' ? { outcome: 'allowed-once' } : safeAnswer()), { code: 'REMOTE_REQUEST_EXPIRED' })
  assert.equal(f.prompts.length, 1)
})

test('pre-aborted and timeout signals never leave a question hung', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(f.hooks.get('user-questions/request')({ ...questionRequest(agent), signal: aborted.signal }, () => assert.fail('no next')),
    { name: 'UserQuestionError', code: 'ASK_ABORTED' })
  assert.equal(await f.hooks.get('approval/request')({ ...approvalRequest(agent), signal: aborted.signal }, () => assert.fail('no next')), 'cancelled')
  const signal = AbortSignal.timeout(10)
  const keepAlive = setTimeout(() => {}, 50)
  try {
    await assert.rejects(f.hooks.get('user-questions/request')({ ...questionRequest(agent), signal }, () => assert.fail('no next')),
      { name: 'UserQuestionError', code: 'ASK_ABORTED' })
    await f.worker.tail
    assert.deepEqual((await f.worker.get(run.runId)).requests, [])
  } finally { clearTimeout(keepAlive) }
})

test('worker cancellation and close settle every owned deferred without relying on an answerer or signal', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const waiting = interactionChange(f.worker, 2)
  const question = f.hooks.get('user-questions/request')(questionRequest(agent), () => assert.fail('no next'))
  const rejected = assert.rejects(question, { code: 'ASK_ABORTED' })
  const approval = f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no next'))
  const snapshot = await waiting
  await f.worker.cancel(run.runId)
  await rejected
  assert.equal(await approval, 'cancelled')
  assert.deepEqual((await f.worker.get(run.runId)).requests, [])
  await assert.rejects(f.worker.respond(run.runId, snapshot.requests[1].id, { outcome: 'allowed-once' }), { code: 'REMOTE_REQUEST_EXPIRED' })
  const second = await f.worker.start({ ...f.input, runId: 'run-2' })
  const secondWaiting = interactionChange(f.worker, 1)
  const another = f.hooks.get('approval/request')(approvalRequest(f.agents.get(second.sessionId)), () => assert.fail('no next'))
  await secondWaiting
  await f.worker.close()
  assert.equal(await another, 'cancelled')
  assert.deepEqual((await f.worker.get(second.runId)).requests, [])
})

test('eight-pending capacity and payload limits fail closed, never delegate malformed real approvals', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const waiting = interactionChange(f.worker, 8)
  const pending = Array.from({ length: 8 }, () => f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no next')))
  await waiting
  assert.equal(await f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no next')), 'unavailable')
  await assert.rejects(f.hooks.get('user-questions/request')(questionRequest(agent), () => assert.fail('no next')), { code: 'REMOTE_INPUT' })
  assert.equal(await f.hooks.get('approval/request')({ agent, toolName: '', secret: true }, () => assert.fail('malformed must not delegate')), 'unavailable')
  await assert.rejects(f.hooks.get('user-questions/request')({ agent, questions: [{ id: 'mode', question: 'a'.repeat(40000) }] }, () => assert.fail('no next')), { code: 'REMOTE_INPUT' })
  await f.worker.cancel(run.runId)
  assert.deepEqual(await Promise.all(pending), Array(8).fill('cancelled'))
})

test('restart clears pending questions/approval without recreating, prompting or accepting a stale decision', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId)
  const waiting = interactionChange(f.worker, 1)
  const original = f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no next'))
  const [pending] = (await waiting).requests
  const restored = fixture(t, [...f.data.values()])
  await restored.worker.initialize()
  const recovered = await restored.worker.get(run.runId)
  assert.equal(recovered.state, 'interrupted')
  assert.deepEqual(recovered.requests, [])
  assert.equal(restored.creates.length, 0)
  assert.equal(restored.prompts.length, 0)
  await assert.rejects(restored.worker.respond(run.runId, pending.id, { outcome: 'allowed-once' }), { code: 'REMOTE_REQUEST_EXPIRED' })
  await f.worker.close()
  assert.equal(await original, 'cancelled')
})

test('same-id but non-owned Agent identity delegates real interactions unchanged', async t => {
  const f = fixture(t), run = await f.worker.start(f.input)
  const other = { id: run.sessionId }
  assert.equal(await f.hooks.get('approval/request')(approvalRequest(other), async () => 'rejected'), 'rejected')
  assert.deepEqual(await f.hooks.get('user-questions/request')(questionRequest(other), async () => safeAnswer()), safeAnswer())
  assert.deepEqual((await f.worker.get(run.runId)).requests, [])
})

test('interaction publication failure and response checkpoint failure never strand or falsely resume a deferred', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId), put = f.store.put
  f.store.put = async (_space, _key, value) => { if (value.requests?.length) throw new Error('journal unavailable'); return put(_space, _key, value) }
  assert.equal(await f.hooks.get('approval/request')(approvalRequest(agent), () => assert.fail('no next')), 'unavailable')
  assert.equal(f.worker.live.get(run.runId).interactions.size, 0)
  assert.deepEqual((await f.worker.get(run.runId)).requests, [])
  f.store.put = put
  const waiting = interactionChange(f.worker, 1)
  const answer = f.hooks.get('user-questions/request')(questionRequest(agent), () => assert.fail('no next'))
  const [pending] = (await waiting).requests
  f.store.put = async (_space, _key, value) => { if (value.responseReceipts) throw new Error('checkpoint unavailable'); return put(_space, _key, value) }
  await assert.rejects(f.worker.respond(run.runId, pending.id, safeAnswer()), /checkpoint unavailable/)
  assert.equal((await f.worker.get(run.runId)).requests.length, 1)
  assert.equal(f.worker.live.get(run.runId).interactions.size, 1)
  f.store.put = put
  await f.worker.respond(run.runId, pending.id, safeAnswer())
  assert.deepEqual(await answer, safeAnswer())
  assert.equal(f.prompts.length, 1)
})

test('abort during response persistence cannot resume an approval even after its digest was written', async t => {
  const f = fixture(t), run = await f.worker.start(f.input), agent = f.agents.get(run.sessionId), signal = new AbortController()
  const waiting = interactionChange(f.worker, 1)
  const original = f.hooks.get('approval/request')({ ...approvalRequest(agent), signal: signal.signal }, () => assert.fail('no next'))
  const [pending] = (await waiting).requests
  const entered = deferred(), release = deferred(), put = f.store.put
  f.store.put = async (space, key, value) => {
    if (value.responseReceipts?.[pending.id] && !value.responseReceipts[pending.id].expired) { entered.resolve(); await release.promise }
    return put(space, key, value)
  }
  const reply = f.worker.respond(run.runId, pending.id, { outcome: 'allowed-once' })
  const rejected = assert.rejects(reply, { code: 'REMOTE_REQUEST_EXPIRED' })
  await entered.promise
  signal.abort()
  assert.equal(await original, 'cancelled')
  release.resolve()
  await rejected
  await f.worker.tail
  assert.equal(f.data.get(run.runId).responseReceipts[pending.id].expired, true)
  await assert.rejects(f.worker.respond(run.runId, pending.id, { outcome: 'allowed-once' }), { code: 'REMOTE_REQUEST_EXPIRED' })
  assert.deepEqual((await f.worker.get(run.runId)).requests, [])
})
