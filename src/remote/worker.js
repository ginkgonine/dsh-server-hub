import { createHash, randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { MAX_INTERACTIONS, normalizeInteractions, serializeInteraction, validateInteractionResponse } from './interaction.js'

const terminal = new Set(['completed', 'error', 'interrupted'])
const OUTPUT_LIMIT = 32768
const copy = value => value === undefined ? undefined : structuredClone(value)
const problem = (code, message) => Object.assign(new Error(message), { code })
const id = (value, label) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw problem('REMOTE_INPUT', `Invalid ${label}`)
  return value
}
const deferred = () => {
  let resolve, reject
  const promise = new Promise((done, fail) => { resolve = done; reject = fail })
  promise.catch(() => {}) // An uncollected run must never crash the DSH host.
  return { promise, resolve, reject }
}
const eventsOf = agent => [...(agent.session.ownEvents?.() || agent.session.snapshotEvents?.() || [])]
const questionAborted = () => Object.assign(new Error('ask_user_question was aborted before the user answered'), { name: 'UserQuestionError', code: 'ASK_ABORTED' })
const responseDigest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX_RESPONSE_RECEIPTS = 256

/** One remote request owns one ordinary, independent worker conversation.
 * Its real interaction waterfalls are claimed by this worker and answered by
 * the controlling human/Hub, never by a fabricated Agent or a new prompt.
 */
export class RemoteWorker {
  constructor(ctx, store, { getConfig } = {}) {
    this.ctx = ctx
    this.store = store
    this.getConfig = getConfig || (() => store.getConfig())
    this.events = new EventEmitter()
    this.live = new Map()
    this.stopping = new Map()
    this.closed = false
    this.tail = Promise.resolve()
    this.initializing = undefined
    this.disposers = []
    for (const event of ['approval/request', 'user-questions/request']) {
      const off = ctx.on(event, async (request, next) => {
        const entry = [...this.live.values()].find(value => value.agent === request.agent)
        if (!entry || !entry.active) return next()
        // Historical status-only fixtures have no native payload. Real requests
        // (including malformed ones) never fall through to another answerer.
        if (Reflect.ownKeys(request).length === 1 && Object.hasOwn(request, 'agent')) {
          entry.waits += 1
          await this._waiting(entry)
          try { return await next() } finally {
            entry.waits -= 1
            await this._waiting(entry)
          }
        }
        return this._interaction(entry, event === 'approval/request' ? 'approval' : 'questions', request)
      }, { global: true, prepend: true })
      if (typeof off === 'function') this.disposers.push(off)
    }
  }

  serial(operation) {
    const result = this.tail.then(operation)
    this.tail = result.catch(() => {})
    return result
  }

  initialize() {
    if (!this.initializing) this.initializing = this.serial(async () => {
      for (const record of await this.store.list('runs')) {
        if (!terminal.has(record.state)) await this._write({ ...record, requests: [], state: 'interrupted', stopReason: 'aborted', diagnostic: 'Worker restarted; this task will not be replayed' })
        else if (record.requests?.length) await this._write({ ...record, requests: [] })
      }
    })
    return this.initializing
  }

  public(record) {
    if (!record) return undefined
    const { runId, sessionId, workspaceId, description, state, output, stopReason, diagnostic, createdAt, updatedAt } = record
    return copy({ runId, sessionId, workspaceId, description, state, createdAt, updatedAt,
      revision: record.revision || 0, requests: normalizeInteractions(record.requests),
      ...(output === undefined ? {} : { output }), ...(stopReason === undefined ? {} : { stopReason }),
      ...(diagnostic === undefined ? {} : { diagnostic }),
      ...(record.cancelledBeforeStart ? { cancelledBeforeStart: true } : {}) })
  }

  async catalog() {
    await this.initialize()
    const config = await this.getConfig()
    const enabled = !this.closed && config?.enabled === true
    return { enabled, workspaces: enabled ? (config.workspaceIds || []).flatMap(workspaceId => {
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      return workspace ? [{ workspaceId, name: workspace.name || workspace.title || workspaceId }] : []
    }) : [] }
  }

  async get(runId) {
    id(runId, 'runId')
    await this.initialize()
    return this.public(await this.store.get('runs', runId))
  }

