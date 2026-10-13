import { randomUUID } from 'node:crypto'

const copy = value => value === undefined ? undefined : structuredClone(value)

/** Small per-instance settings/run journal, using DSH's existing durable storage. */
export class RemoteStore {
  constructor(unit) { this.unit = unit; this.tables = { runs: {}, masters: {} }; this.tail = Promise.resolve(); this.closed = false }
  static async open(ctx) {
    const unit = await ctx.storage.backend.get('json').kv.open({ name: `hub_remote_${ctx.webServer.port}`, version: 1,
      tables: ['runs', 'masters'], hasGlobal: true, layout: 'per-record' })
    const store = new RemoteStore(unit)
    try {
      const snapshot = await unit.loadAll()
      store.tables = snapshot.tables
      store.config = { waitForResult: false, ...(snapshot.global || { instanceId: randomUUID(), enabled: false, workspaceIds: [] }) }
      if (typeof store.config.instanceId !== 'string' || typeof store.config.enabled !== 'boolean' || !Array.isArray(store.config.workspaceIds) || typeof store.config.waitForResult !== 'boolean') throw new Error('Invalid remote settings')
      if (!snapshot.global) await unit.setGlobal(store.config)
      return store
    } catch (error) { await unit.close(); throw error }
  }
  serialize(callback) {
    if (this.closed) return Promise.reject(new Error('Remote store closed'))
    const next = this.tail.then(callback)
    this.tail = next.catch(() => {})
    return next
  }
  getConfig() { return copy(this.config) }
  setConfig(patch) {
    return this.serialize(async () => {
      const next = { ...this.config, ...patch,
        workspaceIds: patch.workspaceIds ? [...new Set(patch.workspaceIds)] : [...this.config.workspaceIds] }
      await this.unit.setGlobal(next)
      this.config = next
      return copy(next)
    })
  }
  get(table, id) { return copy(this.tables[table]?.[id]) }
  list(table) { return Object.values(this.tables[table] || {}).map(copy) }
  put(table, id, record) {
    return this.serialize(async () => {
      const next = copy(record)
      await this.unit.putRecord(table, id, next)
      this.tables[table][id] = next
      return copy(next)
    })
  }
  mutate(table, id, callback) {
    return this.serialize(async () => {
      const next = await callback(copy(this.tables[table][id]))
      if (!next) return copy(this.tables[table][id])
      await this.unit.putRecord(table, id, next)
      this.tables[table][id] = copy(next)
      return copy(next)
    })
  }
  async close() { if (this.closed) return; this.closed = true; await this.tail; await this.unit.close() }
}
