# Ant Code Dashboard 整改需求文档

状态：Draft
日期：2026-07-11
适用范围：`src/dashboard/`、Dashboard 使用的共享运行时、Dashboard 静态资源、相关测试与发布流程

## 1. 背景

Dashboard 当前已经支持本机会话、模型切换、权限确认、上下文管理、文件预览、后台子任务和流式输出，但本轮审查确认其安全边界、并发一致性、响应式交互、无障碍和长会话性能仍存在系统性缺口。

其中最高风险是：服务虽然只监听 loopback，却没有 API 身份凭证、`Host`/`Origin` 校验或 CSRF 防护。实测外站来源可以使用简单跨站请求触发 Dashboard API，并把新任务设置为 `fullAccess`。因此，“仅监听本机”不能作为浏览器安全边界。

本文档把已确认问题转化为可实现、可测试、可验收的整改需求。配套执行步骤见 `dashboard-hardening-execution-checklist.md`。

## 2. 产品目标

- 阻止其他网页、DNS rebinding、恶意工作区内容和超限输入接管或拖垮 Dashboard。
- 保证同一会话中的启动、排队、中断、压缩、删除和后台任务状态一致。
- 保证界面展示的权限、任务状态、上下文占用和关闭状态与真实运行状态一致。
- 在手机、平板和中等宽度桌面上保留会话、对话、文件和新任务等全部核心能力。
- 建立键盘、读屏、慢网、断流、长会话和发布资产的自动化回归门禁。
- 在不重写 Ant Code 核心运行时的前提下完成整改。

## 3. 非目标

- 不把 Dashboard 开放到局域网或公网。
- 不在本阶段引入云端账号、远程中继或多人协作权限模型。
- 不重写模型网关、工具系统、session 存储格式或整个前端技术栈。
- 不把 Dashboard 改造成 IDE，也不新增与本轮问题无关的业务功能。
- 不以关闭安全校验或降低权限默认值作为兼容方案。

## 4. 约束与原则

- Dashboard 继续只允许绑定 `127.0.0.1`、`localhost` 或 `::1`。
- 默认权限必须是 `plan`，权限不得在会话或新任务之间隐式继承。
- 所有高风险状态都由后端判定，前端状态不能成为安全依据。
- API 和文件边界采用默认拒绝；无法确认安全的内容必须下载、隔离或要求显式操作。
- session 和 transcript 必须保持向后兼容；如增加元数据，旧记录仍应可读。
- 任何安全凭证、API key、token 或完整敏感输入都不得写入仓库、URL 查询参数、日志或错误消息。
- 运行时修改应优先复用现有模块和测试模式，不做无关重构。

## 5. 优先级定义

| 优先级 | 定义 | 发布要求 |
| --- | --- | --- |
| P0 | 可导致跨站高权限操作、代码执行或核心信任边界失效 | 未完成不得发布 |
| P1 | 可造成任务丢失、越权、状态损坏、主要流程不可用或明显数据风险 | 本轮整改必须完成 |
| P2 | 可造成错误反馈、性能退化、无障碍阻断或发布回归 | 应在本轮完成，延期需记录原因 |
| P3 | 体验增强或运维改进 | 可在核心验收后安排 |

## 6. 需求总览

