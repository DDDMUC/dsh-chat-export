# Changelog

Notable changes only. Versions follow semantic versioning; this is a DSH
plugin, so a new capability is a minor bump and a fix is a patch.

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
- DeepSeek 导入不插首轮空 system 消息。续聊是否受影响**没有专门验证过**。

## 0.2.3 — 2026-11-09

- 读取 `run_code` 里提出的问题，每行都有标题，表格按 DSH 样式渲染。

## 0.2.2

- 导出对话框可以从任意边和角拖动调整大小。

## 0.2.1

- ZIP 导入写回图片；提问卡片；对话框宽度可调。

## 0.2.0

- 可回灌的会话日志导出，以及真正的导入（`sessions.create` + `sessionPersistence`
  + `workspace.attachSession`）。
