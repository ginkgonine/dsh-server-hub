import { Buffer } from 'node:buffer'

/** Wire protocol and on-disk schema version. No implicit version negotiation. */
export const PROTOCOL_VERSION = 1
/** UTF-8 byte caps; records/events contain summaries, never conversation logs. */
export const LIMITS = Object.freeze({ id: 128, instruction: 32 * 1024, payload: 64 * 1024, record: 128 * 1024, event: 16 * 1024, depth: 16 })
/** Allowed lifecycle states; terminal states cannot be reopened. */
export const TASK_STATES = Object.freeze(['queued', 'dispatching', 'running', 'waiting_execution', 'waiting_human', 'reconciling', 'succeeded', 'failed', 'cancelled'])
const terminal = new Set(['succeeded', 'failed', 'cancelled'])
const transitions = {
  queued: ['dispatching', 'cancelled', 'failed'],
  dispatching: ['running', 'waiting_execution', 'waiting_human', 'reconciling', 'failed', 'cancelled'],
  running: ['waiting_execution', 'waiting_human', 'reconciling', 'succeeded', 'failed', 'cancelled'],
  waiting_execution: ['running', 'waiting_human', 'reconciling', 'succeeded', 'failed', 'cancelled'],
  waiting_human: ['dispatching', 'running', 'waiting_execution', 'reconciling', 'succeeded', 'failed', 'cancelled'],
  reconciling: ['dispatching', 'running', 'waiting_execution', 'waiting_human', 'succeeded', 'failed', 'cancelled'],
}
const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
const immutable = ['taskId', 'nodeId', 'projectId', 'instruction', 'originSessionId', 'createdAt']

/** Validation failure with a stable machine-readable code. */
export class TaskValidationError extends Error {
  constructor(message) { super(message); this.name = 'TaskValidationError'; this.code = 'TASK_VALIDATION' }
}
const fail = message => { throw new TaskValidationError(message) }

/** Assert an ordinary JSON object with own data properties and an exact key allowlist. */
export function assertObject(value, allowed, required = [], label = 'object') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${label} must be a plain object`)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || forbidden.has(key) || !allowed.includes(key)) fail(`${label}: unknown field ${String(key)}`)
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(`${label}.${key} must be an enumerable data property`)
  }
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`${label}.${key} is required`)
  return value
}

/** Bounded path-safe ASCII identifier. Dot, slash, whitespace and reserved object keys are prohibited. */
export function validateId(value, label = 'id') {
  if (typeof value !== 'string' || value.length > LIMITS.id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || forbidden.has(value)) fail(`${label} must be a safe id (1-${LIMITS.id} characters)`)
  return value
}

/** Validate bounded text without NUL; length is measured in UTF-8 bytes. */
export function validateText(value, label, maxBytes, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0') || Buffer.byteLength(value, 'utf8') > maxBytes) fail(`${label} must be bounded text (max ${maxBytes} bytes)`)
  return value
}

/** Validate finite bounded safe integers. */
export function validateInteger(value, label, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label} must be an integer in ${min}..${max}`)
  return value
}

