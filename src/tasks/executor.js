// Trusted-host primitives, not an agent command API. Deployment MUST place stateDir
// and secretFile outside every agent-writable mount/UID boundary. 0700/0600 cannot
// isolate an agent running as the supervisor's own OS user. The signing adapter
// MUST validate a real confinement wrapper; an argv array alone is not confinement.
import { constants, readFileSync, writeSync } from 'node:fs'
import { lstat, mkdir, open, readFile, realpath, rename, unlink } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const VERSION = 1
const MAX_JSON = 128 * 1024
const MAX_TTL = 10 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/
const NOFOLLOW = constants.O_NOFOLLOW
const DEFAULT_LOG_CAP = 8 * 1024 * 1024
let activeExecution = null // One execution per OS supervisor, including direct callers.

function fail(message) { throw new Error(message) }
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function keyBytes(secret) {
  const key = Buffer.isBuffer(secret) ? secret : typeof secret === 'string' ? Buffer.from(secret) : null
  if (!key || key.length < 32) fail('A configured HMAC secret of at least 32 bytes is required')
  return key
}
export function commandDigest(argv) {
  if (!Array.isArray(argv) || !argv.length || argv.some(arg => typeof arg !== 'string' || arg.includes('\0'))) fail('Expected confinedArgv array')
  return createHash('sha256').update(canonical(argv)).digest('hex')
}
function inside(root, path) {
  const part = relative(root, path)
  return part === '' || (!part.startsWith(`..${sep}`) && part !== '..' && !isAbsolute(part))
}
async function canonicalDirectory(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) fail(`${label} must be an explicit canonical absolute directory`)
  if (await realpath(path) !== path || !(await lstat(path)).isDirectory()) fail(`${label} must be an existing canonical directory`)
  return path
}
function validatePayload(payload, { allowedEnvironmentKeys = [], allowPartial = false, now = Date.now(), secret } = {}) {
  if (!payload || payload.version !== VERSION || typeof payload.executionId !== 'string' || typeof payload.projectId !== 'string' || !ID.test(payload.executionId) || !ID.test(payload.projectId)) fail('Invalid launch identity')
  const fields = ['version', 'executionId', 'projectId', 'workspaceRoot', 'cwd', 'confinedArgv', 'enforcement', 'policy', 'commandDigest', 'issuedAt', 'expiresAt', 'environment']
  if (Object.keys(payload).length !== fields.length || fields.some(key => !Object.hasOwn(payload, key))) fail('Invalid launch ticket fields')
  if (payload.policy !== 'workspace-write') fail('Only workspace-write policy is supported')
  if (payload.enforcement !== 'full' && !(payload.enforcement === 'partial' && allowPartial === true)) fail('Partial confinement requires explicit deployment opt-in')
  if (!Array.isArray(payload.confinedArgv) || !payload.confinedArgv.length || !isAbsolute(payload.confinedArgv[0]) || payload.commandDigest !== commandDigest(payload.confinedArgv)) fail('Invalid confined command digest')
  if (!Number.isSafeInteger(payload.issuedAt) || !Number.isSafeInteger(payload.expiresAt) || payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt || payload.expiresAt - payload.issuedAt > MAX_TTL) fail('Launch ticket is stale or has invalid validity interval')
  if (!payload.environment || typeof payload.environment !== 'object' || Array.isArray(payload.environment)) fail('Invalid ticket environment')
  if (!Array.isArray(allowedEnvironmentKeys) || allowedEnvironmentKeys.some(key => typeof key !== 'string' || !ENV_KEY.test(key))) fail('Invalid deployment environment allowlist')
  const allowed = new Set(allowedEnvironmentKeys)
  for (const [key, value] of Object.entries(payload.environment)) {
    if (!ENV_KEY.test(key) || !allowed.has(key) || typeof value !== 'string' || value.includes('\0')) fail(`Environment key is not allowed: ${key}`)
    if (secret) {
      const signingKey = keyBytes(secret)
      if ([signingKey.toString('utf8'), signingKey.toString('hex'), signingKey.toString('base64')].some(encoded => value.includes(encoded))) fail('Signing secret must not pass through the ticket environment')
    }
  }
  if (Buffer.byteLength(canonical(payload)) > MAX_JSON - 128) fail('Launch ticket is too large')
}
async function validateDirectories(payload) {
  await canonicalDirectory(payload.workspaceRoot, 'workspaceRoot')
  await canonicalDirectory(payload.cwd, 'cwd')
  if (!inside(payload.workspaceRoot, payload.cwd)) fail('cwd is outside workspaceRoot')
}

