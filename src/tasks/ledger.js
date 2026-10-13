import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertObject, cloneJson, PROTOCOL_VERSION, sameTaskSubmission, TaskValidationError, validateId, validateInteger, validateTaskEvent, validateTaskRecord, validateTaskTransition } from './protocol.js'
import { getProcessIdentity } from './executor.js'

const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024
const MAX_TASKS = 10_000
const MAX_EVENTS = 100_000
const NOFOLLOW = constants.O_NOFOLLOW || 0
const empty = () => ({ version: PROTOCOL_VERSION, lastSeq: 0, tasks: [], events: [] })
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value))
const error = (code, message) => Object.assign(new Error(message), { code })

function secureStat(stat, directory = false) {
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw error('TASK_UNSAFE_STORAGE', 'ledger storage must use ordinary directories/files')
  if ((stat.mode & 0o077) || (stat.mode & 0o700) !== (directory ? 0o700 : 0o600) || (stat.mode & 0o7000)) throw error('TASK_UNSAFE_STORAGE', 'ledger requires private directory 0700 and files 0600')
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw error('TASK_UNSAFE_STORAGE', 'ledger storage must be owned by this user')
  if (!directory && stat.nlink !== 1) throw error('TASK_UNSAFE_STORAGE', 'hard-linked ledger files are not permitted')
}

async function noSymlinkAncestors(directory) {
  const parsed = path.parse(directory)
  let cursor = parsed.root
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part)
    const stat = await fs.lstat(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw error('TASK_UNSAFE_STORAGE', 'symlink/non-directory ledger path component')
  }
}

async function readPrivate(file, cap) {
  const handle = await fs.open(file, constants.O_RDONLY | NOFOLLOW)
  try {
    const stat = await handle.stat()
    secureStat(stat)
    if (stat.size > cap) throw error('TASK_CORRUPT_STORAGE', 'ledger file exceeds size limit')
    const bytes = await handle.readFile()
    if (bytes.length > cap) throw error('TASK_CORRUPT_STORAGE', 'ledger file exceeds size limit')
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw error('TASK_CORRUPT_STORAGE', 'invalid ledger JSON') }
  } finally { await handle.close() }
}

function validateLock(value) {
  assertObject(value, ['pid', 'nonce', 'createdAt', 'startTime', 'bootId'], ['pid', 'nonce', 'createdAt'], 'lock')
  validateInteger(value.pid, 'lock.pid', 1)
  validateId(value.nonce, 'lock.nonce')
  validateInteger(value.createdAt, 'lock.createdAt')
  if (value.startTime !== undefined && (typeof value.startTime !== 'string' || !/^\d{1,24}$/.test(value.startTime))) throw error('TASK_UNSAFE_STORAGE', 'invalid lock process identity')
  if (value.bootId !== undefined) validateId(value.bootId, 'lock.bootId')
  if ((value.startTime === undefined) !== (value.bootId === undefined)) throw error('TASK_UNSAFE_STORAGE', 'incomplete lock process identity')
  return value
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true } catch (cause) {
    if (cause.code === 'ESRCH') return false
    if (cause.code === 'EPERM') return true
    throw cause
  }
}

async function lockOwnerAlive(owner) {
  if (!processAlive(owner.pid)) return false
  if (owner.startTime && owner.bootId && process.platform === 'linux') {
    const actual = await getProcessIdentity(owner.pid)
    if (actual.startTime && actual.bootId) return actual.startTime === owner.startTime && actual.bootId === owner.bootId
  }
  return true // Unknown/legacy identity is never treated as a dead owner.
}

function validateSnapshot(value) {
  assertObject(value, ['version', 'lastSeq', 'tasks', 'events'], ['version', 'lastSeq', 'tasks', 'events'], 'snapshot')
  if (value.version !== PROTOCOL_VERSION) throw error('TASK_CORRUPT_STORAGE', 'unsupported snapshot version')
  validateInteger(value.lastSeq, 'lastSeq')
  if (!Array.isArray(value.tasks) || value.tasks.length > MAX_TASKS || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) throw error('TASK_CORRUPT_STORAGE', 'invalid snapshot collections')
  const tasks = value.tasks.map(validateTaskRecord)
  const ids = new Set(tasks.map(task => task.taskId))
  if (ids.size !== tasks.length) throw error('TASK_CORRUPT_STORAGE', 'duplicate task in snapshot')
  let previous = 0
  const events = value.events.map(item => {
    const event = validateTaskEvent(item)
    if (event.seq !== previous + 1 || !ids.has(event.taskId)) throw error('TASK_CORRUPT_STORAGE', 'event sequence gap or orphan event')
    previous = event.seq
    return event
  })
  if (previous !== value.lastSeq) throw error('TASK_CORRUPT_STORAGE', 'event sequence counter mismatch')
  return { version: PROTOCOL_VERSION, lastSeq: previous, tasks, events }
}

