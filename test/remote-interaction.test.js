import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_INTERACTION_BYTES, serializeInteraction, normalizeInteractions, validateInteractionResponse } from '../src/remote/interaction.js'

const questions = () => ({ questions: [{ id: 'choice', question: 'Choose a mode', header: 'Mode', detail: 'Supporting detail',
  options: [{ label: 'Safe', description: 'Read only' }, { label: 'Fast' }], multiSelect: false }] })
const approval = () => ({ toolName: 'bash', callId: 'call-1', reason: 'Remote command needs permission', displayReason: { en: 'Allow once?', 'zh-CN': '允许一次？' } })
const wire = (kind, request) => serializeInteraction(kind, request, { id: 'request-1', createdAt: 1 })
const input = () => ({ answers: [{ id: 'choice', selected: ['Safe'] }] })
const bad = callback => assert.throws(callback, { code: 'REMOTE_INPUT' })

test('native interaction serialization projects a detached whitelist, never Agent/signal/unknown data', () => {
  const cycle = {}; cycle.secret = cycle
  const request = { ...questions(), agent: cycle, signal: new AbortController().signal, secret: cycle }
  request.questions[0].extra = cycle
  request.questions[0].options[0].secret = cycle
  const projected = wire('questions', request)
  assert.deepEqual(projected, { id: 'request-1', createdAt: 1, kind: 'questions', ...questions() })
  projected.questions[0].question = 'changed'
  assert.equal(request.questions[0].question, 'Choose a mode')
  assert.deepEqual(wire('approval', { ...approval(), agent: cycle, command: cycle }),
    { id: 'request-1', createdAt: 1, kind: 'approval', ...approval() })
})

test('wire snapshots enforce exact keys, unique IDs and aggregate bounds while ignoring legacy human flags', () => {
  const original = [wire('questions', questions())]
  assert.deepEqual(normalizeInteractions(undefined), [])
  const normalized = normalizeInteractions(original)
  normalized[0].questions[0].options[0].label = 'changed'
  assert.equal(original[0].questions[0].options[0].label, 'Safe')
  bad(() => normalizeInteractions([{ ...original[0], signal: {} }]))
  for (const requiresHuman of [false, true]) {
    assert.deepEqual(normalizeInteractions([{ ...original[0], requiresHuman }]), original)
    const request = wire('approval', approval())
    const [normalizedApproval] = normalizeInteractions([{ ...request, requiresHuman }])
    assert.deepEqual(normalizedApproval, request)
    assert.equal(validateInteractionResponse(normalizedApproval, { outcome: 'allowed-once' }), 'allowed-once')
  }
  bad(() => normalizeInteractions([{ ...original[0], requiresHuman: 'true' }]))
  bad(() => normalizeInteractions([{ ...original[0], requiresHuman: null }]))
  bad(() => normalizeInteractions([original[0], original[0]]))
  bad(() => normalizeInteractions(Array.from({ length: 9 }, (_, index) => ({ ...original[0], id: `request-${index}` }))))
  bad(() => normalizeInteractions([{ ...original[0], questions: [{ ...original[0].questions[0], injected: 'data' }] }]))
  const large = wire('questions', { questions: [{ id: 'q', question: '问'.repeat(5000) }] })
  bad(() => normalizeInteractions([large, { ...large, id: 'request-2' }, { ...large, id: 'request-3' }]))
})

test('invalid/oversized text, duplicate stable identifiers and labels are rejected, never truncated', () => {
  bad(() => wire('questions', { questions: [{ id: 'x', question: 'x\0y' }] }))
  bad(() => wire('questions', { questions: [{ id: 'x', question: '\ud800' }] }))
  bad(() => wire('questions', { questions: [{ id: 'x', question: 'a'.repeat(MAX_INTERACTION_BYTES) }] }))
  bad(() => wire('questions', { questions: [{ id: 'x', question: 'x' }, { id: 'x', question: 'y' }] }))
  bad(() => wire('questions', { questions: [{ id: 'x', question: 'x', options: [{ label: 'same' }, { label: 'same' }] }] }))
  const id = 'id'.repeat(100), label = 'label'.repeat(100)
  const projected = wire('questions', { questions: [{ id, question: 'Choose', options: [{ label }] }] })
  assert.equal(projected.questions[0].id, id)
  assert.equal(projected.questions[0].options[0].label, label)
  assert.deepEqual(validateInteractionResponse(projected, { answers: [{ id, selected: [label] }] }), { answers: [{ id, selected: [label] }] })
})

