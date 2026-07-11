# Ant Code Dashboard 整改执行清单

状态：自动化整改完成，待人工验收与发布签字
日期：2026-07-11
需求基线：`docs/design/dashboard-hardening-requirements.md`
交付分支：`codex/dashboard-tui-hardening`
PR 目标分支：`main`
交付基线：`6cafdea345f2596f325844c26d2ff24b9b9c4f27`（`v1.2.4`，与 `origin/main` 一致）
实现来源：Dashboard 整改从 `codex/dashboard-optimization` 迁入；旧 TUI 重构已丢弃
最近验证：2026-07-11

## 1. 使用规则

- 本清单只定义执行顺序，不授权自动切换分支、覆盖现有修改或执行发布。
- 实施前必须确认目标分支、基线 SHA 和工作区已有修改的归属。
- 每个实现项必须关联至少一个需求 ID；每个 P0/P1 需求必须有自动化测试。
- checkbox 只有在代码、测试、文档和对应验收全部完成后才能勾选。
- 遇到范围变化时先更新需求文档，再调整清单，不在代码中隐式改变验收标准。
- 安全校验失败时采用默认拒绝，不用兼容开关恢复匿名 API 或主动内容执行。

## 2. 阶段和退出条件

| 阶段 | 内容 | 退出条件 |
| --- | --- | --- |
| 0 | 基线与设计门禁 | 分支、依赖、失败基线和详细设计确认 |
| 1 | API 安全边界 | 跨站、DNS rebinding、匿名 API 全部被阻止 |
| 2 | 输入与文件安全 | 超限、越界、SVG、Office、远图攻击用例通过 |
| 3 | 任务与会话一致性 | 重复、丢队列、权限串用、并发和后台生命周期修复 |
| 4 | 状态与异步交互 | 状态真实、请求不串会话、SSE 可恢复 |
| 5 | 响应式与无障碍 | 320-1440px 核心流程、键盘和 axe 通过 |
| 6 | 性能与持久化 | 真分页、回收、增量渲染、原子持久化通过预算 |
| 7 | 发布门禁与交付 | 全量 CI、资产一致性、文档和回滚演练通过 |

## 3. 阶段 0：基线与详细设计

### 3.1 Git 与工作区门禁

- [x] 确认本次实现基于最新 `main`，在 `codex/dashboard-tui-hardening` 独立分支交付，PR 目标为 `main`。（DASH-REL-003）
- [x] 记录基线 commit SHA 和当前分支。（DASH-REL-003）
- [x] 丢弃旧智能体的广泛 TUI 重构，仅迁入本轮输入栏硬化；未引入 `shell`、`styles`、`overlays`、`animation-clock`、layout/theme 重构。（TUI-SCOPE-001）
- [x] 确认 `.antcode-control/` 和其他本地目录继续保持未跟踪且不进入提交。（DASH-REL-003）
- [x] 交付范围仅包含 Dashboard 整改和已确认的 TUI 输入栏硬化；未混入 control、本地项目配置或其他主控改动。（DASH-REL-003、TUI-SCOPE-001）

### 3.2 当前验证基线

- [ ] 复现 Dashboard 专项测试 `128` 项中 `127` 通过、上下文统计 `1` 项失败的基线。（DASH-UX-001、DASH-REL-001）
- [x] 复现 `npm run check:syntax` 对当前源文件通过。（DASH-REL-002）
- [x] 修复或明确处理 `npm-shrinkwrap.json` 与 `package-lock.json` 不一致，确保 dependency policy 能继续执行。（DASH-REL-002）
- [x] 安装并锁定 `typescript@6.0.3`，确认 `tsconfig.json` 的 `checkJs` 可运行。（DASH-REL-002）
- [ ] 保存修复前桌面 `1440x900`、中间宽度 `1024x768` 和手机 `390x844` 截图作为对照。（DASH-UX-004、DASH-REL-001）
- [ ] 保存修复前恶意 Host/Origin、重复 Enter、队列第 21 条、权限继承和请求乱序的可重复测试。（DASH-REL-001）

### 3.3 详细设计决策

- [x] 确定启动凭证从 CLI 到浏览器的传递方案，保证凭证不进入 query、日志和持久化。（DASH-SEC-001）
- [x] 确定 fetch、SSE 和刷新共享认证的方案；如使用 cookie，明确 SameSite、HttpOnly、生命周期和 CSRF；如使用 header，解决原生 EventSource 无法加 header 的问题。（DASH-SEC-001、DASH-UX-003）
- [x] 定义统一 API 错误 envelope、稳定错误码和 HTTP 状态码。（DASH-SEC-001、DASH-UX-001）
- [x] 定义 session 状态、turn 状态、connection 状态和 permission 状态枚举。（DASH-CON-007、DASH-UX-001、DASH-UX-003）
- [x] 定义完整 session ID、turn ID、request ID、event sequence 和 config revision 的契约。（DASH-CON-001、DASH-CON-006、DASH-CON-007、DASH-CON-008）
- [x] 定义附件限额、Office 解压预算、active TTL/LRU 和结构化数据预算的集中配置。（DASH-SEC-004、DASH-SEC-005、DASH-PERF-002、DASH-PERF-004）
- [x] 定义 transcript chunk 索引升级与旧 archive 兼容方案。（DASH-PERF-001）
- [x] 评审详细设计并记录未决项；P0 设计未确认前不开始视觉重构。（DASH-REL-003）

阶段 0 退出检查：

