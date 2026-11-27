# Changelog

Notable changes only. Versions follow semantic versioning; this is a DSH
plugin, so a new capability is a minor bump and a fix is a patch.

## 0.3.3 — 2026-11-28

A patch release: importing a session log now works on Windows, and between
machines, for the first time.

### 修复

- **Windows 上导入必然失败。** `isAbsolutePath` 只认 `startsWith('/')`，Windows 的
  `E:\...` 一律被判成相对路径，于是 `planImport` 造出的会话头没有 `cwd`，宿主的
  `workspace.attachSession` 以 "its stored header carries no cwd to validate against"
  拒绝。新增 `isAbsolutePath()`（认 `/`、双反斜杠、`X:/`、`X:\`），三处调用点全部改用它。

- **`surface replace` 被宿主拒绝。** `planImport` 重排事件时只复制
  `type/seq/time/data/surfaceOp`，漏掉事件顶层的 `sourceEventSeqs`，于是 `replace`
  操作点不出它遮盖的 surface 节点。该字段现在随重排一起保留并重映射。

- **`developer/message` 的 `headerSeq` 悬空。** `request/header` 在
  `DROPPED_TYPES` 里，但幸存的 `developer/message` 会通过 `data.headerSeq` 引用它；
  丢弃后该引用指向不存在的 seq。现在先收集被引用的 header 再决定丢弃，并把
  `headerSeq` 一起重编号。

- **跨机器导入无法挂载。** 另一台机器记录的 `cwd` 在本机不存在，宿主
  `realpathNormalize` 报 "does not resolve"。`planImport` 现在检测到这种情况就改用
  本机真实工作目录，并在 warnings 里说明改到了哪里；`--cwd=` 仍然优先。
  `attachToWorkspace` 同时按候选目录逐个尝试，只吞掉"路径不可用"这一类错误。

### 兼容性

- 导出内容、UI 与会话格式都没有变；`--cwd=` 的行为也没有变。
- `resolveSaveDirectory` 改用目标平台的路径分隔符拼接，不再对 Windows 路径拼出
  混合分隔符。
- 两条导入路由（log 与 zip）不再自行判定 recorded cwd，统一交给 `planImport`。

### 验证

Windows 11 + DSH Desktop 0.2.2-rc.5，用一份 1577 事件的真实会话日志实测：

- 同机导入：`attached: true`，落盘 514268 字节
- 跨机（记录路径来自另一台机器）：自动重定位，`attached: true`
- 跨机 + 显式 `--cwd=`：落到指定目录，`attached: true`

## 0.3.2 — 2026-11-27

A patch release fixing "Save to directory" under `workspace-write`.

### 修复

- **保存到目录不再被沙箱误拒**（issue #2）。之前写文件走 `fs.writeText(..., signal)`
  只传了 4 个参数，没有带逐次沙箱策略；宿主于是用**没有会话**的默认策略解析，
  工作区根退回到应用进程目录，导致 Windows 上明明属于当前会话工作区的路径也被
  `FS_SANDBOX_DENIED` 拒绝。现在和内置写工具一样，用
  `sandboxPolicy.resolve({ session })` 拿到会话自己的边界，作为 `fs.writeText`
  的第 5 个参数传入。插件同时声明了 `sessions` 与 `sandboxPolicy` 依赖；拿不到
  活会话时用导出日志里记录的 cwd 作为边界，老宿主没有这个服务时行为不变。
- **拒绝信息能看懂。** 再遇到 `FS_SANDBOX_DENIED`，报错会直接列出本次策略允许
  写入的根目录（会话工作区 + 系统临时目录），并说明可以切换会话沙箱模式重试，
  不再像一条 Windows 权限错误。

### 兼容性

- 没有改变导出内容、导入流程或 UI；只影响把 Markdown / HTML / 纯文本保存到目录
  时的宿主调用方式。写权限仍由会话策略决定，插件没有扩大权限。

## 0.3.1 — 2026-11-21

A patch release: the composer's input fields and workspace picker work as
intended, and imported subagents can become real child sessions again.

### 修复

- **输入框整格都能点。** 手动新建对话和导入对话框里的文本框之前只有左半边
  响应点击——根因是宿主 `primitives.Input` 画的框比它内部的 `<input>` 宽。
  换成原生 `input` 并让宽度铺满，右半边不再是死区；同时不再依赖那个布局会变的
  宿主组件。
- **工作区下拉认得已有工作区。** 插件之前没声明 `workspaceRegistry` 依赖，
  服务没被注入上下文，下拉永远是空的。现在显式声明并读取，列表用宿主的
  `list()`（`id` / `path` / `title`），和侧栏显示的一致。

### 新增

- **导入的子会话可保留父子关系。** 之前 `planImport` 无条件剥掉
  `parentSession` / `origin` / `delegationDepth`，因为旧的父 id 指向的会话在
  本机不存在时宿主会拒绝。现在保留这份"意图"，但只在 `sessions.get()` 确认
  父会话确实在本机时才写进会话头；父会话不存在就剥掉链接并警告，绝不留悬空
  引用。万一宿主连合法的父头也拒绝，会回退成独立会话再建一次、给出警告，
  不让整次导入失败。`agentPreset` 仍丢弃（本机未必组合得出那个预设）。
- **`/probe-subagent` 诊断命令。** 在内存里试建一对父子会话，直接看宿主接不接受
  带 `parentSession` 的头；不落盘、不进侧栏，用来确认上面的能力是否被宿主支持。

### 兼容性

- 没有破坏性改动。0.3.0 的导出 / 导入 / 手动新建行为不变。
- 父会话链接是"尽力而为"：只有父会话真的在本机、且宿主接受时才建立，其余情况
  一律回退成独立会话——因此同一份子会话日志在不同机器上导入结果可能不同。

## 0.3.0 — 2026-11-14

Three new ways to get a conversation in, and one way to get more out.

### 新增

- **手动新建对话。** 对话框第三个 tab：自己写用户 / 模型消息，每条一张卡片，
  用户的靠左、模型的靠右。模型的消息多一个「思维」框，**在正文上方**（思维发生
  在回答之前，和导出里的渲染顺序一致）。可以上移、下移、删除；底部三个按钮
  「＋ 用户」「＋ 模型」「＋ 一轮」，最后一个一次补一条用户 + 一条模型。填标题、
  选工作区，一键建成真实会话。
- **导入 Chatbox 导出。** 官网的 HTML 导出和 JSON 备份都认。HTML 按
  `chatbox-export-message` 切块、按嵌套深度找闭合标签（消息里带列表、引用、
  表格也不会被截断）；JSON 备份里的 `reasoning` 保留成思考块。
- **导入 DeepSeek 官网导出。** `deepseek_data-*.zip`（`export_format_version: 3`）
  直接导。分支按 `current_message_id` 选，缺失时取 id 最大的消息；片段映射
  `REQUEST` / `RESPONSE` / `THINK` / `TOOL_SEARCH` / `TOOL_OPEN` / `READ_LINK` /
  `FILE`；`CONTENT_FILTER` 的提问和回答一起丢弃；状态不是 `FINISHED` 的该轮以
  错误行结束、提问保留。图片从压缩包读出来存进附件库，成为真图片；非图片落成
  只有名字和大小的卡片。`--session=<id>` 指定会话，`--limit=N` 批量导入。
- **手写文本支持思维链。** `思维：` / `思考：` / `thinking:` 挂到下一条助手消息
  上；连续多个会拼接；标签单独一行、正文写在下面也认；代码块里不会被误判。
- **导出带子会话。** 子代理的对话作为「子会话」章节追加在文末，按 `parentSession`
  做 BFS，带回深度（孙会话带 `↳`）。只跟 `origin: 'subagent'`——fork 也带
  `parentSession`，但它是独立对话。默认开，`--no-subagents` 关掉。

### 改动

- 导入对话框接受 `.html` / `.htm`，描述里列出新增的格式。
- 导出内容区多一个「子会话」开关。
- `.import-zip` 路由新增可选 `session` 字段（DeepSeek 导出选会话用）。
- 新增路由 `POST /api/dsh-chat-export.compose`、`GET /api/dsh-chat-export.workspaces`。

### 兼容性

- 没有破坏性改动。旧的 JSONL / Markdown / Chatbox 导入行为和导出产物不变。
- `subagents` 默认开启，所以同一个会话现在导出的文件会比 0.2.3 长（多出子会话
  附录）。不想要就 `--no-subagents`。

### 已知限制

- 子会话是**附录**，不是原位——父会话日志里只有委派调用，没有子会话 id，硬要对齐
  只能靠猜。
- 子会话只进 Markdown / HTML / ZIP；JSONL 仍是单会话。
- DeepSeek 的搜索 / 抓取写成 `web_search` / `web_fetch` 调用，但结果是文本，不是
  原生搜索卡片（缺 `@deepseek-ai/dsh-tool-web` 的结构化 meta）。
- ~~DeepSeek 导入不插首轮空 system 消息。~~ **0.3.1 更正：** 这条记录不准——
  0.3.0 的代码实际已在首轮插入受保护的空 system 头（宿主加载日志要求如此），
  续聊是否会因此多一轮空 system 消息**仍未专门验证**。

## 0.2.3 — 2026-11-09

- 读取 `run_code` 里提出的问题，每行都有标题，表格按 DSH 样式渲染。

## 0.2.2

- 导出对话框可以从任意边和角拖动调整大小。

## 0.2.1

- ZIP 导入写回图片；提问卡片；对话框宽度可调。

## 0.2.0

- 可回灌的会话日志导出，以及真正的导入（`sessions.create` + `sessionPersistence`
  + `workspace.attachSession`）。
