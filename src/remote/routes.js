export const REMOTE_ROUTE = '/api/dsh-server-hub/remote'

function send(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
async function body(req) {
  if (!/^application\/json(?:;|$)/i.test(String(req.headers['content-type'] || ''))) throw new Error('请发送 JSON 请求')
  let bytes = 0
  const chunks = []
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 128 * 1024) throw new Error('请求过大')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
const workspaceInfo = workspace => ({ id: workspace.id, title: workspace.title || workspace.path?.split(/[\\/]/).filter(Boolean).at(-1) || workspace.id, path: workspace.path })

/** All routes reuse native DSH request admission, including the event stream. */
export function createRemoteRoute({ ctx, store, connections, worker, controller }) {
  const envelope = value => ({ version: 1, instanceId: store.getConfig().instanceId, ...value })
  const settings = () => ({ ...store.getConfig(), workspaces: ctx.workspaceRegistry.list().map(workspaceInfo) })
  return async (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection !== undefined) { res.writeHead(rejection, { 'cache-control': 'no-store' }); res.end(); return }
    const path = new URL(req.url, 'http://localhost').pathname.slice(REMOTE_ROUTE.length)
    try {
      if (req.method === 'GET' && path === '/config') return send(res, 200, envelope(settings()))
      if (req.method === 'PUT' && path === '/config') {
        const input = await body(req)
        if (!input || Array.isArray(input) || !Object.keys(input).length || Object.keys(input).some(key => !['enabled', 'workspaceIds', 'waitForResult'].includes(key))) throw new Error('无效的远控设置')
        if (Object.hasOwn(input, 'waitForResult') && typeof input.waitForResult !== 'boolean') throw new Error('请选择单轮回复模式')
        if (Object.hasOwn(input, 'enabled') || Object.hasOwn(input, 'workspaceIds')) {
          if (typeof input.enabled !== 'boolean' || !Array.isArray(input.workspaceIds) || input.workspaceIds.length > 256 ||
            input.workspaceIds.some(id => typeof id !== 'string' || !ctx.workspaceRegistry.get(id))) throw new Error('请选择已注册的工作区')
        }
        await store.setConfig(input)
        return send(res, 200, envelope(settings()))
      }
      if (req.method === 'GET' && path === '/catalog') {
        const config = store.getConfig()
        return send(res, 200, envelope({ enabled: config.enabled, workspaces: config.enabled ? ctx.workspaceRegistry.list().filter(workspace => config.workspaceIds.includes(workspace.id)).map(workspaceInfo) : [] }))
      }
      if (req.method === 'GET' && path === '/connections') return send(res, 200, envelope({ connections: await connections.list() }))
      if (req.method === 'POST' && path === '/connections') {
        const input = await body(req)
        if (!input || Object.keys(input).some(key => !['endpoint', 'name'].includes(key)) || typeof input.endpoint !== 'string') throw new Error('请选择 Hub 中的目标实例')
        if (new URL(input.endpoint).port === String(ctx.webServer.port)) throw Object.assign(new Error('这是主控本机，无需连接自己；请在 Hub 中选择另一个远程。'), { code: 'REMOTE_SELF' })
        return send(res, 200, envelope({ connection: await connections.connect(req, input) }))
      }
      const connection = path.match(/^\/connections\/(remote-[a-f0-9]{24})$/)
      if (req.method === 'PUT' && connection) {
        const input = await body(req)
        if (!input || Object.keys(input).some(key => !['name', 'onlyIfUnset'].includes(key)) || !Object.hasOwn(input, 'name') ||
          (Object.hasOwn(input, 'onlyIfUnset') && typeof input.onlyIfUnset !== 'boolean')) throw new Error('请提供远程名称')
        return send(res, 200, envelope({ connection: await connections.rename(connection[1], input.name, { onlyIfUnset: input.onlyIfUnset === true }) }))
      }
      if (req.method === 'DELETE' && connection) return send(res, 200, envelope(await connections.forget(connection[1])))
      if (req.method === 'POST' && path === '/runs') return send(res, 202, envelope({ run: await worker.start(await body(req)) }))
      const run = path.match(/^\/runs\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})(\/(?:events|interrupt|drain))?$/)
      if (run) {
        if (req.method === 'POST' && run[2] === '/interrupt') {
          const input = await body(req)
          if (!input || Object.keys(input).length) throw new Error('中断请求不接受其他参数')
          return send(res, 200, envelope({ run: await worker.cancel(run[1]) }))
        }
        const current = await worker.get(run[1])
        if (!current) return send(res, 404, envelope({ error: '任务不存在；不会重建执行' }))
        if (req.method === 'GET' && !run[2]) return send(res, 200, envelope({ run: current }))
        if (req.method === 'GET' && run[2] === '/drain') return send(res, 200, envelope({ run: await worker.drain(run[1]) }))
        if (req.method === 'GET' && run[2] === '/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' })
          let closed = false
          let draining = false
          let queued = false
          const cleanup = () => { if (closed) return; closed = true; clearInterval(heartbeat); worker.events.off('changed', changed); res.off('close', cleanup) }
          const stop = () => { cleanup(); res.end() }
          const changed = id => { if (id === run[1]) void flush() }
          const flush = async () => {
            if (closed) return
            if (draining) { queued = true; return }
            draining = true
            try {
              do {
                queued = false
                const value = await worker.get(run[1])
                if (closed) break
                if (!res.write(`event: run\ndata: ${JSON.stringify(envelope({ run: value }))}\n\n`)) { stop(); break }
                if (['completed', 'error', 'interrupted'].includes(value.state)) { stop(); break }
              } while (queued)
            } catch { stop() } finally { draining = false }
          }
          const heartbeat = setInterval(() => { if (!closed && !res.write(': heartbeat\n\n')) stop() }, 15000)
          heartbeat.unref?.()
          worker.events.on('changed', changed)
          res.on('close', cleanup)
          await flush()
          return
        }
      }
      if (req.method === 'GET' && path === '/activity') {
        const delegated = await controller.activity()
        return send(res, 200, envelope({ runs: [...(await store.list('runs')).map(record => worker.public(record)), ...delegated] }))
      }
      send(res, 404, envelope({ error: '未知远控接口' }))
    } catch (error) {
      if (res.headersSent) { res.end(); return }
      // Known business errors only. Native-cookie values and request headers never leave Host.
      const known = error.code?.startsWith('REMOTE_')
      send(res, 400, envelope({ error: known ? error.message : '远控请求未完成，请检查工作区与连接状态', ...(known ? { code: error.code } : {}),
        ...(known && Number.isInteger(error.remoteStatus) ? { remoteStatus: error.remoteStatus } : {}) }))
    }
  }
}