/**
 * Standalone, dependency-free single-writer ledger adapter.
 * An atomic 0600 ledger.json snapshot contains ALL records and replay events;
 * fsync(temp), rename, fsync(directory) is the commit boundary. No network calls
 * belong in a mutation callback. Reads/writes are serialized and detached.
 * State directory must be absolute, private (0700), and have an existing parent.
 * Limits: 10k tasks, 100k events, 64MiB snapshot; archival is an integration concern.
 * Dead/mismatched Linux process-identity locks are recovered conservatively;
 * live/legacy-ambiguous PID locks fail closed. A crash during lock recovery can leave ledger.recovery requiring manual
 * removal after confirming no writer exists. This is not a distributed/NFS lock.
 */
export class FileTaskLedger {
  #directory
  #directoryHandle
  #directoryIdentity
  #snapshot = empty()
  #queue = Promise.resolve()
  #initialized = false
  #closed = false
  #closing = false
  #poisoned = false
  #lock

  constructor(stateDirectory) {
    if (typeof stateDirectory !== 'string' || !path.isAbsolute(stateDirectory) || stateDirectory.includes('\0')) throw new TaskValidationError('stateDirectory must be an absolute path')
    this.#directory = path.resolve(stateDirectory)
  }

  #enqueue(callback, allowClosed = false) {
    if (!allowClosed && (this.#closing || this.#closed)) return Promise.reject(error('TASK_LEDGER_CLOSED', 'ledger is closing/closed'))
    const result = this.#queue.then(callback)
    this.#queue = result.catch(() => {})
    return result
  }

  #ready() {
    if (!this.#initialized || this.#closed) throw error('TASK_LEDGER_CLOSED', 'call init before using ledger')
    if (this.#poisoned) throw error('TASK_LEDGER_UNCERTAIN', 'commit durability uncertain; close and reload ledger')
  }

  async #checkDirectory() {
    await noSymlinkAncestors(this.#directory)
    const stat = await fs.lstat(this.#directory)
    secureStat(stat, true)
    if (stat.dev !== this.#directoryIdentity.dev || stat.ino !== this.#directoryIdentity.ino) throw error('TASK_UNSAFE_STORAGE', 'ledger directory changed')
  }

  async #writeExclusive(file, value) {
    const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
    try {
      secureStat(await handle.stat())
      await handle.writeFile(JSON.stringify(value))
      await handle.sync()
    } finally { await handle.close() }
  }

  async #acquireLock() {
    const file = path.join(this.#directory, 'ledger.lock')
    const identity = await getProcessIdentity(process.pid)
    this.#lock = { pid: process.pid, nonce: randomUUID(), createdAt: Date.now(),
      ...(identity.startTime && identity.bootId ? { startTime: identity.startTime, bootId: identity.bootId } : {}) }
    try { await this.#writeExclusive(file, this.#lock); await this.#directoryHandle.sync(); return } catch (cause) {
      if (cause.code !== 'EEXIST') throw cause
    }
    const recovery = path.join(this.#directory, 'ledger.recovery')
    // Only one recoverer may inspect/delete a dead lock. Other contenders fail closed.
    try { await this.#writeExclusive(recovery, this.#lock) } catch (cause) {
      if (cause.code === 'EEXIST') throw error('TASK_LEDGER_LOCKED', 'ledger recovery is in progress or requires operator inspection')
      throw cause
    }
    try {
      let owner
      try { owner = validateLock(await readPrivate(file, 4096)) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      if (owner && await lockOwnerAlive(owner)) throw error('TASK_LEDGER_LOCKED', 'ledger already has a live writer')
      if (owner) await fs.unlink(file)
      try { await this.#writeExclusive(file, this.#lock) } catch (cause) {
        if (cause.code === 'EEXIST') throw error('TASK_LEDGER_LOCKED', 'another writer acquired ledger')
        throw cause
      }
      await this.#directoryHandle.sync()
    } finally { await fs.unlink(recovery); await this.#directoryHandle.sync() }
  }

  async #releaseLock() {
    if (!this.#lock) return
    const file = path.join(this.#directory, 'ledger.lock')
    let owner
    try { owner = validateLock(await readPrivate(file, 4096)) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    if (owner?.nonce === this.#lock.nonce && owner.pid === process.pid) {
      await fs.unlink(file)
      await this.#directoryHandle.sync()
    }
    this.#lock = undefined
  }

  /** Acquire exclusive process ownership and load a validated snapshot. Idempotent on the same instance. */
  init() {
    return this.#enqueue(async () => {
      if (this.#initialized) { this.#ready(); return this }
      if (!constants.O_NOFOLLOW || !constants.O_DIRECTORY) throw error('TASK_UNSAFE_STORAGE', 'ledger requires platform support for no-follow directory/file opens')
      await noSymlinkAncestors(path.dirname(this.#directory))
      let created = false
      try { await fs.mkdir(this.#directory, { mode: 0o700 }); created = true } catch (cause) { if (cause.code !== 'EEXIST') throw cause }
      if (created) {
        const parent = await fs.open(path.dirname(this.#directory), constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
        try { await parent.sync() } finally { await parent.close() }
      }
      await noSymlinkAncestors(this.#directory)
      this.#directoryHandle = await fs.open(this.#directory, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
      try {
        this.#directoryIdentity = await this.#directoryHandle.stat()
        secureStat(this.#directoryIdentity, true)
        await this.#acquireLock()
        try { this.#snapshot = validateSnapshot(await readPrivate(path.join(this.#directory, 'ledger.json'), MAX_SNAPSHOT_BYTES)) } catch (cause) {
          if (cause.code !== 'ENOENT') throw cause
          await this.#persist(empty())
        }
        this.#initialized = true
        return this
      } catch (cause) {
        try { await this.#releaseLock() } finally { await this.#directoryHandle.close(); this.#directoryHandle = undefined }
        throw cause
      }
    })
  }

  async #persist(snapshot) {
    await this.#checkDirectory()
    const owner = validateLock(await readPrivate(path.join(this.#directory, 'ledger.lock'), 4096))
    if (owner.nonce !== this.#lock.nonce || owner.pid !== process.pid) throw error('TASK_LEDGER_LOCKED', 'ledger lock ownership changed')
    const encoded = JSON.stringify(snapshot)
    if (Buffer.byteLength(encoded) > MAX_SNAPSHOT_BYTES || snapshot.tasks.length > MAX_TASKS || snapshot.events.length > MAX_EVENTS) throw error('TASK_LEDGER_FULL', 'ledger capacity reached; explicit archival required')
    const target = path.join(this.#directory, 'ledger.json')
    try { secureStat(await fs.lstat(target)) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
    const temporary = path.join(this.#directory, `.ledger-${randomUUID()}.tmp`)
    let renamed = false
    try {
      const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
      try { secureStat(await handle.stat()); await handle.writeFile(encoded); await handle.sync() } finally { await handle.close() }
      await this.#checkDirectory()
      try { secureStat(await fs.lstat(target)) } catch (cause) { if (cause.code !== 'ENOENT') throw cause }
      await fs.rename(temporary, target)
      renamed = true
      await this.#directoryHandle.sync()
      this.#snapshot = snapshot
    } catch (cause) {
      if (renamed) this.#poisoned = true
      throw cause
    } finally {
      if (!renamed) { try { await fs.unlink(temporary) } catch (cause) { if (cause.code !== 'ENOENT') throw cause } }
    }
  }

  #withEvent(snapshot, task, type, data) {
    const event = validateTaskEvent({ seq: snapshot.lastSeq + 1, taskId: task.taskId, type, data, createdAt: Math.max(Date.now(), task.updatedAt, snapshot.events.at(-1)?.createdAt || 0) })
    return { snapshot: { ...snapshot, lastSeq: event.seq, events: [...snapshot.events, event] }, event }
  }

  /** Submit a complete queued revision-1 record; matching duplicate returns the CURRENT record without events/writes. */
  submit(value) {
    // Copy/validate now so caller mutation while waiting cannot change intent.
    let record
    try { record = validateTaskRecord(value) } catch (cause) { return Promise.reject(cause) }
    return this.#enqueue(async () => {
      this.#ready()
      const existing = this.#snapshot.tasks.find(task => task.taskId === record.taskId)
      if (existing) {
        if (!sameTaskSubmission(existing, record)) throw error('TASK_DUPLICATE_MISMATCH', 'duplicate taskId differs in immutable submission fields')
        return copy(existing)
      }
      if (record.state !== 'queued' || record.revision !== 1 || record.updatedAt !== record.createdAt) throw new TaskValidationError('new submissions require queued state, revision 1 and equal timestamps')
      const snapshot = { ...this.#snapshot, tasks: [...this.#snapshot.tasks, record] }
      const next = this.#withEvent(snapshot, record, 'task.submitted', { state: record.state, revision: record.revision })
      await this.#persist(next.snapshot)
      return copy(record)
    })
  }

  /** Read detached current record; missing IDs return undefined. */
  get(taskId) {
    return this.#enqueue(() => { this.#ready(); validateId(taskId, 'taskId'); return copy(this.#snapshot.tasks.find(task => task.taskId === taskId)) })
  }

  /** List detached records in submission order. */
  list() { return this.#enqueue(() => { this.#ready(); return copy(this.#snapshot.tasks) }) }

  /**
   * Serialized read/modify/write. Callback receives a detached draft and may mutate
   * it or return a replacement (undefined means draft). Returning null is invalid.
   * Ledger owns revision/updatedAt; caller cannot change them. Each successful call
   * advances one revision and commits one replay event WITH the record/outbox.
   * Optional {eventType,eventData} replaces the default task.updated summary.
   * Callback may be async, but must not call this ledger (would deadlock).
   */
  mutate(taskId, callback, options = {}) {
    let settings
    try {
      validateId(taskId, 'taskId')
      if (typeof callback !== 'function') throw new TaskValidationError('mutation callback is required')
      assertObject(options, ['eventType', 'eventData'], [], 'mutation options')
      settings = cloneJson(options)
    } catch (cause) { return Promise.reject(cause) }
    return this.#enqueue(async () => {
      this.#ready()
      const index = this.#snapshot.tasks.findIndex(task => task.taskId === taskId)
      if (index === -1) throw error('TASK_NOT_FOUND', 'task does not exist')
      const previous = this.#snapshot.tasks[index]
      const draft = copy(previous)
      const returned = await callback(draft)
      const candidate = validateTaskRecord(returned === undefined ? draft : returned)
      if (candidate.revision !== previous.revision || candidate.updatedAt !== previous.updatedAt) throw new TaskValidationError('ledger owns revision and updatedAt')
      candidate.revision = previous.revision + 1
      candidate.updatedAt = Math.max(Date.now(), previous.updatedAt)
      const record = validateTaskTransition(previous, candidate)
      const tasks = [...this.#snapshot.tasks]
      tasks[index] = record
      const next = this.#withEvent({ ...this.#snapshot, tasks }, record, Object.hasOwn(settings, 'eventType') ? settings.eventType : 'task.updated', Object.hasOwn(settings, 'eventData') ? settings.eventData : { state: record.state, revision: record.revision })
      await this.#persist(next.snapshot)
      return copy(record)
    })
  }

  /** Append a bounded application event atomically; does not change the task revision. */
  appendEvent(taskId, type, data) {
    let detached
    try { validateId(taskId, 'taskId'); detached = cloneJson(data) } catch (cause) { return Promise.reject(cause) }
    return this.#enqueue(async () => {
      this.#ready()
      const task = this.#snapshot.tasks.find(task => task.taskId === taskId)
      if (!task) throw error('TASK_NOT_FOUND', 'task does not exist')
      const next = this.#withEvent(this.#snapshot, task, type, detached)
      await this.#persist(next.snapshot)
      return copy(next.event)
    })
  }

  /** Replay events with seq > after in ascending order; default first 100, maximum page size 1000. */
  eventsSince(after = 0, limit = 100) {
    return this.#enqueue(() => {
      this.#ready()
      validateInteger(after, 'after')
      validateInteger(limit, 'limit', 1, 1000)
      return copy(this.#snapshot.events.filter(event => event.seq > after).slice(0, limit))
    })
  }

  /** Drain queued writes and release only our own lock. Idempotent; no methods accepted after close starts. */
  close() {
    if (this.#closed) return Promise.resolve()
    if (this.#closing) return this.#queue
    this.#closing = true
    return this.#enqueue(async () => {
      try { if (this.#directoryHandle) { await this.#checkDirectory(); await this.#releaseLock() } } finally {
        if (this.#directoryHandle) await this.#directoryHandle.close()
        this.#directoryHandle = undefined
        this.#closed = true
        this.#initialized = false
      }
    }, true)
  }
}
