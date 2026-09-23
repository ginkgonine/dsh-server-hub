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

    const CSS = `
      .dsh-hub-icon { display: block; color: currentColor; }
      .dsh-hub { height: 100%; min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); color: inherit; background: inherit; }
      .dsh-hub-toolbar { min-width: 0; display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-bottom: 1px solid color-mix(in srgb, currentColor 14%, transparent); background: color-mix(in srgb, currentColor 2.5%, transparent); }
      .dsh-hub-brand { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; font-size: 12px; font-weight: 760; white-space: nowrap; }
      .dsh-hub-brand-dot { width: 8px; height: 8px; border-radius: 50%; background: #4f7cff; box-shadow: 0 0 0 3px color-mix(in srgb, #4f7cff 16%, transparent); }
      .dsh-hub-tabs { flex: 1 1 auto; min-width: 100px; display: flex; align-items: center; gap: 6px; overflow-x: auto; padding: 2px; scrollbar-width: thin; }
      .dsh-hub-tab { flex: 0 0 auto; display: flex; align-items: center; gap: 7px; max-width: 190px; padding: 7px 10px; border: 1px solid color-mix(in srgb, currentColor 14%, transparent); border-radius: 999px; color: inherit; background: transparent; cursor: pointer; }
      .dsh-hub-tab:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
      .dsh-hub-tab.is-active { border-color: color-mix(in srgb, #4f7cff 58%, transparent); background: color-mix(in srgb, #4f7cff 15%, transparent); }
      .dsh-hub-tab-dot { width: 7px; height: 7px; flex: 0 0 auto; border-radius: 50%; background: #39b66a; }
      .dsh-hub-tab-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; font-weight: 670; }
      .dsh-hub-tools { flex: 0 0 auto; display: flex; align-items: center; gap: 6px; }
      .dsh-hub-edit-group { display: flex; align-items: center; gap: 5px; }
      .dsh-hub-input { width: 76px; min-width: 0; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 7px; padding: 7px 8px; color: inherit; background: transparent; outline: none; font: inherit; font-size: 11px; }
      .dsh-hub-name-input { width: 118px; }
      .dsh-hub-action { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 7px; padding: 7px 9px; color: inherit; background: transparent; cursor: pointer; font: inherit; font-size: 11px; white-space: nowrap; }
      .dsh-hub-action:hover { background: color-mix(in srgb, currentColor 6%, transparent); }
      .dsh-hub-action:disabled { cursor: default; opacity: .42; }
      .dsh-hub-status { flex: 0 1 170px; min-width: 0; max-width: 170px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; opacity: .56; }
      .dsh-hub-stage { position: relative; min-width: 0; min-height: 0; overflow: hidden; isolation: isolate; background: var(--dsw-alias-bg-base, Canvas); }
      .dsh-hub-frame { position: absolute; inset: 0; z-index: 0; width: 100%; height: 100%; border: 0; display: block; opacity: 0; pointer-events: none; background: var(--dsw-alias-bg-base, Canvas); color-scheme: inherit; transform: translateZ(0); will-change: opacity; transition: opacity 160ms cubic-bezier(.2, .7, .2, 1); }
      .dsh-hub-frame.is-active { z-index: 1; opacity: 1; pointer-events: auto; }
      .dsh-hub-loading { position: absolute; inset: 0; z-index: 2; display: grid; place-items: center; color: var(--dsw-alias-label-secondary, currentColor); background: var(--dsw-alias-bg-base, Canvas); opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 180ms ease, visibility 0s linear 180ms; }
      .dsh-hub-loading.is-visible { opacity: 1; visibility: visible; transition-delay: 0s; }
      .dsh-hub-loading-card { display: flex; align-items: center; gap: 9px; font-size: 12px; opacity: .72; }
      .dsh-hub-loading-dot, .dsh-hub-tab.is-pending .dsh-hub-tab-dot { animation: dsh-hub-pulse 1s ease-in-out infinite alternate; }
      .dsh-hub-loading-dot { width: 8px; height: 8px; border-radius: 50%; background: #4f7cff; box-shadow: 0 0 0 4px color-mix(in srgb, #4f7cff 14%, transparent); }
      .dsh-hub-tab.is-pending .dsh-hub-tab-dot { background: #d99b24; }
      .dsh-hub-empty { position: absolute; inset: 0; z-index: 3; display: grid; place-items: center; padding: 28px; text-align: center; background: var(--dsw-alias-bg-base, Canvas); }
      .dsh-hub-empty-card { max-width: 480px; opacity: .68; line-height: 1.6; font-size: 13px; }
      @keyframes dsh-hub-pulse { from { opacity: .45; transform: scale(.82); } to { opacity: 1; transform: scale(1); } }
      @media (prefers-reduced-motion: reduce) { .dsh-hub-frame, .dsh-hub-loading { transition: none; } .dsh-hub-loading-dot, .dsh-hub-tab.is-pending .dsh-hub-tab-dot { animation: none; } }
      @media (max-width: 1020px) { .dsh-hub-toolbar { flex-wrap: wrap; gap: 7px; } .dsh-hub-tabs { order: 3; flex-basis: 100%; } .dsh-hub-status { display: none; } }
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

    function storePreferences(value) {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
      } catch {
        // The Hub remains usable when browser storage is unavailable.
      }
    }

    function makeInstance(port, source, preferences, detectedUrl) {
      const url = detectedUrl || `http://127.0.0.1:${port}/`
      return {
        id: url,
        port,
        url,
        source,
        label: preferences.names[url] || preferences.names[String(port)] || `DSH :${port}`,
      }
    }

    function HubIcon(props) {
      return React.createElement('svg', {
        className: 'dsh-hub-icon',
        width: props.size,
        height: props.size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: '1.8',
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { opacity: props.active ? 1 : .72 },
      },
        React.createElement('rect', { x: '4', y: '3.5', width: '16', height: '5', rx: '1.8' }),
        React.createElement('rect', { x: '4', y: '15.5', width: '16', height: '5', rx: '1.8' }),
        React.createElement('path', { d: 'M8 8.5v7M16 8.5v7' }),
        React.createElement('circle', { cx: '7.5', cy: '6', r: '.7', fill: 'currentColor', stroke: 'none' }),
        React.createElement('circle', { cx: '7.5', cy: '18', r: '.7', fill: 'currentColor', stroke: 'none' }),
      )
    }

    function HubPanel(props) {
      const [preferences, setPreferences] = React.useState(readPreferences)
      const [instances, setInstances] = React.useState(() => readPreferences().manualPorts.map((port) => makeInstance(port, 'manual', readPreferences())))
      const [selectedId, setSelectedId] = React.useState(null)
      const [readyIds, setReadyIds] = React.useState({})
      const [pendingId, setPendingId] = React.useState(null)
      const [manualPort, setManualPort] = React.useState('')
      const [renameId, setRenameId] = React.useState(null)
      const [renameValue, setRenameValue] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [status, setStatus] = React.useState('准备扫描…')

      const replacePreferences = (next) => {
        setPreferences(next)
        storePreferences(next)
      }

      const scan = async () => {
        setBusy(true)
        setStatus('扫描本机端口…')
        try {
          const response = await window.fetch('/api/dsh-server-hub/scan', {
            method: 'GET',
            credentials: 'same-origin',
            headers: { accept: 'application/json' },
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json()
          const automatic = Array.isArray(result.instances)
            ? result.instances.map((item) => {
                const port = Number(item.port)
                if (!Number.isInteger(port) || port < 1 || port > 65535) return null
                const url = String(item.url || '')
                const allowed = [`http://127.0.0.1:${port}/`, `http://[::1]:${port}/`]
                if (!allowed.includes(url)) return null
                return makeInstance(port, 'auto', preferences, url)
              }).filter((item) => item !== null)
            : []
          const autoSet = new Set(automatic.map((item) => item.port))
          const merged = automatic
            .concat(preferences.manualPorts.filter((port) => !autoSet.has(port)).map((port) => makeInstance(port, 'manual', preferences)))
          setInstances(merged)
          setSelectedId((previous) => previous && merged.some((item) => item.id === previous)
            ? previous
            : (merged[0] ? merged[0].id : null))
          setStatus(result.warning || `已发现 ${automatic.length} 个 DSH`)
        } catch (error) {
          setStatus(`扫描失败：${error && error.message ? error.message : String(error)}`)
        } finally {
          setBusy(false)
        }
      }

      React.useEffect(() => { scan() }, [])

      const addManual = () => {
        const port = Number(String(manualPort).trim())
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
          setStatus('请输入有效端口')
          return
        }
        const existing = instances.find((entry) => entry.port === port)
        if (existing) {
          setSelectedId(existing.id)
          setManualPort('')
          setStatus(`已切换到端口 ${port}`)
          return
        }
        const nextPreferences = preferences.manualPorts.includes(port)
          ? preferences
          : { names: preferences.names, manualPorts: preferences.manualPorts.concat(port) }
        replacePreferences(nextPreferences)
        const item = makeInstance(port, 'manual', nextPreferences)
        setInstances(instances.concat(item))
        setSelectedId(item.id)
        setManualPort('')
        setStatus(`已添加端口 ${port}`)
      }

      const beginRename = () => {
        const selected = instances.find((item) => item.id === selectedId)
        if (!selected) return
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
        const names = Object.assign({}, preferences.names)
        delete names[String(target.port)]
        if (value) names[target.url] = value
        else delete names[target.url]
        const nextPreferences = { names, manualPorts: preferences.manualPorts }
        replacePreferences(nextPreferences)
        setInstances(instances.map((item) => item.url === target.url
          ? Object.assign({}, item, { label: value || `DSH :${item.port}` })
          : item))
        setStatus(value ? `已命名为“${value}”` : '已恢复默认名称')
        setRenameId(null)
        setRenameValue('')
      }

      const selectInstance = (item) => {
        if (item.id === selectedId) return
        if (readyIds[item.id] || selectedId === null) {
          setPendingId(null)
          setSelectedId(item.id)
          return
        }
        setPendingId(item.id)
        setStatus(`正在准备“${item.label}”…`)
      }

      const markFrameReady = (item) => {
        setReadyIds((current) => current[item.id]
          ? current
          : Object.assign({}, current, { [item.id]: true }))
        if (pendingId === item.id) {
          setPendingId(null)
          setSelectedId(item.id)
          setStatus(`已切换到“${item.label}”`)
        }
      }

      const tabs = instances.map((item) => React.createElement('button', {
        key: item.url,
        type: 'button',
        className: `dsh-hub-tab${selectedId === item.id ? ' is-active' : ''}${pendingId === item.id ? ' is-pending' : ''}`,
        onClick: () => selectInstance(item),
        title: `${item.label} · ${item.url}`,
      },
        React.createElement('span', { className: 'dsh-hub-tab-dot' }),
        React.createElement('span', { className: 'dsh-hub-tab-label' }, item.label),
      ))

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

      const editor = renameId
        ? React.createElement('div', { className: 'dsh-hub-edit-group' },
            React.createElement('input', {
              className: 'dsh-hub-input dsh-hub-name-input',
              value: renameValue,
              placeholder: '例如：197服务器',
              maxLength: 40,
              onChange: (event) => setRenameValue(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') finishRename()
                if (event.key === 'Escape') setRenameId(null)
              },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: finishRename, title: '保存名称' }, '✓'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: () => setRenameId(null), title: '取消' }, '×'),
          )
        : React.createElement('div', { className: 'dsh-hub-edit-group' },
            React.createElement('input', {
              className: 'dsh-hub-input',
              value: manualPort,
              placeholder: '端口',
              inputMode: 'numeric',
              onChange: (event) => setManualPort(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') addManual() },
            }),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: addManual, title: '手动添加端口' }, '+'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', disabled: !selectedId, onClick: beginRename, title: '命名当前服务器' }, '命名'),
          )

      return React.createElement('div', { className: 'dsh-hub' },
        React.createElement('header', { className: 'dsh-hub-toolbar' },
          React.createElement('div', { className: 'dsh-hub-brand' },
            React.createElement('span', { className: 'dsh-hub-brand-dot' }),
            React.createElement('span', null, '服务器 Hub'),
          ),
          React.createElement('div', { className: 'dsh-hub-tabs' }, tabs),
          React.createElement('div', { className: 'dsh-hub-tools' },
            editor,
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', disabled: busy, onClick: scan, title: '重新扫描' }, busy ? '…' : '↻'),
            React.createElement('button', { type: 'button', className: 'dsh-hub-action', onClick: () => props.layout.selectPanel(null) }, '主控'),
          ),
          React.createElement('div', { className: 'dsh-hub-status', title: status }, status),
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
                React.createElement('div', { className: 'dsh-hub-empty-card' }, '尚未发现 DSH。可在顶部手动填写 Windows 本地隧道端口；远程 DSH 无需安装本插件。'),
              )
            : null,
        ),
      )
    }

    function apply(ctx) {
      ctx.effect(() => {
        const style = window.document.createElement('style')
        style.dataset.dshServerHub = 'true'
        style.textContent = CSS
        window.document.head.appendChild(style)
        return () => style.remove()
      }, 'dsh-server-hub: styles')

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
