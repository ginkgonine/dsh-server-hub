# DSH Server Hub

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web 提供常驻的多服务器主控界面。

在 Windows PC 上运行一个主控 DSH，将多台远程服务器的 DSH 端口通过 SSH/其他隧道转发到该 PC；本插件自动识别本机监听端口中的 DSH，并在同一个主控外壳里用顶部标签切换。远程服务器无需安装插件。

## 功能

- 自动读取 Windows、Linux、macOS 的本机 TCP 监听端口。
- 通过 IPv4/IPv6 loopback 探测 DSH 启动页或认证响应，并自动排除主控自身端口。
- 左侧栏提供紧凑的服务器 Hub 入口。
- 顶部横向标签切换服务器，主控外壳不会整页跳转。
- 每个服务器 iframe 保持挂载并在后台预载；切换时使用短暂淡入，避免深色模式下出现白屏闪烁。
- 支持手动添加隧道端口。
- 支持自定义服务器名称，例如“197服务器”。
- 自定义名称和手动端口保存在浏览器 `localStorage` 中。

## 架构

```text
Windows PC
├── DSH 主控 + dsh-server-hub
├── 127.0.0.1:3101 ── tunnel ── 服务器 A 的 DSH
├── 127.0.0.1:3102 ── tunnel ── 服务器 B 的 DSH
└── 浏览器
    └── 主控外壳
        ├── 服务器 A iframe
        └── 服务器 B iframe
```

Host 插件只在主控机器上扫描本机监听端口，并通过受 DSH 登录保护的 `/api/dsh-server-hub/scan` 返回识别结果。Client 插件注册 `sidebar.panellist` 和 `main` Slot，在浏览器中加载对应的本机转发地址。

## 安装

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:ginkgonine/dsh-server-hub
```

`dsh-server-hub` 是 Profile Bundle，`dsh plugin` 会把它加入 Web profile 的 bundle 列表。安装完成后重启：

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

1. 在主控 PC 上启动所有端口转发。
2. 打开主控 DSH，点击左侧“服务器 Hub”。
3. 插件会自动扫描；也可以在顶部手动输入端口。
4. 选择服务器后点击“命名”，设置易辨识的名称。
5. 点击“主控”返回主控 DSH 会话。

## 已知限制

- 自动扫描发生在运行主控 DSH 的机器上。插件部署在 Linux 服务器时，看不到 Windows PC 上的本地隧道端口。
- 目标 DSH 必须允许被 iframe 嵌入。如果目标响应设置了阻止嵌入的 CSP `frame-ancestors` 或 `X-Frame-Options`，需要改用主控反向代理方案。
- 自动探测仅访问 `127.0.0.1` 和 `::1`；只绑定其他网卡地址、HTTPS 或非 loopback 的场景需要后续增加完整 URL 配置。
- 不要把本插件安装到远程 DSH；它只属于主控 Web profile。

## 开发

本仓库提交了可直接安装的 `lib/` 产物。构建过程不依赖私有 DSH 构建工具：Host 使用标准 ESM，Client 使用 DSH 的 `window.__ModuleLoader__` 模块包装格式。

```bash
npm run build
npm test
npm run check
```

项目结构：

```text
src/index.js      Host：端口发现、DSH 探测、受保护 API
src/client.js     Client：Slot UI、iframe Hub、本地名称配置
cordis.patch.yml  Web profile bundle patch
scripts/build.mjs 生成 lib/ 发布产物
```

## 安全说明

- 扫描 API 会经过 DSH `connection.requestRejection()` 登录校验。
- 只探测系统已经处于监听状态的本机 TCP 端口，最多 256 个。
- 每个 HTTP 探测有 1.2 秒超时、256 KiB 流式读取上限，并限制并发数。
- 不向远程服务器写入任何文件，也不要求远程服务器加载插件。

## License

[MIT](LICENSE)
