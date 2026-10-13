import { createHash } from 'node:crypto'
import { watch } from 'node:fs'
import { readFile, realpath, stat, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { assertObject, validateText, validateId, validateInteger } from './protocol.js'
import { issueLaunchTicket, readSupervisorSecret, launchSupervisor, inspectExecution, inspectExistingProcess, getProcessIdentity, commandDigest, ensureStateDirectory, stopExecution } from './executor.js'

const hash = (value) => createHash('sha256').update(value).digest('hex')
const within = (root, candidate) => {
  const part = path.relative(root, candidate)
  return part === '' || (part !== '..' && !part.startsWith(`..${path.sep}`) && !path.isAbsolute(part))
}

/** Bridge binds each execution/observer to one task; model never chooses roots or supervisor state. */
export class TaskExecutions {
  constructor({ ctx, config, ledger, events, pollMs = 60000 }) {
    this.ctx = ctx
    this.config = config
    this.ledger = ledger
    this.events = events
    this.pollMs = pollMs
    this.active = new Map()
    this.stops = new Set()
    this.closed = false
  }

  project(task) {
    const project = this.config.projects.find((value) => value.id === task.projectId)
    if (!project || task.nodeId !== this.config.nodeId) throw new Error('Execution project not registered')
    return project
  }

  async initialize() {
    if (!this.config.supervisor) return
    if (process.platform !== 'linux') throw new Error('Persistent execution currently requires a Linux worker')
    const supervisor = this.config.supervisor
    for (const project of this.config.projects) {
      await ensureStateDirectory(supervisor.stateDirectory, project.root)
      if (within(project.root, await realpath(supervisor.secretFile))) throw new Error('Supervisor key must be outside every writable project')
    }
    await readSupervisorSecret(supervisor.secretFile)
    // The configuration attestation is a DEPLOYMENT prerequisite, not a proof that
    // mode bits protect same-UID processes. Do not enable on a shared readable UID.
  }

  async start(task, input, exec) {
    assertObject(input, ['command', 'idempotencyKey'], ['command'], 'execution start')
    validateText(input.command, 'command', 32768)
    if (input.idempotencyKey !== undefined) validateId(input.idempotencyKey, 'idempotencyKey')
    const supervisor = this.config.supervisor
    if (!supervisor) throw new Error('Persistent supervisor is not explicitly configured')
    const project = this.project(task)
    if (!input.idempotencyKey && !exec.callId) throw new Error('Stable execution call identity required')
    const executionId = `exec-${hash(`${task.taskId}:${input.idempotencyKey || exec.callId}`).slice(0, 40)}`
    const businessDigest = hash(input.command)
    if (this.active.has(executionId)) return this.active.get(executionId)
    const work = this.startOnce(task, project, input, executionId, businessDigest, exec).finally(() => this.active.delete(executionId))
    this.active.set(executionId, work)
    return work
  }

  async startOnce(task, project, input, executionId, businessDigest, exec) {
    const supervisor = this.config.supervisor
    if (this.closed || exec.signal?.aborted) throw new Error('Execution launch cancelled')
    const current = await this.ledger.get(task.taskId)
    if (current.state !== 'running') throw new Error('Execution requires a running assigned task')
    const saved = current.notification?.execution
    const history = current.notification?.executionHistory || []
    const priorRequest = history.find((entry) => entry.executionId === executionId)
    if (priorRequest) {
      if (priorRequest.businessDigest !== businessDigest) throw new Error('Execution identity already names a different command')
      return { executionId, status: 'ended', result: priorRequest.result, notice: 'Previously settled execution; never relaunched' }
    }
    let settled
    if (saved) {
      if (saved.executionId === executionId) {
        if (saved.businessDigest !== businessDigest) throw new Error('Execution identity already names a different command')
        return this.status(current)
      }
      settled = await this.status(current)
      if (settled.status !== 'ended') throw new Error('This task already owns another execution; inspect it before starting any new work')
      if (history.length >= 8) throw new Error('Execution continuation limit reached; operator inspection required')
    }
    const root = await realpath(project.root)
    if (root !== project.root) throw new Error('Project root changed')
    const policy = this.ctx.sandboxPolicy.resolve({ session: exec.agent.session })
    if (policy.mode !== 'workspace-write' || policy.workspaceRoot !== root) throw new Error('Task execution policy changed')
    const wrapped = await this.ctx.sandbox.confine(['/bin/bash', '-c', input.command], policy, exec.signal)
    if (wrapped.enforcement === 'partial' && (!project.allowPartial || !supervisor.allowPartial)) throw new Error('Partial execution confinement is not explicitly approved')
    if (!['full', 'partial'].includes(wrapped.enforcement)) throw new Error('No enforcing command wrapper')
    const argv = [...wrapped.argv]
    if (!path.isAbsolute(argv[0])) {
      let resolved
      for (const base of (process.env.PATH || '').split(path.delimiter)) {
        if (!path.isAbsolute(base)) continue
        const candidate = path.join(base, argv[0])
        try { await access(candidate, constants.X_OK); resolved = candidate; break } catch {}
      }
      if (!resolved) throw new Error('Sandbox runner must resolve to an absolute executable')
      argv[0] = resolved
    }
    const secret = await readSupervisorSecret(supervisor.secretFile)
    const digest = commandDigest(argv)
    const ticket = await issueLaunchTicket({ executionId, projectId: project.id, workspaceRoot: root, cwd: root, confinedArgv: argv,
      enforcement: wrapped.enforcement, policy: 'workspace-write', environment: supervisor.environment || {} }, {
      secret, allowedEnvironmentKeys: Object.keys(supervisor.environment || {}), allowPartial: Boolean(project.allowPartial && supervisor.allowPartial),
      validateConfinement: async (payload) => ({ validated: payload.commandDigest === digest && payload.workspaceRoot === root && payload.enforcement === wrapped.enforcement,
        commandDigest: digest, policy: 'workspace-write', enforcement: wrapped.enforcement }),
    })
    if (this.closed || exec.signal?.aborted) throw new Error('Execution launch cancelled')
    await this.ledger.mutate(task.taskId, (draft) => {
      if (draft.state !== 'running' || draft.notification?.execution?.executionId !== saved?.executionId) throw new Error('Task execution ownership changed')
      if (saved) draft.notification.executionHistory = [...(draft.notification.executionHistory || []), {
        executionId: saved.executionId, type: saved.type, ...(saved.businessDigest ? { businessDigest: saved.businessDigest } : {}),
        result: settled.result || { exitCodeKnown: false },
      }]
      draft.notification.execution = { executionId, businessDigest, type: 'managed', launchIntent: true }
      draft.executionId = executionId
    })
    this.events.changed()
    // Crash here stays an ambiguous launch intent, never an automatic replay.
    if (this.closed || exec.signal?.aborted) throw new Error('Execution launch cancelled after intent; reconcile before retrying')
    await launchSupervisor(ticket, { stateDir: supervisor.stateDirectory, secretFile: supervisor.secretFile,
      allowedEnvironmentKeys: Object.keys(supervisor.environment || {}), allowPartial: Boolean(project.allowPartial && supervisor.allowPartial) })
    return { executionId, status: 'starting', notice: 'Use remote_task_park to observe this execution without model polling.' }
  }

  async registerExisting(task, input) {
    assertObject(input, ['pid'], ['pid'], 'legacy observation')
    const { pid } = input
    validateInteger(pid, 'pid', 1)
    const project = this.project(task)
    const info = await stat(`/proc/${pid}`)
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Legacy observation only supports this deployment OS user')
    const cwd = await realpath(`/proc/${pid}/cwd`)
    if (!within(project.root, cwd)) throw new Error('Existing process cwd is outside the configured project')
    const identity = await getProcessIdentity(pid)
    if (identity.status !== 'running' || !identity.startTime) throw new Error('Existing process identity is uncertain')
    const bytes = await readFile(`/proc/${pid}/cmdline`)
    if (bytes.length > 32768) throw new Error('Existing command identity exceeds limit')
    const argv = bytes.toString('utf8').split('\0').filter(Boolean)
    const digest = commandDigest(argv)
    const observation = { ...identity, cwd, commandDigest: digest }
    const verified = await inspectExistingProcess(observation)
    if (verified.status !== 'running') throw new Error('Existing process changed during admission')
    const executionId = `legacy-${hash(`${pid}:${identity.startTime}:${identity.bootId}:${digest}`).slice(0, 40)}`
    await this.ledger.mutate(task.taskId, (draft) => {
      if (draft.state !== 'running') throw new Error('Observation requires a running task')
      if (draft.notification?.execution && draft.notification.execution.executionId !== executionId) throw new Error('Task already owns another execution/observer')
      draft.notification.execution = { executionId, type: 'legacy', observation }
      draft.executionId = executionId
    })
    this.events.changed()
    return { executionId, status: 'running', notice: 'Observation only; no adoption, stop or automatic restart. Exit does not prove training success.' }
  }

  async status(task) {
    const binding = task.notification?.execution
    if (!binding) throw new Error('No execution is registered for this task')
    if (binding.type === 'legacy') return { executionId: binding.executionId, ...(await inspectExistingProcess(binding.observation)), exitCodeKnown: false }
    if (!this.config.supervisor) throw new Error('Supervisor configuration is no longer available')
    const snapshot = await inspectExecution({ stateDir: this.config.supervisor.stateDirectory, executionId: binding.executionId })
    return { executionId: binding.executionId, status: snapshot.status, runnerAlive: snapshot.runnerStatus === 'running', ...(snapshot.result ? { result: snapshot.result } : {}) }
  }

  async stop(task) {
    const binding = task.notification?.execution
    if (!binding || binding.type !== 'managed' || !this.config.supervisor) throw new Error('Only this task\'s managed execution can be intentionally stopped')
    const snapshot = await inspectExecution({ stateDir: this.config.supervisor.stateDirectory, executionId: binding.executionId })
    if (!snapshot.manifest?.runner) throw new Error('Supervisor identity is not available; do not use PID-only cancellation')
    return stopExecution({ stateDir: this.config.supervisor.stateDirectory, executionId: binding.executionId, runnerIdentity: snapshot.manifest.runner })
  }

  async observe(executionId, callback, task) {
    if (task.notification?.execution?.executionId !== executionId) throw new Error('Observer must match its own registered execution')
    let stopped = false
    let delivered = false
    let checking = false
    let watcher
    const started = Date.now()
    const stop = () => { stopped = true; clearInterval(timer); watcher?.close(); this.stops.delete(stop) }
    const check = async () => {
      if (stopped || delivered || checking) return
      checking = true
      try {
        const value = await this.status(task)
        if (['running', 'starting', 'queued'].includes(value.status)) return
        // Detached runner startup may not have created its manifest yet.
        if (task.notification.execution.type === 'managed' && Date.now() - started < 60000 &&
          ['unknown', 'reconciling'].includes(value.status)) return
        delivered = true
        stop()
        await callback(value)
      } catch {
        if (Date.now() - started >= 60000) { delivered = true; stop(); await callback({ executionId, status: 'unknown' }) }
      } finally { checking = false }
    }
    const timer = setInterval(() => { void check() }, this.pollMs)
    timer.unref?.()
    if (task.notification.execution.type === 'managed') {
      // Parent watch catches creation; low-frequency reconciliation covers missed events.
      try {
        watcher = watch(this.config.supervisor.stateDirectory, { recursive: true }, (_event, filename) => {
          const name = String(filename || '').replaceAll('\\\\', '/')
          if (name === executionId || ['result.json', 'manifest.json', 'child.json', 'start-intent.json'].some((file) => name === `${executionId}/${file}`)) void check()
          // Log appends/other tasks do not trigger status reads or model wakes.
        })
        watcher.on('error', () => { watcher?.close() })
      } catch {}
    }
    this.stops.add(stop)
    void check()
    return stop
  }

  close() { this.closed = true; for (const stop of [...this.stops]) stop() }
}
