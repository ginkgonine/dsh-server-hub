window.__ModuleLoader__.load({
  id: 'dsh-server-hub',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const React = require('react')

    const inject = ['slots', 'layout']
    const PANEL_ID = 'dsh-server-hub'
    const STORAGE_KEY = 'dsh-server-hub.preferences.v1'
    const NOTIFICATION_PREFIX = 'dsh-server-hub.notification.'
    const OVERVIEW_ROUTE = '/api/dsh-server-hub/overview'
    const POLL_MS = 1_000

    const CSS = `
      .dsh-hub-icon-wrap { position: relative; display: block; width: var(--dsh-hub-icon-size, 24px); height: var(--dsh-hub-icon-size, 24px); color: currentColor; }
      .dsh-hub-icon { display: block; color: currentColor; }
      .dsh-hub-icon-badge { position: absolute; right: -2px; top: -2px; width: 7px; height: 7px; border-radius: 50%; background: #4f7cff; box-shadow: 0 0 0 2px var(--dsw-specific-sidebar-fill, Canvas); }
      .dsh-hub-icon-badge.is-working { animation: dsh-hub-pulse 850ms ease-in-out infinite alternate; }
      .dsh-hub-icon-badge.is-waiting { background: #e2a12c; }
      .dsh-hub-icon-badge.is-completed { background: #39b66a; }
      .dsh-hub { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); color: inherit; background: inherit; }
      .dsh-hub-toolbar { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: color-mix(in srgb, currentColor 2.5%, transparent); }
      .dsh-hub-brand { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 760; white-space: nowrap; }
      .dsh-hub-brand-state { width: 9px; height: 9px; flex: 0 0 auto; border-radius: 50%; background: #718096; }
      .dsh-hub-brand-state.is-working { border: 2px solid color-mix(in srgb, #4f7cff 25%, transparent); border-top-color: #4f7cff; background: transparent; animation: dsh-hub-spin 720ms linear infinite; }
      .dsh-hub-brand-state.is-waiting { display: grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; color: #241800; background: #e2a12c; font-size: 10px; font-weight: 900; }
      .dsh-hub-brand-state.is-completed { display: grid; place-items: center; width: 14px; height: 14px; border-radius: 50%; color: white; background: #39b66a; font-size: 9px; font-weight: 900; }
      .dsh-hub-tabs { flex: 1 1 auto; min-width: 100px; display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 2px; scrollbar-width: thin; }
      .dsh-hub-tab { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; max-width: 210px; padding: 7px 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 999px; color: inherit; background: transparent; cursor: pointer; }
      .dsh-hub-tab:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
      .dsh-hub-tab.is-active { border-color: color-mix(in srgb, #4f7cff 58%, transparent); background: color-mix(in srgb, #4f7cff 15%, transparent); }
      .dsh-hub-tab-status { width: 12px; height: 12px; flex: 0 0 auto; display: grid; place-items: center; border-radius: 50%; font-size: 10px; font-weight: 900; line-height: 1; }
      .dsh-hub-tab-status.is-idle { width: 7px; height: 7px; margin: 2.5px; background: #718096; }
      .dsh-hub-tab-status.is-offline { width: 8px; height: 8px; margin: 2px; border: 1.5px solid #8b95a5; opacity: .62; }
      .dsh-hub-tab-status.is-working { width: 10px; height: 10px; border: 2px solid color-mix(in srgb, #4f7cff 24%, transparent); border-top-color: #4f7cff; animation: dsh-hub-spin 720ms linear infinite; }
      .dsh-hub-tab-status.is-waiting { color: #241800; background: #e2a12c; animation: dsh-hub-pulse 850ms ease-in-out infinite alternate; }
      .dsh-hub-tab-status.is-completed { color: white; background: #39b66a; }
      .dsh-hub-tab.is-pending .dsh-hub-tab-status { color: #241800; background: #d99b24; animation: dsh-hub-pulse 850ms ease-in-out infinite alternate; }
      .dsh-hub-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 670; }
      .dsh-hub-tab-count { font-size: 9px; opacity: .62; }
      .dsh-hub-tools { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
      .dsh-hub-edit-group { display: flex; align-items: center; gap: 5px; }
      .dsh-hub-input { width: 76px; min-width: 0; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 7px; padding: 7px 8px; color: inherit; background: transparent; outline: none; font: inherit; font-size: 11px; }
      .dsh-hub-name-input { width: 118px; }
      .dsh-hub-action { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 7px; padding: 7px 9px; color: inherit; background: transparent; cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
      .dsh-hub-action:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
      .dsh-hub-action:disabled { cursor: default; opacity: .42; }
      .dsh-hub-action.is-enabled { border-color: color-mix(in srgb, #39b66a 55%, transparent); color: #39b66a; }
      .dsh-hub-status { flex: 0 1 190px; min-width: 0; max-width: 190px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; opacity: .62; }
      .dsh-hub-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; isolation: isolate; background: var(--dsw-alias-bg-base, Canvas); }
      .dsh-hub-frame { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; border: 0; display: block; opacity: 0; pointer-events: none; background: var(--dsw-alias-bg-base, Canvas); color-scheme: inherit; transform: translateZ(0); will-change: opacity; transition: opacity 160ms cubic-bezier(.2, .7, .2, 1); }
      .dsh-hub-frame.is-active { z-index: 1; opacity: 1; pointer-events: auto; }
      .dsh-hub-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; color: var(--dsw-alias-label-secondary, currentColor); background: var(--dsw-alias-bg-base, Canvas); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 180ms ease, visibility 0s linear 180ms; }
      .dsh-hub-loading.is-visible { opacity: 1; visibility: visible; transition-delay: 0s; }
      .dsh-hub-loading-card { display: flex; align-items: center; gap: 9px; font-size: 12px; opacity: .72; }
      .dsh-hub-loading-dot { width: 9px; height: 9px; border: 2px solid color-mix(in srgb, #4f7cff 24%, transparent); border-top-color: #4f7cff; border-radius: 50%; animation: dsh-hub-spin 720ms linear infinite; }
      .dsh-hub-empty { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 28px; text-align: center; background: var(--dsw-alias-bg-base, Canvas); }
      .dsh-hub-empty-card { max-width: 510px; opacity: .68; line-height: 1.6; font-size: 13px; }
      @keyframes dsh-hub-spin { to { transform: rotate(360deg); } }
      @keyframes dsh-hub-pulse { from { opacity: .48; transform: scale(.86); } to { opacity: 1; transform: scale(1); } }
      @media (prefers-reduced-motion: reduce) { .dsh-hub-frame, .dsh-hub-loading { transition: none; } .dsh-hub-brand-state.is-working, .dsh-hub-tab-status.is-working, .dsh-hub-tab-status.is-waiting, .dsh-hub-tab.is-pending .dsh-hub-tab-status, .dsh-hub-icon-badge.is-working, .dsh-hub-loading-dot { animation: none; } }
      @media (max-width: 1080px) { .dsh-hub-toolbar { flex-wrap: wrap; gap: 7px; } .dsh-hub-tabs { order: 3; flex-basis: 100%; } .dsh-hub-status { display: none; } }
      @media (max-width: 620px) { .dsh-hub-brand { display: none; } .dsh-hub-tools { width: 100%; } .dsh-hub-edit-group { flex: 1; } .dsh-hub-input { width: auto; flex: 1; } }
    `

    function defaultPreferences() {
      return { names: {}, manualPorts: [] }
    }

    function readPreferences() {
      try {
        const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null')
        if (!parsed || typeof parsed !== 'object') return defaultPreferences()
        const names = parsed.names && typeof parsed.names === 'object' ? parsed.names : {}
        const manualPorts = Array.isArray(parsed.manualPorts)
          ? [...new Set(parsed.manualPorts.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))]
          : []
        return { names, manualPorts }
      } catch {
        return defaultPreferences()
      }
    }

    let requestOverviewRefresh = async () => {}

    function storePreferences(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // The Hub remains usable when browser storage is unavailable.
      }
      void requestOverviewRefresh(true)
    }

    function validInstance(item, preferences) {
      const port = Number(item && item.port)
      const url = String(item && item.url || '')
      if (!Number.isInteger(port) || port < 1 || port > 65535) return null
      const allowed = [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`]
      if (!allowed.includes(url)) return null
      return {
        id: url,
        port,
        url,
        source: item.source === 'manual' ? 'manual' : 'auto',
        label: preferences.names[url] || preferences.names[String(port)] || `DSH :${port}`,
      }
    }

    let hubSnapshot = {
      instances: [],
      states: {},
      activeId: null,
      scanning: true,
      warning: null,
      discovery: 'unavailable',
      notificationPermission: typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported',
    }
    const hubListeners = new Set()

    function publishHub(patch) {
      hubSnapshot = Object.assign({}, hubSnapshot, patch)
      for (const listener of hubListeners) listener()
    }

    function subscribeHub(listener) {
      hubListeners.add(listener)
      return () => hubListeners.delete(listener)
    }

    function readHubSnapshot() {
      return hubSnapshot
    }

    function useHubSnapshot() {
      return React.useSyncExternalStore(subscribeHub, readHubSnapshot, readHubSnapshot)
    }

    function statusMode(state) {
      if (!state || !state.online) return 'offline'
      if (state.waitingCount > 0) return 'waiting'
      if (state.workingCount > 0) return 'working'
      if (state.completedUnread) return 'completed'
      return 'idle'
    }

    function stateDescription(state) {
      if (!state || !state.online) return state && state.supported ? '状态连接中断' : '未安装状态桥接插件'
      const parts = []
      if (state.waitingCount > 0) parts.push(`${state.waitingCount} 项等待人工处理`)
      if (state.workingCount > 0) parts.push(`${state.workingCount} 个 Agent 工作中`)
      if (state.completedUnread) parts.push('有新完成任务')
      return parts.length ? parts.join('，') : '空闲'
    }

    let notificationOpen = () => {}

    function notificationKey(item, kind) {
      return `${NOTIFICATION_PREFIX}${encodeURIComponent(item.url)}.${kind}`
    }

    function alreadyNotified(item, kind, sequence, epoch) {
      const key = notificationKey(item, kind)
      const eventId = `${epoch || 'unknown'}:${sequence}`
      try {
        if (window.localStorage.getItem(key) === eventId) return true
        window.localStorage.setItem(key, eventId)
      } catch {
        // Notification tags still suppress most duplicates when storage is unavailable.
      }
      return false
    }

    function sendDesktopNotification(item, kind, state) {
      if (typeof window.Notification !== 'function' || window.Notification.permission !== 'granted') return
      const sequence = kind === 'waiting' ? state.waitingSeq : state.completionSeq
      if (alreadyNotified(item, kind, sequence, state.epoch)) return
      const waiting = kind === 'waiting'
      const title = waiting ? `需要处理 · ${item.label}` : `任务已结束 · ${item.label}`
      const outcome = state.lastOutcome && state.lastOutcome !== 'completed' ? `（${state.lastOutcome}）` : ''
      const body = waiting ? 'Agent 正在等待授权或输入回答。' : `Agent 工作已结束${outcome}。`
      try {
        const notification = new window.Notification(title, {
          body,
          tag: `dsh-server-hub:${item.url}`,
          renotify: true,
        })
        notification.onclick = () => {
          window.focus()
          notificationOpen(item.id)
          notification.close()
        }
      } catch {
        // Some browsers can keep a granted permission while the OS channel is unavailable.
      }
    }

    function reconcileStates(instances, rawStates) {
      const nextStates = {}
      const events = []
      for (const item of instances) {
        const raw = rawStates && rawStates[item.url]
        const previous = hubSnapshot.states[item.url]
        if (!raw || typeof raw !== 'object') {
          nextStates[item.url] = previous || {
            online: false,
            supported: false,
            epoch: null,
            workingCount: 0,
            waitingCount: 0,
            completionSeq: 0,
            waitingSeq: 0,
            lastOutcome: null,
            remoteUpdatedAt: 0,
            completedUnread: false,
          }
          continue
        }
        const workingCount = Math.max(0, Number(raw.workingCount) || 0)
        const waitingCount = Math.max(0, Number(raw.waitingCount) || 0)
        const completionSeq = Math.max(0, Number(raw.completionSeq) || 0)
        const waitingSeq = Math.max(0, Number(raw.waitingSeq) || 0)
        const epoch = typeof raw.epoch === 'string' ? raw.epoch : null
        const reset = previous && (previous.epoch !== epoch || completionSeq < previous.completionSeq || waitingSeq < previous.waitingSeq)
        const completed = previous && !reset && completionSeq > previous.completionSeq
        const waiting = previous && !reset && waitingSeq > previous.waitingSeq
        const started = previous && previous.workingCount === 0 && workingCount > 0
        const completedUnread = started
          ? false
          : Boolean((previous && previous.completedUnread) || completed)
        const state = {
          online: raw.online === true,
          supported: raw.supported === true,
          epoch,
          workingCount,
          waitingCount,
          completionSeq,
          waitingSeq,
          lastOutcome: typeof raw.lastOutcome === 'string' ? raw.lastOutcome : null,
          remoteUpdatedAt: Number(raw.remoteUpdatedAt) || 0,
          completedUnread,
          polledAt: Number(raw.polledAt) || 0,
          error: typeof raw.error === 'string' ? raw.error : null,
        }
        nextStates[item.url] = state
        if (waiting) events.push({ item, kind: 'waiting', state })
        if (completed) events.push({ item, kind: 'completed', state })
      }
      return { nextStates, events }
    }

    function markServerRead(id) {
      const current = hubSnapshot.states[id]
      if (!current || !current.completedUnread) return
      publishHub({
        states: Object.assign({}, hubSnapshot.states, {
          [id]: Object.assign({}, current, { completedUnread: false }),
        }),
      })
    }

    function setActiveServer(id) {
      publishHub({ activeId: id })
      if (id) markServerRead(id)
    }

    async function requestNotifications() {
      if (typeof window.Notification !== 'function') {
        publishHub({ notificationPermission: 'unsupported' })
        return 'unsupported'
      }
      let permission = window.Notification.permission
      if (permission === 'default') permission = await window.Notification.requestPermission()
      publishHub({ notificationPermission: permission })
      return permission
    }

    let baseDocumentTitle = window.document.title || 'DeepSeek Harness'
    let lastAppliedTitle = null

    function updateDocumentTitle(snapshot) {
      if (lastAppliedTitle !== null && window.document.title !== lastAppliedTitle) {
        baseDocumentTitle = window.document.title
      }
      const active = []
      for (const item of snapshot.instances) {
        const state = snapshot.states[item.id]
        const mode = statusMode(state)
        if (mode !== 'idle' && mode !== 'offline') active.push({ item, mode })
      }
      const waiting = active.filter((entry) => entry.mode === 'waiting')
      const working = active.filter((entry) => entry.mode === 'working')
      const completed = active.filter((entry) => entry.mode === 'completed')
      let title = baseDocumentTitle
      if (waiting.length === 1 && working.length === 0) title = `! [${waiting[0].item.label}] 等待操作`
      else if (waiting.length > 0) title = `! ${waiting.length} waiting${working.length ? ` · ⏳ ${working.length} working` : ''}`
      else if (working.length === 1) title = `⏳ [${working[0].item.label}] working`
      else if (working.length > 1) title = `⏳ ${working.length} servers working`
      else if (completed.length === 1) title = `✓ [${completed[0].item.label}] 已完成`
      else if (completed.length > 1) title = `✓ ${completed.length} servers completed`
      window.document.title = title
      lastAppliedTitle = title
    }

    function HubMonitor(props) {
      const snapshot = useHubSnapshot()

      React.useEffect(() => {
        let disposed = false
        let inFlight = null
        let pendingForce = false
        const fetchOnce = async (force) => {
          try {
            const preferences = readPreferences()
            const params = new URLSearchParams()
            if (preferences.manualPorts.length) params.set('ports', preferences.manualPorts.join(','))
            if (force) params.set('refresh', '1')
            const response = await window.fetch(`${OVERVIEW_ROUTE}?${params.toString()}`, {
              method: 'GET',
              credentials: 'same-origin',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const result = await response.json()
            if (disposed) return
            const instances = Array.isArray(result.instances)
              ? result.instances.map((item) => validInstance(item, preferences)).filter((item) => item !== null)
              : []
            const reconciled = reconcileStates(instances, result.states)
            const activeId = hubSnapshot.activeId && instances.some((item) => item.id === hubSnapshot.activeId)
              ? hubSnapshot.activeId
              : (instances[0] ? instances[0].id : null)
            publishHub({
              instances,
              states: reconciled.nextStates,
              activeId,
              scanning: result.scanning === true,
              warning: result.warning || null,
              discovery: String(result.discovery || 'unavailable'),
              notificationPermission: typeof window.Notification === 'function' ? window.Notification.permission : 'unsupported',
            })
            for (const event of reconciled.events) sendDesktopNotification(event.item, event.kind, event.state)
          } catch (error) {
            if (!disposed) publishHub({ warning: `状态监控失败：${error && error.message ? error.message : String(error)}`, scanning: false })
          }
        }
        const refresh = (force) => {
          if (disposed) return Promise.resolve()
          if (force) pendingForce = true
          if (inFlight !== null) return inFlight
          inFlight = (async () => {
            do {
              const runForce = pendingForce
              pendingForce = false
              await fetchOnce(runForce)
            } while (pendingForce && !disposed)
          })().finally(() => {
            inFlight = null
          })
          return inFlight
        }
        requestOverviewRefresh = refresh
        notificationOpen = (id) => {
          setActiveServer(id)
          props.layout.selectPanel(PANEL_ID)
        }
        void refresh(false)
        const interval = window.setInterval(() => { void refresh(false) }, POLL_MS)
        return () => {
          disposed = true
          requestOverviewRefresh = async () => {}
          notificationOpen = () => {}
          window.clearInterval(interval)
          if (lastAppliedTitle !== null && window.document.title === lastAppliedTitle) window.document.title = baseDocumentTitle
        }
      }, [])

      React.useEffect(() => {
        updateDocumentTitle(snapshot)
      }, [snapshot])

      return null
    }

    function overallMode(snapshot) {
      const modes = snapshot.instances.map((item) => statusMode(snapshot.states[item.id]))
      if (modes.includes('waiting')) return 'waiting'
      if (modes.includes('working')) return 'working'
      if (modes.includes('completed')) return 'completed'
      return 'idle'
    }

    function HubIcon(props) {
      const snapshot = useHubSnapshot()
      const mode = overallMode(snapshot)
      return React.createElement('span', { className: 'dsh-hub-icon-wrap', style: { '--dsh-hub-icon-size': `${props.size}px` } },
        React.createElement('svg', {
          className: 'dsh-hub-icon', width: props.size, height: props.size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: '1.8', strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { opacity: props.active ? 1 : .72 },
        },
          React.createElement('rect', { x: '4', y: '3.5', width: '16', height: '5', rx: '1.8' }),
          React.createElement('rect', { x: '4', y: '15.5', width: '16', height: '5', rx: '1.8' }),
          React.createElement('path', { d: 'M8 8.5v7M16 8.5v7' }),
          React.createElement('circle', { cx: '7.5', cy: '6', r: '.7', fill: 'currentColor', stroke: 'none' }),
          React.createElement('circle', { cx: '7.5', cy: '18', r: '.7', fill: 'currentColor', stroke: 'none' }),
        ),
        mode === 'idle' ? null : React.createElement('span', { className: `dsh-hub-icon-badge is-${mode}` }),
      )
    }

    function statusGlyph(mode) {
      if (mode === 'waiting') return '!'
      if (mode === 'completed') return '✓'
      return ''
    }

    function HubPanel(props) {
      const snapshot = useHubSnapshot()
      const instances = snapshot.instances
      const selectedId = snapshot.activeId
      const [readyIds, setReadyIds] = React.useState({})
      const [pendingId, setPendingId] = React.useState(null)
      const [manualPort, setManualPort] = React.useState('')
      const [renameId, setRenameId] = React.useState(null)
      const [renameValue, setRenameValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('状态监控已启动')

      React.useEffect(() => {
        if (selectedId === null && instances[0]) setActiveServer(instances[0].id)
      }, [selectedId, instances])

      const refresh = async () => {
        setBusy(true)
        setStatus('重新扫描端口并刷新状态…')
        try {
          await requestOverviewRefresh(true)
          setStatus('状态已刷新')
        } finally {
          setBusy(false)
        }
      }

      const addManual = () => {
        const port = Number(String(manualPort).trim())
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setStatus('请输入有效端口')
          return
        }
        const preferences = readPreferences()
        const nextPreferences = preferences.manualPorts.includes(port)
          ? preferences
          : { names: preferences.names, manualPorts: preferences.manualPorts.concat(port) }
        storePreferences(nextPreferences)
        const id = `http://127.0.0.1:${port}/`
        setActiveServer(id)
        setPendingId(id)
        setManualPort('')
        setStatus(`正在添加并检测端口 ${port}`)
      }

      const beginRename = () => {
        const selected = instances.find((item) => item.id === selectedId)
        if (!selected) return
        const preferences = readPreferences()
        setRenameId(selected.id)
        setRenameValue(preferences.names[selected.url] || preferences.names[String(selected.port)] || '')
      }

      const finishRename = () => {
        const target = instances.find((item) => item.id === renameId)
        if (!target) {
          setRenameId(null)
          return
        }
        const value = String(renameValue).trim().slice(0, 40)
        const preferences = readPreferences()
        const names = Object.assign({}, preferences.names)
        delete names[String(target.port)]
        if (value) names[target.url] = value
        else delete names[target.url]
        storePreferences({ names, manualPorts: preferences.manualPorts })
        setStatus(value ? `已命名为“${value}”` : '已恢复默认名称')
        setRenameId(null)
        setRenameValue('')
      }

      const selectInstance = (item) => {
        markServerRead(item.id)
        if (item.id === selectedId) return
        if (readyIds[item.id] || selectedId === null) {
          setPendingId(null)
          setActiveServer(item.id)
          return
        }
        setPendingId(item.id)
        setStatus(`正在准备“${item.label}”…`)
      }

      const markFrameReady = (item) => {
        setReadyIds((current) => current[item.id] ? current : Object.assign({}, current, { [item.id]: true }))
        if (pendingId === item.id) {
          setPendingId(null)
          setActiveServer(item.id)
          setStatus(`已切换到“${item.label}”`)
        }
      }

      const tabs = instances.map((item) => {
        const serverState = snapshot.states[item.id]
        const mode = pendingId === item.id ? 'pending' : statusMode(serverState)
        const taskCount = serverState && (serverState.waitingCount > 0 ? serverState.waitingCount : serverState.workingCount)
        return React.createElement('button', {
          key: item.url,
          type: 'button',
          className: `dsh-hub-tab${selectedId === item.id ? ' is-active' : ''}${pendingId === item.id ? ' is-pending' : ''}`,
          onClick: () => selectInstance(item),
          title: `${item.label} · ${stateDescription(serverState)} · ${item.url}`,
          'aria-label': `${item.label}，${stateDescription(serverState)}`,
        },
          React.createElement('span', { className: `dsh-hub-tab-status is-${mode === 'pending' ? 'waiting' : mode}` }, mode === 'pending' ? '…' : statusGlyph(mode)),
          React.createElement('span', { className: 'dsh-hub-tab-label' }, item.label),
          taskCount > 1 ? React.createElement('span', { className: 'dsh-hub-tab-count' }, String(taskCount)) : null,
        )
      })

      const frames = instances.map((item) => {
        const active = selectedId === item.id
        return React.createElement('iframe', {
          key: item.url,
          className: `dsh-hub-frame${active ? ' is-active' : ''}`,
          src: item.url,
          title: item.label,
          allow: 'clipboard-read; clipboard-write',
          onLoad: () => markFrameReady(item),
          'aria-hidden': active ? undefined : true,
          tabIndex: active ? 0 : -1,
        })
      })

      const selectedInstance = instances.find((item) => item.id === selectedId)
      const showLoadingCover = Boolean(selectedInstance && !readyIds[selectedInstance.id])
      const mode = overallMode(snapshot)
      const notificationPermission = snapshot.notificationPermission
      const notificationLabel = notificationPermission === 'granted' ? '通知✓' : notificationPermission === 'denied' ? '通知×' : '通知'
      const notificationTitle = notificationPermission === 'granted'
        ? 'Windows 桌面通知已启用'
        : notificationPermission === 'denied'
          ? '通知已被浏览器拒绝，请在站点设置中恢复'
          : notificationPermission === 'unsupported'
            ? '当前浏览器不支持桌面通知'
            : '启用 Windows 桌面通知'

      const editor = renameId
        ? React.createElement('div', { className: 'dsh-hub-edit-group' },
            React.createElement('input', {
              className: 'dsh-hub-input dsh-hub-name-input', value: renameValue, placeholder: '例如：197服务器', maxLength: 40,
              onChange: (event) => setRenameValue(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') finishRename(); if (event.key === 'Escape') setRenameId(null) },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: finishRename, title: '保存名称' }, '✓'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: () => setRenameId(null), title: '取消' }, '×'),
          )
        : React.createElement('div', { className: 'dsh-hub-edit-group' },
            React.createElement('input', {
              className: 'dsh-hub-input', value: manualPort, placeholder: '端口', inputMode: 'numeric',
              onChange: (event) => setManualPort(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') addManual() },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: addManual, title: '手动添加端口' }, '+'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', disabled: !selectedId, onClick: beginRename, title: '命名当前服务器' }, '命名'),
          )

      const brandGlyph = mode === 'waiting' ? '!' : mode === 'completed' ? '✓' : ''
      const summary = mode === 'waiting' ? '有服务器等待操作' : mode === 'working' ? 'Agent 工作中' : mode === 'completed' ? '有任务已完成' : (snapshot.warning || status)

      return React.createElement('div', { className: 'dsh-hub' },
        React.createElement('header', { className: 'dsh-hub-toolbar' },
          React.createElement('div', { className: 'dsh-hub-brand', title: summary },
            React.createElement('span', { className: `dsh-hub-brand-state is-${mode}` }, brandGlyph),
            React.createElement('span', null, '服务器 Hub'),
          ),
          React.createElement('div', { className: 'dsh-hub-tabs' }, tabs),
          React.createElement('div', { className: 'dsh-hub-tools' },
            editor,
            React.createElement('button', {
              type: 'button', className: `dsh-hub-action${notificationPermission === 'granted' ? ' is-enabled' : ''}`,
              disabled: notificationPermission === 'unsupported' || notificationPermission === 'denied',
              onClick: async () => {
                const permission = await requestNotifications()
                setStatus(permission === 'granted' ? '桌面通知已启用' : permission === 'denied' ? '通知权限已被拒绝' : '当前浏览器不支持通知')
              },
              title: notificationTitle,
            }, notificationLabel),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', disabled: busy, onClick: refresh, title: '重新扫描并刷新状态' }, busy ? '…' : '↻'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: () => props.layout.selectPanel(null) }, '主控'),
          ),
          React.createElement('div', { className: 'dsh-hub-status', title: summary }, summary),
        ),
        React.createElement('main', { className: 'dsh-hub-stage' },
          frames,
          React.createElement('div', { className: `dsh-hub-loading${showLoadingCover ? ' is-visible' : ''}`, 'aria-hidden': showLoadingCover ? undefined : true },
            React.createElement('div', { className: 'dsh-hub-loading-card' },
              React.createElement('span', { className: 'dsh-hub-loading-dot' }),
              React.createElement('span', null, selectedInstance ? `正在载入“${selectedInstance.label}”…` : '正在载入…'),
            ),
          ),
          instances.length === 0
            ? React.createElement('div', { className: 'dsh-hub-empty' },
                React.createElement('div', { className: 'dsh-hub-empty-card' }, '尚未发现 DSH。可在顶部手动填写 Windows 本地隧道端口。Agent 状态监控需要在每台远程 DSH 上安装同一插件。'),
              )
            : null,
        ),
      )
    }

    function apply(ctx) {
      if (window.parent !== window) return

      ctx.effect(() => {
        const style = window.document.createElement('style')
        style.dataset.dshServerHub = 'true'
        style.textContent = CSS
        window.document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-server-hub: styles')

      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'dsh-server-hub-monitor', order: -1000, label: 'DSH Server Hub Monitor' },
        () => React.createElement(HubMonitor, { layout: ctx.layout }),
      ))
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
        { name: 'sidebar.panellist', id: PANEL_ID, order: 80, label: '服务器 Hub' },
        HubIcon,
      ))
      ctx.slots.inject('main', () => ctx.slots.register(
        { name: 'main', key: PANEL_ID },
        () => React.createElement(HubPanel, { layout: ctx.layout }),
      ))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