| 需求 ID | 优先级 | 主题 |
| --- | --- | --- |
| DASH-SEC-001 | P0 | 本地 API 身份认证与同源防护 |
| DASH-SEC-002 | P1 | 外部媒体与浏览器网络访问控制 |
| DASH-SEC-003 | P1 | 工作区文件真实路径与主动内容隔离 |
| DASH-SEC-004 | P1 | 请求体、prompt 和附件服务端限额 |
| DASH-SEC-005 | P1 | Office 压缩包安全解析 |
| DASH-SEC-006 | P1 | 敏感字段递归脱敏与安全响应头 |
| DASH-CON-001 | P1 | 提交幂等与重复操作保护 |
| DASH-CON-002 | P1 | 队列容量、顺序和 wakeup 可靠性 |
| DASH-CON-003 | P1 | 权限按会话隔离 |
| DASH-CON-004 | P1 | 中断、强制释放与旧任务隔离 |
| DASH-CON-005 | P1 | 后台任务归属、取消、删除和关闭 |
| DASH-CON-006 | P1 | 会话级互斥与规范化选择器 |
| DASH-CON-007 | P1 | 任务终态和事件序号真实性 |
| DASH-CON-008 | P1 | 配置原子写与上下文持久化 |
| DASH-UX-001 | P1 | 统一界面运行状态模型 |
| DASH-UX-002 | P1 | 异步请求防乱序与错误恢复 |
| DASH-UX-003 | P1 | SSE 连接、重连和离线反馈 |
| DASH-UX-004 | P1 | 响应式导航和布局 |
| DASH-UX-005 | P2 | 输入区与危险操作交互 |
| DASH-UX-006 | P2 | 键盘、焦点、读屏和减弱动画 |
| DASH-PERF-001 | P1 | transcript 按 chunk 真分页 |
| DASH-PERF-002 | P2 | active session 回收与 SSE 背压 |
| DASH-PERF-003 | P2 | 流式增量渲染和长会话窗口化 |
| DASH-PERF-004 | P2 | 结构化数据全局渲染预算 |
| DASH-REL-001 | P1 | Dashboard 行为、安全与浏览器回归矩阵 |
| DASH-REL-002 | P1 | 构建资产与发布门禁 |
| DASH-REL-003 | P2 | 可观测性、文档和回滚约束 |

## 7. 安全需求

### DASH-SEC-001 本地 API 身份认证与同源防护

问题：`src/dashboard/server.js` 当前直接路由请求，不验证访问凭证、`Host`、`Origin`、`Sec-Fetch-Site` 或 CSRF token，且写接口接受 `text/plain` JSON。

需求：

- Dashboard 每次启动必须生成至少 128 bit 的密码学随机临时凭证。
- 凭证只存在于当前进程和当前浏览器会话，不写日志、不写持久化文件、不放入 URL 查询参数。
- `/api/status`、sessions、events、files 等读取接口和全部写接口都必须验证凭证。
- `Host` 必须匹配实际绑定的 loopback host 和端口；其他 Host 返回 `403`。
- 有 `Origin` 的请求必须与 Dashboard origin 完全一致；跨站请求返回 `403`。
- 所有带 body 的修改请求只接受 `application/json`；其他类型返回 `415`。
- 写接口增加 CSRF 防护，并拒绝 `Sec-Fetch-Site: cross-site`。
- 页面必须禁止被第三方 frame 嵌入；不得通过开放 CORS 解决兼容问题。

验收标准：

- 伪造 Host、外站 Origin、缺失/错误凭证、`text/plain` 写请求均不会调用 runtime。
- 正常浏览器首次打开、刷新、SSE 重连和新窗口打开仍可完成认证。
- `/api/trust`、`/api/turns`、`/api/shutdown` 必须包含专项跨站回归测试。

### DASH-SEC-002 外部媒体与浏览器网络访问控制

问题：模型输出中的 Markdown 图片会自动加载任意 `http(s)` 地址，绕过 Ant Code 网络权限，并可能外带上下文或访问内网服务。

需求：

- Markdown 默认只自动加载同源 `/api/files/raw` 和经过验证的 `data:` 位图。
- 远程图片首先显示域名、完整目标和“加载远程图片”操作，不得自动请求。
- 若产品允许加载远程图片，请求必须使用隔离路径、无 referrer，并受显式白名单或单次确认约束。
- CSP 的 `img-src` 默认只允许 `'self'` 和必要的 `data:`；禁止通过放宽全局 CSP 实现远图。
- 外部链接继续使用新窗口，并保留 `noopener`、`noreferrer`。

验收标准：

- 渲染包含唯一追踪 URL 的模型输出时，未点击前目标服务收不到请求。
- `http://127.0.0.1`、RFC1918 和公网图片都执行相同的默认阻止策略。

### DASH-SEC-003 工作区文件真实路径与主动内容隔离

问题：文件边界只做词法 `path.resolve` 检查，后续读取会跟随 symlink/junction；SVG 又以同源主动内容返回并提供顶层打开入口。

需求：

