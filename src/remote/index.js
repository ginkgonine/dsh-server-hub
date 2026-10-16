import { randomUUID } from 'node:crypto'
import { RemoteStore } from './store.js'
import { RemoteConnections } from './auth.js'
import { RemoteWorker } from './worker.js'
import { RemoteController } from './controller.js'
import { createRemoteRoute, REMOTE_ROUTE } from './routes.js'

export const name = 'dsh-server-hub-remote'
// Cordis 4 injection is a service-name array/map; { required: [...] } would
// request a literal service named "required" and leave the routes unregistered.
export const inject = ['webServer', 'connection', 'storage', 'storage.backend.json', 'credentials',
  'workspaceRegistry', 'sessionController', 'sessions', 'tools', 'subagents']
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string' }
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const backgroundGuidance = '审批、提问和最终结果都会自动送到当前聊天，由主控在这里询问用户并回传决定，无需打开 Hub 或远程实例。用户询问进展或需要排查异常时可以按需查询状态；不要为等待远程任务而 sleep 或反复查询。没有其他独立工作时，请直接结束本轮回复，等待自动通知唤醒。'
// Model tools observe task state, but must not deliver queued interactions/results a second time.
const taskOverview = run => Object.fromEntries(Object.entries(run).filter(([key]) => !['requests', 'output'].includes(key)))