/** Reject unsafe JSON values, accessors, cycles, prototype keys and oversized payloads; return a detached copy. */
export function cloneJson(value, maxBytes = LIMITS.payload, label = 'payload') {
  const seen = new Set()
  const walk = (item, depth) => {
    if (depth > LIMITS.depth) fail(`${label} exceeds nesting limit`)
    if (item === null || typeof item === 'boolean' || typeof item === 'string') {
      if (typeof item === 'string' && item.includes('\0')) fail(`${label} contains NUL`)
      return
    }
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item !== 'object' || !item || seen.has(item)) fail(`${label} must contain only acyclic JSON data`)
    seen.add(item)
    if (Array.isArray(item)) {
      if (Object.getPrototypeOf(item) !== Array.prototype) fail(`${label} contains an invalid array`)
      for (const key of Reflect.ownKeys(item)) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length) fail(`${label} contains an invalid array property`)
        const d = Object.getOwnPropertyDescriptor(item, key)
        if (!d.enumerable || !Object.hasOwn(d, 'value')) fail(`${label} contains an accessor`)
      }
      for (let index = 0; index < item.length; index += 1) {
        if (!Object.hasOwn(item, index)) fail(`${label} contains a sparse array`)
        walk(Object.getOwnPropertyDescriptor(item, String(index)).value, depth + 1)
      }
    } else {
      assertObject(item, Object.keys(item), [], label)
      for (const key of Object.keys(item)) walk(Object.getOwnPropertyDescriptor(item, key).value, depth + 1)
    }
    seen.delete(item)
  }
  walk(value, 0)
  const encoded = JSON.stringify(value)
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`)
  return JSON.parse(encoded)
}

const submitKeys = ['version', 'taskId', 'nodeId', 'projectId', 'instruction', 'originSessionId']
/** Validate a v1 submit envelope. Callers cannot supply cwd, preset, policies or execution settings. */
export function validateSubmit(value) {
  assertObject(value, submitKeys, ['version', 'taskId', 'nodeId', 'projectId', 'instruction'], 'submit')
  const input = cloneJson(value, LIMITS.payload, 'submit')
  if (input.version !== PROTOCOL_VERSION) fail('unsupported protocol version')
  for (const key of ['taskId', 'nodeId', 'projectId', 'originSessionId']) if (Object.hasOwn(input, key)) validateId(input[key], key)
  validateText(input.instruction, 'instruction', LIMITS.instruction)
  return input
}

/** Decode bounded wire JSON and validate the exact v1 submit schema. */
export function parseSubmit(payload) {
  if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) fail('wire payload must be text or a Buffer')
  if (Buffer.byteLength(payload) > LIMITS.payload) fail('wire payload exceeds limit')
  let value
  try { value = JSON.parse(typeof payload === 'string' ? payload : new TextDecoder('utf-8', { fatal: true }).decode(payload)) } catch { fail('invalid JSON payload') }
  return validateSubmit(value)
}

/** Durable delivery intent stored atomically inside its task. Integration owns transport and retry scheduling. */
export function validateOutbox(value) {
  assertObject(value, ['id', 'type', 'status', 'attempts', 'createdAt', 'updatedAt', 'nextAttemptAt', 'lastError', 'payload'], ['id', 'type', 'status', 'attempts', 'createdAt', 'updatedAt'], 'outbox')
  const copy = cloneJson(value, LIMITS.payload, 'outbox')
  validateId(copy.id, 'outbox.id')
  if (!['dispatch', 'resume', 'cancel', 'notification'].includes(copy.type)) fail('invalid outbox.type')
  if (!['pending', 'sending', 'sent'].includes(copy.status)) fail('invalid outbox.status')
  validateInteger(copy.attempts, 'outbox.attempts', 0, 1_000_000)
  for (const key of ['createdAt', 'updatedAt', 'nextAttemptAt']) if (Object.hasOwn(copy, key)) validateInteger(copy[key], `outbox.${key}`)
  if (copy.updatedAt < copy.createdAt) fail('outbox timestamps are out of order')
  if (Object.hasOwn(copy, 'lastError')) validateText(copy.lastError, 'outbox.lastError', 4096, true)
  return copy
}

const recordKeys = ['taskId', 'nodeId', 'projectId', 'instruction', 'originSessionId', 'state', 'revision', 'createdAt', 'updatedAt', 'remoteSessionId', 'requestId', 'executionId', 'result', 'error', 'notification', 'outbox']
/** Validate and detach a complete source-of-truth record. Result/error/notification are bounded JSON summaries. */
export function validateTaskRecord(value) {
  assertObject(value, recordKeys, ['taskId', 'nodeId', 'projectId', 'instruction', 'state', 'revision', 'createdAt', 'updatedAt'], 'task')
  const record = cloneJson(value, LIMITS.record, 'task')
  for (const key of ['taskId', 'nodeId', 'projectId', 'originSessionId', 'remoteSessionId', 'requestId', 'executionId']) if (Object.hasOwn(record, key)) validateId(record[key], key)
  validateText(record.instruction, 'instruction', LIMITS.instruction)
  if (!TASK_STATES.includes(record.state)) fail('invalid task state')
  validateInteger(record.revision, 'revision', 1)
  validateInteger(record.createdAt, 'createdAt')
  validateInteger(record.updatedAt, 'updatedAt', record.createdAt)
  for (const key of ['result', 'error', 'notification']) if (Object.hasOwn(record, key)) cloneJson(record[key], LIMITS.event, key)
  if (Object.hasOwn(record, 'outbox')) record.outbox = validateOutbox(record.outbox)
  return record
}

/** Check immutable identity/origin/instruction, legal lifecycle movement and exactly one revision increment. */
export function validateTaskTransition(before, after) {
  const previous = validateTaskRecord(before)
  const next = validateTaskRecord(after)
  for (const key of immutable) if (Object.hasOwn(previous, key) !== Object.hasOwn(next, key) || previous[key] !== next[key]) fail(`${key} is immutable`)
  if (next.revision !== previous.revision + 1) fail('revision must increment exactly once')
  if (next.updatedAt < previous.updatedAt) fail('updatedAt must not move backwards')
  if (next.state !== previous.state && (terminal.has(previous.state) || !transitions[previous.state]?.includes(next.state))) fail(`invalid transition ${previous.state} -> ${next.state}`)
  return next
}

/** True only when a duplicate submission matches all immutable fields, including optional origin presence. */
export function sameTaskSubmission(left, right) {
  return immutable.filter(key => key !== 'createdAt').every(key => Object.hasOwn(left, key) === Object.hasOwn(right, key) && left[key] === right[key])
}

/** Validate a persisted replay event (sequence is global, strictly monotonic). */
export function validateTaskEvent(value) {
  assertObject(value, ['seq', 'taskId', 'type', 'data', 'createdAt'], ['seq', 'taskId', 'type', 'data', 'createdAt'], 'event')
  const event = cloneJson(value, LIMITS.event, 'event')
  validateInteger(event.seq, 'event.seq', 1)
  validateId(event.taskId, 'event.taskId')
  validateText(event.type, 'event.type', 128)
  if (!/^[a-z][a-z0-9_.-]*$/.test(event.type)) fail('invalid event type')
  validateInteger(event.createdAt, 'event.createdAt')
  return event
}