- 工作区 root 和目标文件必须执行 `realpath`，并在解析后再次验证目标位于 root 内。
- session metadata 中的 `cwd` 也必须经过允许工作区校验，不能直接扩大文件访问边界。
- 文件打开应尽量基于已验证的文件句柄，降低检查后替换目标的竞态。
- SVG 不得作为可执行的同源顶层文档提供；必须选择安全净化、独立不可信 origin、沙箱或附件下载之一。
- 未知二进制内容应使用 `application/octet-stream` 和安全的 `Content-Disposition`。
- 所有原始响应增加 `X-Content-Type-Options: nosniff`。

验收标准：

- symlink、junction、大小写差异和 `..` 路径均不能读取工作区外文件。
- 恶意 SVG 的脚本不能访问任何 Dashboard API。
- Windows、macOS 和 Linux 至少各有路径策略单元测试或可重复验证说明。

### DASH-SEC-004 请求体、prompt 和附件服务端限额

问题：`readJson` 会把完整 body 拼入内存；服务端只限制图片数量，不验证 base64、真实字节、MIME 或客户端声明的 size。

需求：

- body 读取必须流式计数，超限立即终止并返回 `413`。
- 普通 API JSON body 默认不得超过 1 MiB。
- prompt UTF-8 字节数不得超过 256 KiB。
- 图片最多 6 张，单张解码后不超过 8 MiB，总解码字节不超过 24 MiB。
- turn body 的编码后上限应根据上述附件上限设置，并在代码中集中定义。
- 服务端必须严格验证 base64、解码长度、允许的 MIME 和文件签名；不得信任 `size` 字段。
- 队列中的附件也计入会话内存预算，超限不得入队。

验收标准：

- `Content-Length` 和 chunked 两类超限请求都返回 `413`，进程内存不会随完整恶意 body 增长。
- 伪造 size、无效 base64、MIME 与内容不符、超单图和超总量均被拒绝。
- 客户端在发送前显示相同限额和可操作的错误信息。

### DASH-SEC-005 Office 压缩包安全解析

问题：DOCX、XLSX、PPTX 只限制压缩文件大小，解析器会同步解压条目，可能被小体积 ZIP bomb 阻塞或耗尽内存。

需求：

- 解析前限制 ZIP 条目数、单条目解压大小、总解压大小和压缩比。
- 默认总解压上限为 64 MiB，单条目上限为 16 MiB，条目数上限为 1000；如调整必须记录依据。
- 只解压预览需要的 XML 和关系文件，不遍历无关大资源。
- Office 解析必须移到受限 worker 或可终止子任务，并设置时间上限。
- 超限、超时和损坏文件只返回安全错误卡片，不阻塞 HTTP 事件循环。

验收标准：

- ZIP bomb、超条目、超时和损坏样本不会造成主进程 OOM 或长时间无响应。
- 正常 DOCX、XLSX、PPTX 轻量预览保持可用。

### DASH-SEC-006 敏感字段递归脱敏与安全响应头

问题：审批输入只按顶层 key 脱敏，嵌套对象、命令字符串和 token-like 值仍可能进入 SSE、DOM 或错误消息。

需求：

- 对对象、数组和嵌套结构递归脱敏常见 secret、token、authorization、password、credential 字段。
- 对 shell 命令、MCP arguments 和 URL 中的 token-like 值执行保守遮罩，同时保留足够审批上下文。
- API 错误不得返回堆栈、密钥、完整敏感输入或本机不必要路径。
- HTML 和 API 响应统一增加最小安全头：CSP、`nosniff`、`Referrer-Policy`、`frame-ancestors` 或等价头。

验收标准：

- 多层嵌套 secret 和带 Authorization 的命令不会出现在事件 JSON、页面文本和测试日志中。
- 审批卡仍能说明工具、目标、风险和非敏感命令结构。

## 8. 运行一致性需求

### DASH-CON-001 提交幂等与重复操作保护

- 点击发送、按 Enter、触屏提交必须共用同一个 submitting guard。
- 客户端为每次 turn 生成稳定 request ID；服务端在合理窗口内对重复 ID 返回同一结果，不重复创建会话或执行任务。
- 提交期间按钮、输入区和状态区暴露一致的 busy 状态；失败后允许安全重试。

验收标准：延迟首个响应后快速连续 Enter 或点击，只产生一个 turn 和一个 session。

