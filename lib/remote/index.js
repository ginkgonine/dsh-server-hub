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
    register('remote_agent_targets', 'List explicitly connected DSH instances and their allowed workspaces. No model runs. First connect an already logged-in instance using the Hub UI. Do not assume a scanned instance permits execution.', object({}), async () => {
      return { targets: await Promise.all((await connections.list()).map(async connection => {
        const targetId = connection.targetId || connection.id
        try {
          const catalog = await connections.request(targetId, '/catalog')
          return { targetId, endpoint: connection.endpoint, instanceId: connection.instanceId, online: true, enabled: catalog.enabled, workspaces: catalog.workspaces }
        } catch { return { targetId, endpoint: connection.endpoint, online: false, workspaces: [], message: '连接不可用；请打开执行端登录，并在 Hub 中重新连接远控' } }
      })) }
    }, true)
    register('remote_agent', 'Dispatch one independent remote Agent to an explicitly connected instance/workspace. Defaults to background: return after acceptance, then receive one final report automatically. Do not poll or submit replacements after unconfirmed acceptance. Only necessary task context is transmitted, not this conversation history. The worker uses its own model and permissions; it may need human approval in its real worker session. Not a training-process supervisor.',
      object({ targetId: text, workspaceId: text, description: text, prompt: text, run_in_background: { type: 'boolean' }, idempotencyKey: text }, ['targetId', 'workspaceId', 'description', 'prompt']), async (args, exec) => {
        if (exec.agent.session?.header?.origin === 'subagent') throw new Error('第一版远程派出仅支持普通主控会话，不支持子 Agent 再派远程 Agent')
        if ([args.description, args.prompt].some(value => typeof value !== 'string' || !value.trim()) || args.description.length > 500 || args.prompt.length > 100000) throw new Error('Provide a bounded, nonempty task description and prompt')
        const background = args.run_in_background !== false
        const runId = controller.runId(String(exec.agent.id), args.idempotencyKey || String(exec.callId || randomUUID()))
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
    register('remote_agent_status', 'Read the cached state/result of your remote Agent without waking either model. Prefer the automatic final report. waiting_approval requires the user to open the worker session; connection_lost is not task failure or permission to resubmit.',
      object({ runId: text }, ['runId']), (args, exec) => controller.status(args.runId, String(exec.agent.id)), true)
    register('remote_agent_interrupt', 'Request interruption of your remote Agent turn. Does not stop existing training processes, containers or unrelated sessions; an unavailable connection cannot confirm interruption.',
      object({ runId: text }, ['runId']), (args, exec) => controller.interrupt(args.runId, String(exec.agent.id)))
    if (typeof ctx.provide === 'function') ctx.provide('serverHubRemote', { store, worker, controller, connections })
    await controller.initialize()
    // Cordis accepts a disposer (or void), not a runtime object. Returning the
    // object from this async apply would fail activation with "Invalid effect".
    return dispose
  } catch (error) { await dispose(); throw error }
}
