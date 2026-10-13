import path from 'node:path'
import { assertObject, cloneJson, LIMITS, TaskValidationError, validateId, validateInteger, validateSubmit, validateText } from './protocol.js'

const fail = message => { throw new TaskValidationError(message) }
export const DEFAULT_TASK_TOOLS = Object.freeze(['run_code', 'bash', 'read', 'read_image', 'write', 'edit', 'glob', 'grep', 'ask_user_question',
  'job_list', 'job_output', 'job_kill', 'todo_write', 'skill', 'web_search', 'web_fetch', 'present',
  'remote_task_finish', 'remote_task_park', 'remote_execution_start', 'remote_execution_observe', 'remote_execution_status', 'remote_execution_stop'])

function absolutePath(value, label) {
  validateText(value, label, 4096)
  if (!path.isAbsolute(value)) fail(`${label} must be absolute`)
  return path.resolve(value)
}

function ids(value, label) {
  if (!Array.isArray(value) || value.length > 256) fail(`${label} must be an array of at most 256 ids`)
  const result = value.map(id => validateId(id, label))
  if (new Set(result).size !== result.length) fail(`${label} contains duplicates`)
  return result
}

function token(value, label) {
  validateText(value, label, 4096)
  if (value.length < 32 || /\s/.test(value) || /[^\x21-\x7e]/.test(value)) fail(`${label} must be at least 32 printable ASCII characters without whitespace`)
  if (/^(REPLACE|CHANGE_ME|YOUR_SECRET)/i.test(value)) fail(`${label} must not use an example placeholder`)
  return value
}

/** Canonical endpoint: HTTP only to literal loopback/localhost; HTTPS everywhere else. No credentials/query/fragment. */
export function validateEndpoint(value) {
  validateText(value, 'endpoint', 2048)
  if (value !== value.trim() || /[\u0000-\u0020\u007f\\]/.test(value)) fail('invalid endpoint characters')
  let url
  try { url = new URL(value) } catch { fail('invalid endpoint URL') }
  if (url.username || url.password || url.search || url.hash) fail('endpoint may not contain credentials, query or fragment')
  // URL normalizes IPv4 aliases such as 2130706433; reject those rather than silently expanding trust.
  const authority = value.match(/^https?:\/\/([^/]+)/i)?.[1]
  if (!authority) fail('endpoint must use http or https')
  const rawHost = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.split(':')[0]
  const hostname = url.hostname.toLowerCase()
  const loopback = hostname === 'localhost' || hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) fail('non-loopback endpoints require https')
  if (url.protocol === 'http:' && rawHost.toLowerCase() !== hostname) fail('HTTP endpoint must use a canonical loopback hostname')
  return url.href.replace(/\/$/, '')
}

/** Explicit remote node; projects, when present, restrict submission to these preconfigured remote IDs. */
export function validateNodeConfig(value) {
  assertObject(value, ['nodeId', 'endpoint', 'token', 'projects'], ['nodeId', 'endpoint', 'token'], 'node')
  const node = cloneJson(value, LIMITS.payload, 'node')
  validateId(node.nodeId, 'node.nodeId')
  node.endpoint = validateEndpoint(node.endpoint)
  node.token = token(node.token, 'node.token')
  if (Object.hasOwn(node, 'projects')) node.projects = ids(node.projects, 'node.projects')
  return node
}

/** Trusted worker project mapping. Submit requests never override these execution settings. */
export function validateProjectConfig(value) {
  assertObject(value, ['id', 'root', 'agentPreset', 'approvalPolicy', 'mode', 'allowPartial', 'resources', 'stepLimit', 'activeTimeoutMs', 'allowedTools'], ['id', 'root', 'agentPreset'], 'project')
  const project = cloneJson(value, LIMITS.payload, 'project')
  validateId(project.id, 'project.id')
  project.root = absolutePath(project.root, 'project.root')
  validateId(project.agentPreset, 'project.agentPreset')
  if (!Object.hasOwn(project, 'approvalPolicy')) project.approvalPolicy = 'ask'
  if (!['ask', 'never'].includes(project.approvalPolicy)) fail('project.approvalPolicy must be ask or never')
  if (!Object.hasOwn(project, 'mode')) project.mode = 'workspace-write'
  if (project.mode !== 'workspace-write') fail('project.mode must be workspace-write')
  if (!Object.hasOwn(project, 'allowPartial')) project.allowPartial = false
  if (typeof project.allowPartial !== 'boolean') fail('project.allowPartial must be boolean')
  project.resources = ids(Object.hasOwn(project, 'resources') ? project.resources : [], 'project.resources')
  project.allowedTools = ids(project.allowedTools || [...DEFAULT_TASK_TOOLS], 'project.allowedTools')
  if (!project.allowedTools.includes('remote_task_finish')) fail('project.allowedTools must include remote_task_finish')
  if (!Object.hasOwn(project, 'stepLimit')) project.stepLimit = 20
  validateInteger(project.stepLimit, 'project.stepLimit', 1, 1000)
  if (!Object.hasOwn(project, 'activeTimeoutMs')) project.activeTimeoutMs = 600_000
  validateInteger(project.activeTimeoutMs, 'project.activeTimeoutMs', 1000, 86_400_000)
  return project
}