### DASH-CON-002 队列容量、顺序和 wakeup 可靠性

- 入队前检查容量，队满返回 `429` 和明确的最大值，不得先写后截断。
- 普通 prompt、guide 转换和 background wakeup 使用同一容量契约。
- guide 不得无提示挤掉队尾消息；从普通消息转换为 guide 必须原子完成。
- wakeup 只有在成功入队或成功开始后才能标记 consumed。
- 事件合并后数组中的 sequence 必须保持严格递增，SSE 重放不得倒序或漏事件。

验收标准：第 21 条普通、guide 和 wakeup 都有确定行为，所有已返回成功的项目最终都会执行或可见地取消。

### DASH-CON-003 权限按会话隔离

- 打开会话时，前端必须使用后端返回的 `session.permission` 更新控件。
- 新任务始终初始化为 `plan`，不得继承前一会话的 `workspace` 或 `fullAccess`。
- 权限状态必须绑定 session ID；切换会话不得修改其他会话权限。
- 进入 `fullAccess` 需要醒目的二次确认，说明任意路径、命令、MCP 和网络风险。
- 权限分段控件必须同步可访问选中状态。

验收标准：A 会话为 `fullAccess` 时切到 plan 会话 B 或新任务，下一次请求仍为 `plan`。

### DASH-CON-004 中断、强制释放与旧任务隔离

- 用户请求中断后，状态进入 `interrupting`，不能立即声称旧执行已经停止。
- 队列下一项只有在旧 turn 真正 settle 后才能复用同一个 session。
- 忽略 AbortSignal 的旧执行超时时，应隔离或 quarantine 该 session，而不是清空 controller 后继续运行。
- 不可取消的工具应在可终止 worker/子进程中执行，或明确阻止自动续跑。
- 中断结果必须区分“已请求”“已停止”“未能及时停止”。

验收标准：构造忽略 Abort 的网关或工具后，不会出现两个 turn 同时修改同一 session。

### DASH-CON-005 后台任务归属、取消、删除和关闭

- 取消 subagent 或 terminal 前必须验证 task、group、parent session 和 cwd 一致。
- 更新任务状态应使用条件更新，不能把未实际取消的其他会话任务写成 interrupted。
- 父会话存在后台任务时，默认禁止删除；用户可选择取消后台任务并等待结束后删除。
- 删除后必须注销 listener、timer、wakeup callback 和对旧 state 的引用，后台回调不得复活会话。
- 关闭 Dashboard 时必须展示主 turn、队列和后台任务数量；有活动任务时要求明确选择取消并关闭或返回。
- shutdown 必须执行有上限的清理流程，不能直接在 25 ms 后 `process.exit`。

验收标准：跨会话取消返回 `403/404` 且不改记录；有后台任务的会话不能被静默删除；关闭后没有遗留可写任务。

### DASH-CON-006 会话级互斥与规范化选择器

- 对每个规范化完整 session ID 建立 keyed mutex 或 in-flight reservation。
- resume、start turn、clear、compact、delete 和影响 session 的配置更新必须遵循同一互斥规则。
- Dashboard 修改接口只接受完整、精确 session ID；不得使用 `latest` 或唯一前缀绕过 active 检查。
- 冷会话并发恢复只允许创建一个 active state。

验收标准：并发恢复、压缩与启动、删除与启动的测试中不会出现重复 active state、覆盖 Map 或 transcript 交叉写入。

### DASH-CON-007 任务终态和事件序号真实性

- `runSessionTurn` 到 Dashboard 的契约必须明确返回 completed、failed、blocked、interrupted、cancelled 等终态。
- gateway error、tool limit、失败子任务和 interrupt 不得映射为 completed/success。
- 只有成功且缺少 final 事件时才允许合成 `assistant_final`。
- 所有事件 sequence 严格单调；合并事件应移到正确顺序或使用不破坏重放的独立快照机制。

验收标准：每种终态在 session list、header、transcript、SSE 重放和持久化 metadata 中一致。

### DASH-CON-008 配置原子写与上下文持久化

