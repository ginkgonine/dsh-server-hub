# 历史草案：远程派单（0.3.0-alpha.1）

> 此实现已被 [简化远程子 Agent](<remote-agents.md>) 替代，不再进入发布包或默认 bundle。下文仅保留历史设计记录，不是当前配置指南。请勿与新模块同时启用。

最小闭环：**主机普通 DSH 会话 → 指定服务器/项目 → 独立服务器 DSH 会话 → 结果回到原主机会话**。

不依赖 TODO 或 QQ 插件，不改它们的代码或数据；也不自动启用、配置服务器、升级 DSH 或操作现有训练。原有 Hub 切换/状态雷达保持不变。现有 Hub 图标反映 Agent 运行/等待，不代表训练任务完成；新派单的执行真相看 remote_task_status/result 与主机会话报告。

## 1. 当前支持与真实边界

- 按 DSH 0.2.0-rc.1/rc.2 会话、权限和沙箱接口实现；原 Hub 的 0.1.5 支持不等于新任务模块支持旧接口。
- 第一版任务账本/持久执行器面向 **Linux、本地 POSIX 文件系统**。要求私有权限、目录 fsync、原子 rename、/proc 进程身份；不支持 NFS/多写者。原 Hub 的 Windows/macOS 支持不变，新任务模块暂不承诺原生 Windows。
- 主机与服务器可使用各自的模型配置。项目必须存在，使用规范绝对路径；注册一个真实可用的 Agent preset ID，不是模型名称。
- 项目写沙箱仅约束文件写入，不保证其他目录不可读，也不提供网络/进程隔离。必须部署 enforcing fs/shell 与 sandbox/permission 服务，不能仅靠 cwd 或提示词。
- 配对 token 是该节点已映射项目的**操作员级凭据**，不是多租户权限系统。保护配置、token、任务控制目录；仅使用可信部署/自己的节点。不同身份或不可信项目需要另行设置 OS/容器、读取和网络边界。
- 可复用服务器现有容器；检查实际挂载、UID、GPU 与沙箱能力。沙箱不可用拒绝执行；partial 只有明确设置项目 allowPartial 才接受。
- 本项目没有替你认证部署隔离。尤其 supervisor 的 controlBoundaryVerified 是部署者核对后的声明，不是自动证明：同 UID 下 0700/0600 **不能**使 key 对 Agent 不可读；不要在这种情况下启用持久执行。
- V1 不支持任务 Agent 再派远程任务/使用 DSH subagent 扩张任务；任务后代的模型步骤被拒绝。独立人工 fork 不属于原任务。
- 项目有显式 allowedTools 能力白名单，默认只提供开发/查看/任务结果工具；goal、workflow、subagent、profile 管理及无关第三方工具不在默认名单。需要额外 MCP/terminal 等工具时由部署者配置，模型不能自行放宽。关闭模块后，Agent 自己生命周期中的 step/tool guard 仍拒绝后台唤醒；核对归属后显式恢复才重新绑定。

## 2. 两端配置

在主机和被指挥服务器安装本地/发布版本，然后分别配置任务模块。

```bash
# 在本仓库目录，先验证本地源码
npm run check
dsh plugin --profile web add .
```

服务器也必须安装相同代码版本。先停止旧进程，再按自身部署方式重新启动；不会有“主机安装即可控制任意纯 DSH”的自动授权。

参考 [主机配置](../examples/master-tasks.patch.yml) 和 [服务器配置](../examples/worker-tasks.patch.yml)。它们均为关闭状态、占位路径/凭据，**不能原样启用**。

1. 配置私有 stateDirectory：父目录先由部署者创建，状态目录要求所属用户正确、0700、无符号链接；内部账本自动创建 0600 文件。
2. 在服务器登记 nodeId（例如 v100）、项目 id（sr）、真实 root、Agent preset、权限及资源标签。
3. 主机登记相同 nodeId、端点、token、允许选择的项目 IDs。HTTP 只允许规范 loopback；远程端点必须 HTTPS。禁止把 token 放在 URL 中。
4. 生成随机 token，两端一致；示例 REPLACE_* 会被配置校验拒绝。不要把真实 token 提交到 Git 或发进模型对话。
5. 完成后将配置的 disabled 改 false、enabled 改 true。每个 DSH 启动使用对应配置 overlay；不是修改服务器浏览器页面。

