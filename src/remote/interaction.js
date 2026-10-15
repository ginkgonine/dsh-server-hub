import { randomUUID } from 'node:crypto'

export const MAX_INTERACTIONS = 8
export const MAX_INTERACTION_BYTES = 32 * 1024
const fail = message => { throw Object.assign(new Error(message), { code: 'REMOTE_INPUT' }) }
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value))

// Read only declared data fields. Live Agent/AbortSignal and unknown fields never
// enter the transport, even when an unknown field contains a cyclic object.
function fields(value, allowed, strict) {
  if (!plain(value)) fail('Expected a plain interaction object')
  if (strict && Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key))) fail('Unknown interaction field')
  const result = {}
  for (const key of allowed) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor) continue
    if (!descriptor.enumerable || !('value' in descriptor) || descriptor.value === undefined) fail('Expected a JSON interaction data field')
    Object.defineProperty(result, key, { value: descriptor.value, enumerable: true })
  }
  return result
}
function text(value, label, nonempty = true) {
  if (typeof value !== 'string' || !value.isWellFormed() || (nonempty && !value.trim()) ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) ||
      Buffer.byteLength(value, 'utf8') > MAX_INTERACTION_BYTES) fail(`Invalid interaction ${label}`)
  return value
}
function list(value, label, min = 0, max = 256) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1 || value.length < min || value.length > max) fail(`Invalid interaction ${label}`)
  return value
}
function bounded(value) {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_INTERACTION_BYTES) fail('Interaction payload exceeds 32 KiB')
  return value
}
function question(value, strict) {
  const source = fields(value, ['id', 'question', 'detail', 'header', 'options', 'multiSelect', 'intent'], strict)
  const result = { id: text(source.id, 'question id'), question: text(source.question, 'question') }
  for (const key of ['detail', 'header']) if (Object.hasOwn(source, key)) result[key] = text(source[key], key, false)
  if (Object.hasOwn(source, 'multiSelect')) {
    if (typeof source.multiSelect !== 'boolean') fail('Invalid interaction multiSelect')
    result.multiSelect = source.multiSelect
  }
  if (Object.hasOwn(source, 'options')) {
    const seen = new Set()
    result.options = list(source.options, 'options').map(value => {
      const option = fields(value, ['label', 'description'], strict)
      const label = text(option.label, 'option label')
      if (seen.has(label)) fail('Duplicate interaction option label')
      seen.add(label)
      return { label, ...(Object.hasOwn(option, 'description') ? { description: text(option.description, 'option description', false) } : {}) }
    })
  }
  if (Object.hasOwn(source, 'intent')) {
    const intent = fields(source.intent, ['kind', 'approve', 'callId'], strict)
    if (intent.kind !== 'plan-review') fail('Unsupported interaction intent')
    const approve = text(intent.approve, 'intent approve')
    if (!Object.hasOwn(result, 'detail') || !(result.options || []).some(option => option.label === approve)) fail('Invalid interaction review intent')
    result.intent = { kind: 'plan-review', approve,
      ...(Object.hasOwn(intent, 'callId') ? { callId: text(intent.callId, 'intent callId') } : {}) }
  }
  return result
}
function payload(kind, value, strict) {
  if (kind === 'questions') {
    const source = fields(value, ['questions'], strict)
    const questions = list(source.questions, 'questions', 1).map(value => question(value, strict))
    if (new Set(questions.map(item => item.id)).size !== questions.length) fail('Duplicate interaction question id')
    return { questions }
  }
  if (kind !== 'approval') fail('Unsupported interaction kind')
  const source = fields(value, ['toolName', 'callId', 'reason', 'displayReason'], strict)
  const result = { toolName: text(source.toolName, 'toolName') }
  for (const key of ['callId', 'reason']) if (Object.hasOwn(source, key)) result[key] = text(source[key], key, key !== 'reason')
  if (Object.hasOwn(source, 'displayReason')) {
    if (!plain(source.displayReason)) fail('Invalid interaction displayReason')
    const entries = Reflect.ownKeys(source.displayReason).map(key => {
      if (typeof key !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/.test(key) || ['constructor', '__proto__', 'prototype'].includes(key)) fail('Invalid interaction locale')
      const descriptor = Object.getOwnPropertyDescriptor(source.displayReason, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) fail('Invalid interaction locale data')
      return [key, text(descriptor.value, 'localized reason', false)]
    })
    if (!entries.some(([key]) => key === 'en')) fail('Interaction displayReason requires en')
    result.displayReason = Object.fromEntries(entries)
  }
  return result
}
function metadata(id, createdAt) {
  if (typeof id !== 'string' || !/^request-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(id)) fail('Invalid interaction request id')
  if (!Number.isSafeInteger(createdAt) || createdAt < 0 || Object.is(createdAt, -0)) fail('Invalid interaction creation time')
  return { id, createdAt }
}