- 模型保存、删除和网关切换使用进程内互斥、必要的跨进程锁和临时文件原子替换。
- 包含密钥的配置文件使用最小必要权限，且任何响应都不得回显 key。
- clear/compact 成功后立即持久化 session metadata、transcript/context window 和必要索引。
- 重启后不得恢复已明确清空的旧上下文，也不得丢失已完成的压缩摘要。

验收标准：并发配置更新不丢字段、不产生半文件；清空或压缩后重启仍保持相同上下文状态。

## 9. 交互需求

### DASH-UX-001 统一界面运行状态模型

- 前端使用明确状态：booting、idle、submitting、running、queued、interrupting、waiting-input、reconnecting、failed、completed、shutting-down、closed。
- 状态文案、按钮可用性、颜色和 aria 状态由同一状态模型派生，不能靠 MutationObserver 解析中文文本。
- shutdown 只有收到成功响应并确认服务停止后才能显示 closed；失败时恢复连接和操作。
- 上下文占用优先展示 active message tokens，最新 prompt/provider 输入作为独立“输入”指标。
- 会话列表对同一运行状态只使用一个主要视觉标记；展开态不得同时出现脉冲灯、荧光文字和整行高亮，稳定终态不占用持续状态标签。

验收标准：状态机测试覆盖合法转换和非法转换；当前上下文用例显示 `20k / 200k · 10% · 输入 40k`。

### DASH-UX-002 异步请求防乱序与错误恢复

- session 打开、历史分页、文件预览、模型切换和配置加载各自维护 AbortController 或递增 request token。
- 响应提交 DOM 前必须再次验证目标 session/file 与当前选择一致。
- 切换会话时取消旧历史和文件请求，旧响应不得修改新会话。
- 每个异步表面必须有 loading、empty、error 和 retry 状态；不得保留旧内容冒充成功。
- bootstrap 任一步失败都显示可重试的错误界面。

验收标准：人为让 A 响应晚于 B，最终始终展示 B，A 的 transcript 和文件不会插入 B。

### DASH-UX-003 SSE 连接、重连和离线反馈

- 展示 connecting、connected、reconnecting、offline 和 stale 状态以及最后事件时间。
- EventSource error 时不能永久显示“运行中”；采用有上限的指数退避并允许手动重连。
- 重连使用已确认的严格单调 cursor，处理服务器重放窗口缺口。
- 切换会话和关闭页面时必须释放旧连接。

验收标准：断开、恢复、服务重启、cursor 过旧和 session 不存在均有明确可恢复行为，不重复最终消息。

### DASH-UX-004 响应式导航和布局

- `>=1200px` 可使用三栏布局；预览栏可折叠，也可在保护中间对话最小宽度的前提下拖动或通过键盘调整宽度，并记住用户选择。
- `768-1199px` 自动收起至少一个侧栏，并提供会话与文件抽屉入口。
- `<768px` 提供“会话 / 对话 / 文件”标签、底部导航或等价入口；新任务始终可达。
- 不得通过 `display:none` 丢弃没有替代入口的核心功能。
- 使用 `100dvh` 与 safe-area，软键盘出现时输入区仍可见。
- 320px 宽度起不得出现页面级横向裁切、状态按钮消失或文本越界。

验收标准：320、390、768、1024、1280、1440 宽度的截图和交互用例均通过；桌面预览栏调整后不挤压中间对话，刷新后宽度保持。

### DASH-UX-005 输入区与危险操作交互

- prompt 输入框自动增高到合理上限，附件和发送保持紧凑且触控目标不小于 44px。
- 发送期间禁止重复提交；运行中“中断”必须与普通发送有明确状态和视觉差异。
- 无当前 session 或任务运行中时，清空/压缩上下文必须禁用并解释原因。
- 清空上下文、删除会话、`fullAccess` 和关闭服务放在次级或危险操作区域，并显示影响范围。
- 长 transcript 在用户离开底部时不得抢滚动；显示“有新回复 / 回到底部”。
- 需求确认面板默认提供足够的正文审阅空间；用户可临时收起面板回看 transcript，回看期间只开放对话浏览，不开放会话切换、发送或其他状态修改操作，返回后保留已选项和补充输入。

验收标准：新任务空状态不会诱导执行无效上下文操作；所有危险操作都能取消且失败后可恢复；需求确认过程中可回看长对话并无损返回继续确认。