```bash
# 按需使用 SSH 隧道；这是用户执行示例，不是插件自动建立的连接
ssh -N -L 3101:127.0.0.1:3080 user@v100

# 在相应机器上：使用经过配置的绝对路径；不替换已有运行的 GUI 服务
# 或将同一 id-targeted 配置追加到你自己的 profile patch
dsh web --patch /absolute/path/master-tasks.patch.yml
dsh web --patch /absolute/path/worker-tasks.patch.yml

# 在私有部署环境生成 token；只在可信终端查看/保存
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

节点端点可以含代理挂载前缀，必须把该前缀剥离后转发到服务器。自动扫描仅用于 Hub 展示；扫描到实例不等于配对或拥有派单权限。`--patch` 示例由用户选择自己的实例，插件不会自动改 profile 或启动替代服务。

同项目串行；配置相同 resources 标签的项目也互斥。租约覆盖等待进程/人工阶段。它不是 GPU 调度器，无法强制约束插件外手工训练；启动前仍需检查已有负载。

## 3. 主机聊天中的工具

- remote_task_targets：一次确定性连接查询，列出配对节点/项目与在线状态，不启动远端 Agent。
- remote_task_submit：nodeId、projectId、instruction，可选 idempotencyKey。返回 taskId 和 accepted；离线/未确认不会说“已交给服务器”。
- remote_task_status / remote_task_result：读取属于本会话的缓存状态和结果，不启动 Agent。优先等通知，不反复调用。
- remote_task_resume：对 waiting_human/reconciling 提供明确补充指令。必须有新的主机会话用户输入；本插件自动 report turn 不允许调用它绕过预算。不能替远端 DSH 批准现有审批。
- remote_task_cancel：取消任务/观察，不会杀已有训练。停掉本系统启动的训练是另一个独立远端操作。

示例自然语言：

> 先看看已配对的服务器和项目。然后在 v100 的 sr 项目检查昨晚训练：仍在运行就观察，不重复启动；明确中断则说明 checkpoint 和恢复方案；完成后汇总指标并回报这个会话。

主机 Agent 选择明确 nodeId/projectId 后提交，回复接收结果就可以空闲。结果只回原会话，不能由模型指定其他会话、任意目录、URL、preset 或提权。

## 4. 服务器如何结束/暂停

每任务一个随机、持久绑定的独立会话；不向服务器当前人工聊天塞命令。已有同名无归属会话拒绝采用，创建前先检查，成功后记录归属。

服务器任务工具（只有任务根会话可操作自己的任务）：

- remote_task_finish：必须有 outcome（succeeded/failed/needs_input）、summary、evidence。成功必须有证据；空闲、最后一段文字、Job completed 都不是成功标准。
- remote_execution_observe：登记本部署用户、项目目录内的现有 Linux PID。保存 starttime、boot ID、cwd、命令摘要，防止 PID 复用。只观察，不接管/杀进程。
- remote_execution_start：可选持久执行器配置完成后，用任务项目写沙箱启动命令，返回 executionId；不接受外部目录或权限。
- remote_task_park：只接受本任务已登记的 executionId。先登记观察再暂停；pre-step gate 阻止继续模型调用。
- remote_execution_status：一次确定性查询真实退出结果，不启动模型。
- remote_execution_stop：独立明确操作，只能停止自己受管执行，不能对旧 tmux/nohup 任意 PID 发信号。

活跃阶段默认 20 次模型步骤/10 分钟，nearest-deadline 程序计时器暂停超时阶段。排队、进程等待、审批等待不产生定时模型调用；审批等待时间不计入活跃预算。

## 5. 长训练与现有 tmux/nohup

已有训练：核对身份后 observe → park。默认 60 秒程序核对一次；进程退出可能没有退出码，因此只触发核对，绝不直接报训练成功。身份不确定转人工处理；不按“进程没了”盲目重启。

新训练：可选 supervisor 启动**独立普通 Node 进程**，不是 DSH 内存 Job，也不要求新容器。准确退出事件/原子结果文件触发观察；日志追加和其他任务不会触发模型或频繁状态读取。状态文件监听遗漏时用 60 秒程序核对补偿。

执行器使用私有 signed ticket，绑定 executionId、项目、真实 root/cwd、已封装的 sandbox argv、期限、受控环境变量、命令摘要。模型不能提交未封装 argv 给 CLI。签名/control state 必须有真正读写隔离；仅放在项目外或 chmod 不够。

生成 key 之前先核对边界；配置 secretFile 为私有文件，supervisor.stateDirectory 必须与所有项目分离、私有本地持久目录。secret 文件不能带 shell 环境自动继承给训练。环境允许 PATH、LANG、LC_ALL、CUDA_VISIBLE_DEVICES；环境激活可以写进项目内的命令，不默认继承整台主机环境。

同一执行 ID 不重跑；不同命令不能复用 ID。先前执行确认已结束后，任务可转入后续执行，最多保留 8 个续行记录；旧 ID 重试返回旧结果。失败至多自动唤醒一次诊断，再次失败需用户输入。

受管进程日志有 8MiB 前缀上限，结果说明截断情况；完整训练日志/指标应写项目约定目录。Agent 需根据实际退出码及产物核对成功，CLI 自身退出成功不等于训练退出成功。

## 6. 断线、重启与取消

- 主机主动连服务器 HTTP/SSE，15 秒 transport heartbeat；45 秒无活动断开补领。不要求服务器反向访问主机，也不调用模型检查心跳。
- taskId 和提交意图先持久化；超时使用同 ID 重试。不同内容/原会话复用 ID 拒绝。取消支持 tombstone，阻止延迟原请求再启动任务。
- 事件序号、主机接收游标与报告 outbox 持久化；重连补事件。报告 requestId 稳定，消息 admission 后请求 Session flush。并发状态同步不能回退远端 revision。
- token/身份错误等待配置修复，不无限重试；断线则程序退避重连，不把运行训练误报失败。
- DSH 正常重启不会调用执行器 kill；独立执行器可继续运行。服务管理器若杀整个 cgroup、容器/机器重启，不能承诺进程存活。
- 等待执行的任务恢复观察；事件唤醒前重新核对持久会话归属、preset、现有权限和工作目录，并重绑任务工具白名单。会话丢失或权限改变拒绝自动继续，不重建会话或把权限改回。
- 中断的活跃 Agent 阶段转 reconciling，不盲目 replay shell/模型。用户核对后从主机明确 resume，或取消后重新派单。配置哈希改变不能自动恢复旧任务。
- 默认 cancel/模块关闭只影响所属 Agent/观察，不杀训练；这是有意行为。已有 tmux/nohup 一律不自动终止。
- 原主机会话删除/归档时，结果保留在账本，报告待处理，不新建会话或改投别人。
- 文件账本单写者、0700/0600、fsync + atomic snapshot；上限 10k tasks、100k events、64MiB。到达容量或存储异常时 fail closed，需显式运维归档；不能宣称 distributed/exactly-once 任意 shell 副作用。

## 7. 验证顺序

1. npm run check；测试覆盖真实 HTTP/SSE（会话/沙箱服务 mock）、持久 runner 的真实短进程、断线/重启记录、PID 身份、非零退出、重复请求、暂停/恢复、归属、并发乱序、预算、子 Agent 门禁。
2. 配置两端，确认 remote_task_targets 返回实际目标；先派一个只读短任务，不用训练或真实权限提升。
3. 确认远端独立会话与 result 证据，回传只到主机原会话；等待过程中模型请求数不增长。
4. 然后验证 legacy 观察，再在已确认隔离的部署里验证持久执行。测试 DSH 重启和网络断开，确认没有重复训练。

自动化测试不是实际 V100/模型/browser 端到端验收。当前默认不启用，不操作真实服务器、不改 TODO/QQ；请核对部署信息后再试。

首次试用只做短任务：不配置 supervisor，不接管训练，先确认 `remote_task_targets` 能看到节点，再让远端查看项目并用 `remote_task_finish` 回报证据。长训练与恢复验收放在短任务闭环之后。

## 8. 网页断链与模型请求失败

- 本模块默认 `disabled: true`，且未设置 `enabled: true` 时不会注册任务路由、工具或监听器。尚未启用派单时，不应直接把网页重连归因于任务控制通道。
- 网页「重新连接」是浏览器到 DSH 的连接状态；`TRANSPORT / fetch failed` 是 DSH 到模型服务的请求错误。两者可能同时发生，但不能据此断言同一原因。
- 排查时先确认服务进程是否重启、直连与隧道访问是否都失败，再记录浏览器 Console 错误和 WebSocket 关闭码。直连短时正常不等于浏览器/隧道链路已修复。
- 不要为排查网页重连而启用派单、改变项目权限、反复提交真实训练或删除旧会话。保留现有会话和日志，先定位连接层。
