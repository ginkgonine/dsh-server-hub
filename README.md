# DSH Server Hub

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 提供常驻的多服务器主控界面。

在 Windows PC 上运行一个主控 DSH，将多台远程服务器的 DSH 端口通过 SSH/其他隧道转发到该 PC；本插件自动识别本机监听端口中的 DSH，并在同一个主控外壳里用顶部标签切换。若要显示 Agent 工作、等待人工处理和完成状态，需要在被监控的远程 DSH 上也安装同一插件作为轻量状态桥接端。

## 功能

- 自动读取 Windows、Linux、macOS 的本机 TCP 监听端口。
- 通过 IPv4/IPv6 loopback 探测 DSH 启动页或认证响应，并自动排除主控自身端口。
- 左侧栏提供紧凑的服务器 Hub 入口。
- 顶部横向标签切换服务器，主控外壳不会整页跳转。
- Hub 面板内的服务器 iframe 保持挂载并在后台预载；服务器标签间切换时使用短暂淡入，避免深色模式下出现白屏闪烁。
- 支持手动添加隧道端口。
- 支持自定义服务器名称，例如“197服务器”。
- 自定义名称和手动端口保存在浏览器 `localStorage` 中。
- 服务器标签显示 Agent 的工作中、等待授权/回答、已完成和离线状态。
- Hub 顶部、侧栏图标和浏览器标签页标题会同步汇总多服务器状态。
- 可由用户主动启用 Windows 浏览器通知；等待人工处理和任务结束使用不同通知。

## 架构

```text
Windows PC
├── DSH 主控 + dsh-server-hub（发现、轮询、Hub UI）
├── 127.0.0.1:3101 ── tunnel ── 服务器 A 的 DSH + dsh-server-hub（状态桥接）
├── 127.0.0.1:3102 ── tunnel ── 服务器 B 的 DSH + dsh-server-hub（状态桥接）
└── 浏览器
    └── 主控外壳
        ├── 常驻状态监控器
        ├── 服务器 A iframe
        └── 服务器 B iframe
```

主控 Host 在浏览器首次连接状态总览后启动常驻监控：每 30 秒重新发现端口，并约每 1.5 秒通过现有转发端口轮询远端桥接端。远端 Host 只返回工作数、等待数和完成序号等最小聚合数据，不传输会话正文。Client 在 `shell.overlay` 中挂载不可见监控器，因此离开 Hub 面板后，浏览器标题和桌面通知仍能继续工作。

## 安装

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:ginkgonine/dsh-server-hub
```

`dsh-server-hub` 是 Profile Bundle，`dsh plugin` 会把它加入 Web profile 的 bundle 列表。主控必须安装；需要状态监控的每台远程 DSH 也执行同一安装命令。远端页面被 Hub iframe 嵌入时不会渲染第二套 Hub UI，只运行 Host 状态桥接。

安装完成后重启对应的 DSH：

```bash
dsh web
```

### 从本地源码安装

```bash
git clone https://github.com/ginkgonine/dsh-server-hub.git
cd dsh-server-hub
npm run check
dsh plugin --profile web add .
```

然后重启 `dsh web`。

### 验证组合

```bash
dsh --profile web --dump-config
```

输出中应包含：

```yaml
- id: dsh-server-hub
  name: dsh-server-hub
```

### 卸载

```bash
dsh plugin --profile web remove dsh-server-hub
```

卸载后重启 DSH。

## 使用

1. 在主控和需要监控的远端 DSH 上安装插件。
2. 在主控 PC 上启动所有端口转发。
3. 打开主控 DSH，点击左侧“服务器 Hub”。
4. 插件会自动扫描；也可以在顶部手动输入端口。
5. 选择服务器后点击“命名”，设置易辨识的名称。
6. 点击“通知”并允许浏览器通知，即可接收 Windows 桌面提示。
7. 点击“主控”返回主控 DSH 会话；后台状态监控仍会继续。

## 已知限制

- 自动扫描发生在运行主控 DSH 的机器上。插件部署在 Linux 服务器时，看不到 Windows PC 上的本地隧道端口。
- 目标 DSH 必须允许被 iframe 嵌入。如果目标响应设置了阻止嵌入的 CSP `frame-ancestors` 或 `X-Frame-Options`，需要改用主控反向代理方案。
- 自动探测仅访问 `127.0.0.1` 和 `::1`；只绑定其他网卡地址、HTTPS 或非 loopback 的场景需要后续增加完整 URL 配置。
- 未安装插件的远端仍可切换和使用，但状态会显示为“未安装状态桥接插件”，不会产生 Agent 状态通知。
- Windows 通知权限必须由用户点击“通知”主动授予；拒绝后需在浏览器站点设置中恢复。

## 开发

本仓库提交了可直接安装的 `lib/` 产物。构建过程不依赖私有 DSH 构建工具：Host 使用标准 ESM，Client 使用 DSH 的 `window.__ModuleLoader__` 模块包装格式。

```bash
npm run build
npm test
npm run check
```

项目结构：

```text
src/index.js      Host：端口发现、状态桥接、常驻轮询与受保护 API
src/client.js     Client：Slot UI、iframe Hub、标题/通知与本地名称配置
cordis.patch.yml  Web profile bundle patch
scripts/build.mjs 生成 lib/ 发布产物
```

## 安全说明

- 扫描和状态总览 API 会经过 DSH `connection.requestRejection()` 登录校验。
- 远端 `/api/dsh-server-hub/status` 只接受无 `Origin` 的 loopback GET/HEAD 请求，供 SSH 转发后的主控 Host 轮询；不会开放浏览器跨域访问。
- 不要把该状态端点放在会把外部请求转成 loopback 来源的本机反向代理后面；需要反向代理时应另外增加访问控制。
- 状态桥接只返回进程纪元、聚合数字、递增序号和结束原因，不返回会话 ID、标题、消息或工具参数。
- 只探测系统已经处于监听状态的本机 TCP 端口，最多 256 个；手动端口最多 64 个且仍限定 loopback HTTP。
- HTTP 探测有 1.2 秒超时和流式读取上限；状态轮询限制为 16 KiB、禁止重定向，并限制并发数。

## License

[MIT](LICENSE)