### DASH-UX-006 键盘、焦点、读屏和减弱动画

- 使用原生 `<dialog>` 或完整实现 modal 的 focus trap、背景 inert、Escape 和焦点恢复。
- 权限模式使用 radiogroup/aria-checked 或等价语义，并支持方向键。
- prompt、自定义回答和关键控件必须有真实 label 或可靠 accessible name。
- transcript 使用 `role=log` 或等价增量语义；历史和草稿默认 `aria-live=off`，最终状态通过小型 live region 通知。
- 所有展开控件使用 button/details 并维护 `aria-expanded`。
- 提供统一高对比 `:focus-visible`；不得只用弱边框表示文本框焦点。
- 遵循 `prefers-reduced-motion`，关闭无限 pulse 和平滑滚动。
- 颜色对比达到 WCAG 2.1 AA，纯键盘可完成核心流程。

验收标准：axe 不存在 serious/critical 问题；键盘可完成启动、切会话、发消息、审批、问答、文件预览和关闭 modal。

## 10. 性能需求

### DASH-PERF-001 transcript 按 chunk 真分页

- 首屏和上一页只读取覆盖目标 cursor 的必要 archive chunk，不能先拼接完整历史再切片。
- transcript archive 需要提供可定位消息范围的索引；损坏 chunk 应返回明确错误而不是静默降级为不完整历史。
- “展示分页”和“resume 恢复完整模型上下文”分开实现和测试。

验收标准：10,000 条消息的首屏 100 条和上一页请求只读取必要 chunk；resume 仍能获得完整需要的上下文。

### DASH-PERF-002 active session 回收与 SSE 背压

- 非运行、无 listener、无后台任务且已持久化的 active state 支持 TTL/LRU 驱逐。
- 默认 active 上限和 idle TTL 集中配置；驱逐前清理 timer、listener、controller 和大对象引用。
- SSE 设置单 session/进程连接上限，处理 `res.write()` 背压和慢消费者。
- 驱逐后重新打开会话应透明恢复，不丢 transcript 或权限安全默认值。

验收标准：持续打开大量历史会话后 active Map 和 heap 有稳定上限；慢 SSE 客户端不会拖垮事件循环。

### DASH-PERF-003 流式增量渲染和长会话窗口化

- 流式阶段按增量或分块更新纯文本，不得每 180 ms 重新解析累计全文。
- 最终回答到达后执行一次完整 Markdown/rich render。
- transcript DOM 使用窗口化、分段卸载或等价策略，默认只保留可控数量的消息节点。
- 每帧最多执行一次自动滚动；尊重用户当前滚动位置。
- Mermaid、KaTeX、Office 和大型表格按可见性懒加载。

验收标准：50k 字符流式输出和 500+ 消息会话中，输入、滚动和中断按钮保持可响应，最终内容完整。

### DASH-PERF-004 结构化数据全局渲染预算

- 深度限制必须真正停止递归，而不只是控制 `<details open>`。
- 每个 rich block 设置全局节点、深度、行、列和字符串字节预算。
- 超出预算时显示摘要和显式“继续展开”，展开时按需生成 DOM。
- 不得把无限制完整 TSV 或大文本复制到 data attribute。

验收标准：深层、宽层和组合爆炸 JSON/YAML 不会生成指数级隐藏 DOM；正常小数据保持当前可读性。

## 11. 质量与发布需求

### DASH-REL-001 Dashboard 行为、安全与浏览器回归矩阵

- 保留现有 unit/runtime/server 测试，并增加真实 DOM 或浏览器级测试。
- 安全矩阵至少覆盖恶意 Origin/Host、错误凭证、CSRF、body 超限、远图、symlink、SVG 和 ZIP bomb。
- 一致性矩阵至少覆盖双回车、队列第 21 条、权限切换、并发恢复、强制中断、后台删除和跨会话取消。
- 浏览器矩阵至少覆盖响应乱序、SSE 断线、modal 焦点、纯键盘、移动端导航、长流式内容和 axe。
- 测试不得只通过正则检查源码是否包含某段文本来代替行为验证。

验收标准：新增回归在修复前可稳定失败、修复后稳定通过，且不依赖外部模型服务。

