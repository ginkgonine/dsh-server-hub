/** Nearest-deadline timer. It pauses stalled active phases without model polling. */
export class PhaseDeadlines {
  constructor({ worker, ledger, events, now = Date.now }) {
    this.worker = worker
    this.ledger = ledger
    this.events = events
    this.now = now
    this.closed = false
    this.generation = 0
    this.changed = () => { void this.schedule() }
    events.on('changed', this.changed)
  }

  async schedule() {
    const generation = ++this.generation
    if (this.closed) return
    try {
      const tasks = await this.ledger.list()
      if (this.closed || generation !== this.generation) return
      clearTimeout(this.timer)
      const running = tasks.filter((task) => this.worker.owns(task) && task.state === 'running')
        .map((task) => ({ task, at: task.notification.worker.phaseStartedAt + task.notification.worker.activeTimeoutMs }))
        .filter((entry) => Number.isSafeInteger(entry.at)).sort((a, b) => a.at - b.at)
      if (!running.length) return
      const nearest = running[0]
      this.timer = setTimeout(() => {
        if (this.closed) return
        // At/after the deadline this returns false without admitting/modeling a step.
        void this.worker.beforeStep(nearest.task.remoteSessionId).then(() => this.schedule()).catch(() => {})
      }, Math.max(1, nearest.at - this.now() + 1))
      this.timer.unref?.()
    } catch { /* An unavailable/poisoned ledger cannot authorize new work. */ }
  }

  close() {
    this.closed = true
    ++this.generation
    clearTimeout(this.timer)
    this.events.off('changed', this.changed)
  }
}