// validateConfinement is supplied ONLY by the trusted host, never from model input.
// Its attestation is not an OS sandbox: it must inspect the wrapper, policy and
// namespace/mount configuration before returning validated:true. Partial mode
// requires both the host signer and independent runner configuration to opt in.
export async function issueLaunchTicket(input, { secret, validateConfinement, allowedEnvironmentKeys = [], allowPartial = false, now = Date.now(), ttlMs = 60_000 } = {}) {
  if (typeof validateConfinement !== 'function') fail('Trusted host confinement validation is required')
  const payload = {
    version: VERSION, executionId: input.executionId, projectId: input.projectId,
    workspaceRoot: input.workspaceRoot, cwd: input.cwd,
    confinedArgv: Array.isArray(input.confinedArgv) ? [...input.confinedArgv] : input.confinedArgv,
    enforcement: input.enforcement, policy: input.policy,
    commandDigest: commandDigest(input.confinedArgv), issuedAt: now, expiresAt: now + ttlMs,
    environment: { ...(input.environment || {}) },
  }
  keyBytes(secret)
  validatePayload(payload, { allowedEnvironmentKeys, allowPartial, now, secret })
  await validateDirectories(payload)
  const attestation = await validateConfinement(JSON.parse(canonical(payload)))
  if (attestation?.validated !== true || attestation.enforcement !== payload.enforcement || attestation.policy !== payload.policy || attestation.commandDigest !== payload.commandDigest) fail('Trusted host did not attest confinement of this exact command')
  return { payload, signature: createHmac('sha256', keyBytes(secret)).update(canonical(payload)).digest('hex') }
}

export async function verifyLaunchTicket(ticket, options = {}) {
  if (!ticket || Object.keys(ticket).length !== 2 || !ticket.payload || typeof ticket.signature !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.signature)) fail('Invalid signed launch ticket')
  const expected = createHmac('sha256', keyBytes(options.secret)).update(canonical(ticket.payload)).digest()
  if (!timingSafeEqual(expected, Buffer.from(ticket.signature, 'hex'))) fail('Launch ticket signature mismatch')
  // Snapshot to prevent mutation by a caller while asynchronous checks run.
  const payload = JSON.parse(canonical(ticket.payload))
  validatePayload(payload, options)
  await validateDirectories(payload)
  return payload
}