- [x] 目标分支、基线、依赖和现有修改归属均已确认。
- [x] P0 攻击链具有稳定失败测试。
- [x] 认证、状态、ID、限额和迁移方案已完成评审。

## 4. 阶段 1：API 安全边界

主要模块：`src/dashboard/server.js`、`src/dashboard/sessions.js`、`src/dashboard/public/app.js`、`src/cli/index.js`。

### 4.1 启动凭证与认证中间件

- [x] 在 Dashboard 启动时使用 `node:crypto` 生成至少 128 bit 临时凭证。（DASH-SEC-001）
- [x] 凭证只保存在当前进程和当前浏览器会话，不打印、不持久化、不进入查询参数。（DASH-SEC-001）
- [x] 为所有 `/api/*` 路由增加统一认证中间件，包括 GET、SSE、文件读取和 shutdown。（DASH-SEC-001）
- [x] 区分静态页面 bootstrap 与受保护 API；确认匿名静态页面不泄漏 cwd、session 或配置。（DASH-SEC-001）
- [x] 认证失败使用稳定 `401/403` envelope，不暴露正确凭证形式。（DASH-SEC-001、DASH-UX-001）
- [x] SSE 重连和页面刷新后认证继续有效，关闭 Dashboard 后立即失效。（DASH-SEC-001、DASH-UX-003）

### 4.2 Host、Origin、CSRF 与内容类型

- [x] 按实际 bound host/port 建允许列表，严格校验 `Host`，覆盖 IPv4、IPv6 和 `localhost`。（DASH-SEC-001）
- [x] 所有带 Origin 的 API 请求严格匹配 Dashboard origin。（DASH-SEC-001）
- [x] 拒绝 `Sec-Fetch-Site: cross-site` 的 API 请求。（DASH-SEC-001）
- [x] 为所有状态修改接口增加 CSRF 防护。（DASH-SEC-001）
- [x] POST/DELETE/PATCH body 只接受 `application/json`，错误类型返回 `415`。（DASH-SEC-001）
- [x] 不增加 `Access-Control-Allow-Origin: *` 或反射 Origin。（DASH-SEC-001）

### 4.3 安全响应头和 frame 防护

- [x] 为 HTML 建立最小 CSP：`default-src 'self'`、`frame-ancestors 'none'`、`object-src 'none'`、`base-uri 'none'`，并按实际字体、样式和图片需求收紧。（DASH-SEC-001、DASH-SEC-002、DASH-SEC-006）
- [x] 增加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和兼容的 frame 防护。（DASH-SEC-003、DASH-SEC-006）
- [x] 验证 CSP 不需要 `unsafe-eval`，内联内容使用模块文件、nonce 或 hash。（DASH-SEC-006）

### 4.4 API 安全测试

- [x] 新增缺失凭证、错误凭证和过期凭证测试。（DASH-SEC-001、DASH-REL-001）
- [x] 新增恶意 Host 和 DNS rebinding Host 测试。（DASH-SEC-001、DASH-REL-001）
- [x] 新增外站 Origin 对 status、sessions、files、trust、turns、cancel、delete、shutdown 的测试。（DASH-SEC-001、DASH-REL-001）
- [x] 新增 `text/plain`、form、错误 JSON 和错误 Content-Type 测试。（DASH-SEC-001、DASH-REL-001）
- [x] 新增 iframe/clickjacking 和 CSP 浏览器测试。（DASH-SEC-001、DASH-REL-001）

阶段 1 退出检查：

- [x] 外站网页不能读取任何 API，也不能触发任何 runtime 方法。
- [x] 正常页面打开、刷新、SSE 重连和关闭流程通过。
- [x] 安全凭证未出现在日志、URL、DOM、错误或测试快照中。

## 5. 阶段 2：输入、媒体和文件安全

主要模块：`src/dashboard/server.js`、`src/dashboard/files.js`、`src/dashboard/public/markdown.js`、`src/dashboard/public/app.js`、`src/tools/document-tools.js`。

### 5.1 请求体、prompt 和附件限额

- [x] 把普通 JSON、turn body、prompt、单图、总附件、数量上限定义为共享常量。（DASH-SEC-004）
- [x] 在 `readJson` 中流式累计字节，读取完整 body 前执行上限判断。（DASH-SEC-004）
- [x] 同时处理合法、缺失、伪造 `Content-Length` 和 chunked body。（DASH-SEC-004）
- [x] 超限时停止读取、关闭或排空请求并返回 `413`，不调用 runtime。（DASH-SEC-004）
- [x] 服务端校验 prompt UTF-8 字节数。（DASH-SEC-004）
- [x] 严格解析 base64，按解码后字节校验单图和总量。（DASH-SEC-004）
- [x] 校验允许 MIME 和文件签名，拒绝伪造 `size`、错误 MIME、SVG 附件和无效内容。（DASH-SEC-004）
- [x] 客户端使用相同限制提供提交前反馈，但不作为安全边界。（DASH-SEC-004、DASH-UX-005）

### 5.2 远程媒体

- [x] 修改 Markdown URL 策略，默认不生成会自动加载的远程 `<img>`。（DASH-SEC-002）
- [x] 为远程媒体渲染安全占位，显示目标域名和显式操作。（DASH-SEC-002）
- [x] 确认远图加载方案不通过未受控本地代理引入 SSRF。（DASH-SEC-002）
- [x] 限制 `data:` 为受支持的位图 MIME 和大小，禁止 SVG data URL。（DASH-SEC-002）
- [x] 测试公网、loopback、RFC1918、协议相对、`file:`、`javascript:` 和畸形 URL。（DASH-SEC-002、DASH-REL-001）
- [x] 用本地探针证明未点击前没有任何远程请求。（DASH-SEC-002、DASH-REL-001）