### DASH-REL-002 构建资产与发布门禁

- CI 和发布流程必须重建 Dashboard rich bundle、KaTeX CSS 和字体，并逐字节或按稳定 hash 比较产物。
- Windows 可执行文件构建前必须执行 Dashboard 资产一致性检查。
- `npm-shrinkwrap.json` 与 `package-lock.json` 必须保持一致，依赖检查通过。
- 增加并执行 TypeScript `checkJs` 类型检查脚本；当前声明的 TypeScript 依赖必须真实安装。
- 发布门禁至少包含 syntax、forbidden endpoints、dependency policy、typecheck、Dashboard tests、browser tests、asset check 和 `git diff --check`。

验收标准：故意修改源码但不重建 bundle、故意制造 lock 差异或类型错误时，CI 和发布构建均明确失败。

### DASH-REL-003 可观测性、文档和回滚约束

- 记录不含敏感内容的 API 拒绝原因、SSE 连接数、队列拒绝、active 驱逐和解析超限计数。
- README、本地安装、安全边界和 Dashboard 使用文档更新认证启动、远程媒体、附件限额和关闭语义。
- 若引入 session/archive 新字段，提供向后兼容读取和回滚说明。
- 安全认证不得通过运行时开关关闭；出现启动兼容问题时应回滚整个版本，而不是降级为无认证。
- 每个阶段完成后保留验证结果和已知剩余风险。

验收标准：运维信息足以定位拒绝和重连问题，但日志中不存在凭证、API key、完整 prompt 或附件数据。

## 12. 需求依赖与实施顺序

```text
DASH-SEC-001/004
  -> DASH-CON-001/002/003/005/006
  -> DASH-UX-001/002/003
  -> DASH-UX-004/005/006
  -> DASH-PERF-001/002/003/004
  -> DASH-REL-001/002/003
```

- API 认证和 body 限额必须最先完成，因为后续浏览器测试和接口契约都依赖它们。
- 运行一致性应早于视觉重排，避免在错误状态模型上继续堆 UI。
- 响应式和无障碍可以并行，但必须共用相同导航与 modal 结构。
- 性能优化应在状态和分页契约稳定后实施。
- 发布门禁从第一阶段开始增量接入，不能等全部代码完成后一次补齐。

## 13. 风险与待确认事项

- 临时 API 凭证如何交给自动打开的浏览器且不进入查询参数，需要在详细设计中定稿。
- 严格 Host 校验需要兼容 `127.0.0.1`、`localhost` 和 IPv6 loopback 的实际启动 URL。
- Windows junction、Unix symlink 和文件替换的跨平台安全语义需要分别验证。
- Office worker 的实现方式要兼容 Node.js 20 和打包后的 Windows 可执行文件。
- transcript chunk 索引扩展必须保持旧 archive 可读。
- active TTL/LRU 不能回收仍有后台任务、pending approval/question 或 SSE listener 的 state。
- 移动端导航方案可以在实现前做低保真验证，但不得改变“核心能力不消失”的验收标准。

## 14. Definition of Done

- 所有 P0、P1 需求完成并通过自动化验收。
- P2 未完成项有明确负责人、原因、风险和后续日期，且不影响安全发布。
- Dashboard 专项 unit/integration/browser tests 全部通过。
- `npm run check`、类型检查、Dashboard 资产一致性检查和 `git diff --check` 通过。
- 320 至 1440 宽度截图、纯键盘流程、axe、慢网/断网、10k 历史和 50k 流式性能验收通过。
- 安全文档、安装文档、变更日志和回滚说明已更新。
- 没有凭证、测试 secret、临时会话、截图或构建产物进入版本控制。

## 附录 A：同一 PR 中的 TUI 输入栏配套需求

本附录只覆盖本轮明确要求的输入栏硬化。旧智能体对 TUI shell、主题、布局、overlay、动画和整体视觉结构的重构不属于交付范围，必须丢弃且不得通过整文件复制重新混入。

### TUI-IN-001 确定性的输入事件归属