/** Project a borrowed native request to a bounded, detached wire value. */
export function serializeInteraction(kind, request, { id = `request-${randomUUID()}`, createdAt = Date.now() } = {}) {
  return bounded({ ...metadata(id, createdAt), kind, ...payload(kind, request, false) })
}

/** Validate an untrusted snapshot. Legacy human-only flags are ignored. */
export function normalizeInteractions(requests) {
  if (requests === undefined) return []
  const seen = new Set()
  const result = list(requests, 'requests', 0, MAX_INTERACTIONS).map(value => {
    const source = fields(value, ['id', 'kind', 'requiresHuman', 'createdAt', 'questions', 'toolName', 'callId', 'reason', 'displayReason'], true)
    const allowed = source.kind === 'questions' ? ['questions'] : ['toolName', 'callId', 'reason', 'displayReason']
    if (Object.keys(source).some(key => !['id', 'kind', 'requiresHuman', 'createdAt', ...allowed].includes(key))) fail('Fields do not match interaction kind')
    const data = Object.fromEntries(allowed.filter(key => Object.hasOwn(source, key)).map(key => [key, source[key]]))
    const projected = { ...metadata(source.id, source.createdAt), kind: source.kind, ...payload(source.kind, data, true) }
    if (Object.hasOwn(source, 'requiresHuman') && typeof source.requiresHuman !== 'boolean') fail('Invalid legacy interaction flag')
    if (seen.has(projected.id)) fail('Duplicate interaction request id')
    seen.add(projected.id)
    return projected
  })
  return bounded(result)
}

/** Validate a decision from the owning controller without imposing a UI channel. */
export function validateInteractionResponse(interaction, input) {
  const [request] = normalizeInteractions([interaction])
  if (request.kind === 'approval') {
    const source = fields(input, ['outcome'], true)
    if (!['allowed-once', 'rejected', 'cancelled', 'unavailable'].includes(source.outcome)) fail('Invalid approval outcome')
    return source.outcome
  }
  const source = fields(input, ['answers'], true)
  const items = list(source.answers, 'answers', request.questions.length, request.questions.length)
  const byId = new Map()
  for (const value of items) {
    const answer = fields(value, ['id', 'selected', 'custom'], true)
    const id = text(answer.id, 'answer id')
    if (byId.has(id)) fail('Duplicate answer id')
    const selected = list(answer.selected, 'selected').map(value => text(value, 'selected label'))
    if (new Set(selected).size !== selected.length) fail('Duplicate selected label')
    byId.set(id, { id, selected, ...(Object.hasOwn(answer, 'custom') ? { custom: text(answer.custom, 'custom answer') } : {}) })
  }
  const answers = request.questions.map(item => {
    const answer = byId.get(item.id)
    if (!answer) fail('Answers must match the question ids')
    const labels = (item.options || []).map(option => option.label)
    if (answer.selected.some(label => !labels.includes(label))) fail('Unknown selected option')
    if (item.multiSelect !== true && (answer.selected.length > 1 || (answer.selected.length > 0 && answer.custom !== undefined))) fail('Single-select question accepts one answer')
    if (!answer.selected.length && answer.custom === undefined) fail('Question requires an option or custom answer')
    return { ...answer, selected: labels.filter(label => answer.selected.includes(label)) }
  })
  return bounded({ answers })
}