### 5.3 文件真实路径和 SVG

- [x] 抽取统一的 workspace realpath 授权函数，供 preview、raw、Office 和 session cwd 使用。（DASH-SEC-003）
- [x] 对 root 和目标执行 `realpath` 后按路径组件重新校验包含关系。（DASH-SEC-003）
- [x] 验证 session metadata cwd 仍位于允许工作区内。（DASH-SEC-003）
- [x] 使用文件句柄或等价方案降低校验后替换的 TOCTOU。（DASH-SEC-003）
- [x] 明确并实现工作区内部 symlink 策略。（DASH-SEC-003）
- [x] SVG 默认改为附件下载、安全净化、独立 origin 或位图转换，不再作为同源顶层主动文档。（DASH-SEC-003）
- [x] 为原始文件响应设置正确 MIME、`nosniff` 和安全 `Content-Disposition`。（DASH-SEC-003、DASH-SEC-006）
- [x] 增加 Windows junction、Unix symlink、大小写、UNC、`..` 和恶意 SVG 测试。（DASH-SEC-003、DASH-REL-001）

### 5.4 Office 解析预算

- [x] 解析 central directory 前校验压缩包格式和条目元数据。（DASH-SEC-005）
- [x] 限制条目数、单条目解压大小、总解压大小和压缩比。（DASH-SEC-005）
- [x] 只读取预览需要的 XML/关系文件，跳过大媒体和无关条目。（DASH-SEC-005）
- [x] 把 Office 解析移到可终止 worker/子任务，并设置超时。（DASH-SEC-005）
- [x] 超限、超时和损坏文件返回安全预览错误，不阻塞 HTTP 事件循环。（DASH-SEC-005、DASH-UX-002）
- [x] 使用小体积生成 fixture 覆盖 ZIP bomb、超条目、高压缩比、损坏文件和正常 Office。（DASH-SEC-005、DASH-REL-001）

### 5.5 递归脱敏

- [x] 将审批输入脱敏改为对象/数组递归处理，并设置深度和节点预算。（DASH-SEC-006）
- [x] 遮罩嵌套 secret/token/password/authorization/credential 字段。（DASH-SEC-006）
- [x] 遮罩命令、MCP arguments 和 URL 中常见 token-like 值。（DASH-SEC-006）
- [x] 清理 API 错误，禁止堆栈、密钥、完整敏感输入和不必要绝对路径。（DASH-SEC-006）
- [x] 断言事件 JSON、DOM、日志和测试输出中均不存在测试 secret。（DASH-SEC-006、DASH-REL-001）

阶段 2 退出检查：

- [x] 超限输入不会造成 OOM、部分任务或临时数据残留。
- [x] 文件读取不能越出工作区，主动内容不能获得 Dashboard origin。
- [x] 模型输出不能在无操作时触发浏览器网络请求。
- [x] Office 恶意样本不会阻塞主进程。

## 6. 阶段 3：任务和会话一致性

主要模块：`src/dashboard/sessions.js`、`src/dashboard/events.js`、`src/dashboard/public/app.js`、`src/storage/session-store.js`、后台任务 registry/store。

### 6.1 提交幂等

- [x] 客户端增加 `turnSubmitting`，点击、Enter 和触屏路径共用 guard。（DASH-CON-001）
- [x] 每次新提交生成 request ID，超时重试复用原 ID。（DASH-CON-001）
- [x] 服务端按 request ID 去重，并返回首次创建的 session/turn/queue 结果。（DASH-CON-001）
- [x] 提交期间设置 disabled、`aria-busy` 和稳定状态；失败保留 prompt/附件。（DASH-CON-001、DASH-UX-005）
- [x] 增加延迟响应下双 Enter、双击、超时重试和多标签重复请求测试。（DASH-CON-001、DASH-REL-001）

### 6.2 队列与事件顺序

- [x] 入队前检查容量，队满返回 `429 QUEUE_FULL`。（DASH-CON-002）
- [x] 普通 prompt、guide 和 wakeup 共享同一容量契约。（DASH-CON-002）
- [x] guide 转换使用原子更新，不静默挤掉尾部。（DASH-CON-002）
- [x] wakeup 仅在成功入队或开始后写 consumed 标记。（DASH-CON-002）
- [x] API 只对真正留在队列中的项目返回 queued success。（DASH-CON-002）
- [x] 修复事件 coalesce 后 sequence 倒序；重放结果必须严格单调。（DASH-CON-002、DASH-CON-007）
- [x] 覆盖第 20/21 条、guide 满队列、wakeup 满队列、取消和 SSE replay 测试。（DASH-CON-002、DASH-REL-001）

### 6.3 权限隔离

- [x] `openSession` 使用后端 `session.permission` 更新权限控件。（DASH-CON-003）
- [x] `newTask` 明确重置为 `plan`。（DASH-CON-003）
- [x] 前端权限状态按 session ID 保存或始终以服务端响应为准。（DASH-CON-003）
- [x] 后端在执行前验证目标 session 权限，不接受跨 session 隐式提升。（DASH-CON-003）
- [x] `fullAccess` 增加风险确认和持续可见状态。（DASH-CON-003、DASH-UX-005、DASH-UX-006）
- [x] 增加 A=fullAccess、B=plan、切换、新任务、刷新和篡改客户端状态测试。（DASH-CON-003、DASH-REL-001）

