/** Version boundary for one remote execution and its immutable delivery mode. */
export class RemoteDispatch {
  constructor(ctx, store, controller) {
    this.ctx = ctx; this.store = store; this.controller = controller
    this.starting = new Map()
  }
  async start(input, parent, signal = new AbortController().signal) {
    const previous = this.starting.get(input.runId)
    if (previous) {
      await previous.catch(() => {})
      return this.start(input, parent, signal)
    }
    // Reserve synchronously: duplicate tool calls may arrive before the first
    // provider has journaled its intent. Never create two native activations.
    const pending = Promise.resolve().then(() => this.establish(input, parent, signal))
      .finally(() => { if (this.starting.get(input.runId) === pending) this.starting.delete(input.runId) })
    this.starting.set(input.runId, pending)
    return pending
  }
  async waitForResult(started, parent, signal = new AbortController().signal, callId) {
    if (started.reused || started.background || !started.execution) throw new Error('Only a fresh foreground dispatch owns its wait')
    const { execution, runId } = started
    let phase = 'waiting', exited = false, rejectAbort
    const aborted = () => Object.assign(new Error('Foreground remote wait was cancelled'), { code: 'REMOTE_CANCELLED' })
    const cancellation = new Promise((_, reject) => { rejectAbort = reject })
    cancellation.catch(() => {})
    const dispose = () => { execution.dispose().catch(() => {}) }
    const cancel = () => {
      if (['done', 'background'].includes(phase)) return
      // Once handoff begins, wait for its journal outcome before deciding who
      // owns cancellation. The tool can still exit promptly while it commits.
      if (phase !== 'yielding') { phase = 'cancelled'; dispose() }
      rejectAbort(aborted())
    }
    const closed = () => {
      if (['done', 'background'].includes(phase)) return
      if (phase !== 'yielding') phase = 'cancelled'
      rejectAbort(aborted())
    }
    signal.addEventListener('abort', cancel, { once: true })
    this.controller.events.on('closed', closed)
    try {
      if (signal.aborted) cancel()
      if (this.controller.closed) closed()
      while (true) {
        const waiting = new AbortController()
        let next
        try {
          next = await Promise.race([
            execution.result.then(result => ({ result })),
            this.controller.waitForInteraction(runId, String(parent.id), waiting.signal).then(pending => ({ pending })),
            cancellation,
          ])
        } finally { waiting.abort() }
        if (phase === 'cancelled') throw aborted()
        if (next.result || next.pending === null) {
          const result = next.result || await Promise.race([execution.result, cancellation])
          if (phase === 'cancelled') throw aborted()
          phase = 'done'
          return { result }
        }
        phase = 'yielding'
        const handoff = this.controller.yieldForInput(runId, String(parent.id), callId).then(async transfer => {
          phase = transfer.yielded ? 'background' : 'waiting'
          if (exited || signal.aborted || this.controller.closed) {
            if (transfer.yielded && !this.controller.closed) {
              // The tool response may be discarded by cancellation. Queue the
              // original request instead of claiming it was shown to the user.
              await this.controller.reconcileYield(transfer.run, { force: true }).catch(() => {})
            } else if (!transfer.yielded && !this.controller.closed) dispose()
          }
          return transfer
        }, error => {
          phase = 'cancelled'
          if (!this.controller.closed) dispose()
          throw error
        })
        handoff.catch(() => {})
        const transfer = await Promise.race([handoff, cancellation])
        if (transfer.yielded) return { pending: transfer.run }
        // A withdrawn request resumes the event wait. A terminal snapshot still
        // waits on execution.result so native/legacy teardown cannot be bypassed.
        if (signal.aborted) cancel()
        if (this.controller.closed) closed()
      }
    } finally {
      exited = true
      signal.removeEventListener('abort', cancel)
      this.controller.events.off('closed', closed)
      if (!['done', 'background', 'yielding'].includes(phase) && !this.controller.closed) dispose()
    }
  }
  async establish(input, parent, signal) {
    if (signal.aborted) throw new Error('Task submission cancelled')
    const existing = await this.store.get('masters', input.runId)
    if (existing) {
      if (existing.originSessionId !== String(parent.id) || ['targetId', 'workspaceId', 'prompt'].some(key => existing[key] !== input[key])) {
        throw new Error('Run ID already names a different task')
      }
      // This includes cold-restored and completed runs. The controller already
      // observes/reports them; re-activating would duplicate native notices.
      return { ...(await this.controller.status(input.runId, String(parent.id))), background: existing.background !== false, reused: true }
    }
    const native = typeof this.ctx.subagents.startActivation === 'function'
    const background = input.background !== false
    if (!native && typeof this.ctx.subagents.start !== 'function') throw new Error('当前 DSH 缺少受支持的子 Agent 派单接口')
    const abort = new AbortController()
    const cancel = () => abort.abort(signal.reason)
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) cancel()
    let run
    try {
      const resultDelivery = native ? (background ? 'native' : 'caller') : 'hub'
      const prompt = [{ type: 'text', text: JSON.stringify({ ...input, background, resultDelivery }) }]
      run = native
        ? await this.ctx.subagents.startActivation({ provider: 'server-hub-remote', label: input.description,
          request: { parent, prompt }, signal: abort.signal, delivery: background ? 'parent' : 'caller' })
        : await this.ctx.subagents.start('server-hub-remote', { parent, prompt, label: input.description, signal: abort.signal })
    } catch (error) {
      // Native admission can fail after the provider accepted remote work. Its
      // rollback disposes that activation; Hub recovery owns any durable record.
      if (native) await this.controller.nativeSettled(input.runId).catch(() => {})
      throw error
    } finally {
      // Publication transfers lifetime ownership to DSH (or the legacy run),
      // not the completed parent tool call's signal.
      signal.removeEventListener('abort', cancel)
    }
    let disposal
    const dispose = () => disposal ||= Promise.resolve().then(() => run.dispose())
    // A foreground result must include teardown, for old and new runtimes alike.
    const result = native ? run.result : run.result.finally(dispose)
    result.catch(() => {})
    if (native) {
      // Native result resolves after cleanup and (for parent delivery) notification.
      // Caller delivery never sends a native notice; a foreground task handed off
      // for input is instead reported by Hub after this same cleanup boundary.
      result.then(() => this.controller.nativeSettled(input.runId), () => this.controller.nativeSettled(input.runId)).catch(() => {})
    }
    return { ...(await this.controller.status(input.runId, String(parent.id))), background,
      execution: { result, dispose } }
  }
}