- raw/Ink 对同一个按键或粘贴事件只能处理一次，使用明确的事件 claim，不使用 25-120ms 时间窗口猜测去重。
- raw 层接管 bracketed paste、终端特定 Backspace/Delete 序列、Shift+Tab fallback、鼠标和滚动/Page 事件；普通字符和 Ctrl 快捷键由 Ink 输入路径处理。
- Windows Terminal 常见的 `0x7F` 必须按 Backspace 向后删除，真正的 `CSI 3~` 才按 Delete 向前删除；两者通过原始序列确定性区分。
- 同一个 stdin chunk 中混合的普通文本、Backspace 和 Delete 必须按原顺序执行；不能把控制字节插入草稿，也不能丢掉相邻文本。
- Kitty `release` 事件只用于结束按键状态，不得再次触发删除、提交、滚动或快捷键；`repeat` 事件保持正常连按语义。
- 保留进程 SIGINT 处理和现有双 Ctrl+C 退出语义。

验收标准：快速连续输入、退格、Delete、Ctrl 快捷键和粘贴不重复、不漏键；Windows 的 `0x08`、`0x7F`、Kitty Backspace 和 CSI Delete 均有回归覆盖，也不会因机器负载变化产生时序差异。

### TUI-IN-002 快捷键与换行契约

- Ctrl 快捷键使用 Ink 实际发出的 `inputValue`，不读取不存在的 `key.name`。
- 普通 Enter 提交；`Shift+Enter`、`Alt+Enter` 和 `Ctrl+J` 在普通输入和自定义问答中插入换行。
- Home/End/Delete 只使用 Ink 提供的标准键状态，不保留失效的 `key.name` fallback。
- Alt/Ctrl+Backspace 和 Alt/Ctrl+Delete 在终端可区分修饰键时按单词边界删除；合并到同一 chunk 的“文本+Return”仍按提交处理。

验收标准：Ctrl+A/E/K/U/W/J/O/G/C/F/B/L 在对应上下文稳定生效；换行快捷键不误提交。

### TUI-IN-003 Unicode grapheme 安全

- 光标、插入、退格、Delete 和宽度计算以 grapheme cluster 为单位，而不是 UTF-16 code unit 或单个 code point。
- 正确处理家庭 emoji、区域旗帜、组合音标、CJK、variation selector、ZWJ 和制表位。
- 草稿 grapheme 缓存和单 grapheme 显示宽度缓存必须分别设置固定上限，不允许长会话持续增长。

验收标准：单次退格不会拆开 emoji/组合字符；视觉列、软换行和光标位置一致。

### TUI-IN-004 稳定的多行编辑视口

- 输入草稿保存 `visibleStart` 和纵向移动的首选列，普通输入最多显示 3 个内容行，问答最多显示 10 个内容行。
- 光标在当前窗口内移动时不抖动；离开窗口时只移动必要行数。
- Home/End 移到当前视觉行边界；长粘贴显示真实可编辑行，transcript 仍可保持摘要压缩。
- 应用模式保持硬件光标隐藏，只渲染一个反色视频软件光标。

验收标准：长单行软换行、多行草稿和宽字符上下移动时，光标、文本和可视窗口没有跳动或脱节。

### TUI-IN-005 粘贴与渲染性能

- bracketed paste 解析器支持分片的开始/结束标记、标记前后相邻文本和普通 Escape 序列。
- 粘贴内容只插入一次；开始标记前缀不足以确认时不得吞掉普通 Escape。
- Ink 使用增量渲染，最高 60 FPS；50k ASCII/CJK 草稿常见编辑的本机中位耗时应控制在约 10ms 内，极端 emoji 草稿也不得重复执行无界 Unicode 宽度计算。

验收标准：TUI 专项回归全部通过，完整仓库门禁通过，且交付分支不包含旧 TUI 重构特征文件。

### TUI-SCOPE-001 分支和交付边界

- 源分支为 `codex/dashboard-tui-hardening`，目标分支为 `main`；不得直接在 `main` 上开发或提交。
- `main`、`origin/main` 和交付基线在本轮交付时均为 `6cafdea345f2596f325844c26d2ff24b9b9c4f27`。
- 旧 TUI 工作树和分支在干净迁移、测试和污染审计通过后删除。
- 禁止混入 `src/control`、`.antcode-control`、本地项目配置，以及旧 TUI 的 shell/styles/overlays/animation-clock/layout/theme 重构。