### 6.4 中断与隔离

- [x] 引入 `interrupting`/`quarantined` 状态，不把 abort request 当作已停止。（DASH-CON-004）
- [x] 旧 turn settle 前不启动队列下一项。（DASH-CON-004）
- [x] 迟到事件按 turn ID 丢弃，不写新 turn transcript 或状态。（DASH-CON-004、DASH-CON-007）
- [x] 评估 shell、MCP、gateway 和工具取消传播；不可取消路径进入隔离。（DASH-CON-004）
- [x] 后台子进程取消处理进程树。（DASH-CON-004、DASH-CON-005）
- [x] 增加忽略 Abort、迟到结果、强制超时和排队下一项测试。（DASH-CON-004、DASH-REL-001）

### 6.5 后台任务所有权、删除和 shutdown

- [x] 取消前验证 group/task 的 parentSessionId、groupId、taskId、cwd 和当前状态。（DASH-CON-005）
- [x] 使用条件更新，真实 controller 未取消时不把其他任务标成 interrupted。（DASH-CON-005）
- [x] terminal 未找到或未取消时返回明确失败，不返回空数组 success。（DASH-CON-005）
- [x] 有后台任务的父会话默认禁止删除。（DASH-CON-005）
- [x] 实现“取消全部后台任务并等待后删除”的显式流程。（DASH-CON-005、DASH-UX-005）
- [x] 删除时注销 timer、listener、wakeup callback 和旧 state 引用。（DASH-CON-005、DASH-PERF-002）
- [x] shutdown 展示主 turn、队列和后台任务数量，并要求明确决策。（DASH-CON-005、DASH-UX-001、DASH-UX-005）
- [x] 实现有上限的 graceful shutdown，不直接短延时退出。（DASH-CON-005）
- [x] 增加跨会话取消、后台删除、删除后 wakeup、关闭活动任务和清理超时测试。（DASH-CON-005、DASH-REL-001）

### 6.6 会话互斥和精确 ID

- [x] 为规范化完整 session ID 建 keyed mutex/in-flight reservation。（DASH-CON-006）
- [x] 把 resume、start、clear、compact、delete 和 session config update 纳入互斥。（DASH-CON-006）
- [x] Dashboard 修改 API 拒绝 `latest` 和 prefix selector，只接受完整 ID。（DASH-CON-006）
- [x] 冷会话并发恢复共享同一 active state。（DASH-CON-006）
- [x] 定义锁顺序和释放策略，避免持锁等待不可控外部任务。（DASH-CON-006）
- [x] 增加 resume/resume、compact/start、delete/start、异常释放和不同 session 并行测试。（DASH-CON-006、DASH-REL-001）

### 6.7 状态和 sequence 契约

- [x] 定义 completed、failed、blocked、interrupted、cancelled 等后端终态。（DASH-CON-007）
- [x] 修复 `turn_complete`、失败子任务和 runtime fallback 的成功硬编码。（DASH-CON-007）
- [x] 只在成功且缺少 final 时合成 `assistant_final`。（DASH-CON-007）
- [x] session list、header、transcript、SSE 和 metadata 使用同一映射。（DASH-CON-007、DASH-UX-001）
- [x] 事件 sequence 在内存、replay 和客户端应用顺序中严格递增。（DASH-CON-007）
- [x] 为所有终态和 replay cursor 增加契约测试。（DASH-CON-007、DASH-REL-001）

阶段 3 退出检查：

- [x] 不存在重复创建、成功后丢队列或 wakeup 丢失。
- [x] 权限不跨会话，中断旧任务不会与新任务并发。
- [x] 后台任务取消、删除和 shutdown 与真实执行一致。
- [x] 会话操作串行化，状态和事件顺序可重放。

## 7. 阶段 4：状态与异步交互

主要模块：`src/dashboard/public/app.js`、`src/dashboard/public/index.html`、`src/dashboard/public/styles.css`。

### 7.1 统一 UI 状态机

- [x] 用显式状态替换 MutationObserver 对中文状态文本的解析。（DASH-UX-001）
- [x] 实现 booting、idle、submitting、running、queued、interrupting、waiting-input、reconnecting、failed、completed、shutting-down、closed。（DASH-UX-001）
- [x] 按状态统一派生按钮、文案、颜色、aria 和可执行动作。（DASH-UX-001、DASH-UX-006）
- [x] shutdown 失败时恢复按钮和 SSE，不进入 closed。（DASH-UX-001）
- [x] shutdown 成功后让应用 inert 或禁用剩余操作。（DASH-UX-001、DASH-UX-006）
- [x] 修复上下文口径：active message tokens 为占用，prompt/provider tokens 单列“输入”。（DASH-UX-001）
- [x] 修复并扩充上下文统计测试。（DASH-UX-001、DASH-REL-001）

### 7.2 防乱序请求层

- [x] 为 session、transcript、file、model/config 请求分别维护 AbortController 或 request version。（DASH-UX-002）
- [x] 响应落地前验证 session ID、file path 和 request version。（DASH-UX-002）
- [x] 会话切换时取消旧历史和文件请求。（DASH-UX-002）
- [x] history response 只允许更新发起时的 session，不直接读取可变全局 session。（DASH-UX-002）
- [x] 每个表面实现 skeleton/loading、empty、error 和 retry。（DASH-UX-002）
- [x] bootstrap 总入口捕获失败并提供重试，不停在“加载中”。（DASH-UX-002）
- [x] 增加 A/B 逆序会话、历史、文件和初始化失败测试。（DASH-UX-002、DASH-REL-001）

