/** Resolve task ancestry only through DSH-owned subagent lineage, never ordinary forks. */
export async function taskForAgent(ctx, worker, agent) {
  if (!worker || !agent) return undefined
  let id = String(agent.id)
  let header = agent.session?.header || ctx.sessions?.get(id)?.header
  const seen = new Set()
  for (let depth = 0; depth < 64; depth++) {
    if (seen.has(id)) throw new Error('Cyclic task session lineage')
    seen.add(id)
    const task = await worker.taskForSession(id)
    if (task) return task
    if (!header || header.origin !== 'subagent' || !header.parentSession) return undefined
    id = String(header.parentSession)
    header = ctx.sessions?.get(id)?.header
    if (!header) {
      const observation = await ctx.sessionController.inspect(id)
      header = observation.meta || observation.header
      if (!header) throw new Error('Task ancestor cannot be inspected')
    }
  }
  throw new Error('Task session lineage exceeds limit')
}