/** Strict disabled-by-default controller/worker configuration. Missing credentials never imply automatic discovery. */
export function validateTaskConfig(value = {}) {
  assertObject(value, ['enabled', 'stateDirectory', 'nodeId', 'token', 'nodes', 'projects', 'supervisor'], [], 'tasks config')
  const input = cloneJson(value, 1024 * 1024, 'tasks config')
  const config = { enabled: false, nodes: [], projects: [], ...input }
  if (typeof config.enabled !== 'boolean') fail('enabled must be boolean')
  if (!Array.isArray(config.nodes) || config.nodes.length > 256 || !Array.isArray(config.projects) || config.projects.length > 256) fail('nodes/projects must be arrays of at most 256 entries')
  config.nodes = config.nodes.map(validateNodeConfig)
  config.projects = config.projects.map(validateProjectConfig)
  if (new Set(config.nodes.map(node => node.nodeId)).size !== config.nodes.length) fail('duplicate nodeId')
  if (new Set(config.projects.map(project => project.id)).size !== config.projects.length) fail('duplicate project id')
  if (Object.hasOwn(config, 'stateDirectory')) config.stateDirectory = absolutePath(config.stateDirectory, 'stateDirectory')
  else if (config.enabled) fail('enabled tasks require stateDirectory')
  if (Object.hasOwn(config, 'nodeId')) validateId(config.nodeId, 'nodeId')
  if (Object.hasOwn(config, 'token')) config.token = token(config.token, 'token')
  if (config.projects.length && (!config.nodeId || !config.token)) fail('worker projects require explicit local nodeId and token')
  if (config.nodeId && config.nodes.some(node => node.nodeId === config.nodeId)) fail('local nodeId must not also name a remote node')
  if (config.supervisor !== undefined) {
    assertObject(config.supervisor, ['stateDirectory', 'secretFile', 'controlBoundaryVerified', 'environment', 'allowPartial'], ['stateDirectory', 'secretFile', 'controlBoundaryVerified'], 'supervisor')
    if (config.supervisor.controlBoundaryVerified !== true) fail('supervisor requires an explicitly verified agent-inaccessible control/key boundary')
    config.supervisor.stateDirectory = absolutePath(config.supervisor.stateDirectory, 'supervisor.stateDirectory')
    config.supervisor.secretFile = absolutePath(config.supervisor.secretFile, 'supervisor.secretFile')
    if (config.supervisor.allowPartial !== undefined && typeof config.supervisor.allowPartial !== 'boolean') fail('supervisor.allowPartial must be boolean')
    config.supervisor.environment ??= {}
    assertObject(config.supervisor.environment, ['PATH', 'LANG', 'LC_ALL', 'CUDA_VISIBLE_DEVICES'], [], 'supervisor.environment')
    for (const [key, value] of Object.entries(config.supervisor.environment)) validateText(value, `supervisor.environment.${key}`, 4096, true)
  }
  return config
}

/** Resolve only explicitly configured destinations. Returned settings are detached, not caller-controlled. */
export function resolveTaskTarget(value, request) {
  const config = validateTaskConfig(value)
  const submit = validateSubmit(request)
  if (!config.enabled) fail('tasks are disabled')
  if (submit.nodeId === config.nodeId) {
    const project = config.projects.find(project => project.id === submit.projectId)
    if (!project) fail('unknown local project')
    return { nodeId: config.nodeId, project }
  }
  const node = config.nodes.find(node => node.nodeId === submit.nodeId)
  if (!node || (node.projects && !node.projects.includes(submit.projectId))) fail('unknown or disallowed remote target')
  return { node }
}