### 7.3 SSE 状态和恢复

- [x] 增加 connecting、connected、reconnecting、offline 和 stale 连接状态。（DASH-UX-003）
- [x] 记录最后事件时间并在长时间无事件/心跳时显示 stale。（DASH-UX-003）
- [x] 实现有上限指数退避和手动重连。（DASH-UX-003）
- [x] 重连基于已确认 cursor，窗口缺失时先获取权威 snapshot。（DASH-UX-003、DASH-CON-007）
- [x] 切会话、关闭和 session 不存在时释放 EventSource，不无限重连。（DASH-UX-003、DASH-PERF-002）
- [x] 增加断网、恢复、服务重启、过旧 cursor 和重复 final 测试。（DASH-UX-003、DASH-REL-001）

阶段 4 退出检查：

- [x] 所有状态与后端事实一致，失败有恢复动作。
- [x] 旧请求不能污染当前会话。
- [x] SSE 断流、重连和窗口缺失可见且可恢复。

## 8. 阶段 5：响应式、操作体验与无障碍

### 8.1 响应式外壳

- [x] 重构默认三栏宽度，避免 981-1199px 的固定最小宽度裁切。（DASH-UX-004）
- [x] `>=1200px` 保持三栏，允许预览折叠。（DASH-UX-004）
- [x] `768-1199px` 提供会话/文件抽屉，主对话不被裁切。（DASH-UX-004）
- [x] `<768px` 提供会话/对话/文件三视图或等价导航。（DASH-UX-004）
- [x] 手机端保留新任务、会话切换、文件查看和返回对话入口。（DASH-UX-004）
- [x] 使用 `100dvh`、safe-area 和软键盘适配。（DASH-UX-004）
- [x] 320px 起无页面级横向滚动、按钮消失、文本越界和遮挡。（DASH-UX-004）
- [x] 文件预览在手机改为全屏表面并保留加载/错误状态。（DASH-UX-002、DASH-UX-004）
- [x] 桌面文件预览栏支持拖动、方向键和双击复位，宽度限制为 300-640px 并动态保护至少 520px 的中间对话区域，刷新后保持设置。（DASH-UX-004、DASH-UX-006）
- [x] 会话展开态只显示一个低对比实时状态标记，稳定终态不显示胶囊；状态灯仅在左栏收起时作为替代入口显示。（DASH-UX-001、DASH-UX-006）

### 8.2 Composer 和危险操作

- [x] prompt textarea 自动增高到上限，手机端附件和发送保持紧凑。（DASH-UX-005）
- [x] 发送、提交中、中断和中断中具有稳定尺寸和明确差异。（DASH-UX-001、DASH-UX-005）
- [x] 无 session 或运行中禁用清空/压缩，并说明原因。（DASH-UX-005）
- [x] 清空、删除、fullAccess、shutdown 放入合理危险操作区域并显示影响范围。（DASH-UX-005）
- [x] 用户离开 transcript 底部后停止抢滚动，显示“有新回复/回到底部”。（DASH-UX-005、DASH-PERF-003）
- [x] 所有危险操作支持取消，失败后恢复原状态和焦点。（DASH-UX-005、DASH-UX-006）
- [x] 需求确认面板扩大默认审阅区域，并提供“查看对话/返回确认”；回看期间仅 transcript 可交互，选择和补充输入保持不丢失。（DASH-UX-005、DASH-UX-006）

### 8.3 Modal、键盘和读屏

- [x] 模型配置、图片/表格预览、确认面板使用 `<dialog>` 或完整 focus trap。（DASH-UX-006）
- [x] 打开 modal 保存触发点、移动焦点、背景 inert；关闭后恢复焦点。（DASH-UX-006）
- [x] 权限分段控件改为 radiogroup/aria-checked，支持方向键。（DASH-CON-003、DASH-UX-006）
- [x] prompt 和自定义问答增加真实 label/description。（DASH-UX-006）
- [x] activity 展开改用 button/details 并维护 aria-expanded。（DASH-UX-006）
- [x] transcript 改为 `role=log` 或等价增量语义，历史和草稿 `aria-live=off`。（DASH-UX-006）
- [x] 使用独立小型 live region 播报连接、审批、失败和最终完成。（DASH-UX-006）
- [x] 建立全局高对比 `:focus-visible`，恢复 textarea 明确焦点。（DASH-UX-006）
- [x] 增加 `prefers-reduced-motion`，关闭 pulse、平滑滚动和非必要 transition。（DASH-UX-006）
- [x] 触控目标至少 44px，文本与背景达到 WCAG 2.1 AA。（DASH-UX-006）

### 8.4 浏览器和无障碍验收

- [x] 视口：320x568、390x844、768x1024、1024x768、1280x800、1440x900。（DASH-UX-004、DASH-REL-001）
- [x] 每个视口完成新任务、切会话、发送、中断、审批、问答、打开文件和返回。（DASH-UX-004、DASH-REL-001）
- [x] 纯键盘完成上述核心流程。（DASH-UX-006、DASH-REL-001）
- [x] modal 焦点 trap、Escape、焦点恢复和背景 inert 自动化断言通过。（DASH-UX-006、DASH-REL-001）
- [x] axe 无 serious/critical，200% 缩放无功能丢失。（DASH-UX-006、DASH-REL-001）
- [ ] NVDA 或等价读屏人工验证关键状态，不出现流式播报风暴。（DASH-UX-006、DASH-REL-001）

阶段 5 退出检查：

