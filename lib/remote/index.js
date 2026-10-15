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
  'workspaceRegistry', 'sessionController', 'sessions', 'tools', 'subagents', 'agents', 'userQuestions', 'approval']
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const text = { type: 'string' }
const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }

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
    register('remote_agent', 'Dispatch a task to a remote Agent on a target instance and workspace. The remote Agent does not share this conversation history, so include all necessary context in prompt. Runs in the background by default with an automatic completion report, or waits for the result when configured. Avoid repeated status polling and duplicate submissions.',
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
        let run
        try {
          run = await ctx.subagents.start('server-hub-remote', { parent: exec.agent, signal: background ? ac.signal : exec.signal,
            label: args.description, prompt: [{ type: 'text', text: JSON.stringify({ ...args, runId, background }) }] })
        } finally { exec.signal?.removeEventListener('abort', abort) }
        if (!background) {
          try { return { runId, ...(await run.result) } } finally { await run.dispose() }
        }
        run.result.then(async () => {
          try { await controller.report(await store.get('masters', runId)) } finally { await run.dispose() }
        }).catch(() => {})
        const current = await controller.status(runId, String(exec.agent.id))
        return { runId, accepted: true, state: current.state, message: '已派出远程子 Agent；完成后自动回报，不必等待或反复查询。' }
      })
    register('remote_agent_status', 'Check the cached status, result, and pending requests of a remote Agent task. Call only when needed, as completed tasks notify automatically. State notes: waiting_input can be answered via remote_agent_respond; waiting_approval requires user action; connection_lost means the connection was lost (do not resubmit).',
      object({ runId: text }, ['runId']), (args, exec) => controller.status(args.runId, String(exec.agent.id)), true)
    const answer = object({ id: text, selected: { type: 'array', items: text }, custom: text }, ['id', 'selected'])
    register('remote_agent_respond', 'Reply to a pending question (waiting_input) from a remote Agent to resume its execution. Match runId, requestId, and question IDs from the pending request. Answer only based on clear user intent, or ask the user first if unsure. Cannot be used for permission approvals or plan reviews.',
      object({ runId: text, requestId: text, answers: { type: 'array', items: answer } }, ['runId', 'requestId', 'answers']),
      (args, exec) => controller.respond(args.runId, args.requestId, { answers: args.answers }, String(exec.agent.id), { signal: exec.signal }))
    register('remote_agent_interrupt', 'Request interruption of a remote Agent\'s current turn by runId. Does not stop external processes or containers.',
      object({ runId: text }, ['runId']), (args, exec) => controller.interrupt(args.runId, String(exec.agent.id)))
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
      assembly.variables.server_hub_remote_instances = `Hub 已连接远程实例（${targets.length} 个）：\n${names}\n\n用户要求在这些实例上执行任务时，使用 remote_agent_targets 查询目标和工作区，再通过 remote_agent 派发任务。`
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