test('approval decisions and plan-review answers accept ordinary controller replies without a human capability', () => {
  const request = wire('approval', approval())
  assert.equal('requiresHuman' in request, false)
  for (const outcome of ['allowed-once', 'rejected', 'cancelled', 'unavailable']) {
    assert.equal(validateInteractionResponse(request, { outcome }), outcome)
  }
  bad(() => validateInteractionResponse(request, { outcome: 'always' }))
  bad(() => validateInteractionResponse(request, { outcome: 'allowed-once', human: true }))
  const review = questions()
  review.questions[0].intent = { kind: 'plan-review', approve: 'Safe', callId: 'remote-call' }
  const plan = wire('questions', review)
  assert.equal('requiresHuman' in plan, false)
  assert.deepEqual(plan.questions[0].intent, review.questions[0].intent)
  for (const selected of [['Safe'], ['Fast']]) {
    const response = { answers: [{ id: 'choice', selected }] }
    assert.deepEqual(validateInteractionResponse(plan, response), response)
    for (const requiresHuman of [false, true]) {
      const [normalized] = normalizeInteractions([{ ...plan, requiresHuman }])
      assert.deepEqual(normalized, plan)
      assert.deepEqual(validateInteractionResponse(normalized, response), response)
    }
  }
  bad(() => wire('questions', { questions: [{ ...review.questions[0], intent: { kind: 'plan-review', approve: 'missing' } }] }))
})

test('question responses exactly match IDs, options and single-select semantics', () => {
  const request = wire('questions', questions())
  assert.deepEqual(validateInteractionResponse(request, input()), input())
  assert.deepEqual(validateInteractionResponse(request, { answers: [{ id: 'choice', selected: [], custom: 'Other mode' }] }),
    { answers: [{ id: 'choice', selected: [], custom: 'Other mode' }] })
  for (const value of [
    { answers: [] }, { answers: [{ id: 'unknown', selected: ['Safe'] }] },
    { answers: [{ id: 'choice', selected: ['unknown'] }] },
    { answers: [{ id: 'choice', selected: [] }] },
    { answers: [{ id: 'choice', selected: [], custom: ' ' }] },
    { answers: [{ id: 'choice', selected: ['Safe', 'Fast'] }] },
    { answers: [{ id: 'choice', selected: ['Safe', 'Safe'] }] },
    { answers: [{ id: 'choice', selected: ['Safe'], custom: 'Other' }] },
    { answers: [{ id: 'choice', selected: ['Safe'], extra: true }] },
    { answers: [{ id: 'choice', selected: ['Safe'] }], outcome: 'allowed-once' },
  ]) bad(() => validateInteractionResponse(request, value))
})

test('multi-select responses normalize to question and option order for stable receipts', () => {
  const request = wire('questions', { questions: [
    { id: 'a', question: 'Choose', multiSelect: true, options: [{ label: 'one' }, { label: 'two' }] },
    { id: 'b', question: 'Explain' },
  ] })
  assert.deepEqual(validateInteractionResponse(request, { answers: [
    { id: 'b', selected: [], custom: 'text' }, { id: 'a', selected: ['two', 'one'], custom: 'extra' },
  ] }), { answers: [{ id: 'a', selected: ['one', 'two'], custom: 'extra' }, { id: 'b', selected: [], custom: 'text' }] })
  bad(() => validateInteractionResponse(request, { answers: [{ id: 'a', selected: ['one'] }, { id: 'a', selected: ['two'] }] }))
})