- [x] 所有核心功能在手机、平板、中间宽度和桌面可达。
- [ ] 纯键盘、焦点和读屏流程通过。
- [x] 危险操作不会占据主流程或在无效状态下可执行。

## 9. 阶段 6：性能与持久化

### 9.1 transcript 真分页

- [x] 为 archive chunk 保存消息起止索引或等价 cursor 索引。（DASH-PERF-001）
- [x] `readSession` 首屏只读取末尾必要 chunk。（DASH-PERF-001）
- [x] `readTranscriptPage` 只读取覆盖目标 cursor 的 chunk。（DASH-PERF-001）
- [x] 损坏 chunk 返回明确错误，不静默退回不完整 fallback。（DASH-PERF-001）
- [x] resume 完整上下文与 UI 展示分页分开实现。（DASH-PERF-001）
- [x] 增加 10k 消息首屏、上一页、追加和完整 resume 的 I/O 断言。（DASH-PERF-001、DASH-REL-001）

### 9.2 active state 和 SSE 资源

- [x] 集中配置 active 最大值和 idle TTL。（DASH-PERF-002）
- [x] 只驱逐非运行、无 listener、无后台任务、无 pending interaction 且已持久化的 state。（DASH-PERF-002）
- [x] 驱逐前清理 timer、listener、controller 和大对象引用。（DASH-PERF-002）
- [x] 驱逐后重新打开可透明恢复且默认权限安全。（DASH-PERF-002、DASH-CON-003）
- [x] 限制进程和单 session SSE 连接数。（DASH-PERF-002）
- [x] 处理 `res.write()` 背压、慢消费者和连接错误。（DASH-PERF-002）
- [ ] 增加大量会话、长时间运行、慢 SSE 客户端和 heap 回落测试。（DASH-PERF-002、DASH-REL-001）

### 9.3 流式和 DOM 窗口化

- [x] 流式阶段按 delta/块更新纯文本，不反复解析累计全文。（DASH-PERF-003）
- [x] 每帧最多一次渲染和一次自动滚动。（DASH-PERF-003）
- [x] 最终回答到达后执行一次完整 Markdown/rich render。（DASH-PERF-003）
- [x] transcript 采用窗口化或分段卸载，节点数量有稳定上限。（DASH-PERF-003）
- [ ] Mermaid、KaTeX、Office 和大型表格按可见性懒加载。（DASH-PERF-003）
- [x] 增加 50k 字符流式、500+ 消息、用户离底和最终一致性测试。（DASH-PERF-003、DASH-REL-001）

### 9.4 结构化数据预算

- [x] 真正停止超过最大深度的递归。（DASH-PERF-004）
- [x] 设置每块全局节点、深度、行、列、字符串和复制字节预算。（DASH-PERF-004）
- [x] 超限时显示摘要，显式展开时才生成下一段 DOM。（DASH-PERF-004）
- [x] 删除无限制完整 TSV/data attribute，改用受控内存或按需生成。（DASH-PERF-004）
- [x] 增加深层、宽层、组合爆炸、循环保护和上限 +1 测试。（DASH-PERF-004、DASH-REL-001）

### 9.5 配置和上下文持久化

- [x] 为模型保存、删除和网关切换增加配置 mutex/revision。（DASH-CON-008）
- [x] 使用同目录临时文件、完整写入、必要 fsync 和原子替换。（DASH-CON-008）
- [x] 跨进程并发采用文件锁或明确的 compare-and-swap 策略。（DASH-CON-008）
- [x] 密钥配置文件使用最小必要权限，响应和日志不回显 key。（DASH-CON-008、DASH-SEC-006）
- [x] clear/compact 成功后立即持久化 context、metadata 和 transcript 状态。（DASH-CON-008）
- [ ] 重启后已清空上下文不恢复，已压缩摘要不丢失。（DASH-CON-008）
- [x] 增加并发配置、半写故障、重启 clear/compact 和旧格式兼容测试。（DASH-CON-008、DASH-REL-001）

阶段 6 退出检查：

- [x] 历史页 I/O 与目标页相关，不与完整 archive 线性增长。
- [x] active Map、DOM 和 SSE 连接有稳定上限。
- [x] 长流式内容保持可交互，结构化数据不能指数展开。
- [x] 配置和上下文在并发、崩溃和重启后保持一致。

## 10. 阶段 7：测试、发布和交付

### 10.1 测试基础设施

- [x] 保留现有 Dashboard unit/runtime/server 测试并修复当前失败。（DASH-REL-001）
- [x] 引入浏览器级 fake API/E2E 测试，不用源码正则替代行为。（DASH-REL-001）
- [x] 为慢响应、断网、乱序、超限、崩溃和取消提供确定性 fault injection。（DASH-REL-001）
- [x] 加入 axe 和多 viewport 截图测试。（DASH-REL-001）
- [x] 安全 fixture 不依赖公网，不提交真实 secret 或危险大文件。（DASH-REL-001）

### 10.2 安全回归矩阵

- [x] 恶意 Host、Origin、CSRF、无凭证、错误凭证、错误 Content-Type。（DASH-SEC-001、DASH-REL-001）
- [x] body、prompt、base64、单图、总附件上限和 chunked 请求。（DASH-SEC-004、DASH-REL-001）
- [x] 远程媒体无自动请求。（DASH-SEC-002、DASH-REL-001）
- [x] symlink/junction、session cwd、恶意 SVG、raw response。（DASH-SEC-003、DASH-REL-001）
- [x] ZIP bomb、超条目、超时和损坏 Office。（DASH-SEC-005、DASH-REL-001）
- [x] 嵌套 secret 和命令 token 脱敏。（DASH-SEC-006、DASH-REL-001）

