import { validateTaskConfig } from './config.js'
import { FileTaskLedger } from './ledger.js'
import { TaskEventHub, createTaskRoute, TASK_ROUTE } from './transport.js'
import { TaskController } from './controller.js'
import { RemoteTaskWorker } from './worker.js'
import { DshTaskSessions, TASK_SECURITY_NOTICE } from './dsh-adapter.js'
import { TaskExecutions } from './execution-bridge.js'
import { PhaseDeadlines } from './deadlines.js'
import { taskForAgent } from './ancestry.js'

export const name = 'dsh-server-hub-tasks'
export const inject = {
  required: ['tools', 'sessionController', 'sessions'],
  optional: ['webServer', 'sandbox', 'sandboxPolicy', 'fs', 'shell', 'permissionPresets', 'workspaceRegistry'],
}

const output = { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required })
const text = { type: 'string' }

/** Disabled-by-default task plugin, separate from the existing UI/status bridge. */
export async function apply(ctx, rawConfig = {}) {
  const config = validateTaskConfig(rawConfig)
  if (!config.enabled) return
  const ledger = await new FileTaskLedger(config.stateDirectory).init()
  const events = new TaskEventHub()
  const sessions = new DshTaskSessions(ctx, config, ledger)
  let worker
  let controller
  let executions
  let deadlines
  let closed = false
  const dispose = async () => {
    if (closed) return
    closed = true
    sessions.close()
    deadlines?.close()
    events.close()
    executions?.close()
    await Promise.allSettled([worker?.close(), controller?.close()])
    await ledger.close()
  }
  ctx.effect(() => dispose, 'dsh-server-hub: durable task runtime')
  try {
    if (config.projects.length) {
      if (!ctx.webServer) throw new Error('Remote tasks require webServer')
      await sessions.validateProjects()
      executions = new TaskExecutions({ ctx, config, ledger, events })
      await executions.initialize()
      worker = new RemoteTaskWorker({ config, ledger, events, sessions, executions })
      deadlines = new PhaseDeadlines({ worker, ledger, events })
      ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: TASK_ROUTE,
        handler: createTaskRoute({ nodeId: config.nodeId, token: config.token, projects: config.projects.map((project) => project.id), ledger, events,
          accept: (input) => worker.accept(input), cancel: (taskId, submission) => worker.cancel(taskId, submission), resume: (taskId, input) => worker.resume(taskId, input) }) }), 'dsh-server-hub: authenticated task routes')
      ctx.on('agent/pre-step', async ({ agent }, next) => {
        const task = await taskForAgent(ctx, worker, agent)
        if (!task) return next()
        // V1 intentionally blocks delegated task Agents. A child cannot bypass
        // the parent's pause/budget or expand the task into recursive dispatch.
        if (String(agent.id) !== task.remoteSessionId) return { kind: 'reject' }
        if (task.state === 'running') {
          const policy = ctx.sandboxPolicy.resolve({ session: agent.session || ctx.sessions.get(String(agent.id)) })
          if (policy.mode !== 'workspace-write' || policy.workspaceRoot !== worker.project(task).root) {
            await worker.finish(task.taskId, { outcome: 'needs_input', summary: 'Task workspace permission boundary changed; operator inspection required', evidence: [] })
            return { kind: 'reject' }
          }
        }
        // Reject step, not kill external process. The Agent goes idle without a model call.
        return await worker.beforeStep(String(agent.id)) ? next() : { kind: 'reject' }
      }, { global: true, prepend: true })
      for (const event of ['approval/request', 'user-questions/request']) {
        ctx.on(event, async (request, next) => {
          if (!request.agent) return next()
          const sessionId = String(request.agent.id)
          const waiting = await worker.approvalWaiting(sessionId, true)
          try { return await next() } finally {
            if (waiting) await worker.approvalWaiting(sessionId, false)
          }
        }, { global: true, prepend: true })
      }
    }
    if (config.nodes.length) {
      controller = new TaskController({ config, ledger, events, sessions })
    }

    const register = (toolName, description, parameters, execute, safe = false) => {
      ctx.effect(() => ctx.tools.register({ name: toolName, description, parameters, output,
        isConcurrencySafe: () => safe,
        async execute(args, exec) {
          if (closed || !exec.agent) throw new Error('A live owning DSH session is required')
          if (['remote_task_submit', 'remote_task_resume'].includes(toolName)) {
            const input = [...(exec.agent.session?.ownEvents?.() || [])].reverse().find((event) => event.type === 'user/message')
            if (input?.data?.source?.kind !== 'user' || String(input.data.source.rpcId || '').startsWith('report-')) {
              throw new Error('Dispatch/resume requires owner input; automatic remote-report turns cannot create replacement tasks or reset budgets')
            }
          }
          if (worker && ['remote_task_submit', 'remote_task_resume', 'remote_task_cancel'].includes(toolName) && await taskForAgent(ctx, worker, exec.agent)) {
            throw new Error('Assigned task Agents/descendants cannot recursively control remote tasks')
          }
          return execute(args, exec)
        },
      }), `dsh-server-hub: ${toolName}`)
    }
    if (controller) {
      register('remote_task_targets', 'List explicitly paired server/project IDs and connection state. Does not start remote Agents or expose credentials/paths.',
        object({}, []), () => controller.targets(), true)
      register('remote_task_submit', 'Submit one task to an explicitly paired server/project. Returns promptly; do not wait or repeatedly check. No cwd, permissions or arbitrary server URLs. Results return to this owning session.',
        object({ nodeId: text, projectId: text, instruction: text, idempotencyKey: text }, ['nodeId', 'projectId', 'instruction']),
        async (args, exec) => {
          if (worker && await worker.taskForSession(String(exec.agent.id))) throw new Error('Remote worker tasks may not recursively dispatch tasks')
          return controller.submit(args, { sessionId: String(exec.agent.id), callId: String(exec.callId || '') })
        })
      register('remote_task_resume', 'Resume your paused/reconciling task with explicit clarification. Never automatically retry this tool to defeat a budget or approval. Live DSH approval must be answered through its existing interface; this tool cannot approve it.',
        object({ taskId: text, instruction: text, idempotencyKey: text }, ['taskId', 'instruction']),
        (args, exec) => {
          const entries = exec.agent.session?.ownEvents?.()
          const currentInput = entries && [...entries].reverse().find((event) => event.type === 'user/message')
          const source = currentInput?.data?.source
          if (source?.kind !== 'user' || String(source.rpcId || '').startsWith('report-')) {
            throw new Error('Task resume requires new owner input, not an automatic remote-report turn')
          }
          return controller.resume(args, { sessionId: String(exec.agent.id), callId: String(exec.callId || '') })
        })
      for (const [toolName, method] of [['remote_task_status', 'status'], ['remote_task_result', 'status'], ['remote_task_cancel', 'cancel']]) {
        register(toolName, method === 'cancel' ? 'Cancel your task/observation. Does not kill existing or independently managed training processes.' : 'Read your cached remote task state/result without starting an Agent. Prefer waiting for completion messages instead of polling.',
          object({ taskId: text }, ['taskId']), (args, exec) => controller[method](args.taskId, String(exec.agent.id)), method === 'status')
      }
    }
    if (worker) {
      const owned = async (exec) => {
        const task = await worker.taskForSession(String(exec.agent.id))
        if (!task) throw new Error('This tool is available only to an assigned remote task session')
        return task
      }
      register('remote_task_finish', 'Commit a structured task result. Agent idle does not imply success. Success requires evidence; needs_input pauses without automatic retries.',
        object({ outcome: { type: 'string', enum: ['succeeded', 'failed', 'needs_input'] }, summary: text, evidence: { type: 'array', items: text } }, ['outcome', 'summary', 'evidence']),
        async (args, exec) => {
          const result = await worker.finish((await owned(exec)).taskId, args)
          exec.concludeTurn?.()
          return result
        })
      register('remote_task_park', 'Pause your assigned task without another model step. For external training use a registered execution observer; never busy-wait, sleep-loop, or schedule repeated model checks.',
        object({ executionId: text, reason: text }, ['executionId', 'reason']), async (args, exec) => {
          const task = await owned(exec)
          if (task.notification?.execution?.executionId !== args.executionId) throw new Error('Register your own execution/observer before parking')
          const result = await worker.park(task.taskId, args)
          exec.concludeTurn?.()
          return result
        })
      register('remote_execution_start', 'Start one restart-persistent command under this task\'s registered project sandbox. Requires a deployment-isolated supervisor. Immediately park with the returned executionId; do not poll. Never use arbitrary tmux/nohup to bypass confinement.',
        object({ command: text, idempotencyKey: text }, ['command']), async (args, exec) => executions.start(await owned(exec), args, exec))
      register('remote_execution_observe', 'Register observation of an existing Linux process in your configured project, without adopting, killing or restarting it. Returns executionId for remote_task_park. Exit does not prove success.',
        object({ pid: { type: 'integer' } }, ['pid']), async (args, exec) => executions.registerExisting(await owned(exec), args))
      register('remote_execution_status', 'Read your registered execution state/actual exit result without model activation. Prefer completion messages to repeated checks.',
        object({}, []), async (_args, exec) => executions.status(await owned(exec)), true)
      register('remote_execution_stop', 'Intentionally stop only this task\'s managed training execution. A separate explicit operation; never stops pre-existing tmux/nohup training or uses arbitrary PIDs.',
        object({}, []), async (_args, exec) => executions.stop(await owned(exec)))
    }
    // Optional trusted service, not a model-facing unrestricted execution handle.
    if (typeof ctx.provide === 'function') ctx.provide('serverHubTasks', { ledger, worker, controller, securityNotice: TASK_SECURITY_NOTICE })
    // Install tools and all admission gates BEFORE recovered tasks can wake.
    if (worker) await worker.initialize()
    if (controller) await controller.initialize()
    return { dispose, ledger, worker, controller }
  } catch (error) {
    await dispose()
    throw error
  }
}