  async start(input) {
    if (!input || Object.getPrototypeOf(input) !== Object.prototype || Object.keys(input).some(key => !['runId', 'workspaceId', 'prompt', 'description'].includes(key))) throw problem('REMOTE_INPUT', 'Expected a remote task request')
    const runId = id(input.runId, 'runId'), workspaceId = id(input.workspaceId, 'workspaceId')
    if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 100000) throw problem('REMOTE_INPUT', 'Expected a nonempty prompt of at most 100000 characters')
    const description = input.description ?? 'Remote agent task'
    if (typeof description !== 'string' || !description.trim() || description.length > 500) throw problem('REMOTE_INPUT', 'Expected a short description')
    const digest = createHash('sha256').update(JSON.stringify([workspaceId, input.prompt, description])).digest('hex')
    await this.initialize()
    const { record, entry, fresh } = await this.serial(async () => {
      const previous = await this.store.get('runs', runId)
      if (previous) {
        if (previous.cancelledBeforeStart) throw problem('REMOTE_CANCELLED', 'This runId was cancelled before acceptance')
        if (previous.digest !== digest) throw problem('REMOTE_DUPLICATE', 'runId already identifies different work')
        return { record: previous, entry: this.live.get(runId), fresh: false }
      }
      const config = await this.getConfig()
      if (this.closed || config?.enabled !== true) throw problem('REMOTE_DISABLED', 'Remote execution is disabled')
      if (!config.workspaceIds?.includes(workspaceId)) throw problem('REMOTE_WORKSPACE', 'Workspace is not enabled for remote execution')
      const workspace = this.ctx.workspaceRegistry.get(workspaceId)
      if (!workspace?.path || (typeof workspace.status === 'function' && await workspace.status() !== 'ok')) throw problem('REMOTE_WORKSPACE', 'Registered workspace is unavailable')
      const now = Date.now()
      const record = { runId, sessionId: `remote-${randomUUID()}`, workspaceId, description, digest, state: 'running', createdAt: now, updatedAt: now }
      // Durable intent precedes every session creation or model request. Restarts
      // reconcile this record; they never replay shell/model work.
      await this._write(record)
      const entry = { runId, record, cwd: workspace.path, active: true, waits: 0, interactions: new Map(), admitted: deferred(), done: deferred(), firstTurn: undefined }
      this.live.set(runId, entry)
      return { record, entry, fresh: true }
    })
    if (fresh) void this._launch(entry, input.prompt).catch(error => this._launchFailed(entry, error))
    return this.public(entry ? await entry.admitted.promise : record)
  }

  async _write(record) {
    const updated = { ...record, revision: (record.revision || 0) + 1, updatedAt: Date.now() }
    await this.store.put('runs', record.runId, updated)
    this.events.emit('changed', record.runId)
    return updated
  }

  async _current(entry) {
    const record = await this.store.get('runs', entry.runId)
    return entry.active && !this.closed && record && !terminal.has(record.state)
  }

  async _launch(entry, prompt) {
    if (!await this._current(entry)) { entry.admitted.resolve(await this.store.get('runs', entry.runId)); return }
    // Omit workspaceId (no automatic sidebar membership), parent/history and
    // model/permission/preset overrides. The worker's configured defaults own it.
    const created = await this.ctx.sessionController.create({ sessionId: entry.record.sessionId, cwd: entry.cwd })
    if (created.sessionId !== entry.record.sessionId) throw problem('REMOTE_SESSION', 'Worker returned a different session identity')
    const resolved = await this.ctx.sessionController.resolveAgent(created.sessionId)
    const agent = resolved?.agent || resolved // Current DSH returns the Agent directly.
    if (!agent?.session || agent.id !== entry.record.sessionId || typeof agent.whenIdle !== 'function' || typeof agent.cancel !== 'function') throw problem('REMOTE_SESSION', 'Worker session cannot be driven')
    entry.agent = agent
    if (agent.session.header?.cwd !== entry.cwd) throw problem('REMOTE_SESSION', 'Worker session directory differs from its registered workspace')
    entry.boundary = eventsOf(agent).length
    if (!agent.ctx?.tools?.guard || !agent.ctx?.on) throw problem('REMOTE_SESSION', 'Worker session does not expose scoped guards')
    agent.ctx.tools.guard(exec => !entry.active || this.closed ? 'This remote one-shot task has ended' :
      String(exec.name).startsWith('remote_agent') ? 'A remote task cannot recursively dispatch remote agents' : undefined)
    agent.ctx.on('agent/pre-step', (_payload, next) => {
      if (!entry.active || this.closed) return { kind: 'reject' }
      const turn = eventsOf(agent).slice(entry.boundary).findLast(event => event.type === 'turn/start')?.data?.turn
      if (entry.firstTurn === undefined && turn !== undefined) entry.firstTurn = turn
      return turn !== undefined && turn !== entry.firstTurn ? { kind: 'reject' } : next()
    })
    if (!await this._current(entry)) {
      agent.cancel({ kind: 'user' })
      entry.admitted.resolve(await this.store.get('runs', entry.runId))
      void agent.whenIdle().then(() => this._archive(entry)).catch(() => {})
      return
    }
    await this._flush(agent.session)
    if (!await this._current(entry)) {
      agent.cancel({ kind: 'user' })
      entry.admitted.resolve(await this.store.get('runs', entry.runId))
      void agent.whenIdle().then(() => this._archive(entry)).catch(() => {})
      return
    }
    await this.ctx.sessionController.prompt({ sessionId: agent.id, requestId: `remote-${entry.runId}`, mode: 'queue', content: [{ type: 'text', text: prompt }] }, new AbortController().signal)
    await this._flush(agent.session)
    entry.admitted.resolve(await this.store.get('runs', entry.runId))
    // Promise/event waiting only: neither timers nor model-status polling.
    void agent.whenIdle().then(() => this._settle(entry)).catch(error => this._launchFailed(entry, error))
  }

  async _flush(session) {
    if (!await this.ctx.sessions.flush(session)) throw problem('REMOTE_STORAGE', 'Worker session durability checkpoint failed')
  }

  _interactionState(entry, requests) {
    return entry.waits > 0 || requests.some(request => request.kind === 'approval') ? 'waiting_approval' :
      requests.length ? 'waiting_input' : 'running'
  }

  async _waiting(entry) {
    await this.serial(async () => {
      const record = await this.store.get('runs', entry.runId)
      if (!record || terminal.has(record.state) || !entry.active) return
      const requests = normalizeInteractions([...entry.interactions.values()].map(pending => pending.wire))
      const state = this._interactionState(entry, requests)
      if (record.state !== state || JSON.stringify(record.requests || []) !== JSON.stringify(requests)) await this._write({ ...record, requests, state })
    })
  }

  _releaseInteraction(entry, pending, value, error) {
    if (pending.closed) return
    pending.closed = true
    entry.interactions.delete(pending.wire.id)
    pending.signal?.removeEventListener('abort', pending.abort)
    if (error) pending.answer.reject(error)
    else pending.answer.resolve(value)
  }

  _withdrawInteraction(entry, pending) {
    if (pending.closed) return
    pending.expired = true
    this._releaseInteraction(entry, pending, 'cancelled', pending.wire.kind === 'questions' ? questionAborted() : undefined)
    // Wake the original tool immediately; durable projection removal follows
    // the same serial journal as responses and terminal transitions.
    void this.serial(async () => {
      const record = await this.store.get('runs', entry.runId)
      if (!record) return
      const receipts = { ...(record.responseReceipts || {}) }
      if (receipts[pending.wire.id]) receipts[pending.wire.id] = { ...receipts[pending.wire.id], expired: true }
      const requests = normalizeInteractions([...entry.interactions.values()].map(item => item.wire))
      await this._write({ ...record, responseReceipts: receipts, requests,
        ...(terminal.has(record.state) ? {} : { state: this._interactionState(entry, requests) }) })
    }).catch(() => {})
  }

  _cancelInteractions(entry) {
    if (!entry) return
    for (const pending of [...entry.interactions.values()]) this._withdrawInteraction(entry, pending)
  }

  async _interaction(entry, kind, request) {
    if (request.signal?.aborted) {
      if (kind === 'approval') return 'cancelled'
      throw questionAborted()
    }
    let pending
    try {
      const wire = serializeInteraction(kind, request)
      pending = { wire, signal: request.signal, answer: deferred(), closed: false, expired: false }
      pending.abort = () => this._withdrawInteraction(entry, pending)
      pending.signal?.addEventListener('abort', pending.abort, { once: true })
      if (pending.signal?.aborted) pending.abort()
      await this.serial(async () => {
        const record = await this.store.get('runs', entry.runId)
        if (pending.expired || !entry.active || this.closed || !record || terminal.has(record.state)) throw problem('REMOTE_REQUEST_EXPIRED', 'Interaction is no longer pending')
        if (entry.interactions.size >= MAX_INTERACTIONS || Object.keys(record.responseReceipts || {}).length >= MAX_RESPONSE_RECEIPTS) throw problem('REMOTE_INPUT', 'Too many remote interactions')
        const requests = normalizeInteractions([...entry.interactions.values()].map(item => item.wire).concat(wire))
        entry.interactions.set(wire.id, pending)
        await this._write({ ...record, requests, state: this._interactionState(entry, requests) })
      })
      return await pending.answer.promise
    } catch (error) {
      if (pending && !pending.closed) this._releaseInteraction(entry, pending, 'unavailable', kind === 'questions' ? error : undefined)
      if (pending?.expired || request.signal?.aborted) {
        if (kind === 'approval') return 'cancelled'
        throw questionAborted()
      }
      if (kind === 'approval') return 'unavailable'
      throw error
    }
  }

  /** Resume exactly one original waterfall, never create or prompt an Agent. */
  async respond(runId, requestId, input, { human = false } = {}) {
    id(runId, 'runId'); id(requestId, 'requestId')
    await this.initialize()
    return this.serial(async () => {
      let record = await this.store.get('runs', runId)
      if (!record) throw problem('REMOTE_NOT_FOUND', 'Remote task does not exist')
      const receipt = record.responseReceipts?.[requestId]
      if (receipt) {
        const native = validateInteractionResponse(receipt.interaction, input, { human })
        if (receipt.expired) throw problem('REMOTE_REQUEST_EXPIRED', 'Interaction is no longer pending')
        if (responseDigest(native) !== receipt.digest) throw problem('REMOTE_CONFLICT', 'Interaction already received a different response')
        return this.public(record)
      }
      const entry = this.live.get(runId)
      const pending = entry?.interactions.get(requestId)
      if (this.closed || !entry?.active || terminal.has(record.state) || !pending || pending.closed || pending.signal?.aborted) throw problem('REMOTE_REQUEST_EXPIRED', 'Interaction is no longer pending')
      const native = validateInteractionResponse(pending.wire, input, { human })
      const requests = normalizeInteractions([...entry.interactions.values()].filter(item => item !== pending).map(item => item.wire))
      record = await this._write({ ...record, requests, state: this._interactionState(entry, requests),
        responseReceipts: { ...(record.responseReceipts || {}), [requestId]: { interaction: pending.wire, digest: responseDigest(native) } } })
      // Cancellation can arrive while a durable checkpoint is in flight. A
      // committed digest is not permission to resume an expired approval.
      if (pending.expired || pending.signal?.aborted || this.closed || !entry.active) {
        this._withdrawInteraction(entry, pending)
        throw problem('REMOTE_REQUEST_EXPIRED', 'Interaction was cancelled before its response committed')
      }
      this._releaseInteraction(entry, pending, native)
      return this.public(record)
    })
  }

  async _settle(entry) {
    const events = eventsOf(entry.agent).slice(entry.boundary)
    const firstTurn = events.find(event => event.type === 'turn/start')?.data?.turn
    const own = firstTurn === undefined ? events : events.filter(event => event.data?.turn === undefined || event.data.turn === firstTurn)
    const end = own.findLast(event => event.type === 'turn/end')
    const reason = end?.data?.reason
    const stopReason = ({ completed: 'completed', aborted: 'aborted', 'max-tokens': 'max-tokens', blocked: 'refusal' })[reason?.kind] || 'error'
    const message = own.findLast(event => event.type === 'assistant/message' && event.data?.message?.content?.length)
    let text = message?.data.message.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('') || ''
    if (text.length > OUTPUT_LIMIT) {
      const notice = '\n[Remote output truncated; the complete answer remains in the worker session]'
      text = text.slice(0, OUTPUT_LIMIT - notice.length) + notice
    }
    const output = text ? [{ type: 'text', text }] : []
    const diagnostic = reason?.kind === 'error' ? String(reason.error?.message || 'Worker agent failed').slice(0, 4096) :
      !end ? 'Worker reached idle without a task turn result' : stopReason !== 'completed' && stopReason !== 'aborted' ? `Worker turn ended: ${stopReason}` : undefined
    await this._finish(entry, { state: stopReason === 'completed' ? 'completed' : stopReason === 'aborted' ? 'interrupted' : 'error', stopReason, output,
      ...(diagnostic === undefined ? {} : { diagnostic }) })
    await this._archive(entry)
  }

  async _launchFailed(entry, error) {
    // Do not expose raw filesystem, tool inputs or protocol objects as diagnostics.
    const diagnostic = error?.code === 'REMOTE_STORAGE' ? error.message : 'Worker session could not complete its remote task'
    try { entry.agent?.cancel({ kind: 'user' }) } catch {}
    try {
      await this._finish(entry, { state: 'error', stopReason: 'error', output: [], diagnostic })
    } catch {
      entry.active = false
      this.live.delete(entry.runId)
      const failure = problem('REMOTE_STORAGE', 'Remote task outcome could not be persisted')
      entry.admitted.reject(failure)
      entry.done.reject(failure)
    }
    if (entry.agent) void entry.agent.whenIdle().then(() => this._archive(entry)).catch(() => {})
  }

  async _finish(entry, result) {
    this._cancelInteractions(entry)
    return this.serial(async () => {
      let record = await this.store.get('runs', entry.runId)
      if (!terminal.has(record.state)) record = await this._write({ ...record, ...result, requests: [] })
      entry.active = false
      entry.admitted.resolve(record)
      entry.done.resolve(this.public(record))
      this.live.delete(entry.runId)
      return this.public(record)
    })
  }

  async _archive(entry) {
    try {
      const record = await this.store.get('runs', entry.runId)
      if (record && terminal.has(record.state) && !entry.archived) {
        entry.archived = true
        await this.ctx.workspaceRegistry.archiveSession?.(record.sessionId)
      }
    } catch {
      // Archival is presentation cleanup, never a reason to rewrite task outcome.
    }
  }

  async done(runId) {
    const record = await this.get(runId)
    if (!record) throw problem('REMOTE_NOT_FOUND', 'Remote task does not exist')
    if (terminal.has(record.state)) return record
    const entry = this.live.get(runId)
    if (!entry) throw problem('REMOTE_NOT_FOUND', 'Remote task has no live owner')
    return entry.done.promise
  }

  async cancel(runId) {
    await this.initialize()
    id(runId, 'runId')
    const entry = this.live.get(runId)
    this._cancelInteractions(entry)
    let stop = false
    const result = await this.serial(async () => {
      let record = await this.store.get('runs', runId)
      if (!record) {
        const now = Date.now()
        record = await this._write({ runId, state: 'interrupted', stopReason: 'aborted', cancelledBeforeStart: true,
          description: 'Cancelled before acceptance', output: [], createdAt: now, updatedAt: now })
        return this.public(record)
      }
      if (!terminal.has(record.state)) {
        stop = true
        record = await this._write({ ...record, requests: [], state: 'interrupted', stopReason: 'aborted', output: [] })
      }
      if (entry) {
        entry.active = false
        entry.admitted.resolve(record)
        entry.done.resolve(this.public(record))
        this.live.delete(runId)
      }
      return this.public(record)
    })
    // Cancel only the Agent. No PID, Docker, supervisor, training or shell kill.
    if (stop && entry?.agent) {
      entry.agent.cancel({ kind: 'user' })
      const stopping = entry.agent.whenIdle().then(() => this._archive(entry)).finally(() => this.stopping.delete(runId))
      stopping.catch(() => {}) // Disposal collects failures; an uncollected stop must not crash the host.
      this.stopping.set(runId, stopping)
    }
    return result
  }

  async drain(runId) {
    id(runId, 'runId')
    await this.initialize()
    const stopping = this.stopping.get(runId)
    if (stopping) await stopping
    return this.get(runId)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.initialize()
    await Promise.all([...this.live.keys()].map(runId => this.cancel(runId)))
    for (const dispose of this.disposers.splice(0)) dispose()
  }
}

export default RemoteWorker