### 10.3 一致性与交互回归矩阵

- [x] 双 Enter、双击、超时重试和重复 request ID。（DASH-CON-001、DASH-REL-001）
- [x] 队列第 20/21 条、guide、wakeup、取消和顺序。（DASH-CON-002、DASH-REL-001）
- [x] fullAccess 切 plan 会话、新任务、刷新和客户端篡改。（DASH-CON-003、DASH-REL-001）
- [x] 忽略 Abort、迟到事件和旧/新 turn 隔离。（DASH-CON-004、DASH-REL-001）
- [x] 后台删除、跨会话取消、shutdown 和 orphan 防护。（DASH-CON-005、DASH-REL-001）
- [x] 并发恢复、压缩、启动、删除和锁释放。（DASH-CON-006、DASH-REL-001）
- [x] 所有终态和严格单调 SSE replay。（DASH-CON-007、DASH-REL-001）
- [x] A/B 会话、历史和文件响应逆序。（DASH-UX-002、DASH-REL-001）
- [x] 初始化失败、SSE 断线、重启和手动重连。（DASH-UX-001、DASH-UX-003、DASH-REL-001）

### 10.4 构建和 CI 门禁

- [x] 增加 `check:types`，运行 `tsc --noEmit`。（DASH-REL-002）
- [x] 增加 `check:dashboard-assets`，内存重建并比较 rich bundle、KaTeX CSS 和字体。（DASH-REL-002）
- [x] Windows exe 构建前强制执行 Dashboard 资产检查。（DASH-REL-002）
- [x] 保证 `package-lock.json` 与 `npm-shrinkwrap.json` 同步。（DASH-REL-002）
- [x] 增加 Dashboard browser/E2E 脚本并纳入 `npm run check`。（DASH-REL-001、DASH-REL-002）
- [x] 发布检查依次覆盖 syntax、forbidden、dependencies、types、unit/integration、browser、assets、diff check。（DASH-REL-002）
- [x] 故意制造陈旧 bundle、类型错误和 lock 差异，确认 CI 阻断。（DASH-REL-002）

### 10.5 文档、可观测性和回滚

- [x] 更新 README 和本地安装文档中的认证启动方式。（DASH-REL-003）
- [x] 更新安全边界文档中的浏览器同源、远程媒体、SVG、附件和 Office 策略。（DASH-REL-003）
- [x] 更新 quickstart 中权限隔离、中断状态、移动端导航和 shutdown 语义。（DASH-REL-003）
- [x] 更新 CHANGELOG，列出安全修复、行为变化和兼容影响。（DASH-REL-003）
- [ ] 增加不含敏感信息的 API 拒绝、队列拒绝、SSE 连接、active 驱逐和解析超限计数。（DASH-REL-003）
- [ ] 为 transcript/config 新字段提供旧格式读取、备份和回滚说明。（DASH-REL-003）
- [ ] 演练完整版本回滚；不得通过关闭认证或文件边界校验降级。（DASH-REL-003）
- [ ] 记录每阶段验证结果、剩余风险、负责人和完成日期。（DASH-REL-003）

### 10.6 TUI 输入栏配套整改

- [x] 用明确事件归属替代 25-120ms 时间窗口去重；raw 层按原始序列确定性区分 Windows `0x7F` Backspace、Kitty Backspace 和 CSI Delete，Ctrl+C/Ctrl+O 保持单一路径。（TUI-IN-001）
- [x] 顺序处理同一 chunk 中的文本与删除，过滤 Kitty release 和不可见控制字符；鼠标、滚轮和 Page 键不再保留时间去重 fallback。（TUI-IN-001）
- [x] Ctrl 快捷键按 Ink 实际 `inputValue` 判定，修复依赖不存在 `key.name` 的失效路径。（TUI-IN-002）
- [x] 支持 `Shift+Enter`、`Alt+Enter`、`Ctrl+J` 换行，普通 Enter 保持提交。（TUI-IN-002）
- [x] 支持 Alt/Ctrl+Backspace、Alt/Ctrl+Delete 单词删除，并处理“普通文本+Return”被合并读取时的提交语义。（TUI-IN-002）
- [x] 使用 grapheme cluster 编辑和显示宽度，覆盖家庭 emoji、组合字符、旗帜和 CJK。（TUI-IN-003）
- [x] 保存稳定可视窗口和纵向首选列；Home/End 作用于当前视觉行。（TUI-IN-004）
- [x] 大段粘贴显示真实可编辑行，不再用与光标脱节的摘要代替输入内容。（TUI-IN-004）
- [x] bracketed paste 支持分片起止标记、相邻文本和普通 Escape，不重复或吞掉输入。（TUI-IN-005）
- [x] 隐藏硬件光标，仅保留软件光标；Ink 增量渲染上限提高到 60 FPS。（TUI-IN-004、TUI-IN-005）
- [x] grapheme 分段和显示宽度缓存均有界；50k ASCII/CJK 常见编辑本机中位数约 5ms，20k 家庭 emoji 极端样本约 20ms。（TUI-IN-005）
- [x] TUI 回归 `167/167` 通过，并纳入完整 `npm run check`。（TUI-IN-001～005）
- [x] 删除旧 TUI 工作树和 `codex/tui-input-hardening` 分支，确认交付分支无旧重构特征文件。（TUI-SCOPE-001）

阶段 7 退出检查：