async function noSymlinkComponents(path) {
  const absolute = resolve(path)
  let cursor = absolute
  for (;;) {
    const info = await lstat(cursor)
    if (info.isSymbolicLink()) fail(`Unsafe state symlink: ${cursor}`)
    if (cursor === dirname(cursor)) break
    cursor = dirname(cursor)
  }
}
function privateMode(info, directory) {
  if ((directory ? !info.isDirectory() : !info.isFile()) || (info.mode & 0o777) !== (directory ? 0o700 : 0o600) || (typeof process.getuid === 'function' && info.uid !== process.getuid()) || (!directory && info.nlink !== 1)) fail('Supervisor state must be private, owned, and not linked')
}
async function privateDirectory(path) {
  await noSymlinkComponents(path)
  privateMode(await lstat(path), true)
}
export async function ensureStateDirectory(stateDir, workspaceRoot) {
  if (typeof stateDir !== 'string' || !isAbsolute(stateDir) || resolve(stateDir) !== stateDir) fail('Deployment must configure an absolute stateDir')
  if (workspaceRoot && (inside(workspaceRoot, stateDir) || inside(stateDir, workspaceRoot))) fail('Supervisor state must be separate from the agent workspace')
  await noSymlinkComponents(dirname(stateDir))
  let created = false
  try { await mkdir(stateDir, { mode: 0o700 }); created = true } catch (error) { if (error.code !== 'EEXIST') throw error }
  await privateDirectory(stateDir)
  if (created) await syncDirectory(dirname(stateDir))
  return stateDir
}
async function privateRead(path, maxBytes = MAX_JSON, encoding = 'utf8') {
  for (let attempt = 0; ; attempt++) {
    await noSymlinkComponents(path)
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW)
    try {
      const info = await handle.stat()
      // atomicJSON can replace the opened inode before fstat, making nlink=0.
      // Never read that inode: reopen only a verified private replacement, with
      // bounded retries. Unlink alone, hardlinks and unsafe modes still reject.
      if (info.nlink === 0 && attempt < 3) {
        let replacement
        try { replacement = await lstat(path) } catch (error) { if (error.code !== 'ENOENT') throw error }
        if (replacement && (replacement.dev !== info.dev || replacement.ino !== info.ino)) {
          privateMode(replacement, false)
          continue
        }
      }
      privateMode(info, false)
      if (info.size > maxBytes) fail('Private file is too large')
      return await handle.readFile(encoding)
    } finally { await handle.close() }
  }
}
export async function readLaunchTicket(path) { return JSON.parse(await privateRead(path)) }
export async function readSupervisorSecret(path) { return keyBytes(await privateRead(path, 4096, null)) }
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}
async function atomicJSON(directory, name, value) {
  await privateDirectory(directory)
  const destination = join(directory, name)
  try { privateMode(await lstat(destination), false) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`)
    await handle.sync()
  } finally { await handle.close() }
  try { await rename(temporary, destination); await syncDirectory(directory) }
  finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function optionalJSON(directory, name) {
  try { return JSON.parse(await privateRead(join(directory, name))) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
function executionDirectory(stateDir, executionId) {
  if (typeof executionId !== 'string' || !ID.test(executionId)) fail('Invalid executionId')
  return join(stateDir, executionId)
}

// Linux starttime is field 22 of /proc/PID/stat. Boot ID also prevents identity
// collisions across machine reboots. No ps parsing, tmux, adoption or restart.
function identityFromStat(pid, text, bootId) {
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  const startTime = fields[19]
  if (!/^\d+$/.test(startTime || '')) return { status: 'unknown', pid }
  return { status: fields[0] === 'Z' || fields[0] === 'X' ? 'ended' : 'running', pid, startTime, bootId }
}
export async function getProcessIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) fail('Invalid PID')
  if (process.platform !== 'linux') return { status: 'unknown', pid }
  try {
    const text = await readFile(`/proc/${pid}/stat`, 'utf8')
    const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    return identityFromStat(pid, text, bootId)
  } catch (error) {
    return { status: error.code === 'ENOENT' || error.code === 'ESRCH' ? 'ended' : 'unknown', pid }
  }
}
async function matchingIdentity(expected) {
  if (!expected || !Number.isSafeInteger(expected.pid) || expected.pid <= 0 || typeof expected.startTime !== 'string') return { status: 'unknown' }
  const actual = await getProcessIdentity(expected.pid)
  if (actual.startTime && (actual.startTime !== expected.startTime || (expected.bootId && actual.bootId !== expected.bootId))) return { ...actual, status: 'mismatch' }
  return actual
}
export async function inspectExistingProcess({ pid, startTime, cwd, commandDigest: digest, bootId } = {}) {
  const expected = { pid, startTime, bootId }
  const actual = await matchingIdentity(expected)
  if (actual.status !== 'running') return actual
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) return { ...actual, status: 'unknown' }
  try {
    const observedCwd = await realpath(`/proc/${pid}/cwd`)
    if (observedCwd !== cwd) return { ...actual, status: 'mismatch', reason: 'cwd' }
    if (digest !== undefined) {
      const cmdline = await readFile(`/proc/${pid}/cmdline`)
      const argv = cmdline.toString('utf8').split('\0')
      if (argv.at(-1) === '') argv.pop()
      if (!argv.length) {
        const recheck = await matchingIdentity(expected)
        return recheck.status === 'running' ? { ...actual, status: 'unknown' } : recheck
      }
      if (commandDigest(argv) !== digest) return { ...actual, status: 'mismatch', reason: 'commandDigest' }
    }
    // Recheck starttime after inspecting /proc to detect PID reuse mid-read.
    const recheck = await matchingIdentity(expected)
    return recheck.status === 'running' ? { ...actual, cwd: observedCwd } : recheck
  } catch (error) {
    return { ...actual, status: error.code === 'ENOENT' || error.code === 'ESRCH' ? 'ended' : 'unknown' }
  }
}

export async function inspectExecution({ stateDir, executionId }) {
  await ensureStateDirectory(stateDir)
  const directory = executionDirectory(stateDir, executionId)
  try { await privateDirectory(directory) } catch (error) { if (error.code === 'ENOENT') return { executionId, status: 'unknown' }; throw error }
  const result = await optionalJSON(directory, 'result.json')
  const manifest = await optionalJSON(directory, 'manifest.json')
  const intent = await optionalJSON(directory, 'start-intent.json')
  const child = await optionalJSON(directory, 'child.json')
  if (result) return { executionId, status: 'ended', manifest, child, result }
  const runner = await matchingIdentity(manifest?.runner)
  const childState = child ? await matchingIdentity(child.identity) : { status: 'unknown' }
  // Result can commit (and the runner exit) while /proc identity is being read.
  // Re-read before classifying that normal terminal race as lost supervision.
  const terminalResult = await optionalJSON(directory, 'result.json')
  if (terminalResult) return { executionId, status: 'ended', manifest, child, result: terminalResult }
  return {
    executionId, status: runner.status === 'running' ? (child ? (childState.status === 'running' ? 'running' : 'reconciling') : 'starting') : 'reconciling',
    manifest, intent, child, runnerStatus: runner.status, childStatus: childState.status,
    // A dead runner, missing receipt, unknown identity or abandoned claim is
    // deliberately NEVER replayed, even if the child appears to have ended.
  }
}

async function duplicateState(stateDir, payload) {
  const state = await inspectExecution({ stateDir, executionId: payload.executionId })
  const previous = state.manifest
  if (previous && ['projectId', 'workspaceRoot', 'cwd', 'commandDigest', 'policy', 'enforcement'].some(key => previous[key] !== payload[key])) fail('Execution ID is already claimed by a different launch')
  return { duplicate: true, ...state }
}
function validateLogCap(logCapBytes) {
  if (!Number.isSafeInteger(logCapBytes) || logCapBytes < 1 || logCapBytes > 1024 * 1024 * 1024) fail('Invalid log cap')
}
export async function runTicket(ticket, { stateDir, secret, allowedEnvironmentKeys = [], allowPartial = false, logCapBytes = DEFAULT_LOG_CAP } = {}) {
  if (process.platform !== 'linux') fail('Persistent execution requires Linux /proc process identity')
  validateLogCap(logCapBytes)
  const payload = await verifyLaunchTicket(ticket, { secret, allowedEnvironmentKeys, allowPartial })
  await ensureStateDirectory(stateDir, payload.workspaceRoot)
  if (activeExecution !== null) {
    if (activeExecution.executionId !== payload.executionId || activeExecution.stateDir !== stateDir) fail('Each supervisor process may own only one execution')
    return duplicateState(stateDir, payload)
  }
  activeExecution = { executionId: payload.executionId, stateDir }
  try { return await executeClaimedTicket(ticket, payload, stateDir, logCapBytes) }
  finally { activeExecution = null }
}

async function executeClaimedTicket(ticket, payload, stateDir, logCapBytes) {
  const directory = executionDirectory(stateDir, payload.executionId)
  try { await mkdir(directory, { mode: 0o700 }); await syncDirectory(stateDir) }
  catch (error) { if (error.code === 'EEXIST') return duplicateState(stateDir, payload); throw error }
  const runner = await getProcessIdentity(process.pid)
  if (runner.status !== 'running') fail('Cannot establish supervisor identity; execution needs reconciliation')
  const manifest = { version: VERSION, executionId: payload.executionId, projectId: payload.projectId, workspaceRoot: payload.workspaceRoot, cwd: payload.cwd, commandDigest: payload.commandDigest, enforcement: payload.enforcement, policy: payload.policy, runner, createdAt: Date.now(), status: 'starting' }
  await atomicJSON(directory, 'ticket.json', ticket)
  await atomicJSON(directory, 'manifest.json', manifest)
  const log = await open(join(directory, 'log.txt'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600)
  // A durable intent precedes spawn. Crash anywhere after this point is ambiguous
  // until a child receipt/result exists; the exclusive claim forbids replay.
  try { await atomicJSON(directory, 'start-intent.json', { executionId: payload.executionId, runner, commandDigest: payload.commandDigest, at: Date.now() }) }
  catch (error) { await log.close(); throw error }
  let child, identity, stopSignal = null, storedBytes = 0, totalBytes = 0, closed = false, receiptError = null
  const terminate = async signal => {
    if (closed || stopSignal) return
    stopSignal = signal
    try { await atomicJSON(directory, 'supervisor-stop.json', { executionId: payload.executionId, runner, child: identity || null, signal, at: Date.now() }) }
    catch (error) { receiptError ||= `Stop record failed: ${error.message}` }
    if (identity && (await matchingIdentity(identity)).status === 'running' && !closed) {
      try { process.kill(-identity.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
  let signalWork = Promise.resolve()
  const onSignal = signal => { signalWork = signalWork.then(() => terminate(signal)).catch(error => { receiptError ||= error.message }) }
  const sigterm = () => onSignal('SIGTERM')
  const sigint = () => onSignal('SIGINT')
  process.on('SIGTERM', sigterm)
  process.on('SIGINT', sigint)
  const append = chunk => {
    totalBytes += chunk.length
    const count = Math.min(chunk.length, Math.max(0, logCapBytes - storedBytes))
    if (count > 0) {
      try {
        let offset = 0
        while (offset < count) offset += writeSync(log.fd, chunk, offset, count - offset)
        storedBytes += count
      } catch (error) { receiptError ||= `Log write failed: ${error.message}` }
    }
  }
  try {
    child = spawn(payload.confinedArgv[0], payload.confinedArgv.slice(1), { cwd: payload.cwd, env: payload.environment, detached: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    // Register close/error immediately, before asynchronous receipt persistence.
    const completion = new Promise(resolveCompletion => {
      let spawnError = null
      child.once('error', error => { spawnError = { code: error.code || null, message: error.message.slice(0, 4096) } })
      child.once('close', (exitCode, signal) => { closed = true; resolveCompletion({ exitCode: spawnError ? null : exitCode, signal, spawnError }) })
    })
    if (child.pid) {
      // Read before yielding to the event loop: even a /bin/true zombie still
      // has /proc identity until Node reaps it. Async reads alone can lose it.
      try { identity = identityFromStat(child.pid, readFileSync(`/proc/${child.pid}/stat`, 'utf8'), runner.bootId) }
      catch { identity = await getProcessIdentity(child.pid) }
      if (!identity.startTime) receiptError ||= 'Child starttime unavailable; identity requires reconciliation'
      try {
        await atomicJSON(directory, 'child.json', { executionId: payload.executionId, identity, at: Date.now() })
        manifest.status = 'running'
        await atomicJSON(directory, 'manifest.json', manifest)
      } catch (error) { receiptError = error.message }
      // A signal may have arrived before the child identity was read.
      if (stopSignal && !closed && (await matchingIdentity(identity)).status === 'running') {
        try { process.kill(-identity.pid, stopSignal) } catch (error) { if (error.code !== 'ESRCH') throw error }
      }
    }
    const outcome = await completion
    await signalWork
    await log.sync()
    const result = { version: VERSION, executionId: payload.executionId, commandDigest: payload.commandDigest, ...outcome, stoppedBy: stopSignal, finishedAt: Date.now(), log: { bytes: storedBytes, totalBytes, truncated: totalBytes > storedBytes }, receiptError }
    await atomicJSON(directory, 'result.json', result)
    manifest.status = 'ended'
    await atomicJSON(directory, 'manifest.json', manifest)
    return { duplicate: false, executionId: payload.executionId, status: 'ended', result }
  } finally {
    process.off('SIGTERM', sigterm)
    process.off('SIGINT', sigint)
    await signalWork
    await log.close()
  }
}

// Trusted host only: detach an ordinary Node supervisor, not a DSH managed job.
// The secret is passed by private file path, never argv content or child env.
export async function launchSupervisor(ticket, { stateDir, secretFile, allowedEnvironmentKeys = [], allowPartial = false, logCapBytes = DEFAULT_LOG_CAP } = {}) {
  validateLogCap(logCapBytes)
  const runnerPath = fileURLToPath(new URL('./executor-cli.js', import.meta.url))
  const secret = await readSupervisorSecret(secretFile)
  const payload = await verifyLaunchTicket(ticket, { secret, allowedEnvironmentKeys, allowPartial })
  const keyPath = await realpath(secretFile)
  if (inside(payload.workspaceRoot, keyPath)) fail('Signing key must be outside the agent workspace')
  await ensureStateDirectory(stateDir, payload.workspaceRoot)
  const name = `launch-${randomUUID()}.json`
  await atomicJSON(stateDir, name, ticket)
  const args = [runnerPath, 'run', '--ticket', join(stateDir, name), '--state-dir', stateDir, '--secret-file', secretFile, '--log-cap', String(logCapBytes)]
  for (const key of allowedEnvironmentKeys) args.push('--allow-env', key)
  if (allowPartial) args.push('--allow-partial')
  const supervisor = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: {}, shell: false })
  await new Promise((resolveSpawn, rejectSpawn) => { supervisor.once('spawn', resolveSpawn); supervisor.once('error', rejectSpawn) })
  supervisor.unref()
  return { executionId: payload.executionId, runner: await getProcessIdentity(supervisor.pid), ticketFile: join(stateDir, name) }
}

// Identity-bound intentional stop. No PID-only API, adoption, process scanning,
// escalation to SIGKILL, or stale group killing. A live runner validates its own
// recorded child starttime again before signaling the detached child group.
export async function stopExecution({ stateDir, executionId, runnerIdentity }) {
  const state = await inspectExecution({ stateDir, executionId })
  if (state.status === 'ended') return { stopped: false, status: 'ended' }
  const saved = state.manifest?.runner
  if (!saved || !runnerIdentity || saved.pid !== runnerIdentity.pid || saved.startTime !== runnerIdentity.startTime || saved.bootId !== runnerIdentity.bootId) fail('Stop requires the matching execution runner identity')
  if ((await matchingIdentity(saved)).status !== 'running') return { stopped: false, status: 'reconciling' }
  await atomicJSON(executionDirectory(stateDir, executionId), 'stop-request.json', { executionId, runner: saved, requestedAt: Date.now() })
  if ((await matchingIdentity(saved)).status !== 'running') return { stopped: false, status: 'reconciling' }
  try { process.kill(saved.pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') throw error; return { stopped: false, status: 'reconciling' } }
  return { stopped: true, status: 'stopping' }
}