/** No hand-written pairing/config: every instance has UI settings, off until opted in. */
export async function apply(ctx) {
  const store = await RemoteStore.open(ctx)
  const connections = new RemoteConnections(ctx)
  const worker = new RemoteWorker(ctx, store)
  const controller = new RemoteController(ctx, store, connections)
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true
    await Promise.allSettled([worker.close(), controller.close()])
    await store.close()
  }
  ctx.effect(() => dispose, 'server-hub: remote agents')
  try {
    await worker.initialize()
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: REMOTE_ROUTE,
      handler: createRemoteRoute({ ctx, store, connections, worker, controller }) }), 'server-hub: native-auth remote routes')
    ctx.effect(() => ctx.subagents.registerProvider(controller.provider()), 'server-hub: remote subagent backend')
    const register = (name, description, parameters, execute, safe = false) => {
      ctx.effect(() => ctx.tools.register({ name, description, parameters, output,
        isConcurrencySafe: () => safe,
        execute: async (args, exec) => {
          if (closed || !exec.agent) throw new Error('A live parent session is required')
          return execute(args, exec)
        },
      }), `server-hub: ${name}`)
    }
    register('remote_agent_targets', 'List connected DSH instances and their available workspaces. Match targets by name or endpoint, then use targetId and workspaceId to dispatch tasks. Ask the user to clarify if multiple instances share a name.', object({}), async () => {
      return { targets: await Promise.all((await connections.list()).map(async connection => {
        const targetId = connection.targetId || connection.id
        try {
          const catalog = await connections.request(targetId, '/catalog')
          return { targetId, name: connection.name || '', endpoint: connection.endpoint, instanceId: connection.instanceId, online: true, enabled: catalog.enabled, workspaces: catalog.workspaces }
        } catch { return { targetId, name: connection.name || '', endpoint: connection.endpoint, online: false, workspaces: [], message: '连接不可用；请打开远程实例登录，并在 Hub 中重新连接远控' } }
      })) }
    }, true)
    register('remote_agent', 'Dispatch a task to a remote Agent on a target instance and workspace. The remote Agent does not share this conversation history, so include all necessary context in prompt. Runs in the background by default, or waits for the result when configured. Background questions, approvals and final results automatically arrive in this chat; handle approvals here with the user. If no independent work remains, end your turn and let a notification wake you. Do not sleep or poll to wait for remote work or capture approvals. Query status on demand when the user asks about progress or to diagnose a problem. Avoid duplicate submissions.',
      object({ targetId: text, workspaceId: text, description: text, prompt: text, run_in_background: { type: 'boolean' }, idempotencyKey: text }, ['targetId', 'workspaceId', 'description', 'prompt']), async (args, exec) => {
        if (exec.agent.session?.header?.origin === 'subagent') throw new Error('第一版远程派出仅支持普通主控会话，不支持子 Agent 再派远程 Agent')
        if ([args.description, args.prompt].some(value => typeof value !== 'string' || !value.trim()) || args.description.length > 500 || args.prompt.length > 100000) throw new Error('Provide a bounded, nonempty task description and prompt')
        const runId = controller.runId(String(exec.agent.id), args.idempotencyKey || String(exec.callId || randomUUID()))
        // This user setting is authoritative for new tasks. A retry retains the
        // task's original delivery mode, so a setting change cannot double-report.
        const existing = await store.get('masters', runId)
        const background = existing ? existing.background !== false : !store.getConfig().waitForResult && args.run_in_background !== false
        const ac = new AbortController()
        const abort = () => ac.abort(exec.signal.reason)
        if (exec.signal?.aborted) throw new Error('Task submission cancelled')
        exec.signal?.addEventListener('abort', abort, { once: true })
        let run, started = false
        try {
          run = await ctx.subagents.start('server-hub-remote', { parent: exec.agent, signal: ac.signal,
            label: args.description, prompt: [{ type: 'text', text: JSON.stringify({ ...args, runId, background }) }] })
          started = true
        } finally { if (background || !started) exec.signal?.removeEventListener('abort', abort) }
        const reportInBackground = () => run.result.then(async () => {
          try { await controller.report(await store.get('masters', runId)) } finally { await run.dispose() }
        }).catch(() => {})
        if (!background) {
          const waiting = new AbortController()
          let yielded = false
          try {
            const next = await Promise.race([
              run.result.then(result => ({ result })),
              controller.waitForInteraction(runId, String(exec.agent.id), AbortSignal.any([exec.signal, waiting.signal]))
                .then(async pending => pending ? { pending } : { result: await run.result }),
            ])
            if (next.result) return { runId, ...next.result }
            const pending = await controller.yieldForInput(runId, String(exec.agent.id))
            if (['completed', 'error', 'interrupted'].includes(pending.state)) return { runId, ...(await run.result) }
            yielded = true
            reportInBackground()
            return { ...pending, message: `远程任务需要回复，先在当前聊天向用户说明并询问决定，再用 remote_agent_respond 回传。原任务保留。${backgroundGuidance}` }
          } finally {
            exec.signal?.removeEventListener('abort', abort)
            waiting.abort()
            if (!yielded) await run.dispose()
          }
        }
        reportInBackground()
        const current = await controller.status(runId, String(exec.agent.id))
        return { runId, accepted: true, state: current.state, message: `已派出远程子 Agent。${backgroundGuidance}` }
      })
    register('remote_agent_status', 'Check a remote task\'s cached state and timing on demand when the user asks about progress or to diagnose a problem. This is an overview, not a live progress probe; it does not return approval/question payloads or final output. Those arrive automatically in the current chat. Do not poll or sleep to wait for them. If no independent work remains, end your turn. connection_lost means the connection was lost; do not resubmit.',
      object({ runId: text }, ['runId']), async (args, exec) => ({
        ...taskOverview(await controller.status(args.runId, String(exec.agent.id))), message: backgroundGuidance,
      }), true)
    const answer = object({ id: text, selected: { type: 'array', items: text }, custom: text }, ['id', 'selected'])
    register('remote_agent_respond', 'Reply to your remote task\'s pending request. For questions or plan reviews pass answers; for permission requests pass outcome: allowed-once, rejected, or cancelled. Explain the remote operation and ask the user in the current chat (plain text or ask_user_question) when their decision is needed, then relay that decision. Match the existing runId/requestId from the notification or foreground dispatch response; this continues the original task. Success returns only an acknowledgement. Further questions, approvals and final results arrive automatically in this chat. If no independent work remains, end your turn; do not sleep or poll.',
      object({ runId: text, requestId: text, answers: { type: 'array', items: answer },
        outcome: { type: 'string', enum: ['allowed-once', 'rejected', 'cancelled'] } }, ['runId', 'requestId']),
      async (args, exec) => {
        if (Object.hasOwn(args, 'answers') === Object.hasOwn(args, 'outcome')) throw new Error('Provide exactly one of answers or outcome')
        await controller.respond(args.runId, args.requestId, Object.hasOwn(args, 'outcome') ? { outcome: args.outcome } : { answers: args.answers },
          String(exec.agent.id), { signal: exec.signal })
        return { runId: args.runId, requestId: args.requestId, accepted: true, message: `回复已回传。${backgroundGuidance}` }
      })
    register('remote_agent_interrupt', 'Request interruption of a remote Agent\'s current turn by runId. Does not stop external processes or containers.',
      object({ runId: text }, ['runId']), async (args, exec) => ({
        ...taskOverview(await controller.interrupt(args.runId, String(exec.agent.id))), message: backgroundGuidance,
      }))
    // Read local connections on each assembly: no remote probes, cached names, or extra model turns.
    ctx.effect(() => ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const assembly = await next()
      if (closed || context.agent?.session?.header?.origin === 'subagent' ||
          (context.agent && [...worker.live.values()].some(entry => entry.agent === context.agent)) ||
          !['remote_agent_targets', 'remote_agent'].every(name => assembly.tools.some(tool => tool.name === name))) return assembly
      let targets
      try { targets = await connections.list() } catch { return assembly }
      if (closed || !targets.length) return assembly
      const names = targets.map(target => `- ${target.name || target.endpoint}`).join('\n')
      // Interpolate once through a variable so names containing {{...}} stay literal data.
      assembly.variables.server_hub_remote_instances = `Hub 已连接远程实例（${targets.length} 个）：\n${names}\n\n用户要求在这些实例上执行任务时，使用 remote_agent_targets 查询目标和工作区，再通过 remote_agent 派发任务。\n\n后台远程任务：${backgroundGuidance}`
      assembly.contexts.push({ name: 'server-hub:remote-instances', text: '{{server_hub_remote_instances}}' })
      return assembly
    }), 'server-hub: connected instance context')
    if (typeof ctx.provide === 'function') ctx.provide('serverHubRemote', { store, worker, controller, connections })
    await controller.initialize()
    // Cordis accepts a disposer (or void), not a runtime object. Returning the
    // object from this async apply would fail activation with "Invalid effect".
    return dispose
  } catch (error) { await dispose(); throw error }
}