- [ ] 所有 P0/P1 checkbox 完成。
- [ ] P2 延期项有负责人、风险和日期。
- [ ] 全量 CI 从干净检出通过。
- [ ] 发布资产、安装包、文档和源码一致。
- [ ] 回滚演练不会恢复匿名 API、丢 session 或破坏配置。

## 11. 建议验证命令

当前已有命令：

```powershell
npm run check:syntax
npm run check:forbidden
npm run check:dependencies
node --test tests/unit/dashboard-events.test.js tests/unit/dashboard-files.test.js tests/unit/dashboard-markdown.test.js tests/unit/dashboard-permissions.test.js tests/unit/dashboard-rich-assets.test.js tests/unit/dashboard-runtime.test.js tests/unit/dashboard-server.test.js tests/unit/dashboard-structured-data.test.js tests/unit/dashboard-ui.test.js
npm run build:dashboard-assets
npm test
git diff --check
```

整改过程中需要新增并纳入 `npm run check` 的命令：

```powershell
npm run check:types
npm run check:dashboard-assets
npm run test:dashboard:browser
npm run test:dashboard:security
npm run test:dashboard:performance
```

## 12. 最终追踪表

### 12.1 本轮验证记录

- 自动化结果：本地 unit/integration `841/841`；Edge 浏览器 `8/8`；TUI 回归 `167/167`；聚焦 Dashboard/session/storage/UI/Markdown 等测试 `315/315`。
- 发布门禁：syntax、forbidden endpoint、dependency policy、type ratchet、browser、Dashboard assets 和 `git diff --check` 均通过。
- 类型与资产：27 个文件维持 2693 条历史诊断基线且无新增诊断；62 个 Dashboard 资产与隔离依赖安装逐字节一致。
- 性能证据：550 条消息后 DOM 不超过 300；500 个 SSE delta/50k 字符只保留一个流式纯文本节点；连续加载 5 页后锚点保持 `52px -> 52px`。
- 配置持久化：24 个并发 mutation、8 个并发模型配置、stale revision 和 fault injection 均通过。
- 尚需人工验收：NVDA 或等价读屏、真实手机软键盘、Firefox/Safari 等非 Chromium 浏览器、完整回滚演练、安装包与负责人签字。
- TUI 范围：旧智能体的广泛 TUI 重构未迁入交付分支；仅保留输入编辑器、输入事件接线、提示文本和对应测试。
- 分支清理：旧 TUI 工作树和 `codex/tui-input-hardening`、`codex/tui-ui-refactor` 分支均已删除。
- 工作区隔离：`.antcode-control/`、`项目配置/` 等无关未跟踪内容未修改、未暂存、未提交。

| 需求 ID | 实现 PR/提交 | 测试文件 | 验收人 | 状态 |
| --- | --- | --- | --- | --- |
| DASH-SEC-001 | 当前工作区 | `dashboard-server.test.js`、browser | 待签字 | 自动验收通过 |
| DASH-SEC-002 | 当前工作区 | `dashboard-markdown.test.js`、browser | 待签字 | 自动验收通过 |
| DASH-SEC-003 | 当前工作区 | `dashboard-files.test.js` | 待签字 | 自动验收通过 |
| DASH-SEC-004 | 当前工作区 | `dashboard-server.test.js`、`dashboard-runtime.test.js` | 待签字 | 自动验收通过 |
| DASH-SEC-005 | 当前工作区 | `tools.test.js` | 待签字 | 自动验收通过 |
| DASH-SEC-006 | 当前工作区 | server/permissions/browser | 待签字 | 自动验收通过 |
| DASH-CON-001～008 | 当前工作区 | runtime/events/config-store/session-store | 待签字 | 自动验收通过 |
| DASH-UX-001～005 | 当前工作区 | UI/runtime/browser | 待签字 | 自动验收通过 |
| DASH-UX-006 | 当前工作区 | UI/browser/axe | 待签字 | 自动通过，读屏待人工 |
| DASH-PERF-001 | 当前工作区 | session-store/runtime | 待签字 | 自动验收通过 |
| DASH-PERF-002 | 当前工作区 | runtime/server | 待签字 | 核心通过，heap 人工观察待办 |
| DASH-PERF-003 | 当前工作区 | UI/browser 压力验证 | 待签字 | 核心通过，懒加载待办 |
| DASH-PERF-004 | 当前工作区 | structured-data | 待签字 | 自动验收通过 |
| DASH-REL-001 | 当前工作区 | 841 unit/integration + 8 browser | 待签字 | 自动验收通过 |
| DASH-REL-002 | 当前工作区 | release-gates/assets/types | 待签字 | 自动验收通过 |
| DASH-REL-003 | 当前工作区 | README/部署/安全/CHANGELOG | 待签字 | 文档完成，回滚与签字待办 |
| TUI-IN-001～005 | 当前工作区 | tui-input-editor/tui-format/tui-frame + full check | 待签字 | 167 TUI 自动验收通过 |
| TUI-SCOPE-001 | 当前工作区 | 变更路径污染审计 | 待签字 | 旧重构与 control 文件均未混入 |

## 13. 最终发布签字

- [ ] 安全负责人确认 P0 攻击链均被自动化测试阻断。
- [ ] 运行时负责人确认没有重复执行、静默丢队列、权限串用或旧任务并发。
- [ ] 前端负责人确认状态、响应式、键盘、读屏和长会话验收通过。
- [ ] 发布负责人确认锁文件、类型、资产、安装包、文档和回滚演练通过。
- [ ] 产品负责人确认所有延期 P2 风险可接受。
