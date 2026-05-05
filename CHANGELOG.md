# Change Log

## [0.0.4] - 2026-05-05

### 新增

- AI 回复支持流式传输，文本块 / thinking 块实时显示。
- 消息气泡中展示工具调用：显示有意义的摘要（读取的文件、执行的命令等），未完成时显示 loading，完成后折叠查看参数详情与执行结果。
- `AskUserQuestion` 提问内容改用 Markdown 渲染，支持代码、链接、列表等富文本格式。
- 模型选择器新增 `gpt-5.5` 选项，并支持大小写不敏感的搜索过滤。
- 内置示例工作流扩展：
  - 在 `常用 Agent 可直接复制` 中新增 `修改代码（无限循环）` 自环 Agent（按用户要求修改代码、生成 commit message 并提交）。
  - 新增 `AI 对话` 默认工作流。
- 适配 Claude Opus 4.7 与新版 `@anthropic-ai/claude-agent-sdk`。
- 多平台分发：发布流程支持 win32 / darwin / linux × x64 / arm64。
- `openPanel` 打开的 Webview 面板设置了插件图标（`resources/icon.svg`）。

### 优化

- `openPanel` 改为在主编辑区打开 Webview（`ViewColumn.One`，原为 `Beside`）。
- 文件打开改用 `ViewColumn.Beside`，使 Webview 与目标文件并排展示。
- `addSelectionToInput` 在无 ChatPanel 时不再自动打开面板；Webview 已打开但 ChatPanel 未展示时，通过 `insertSelectionFailed` 事件回传并由 extension 显示 VS Code 提示。
- 聊天 Drawer 支持拖拽调整宽度、`Esc` 关闭，并调整了默认宽度。
- 节点自动布局时 x 坐标右移 320px，为侧边面板预留空间。
- 工作流列表移动到左下角，移除画布小控件。
- `starting` 阶段禁止中断工作流 / 停止 Agent；启动期间显示骨架屏。
- `FlowList` 在 `AskUserQuestion` / 工具授权等待时显示"等待用户"而非"AI 生成中"。
- Agent 提示词字段由数组改为字符串。
- 默认工作流内容优化。
- `CodeRefChip` / `FileRefChip` 增加 `whiteSpace: pre-wrap` + `wordBreak: break-all`，避免长文件名撑满消息容器。
- 统一 AntD `ConfigProvider`，确保消息中图标颜色正确。
- `thinking` 块为空时不展示；loading 样式与触发条件调整。
- Release 发布流程使用 `--frozen-lockfile` 安装依赖。
- AI 默认使用中文回复。

### 修复

- 修复用户消息气泡中 `code_snippet` / `file_ref` / `attachment` 的前导 HTML 注释被渲染为纯文本的问题。
- 修复 `ChatInput` 复制出的富文本无法粘贴回输入框的问题。
- 修复中断 Agent 后 `streamingBlocks` 残留导致的消息重复展示。
- 修复 `AgentComplete` 的 `content` 与前置 assistant 文本块重复展示的问题。
- 修复 `ChatPanel` 因 `ctx` / `answeredMap` 引用不稳定导致的无限重渲染（`Maximum update depth exceeded`）。
- 修复流式传输完成后 thinking / text 块与 assistant 消息重复渲染：改用位置过滤（`streamCutoff = max(lastResultIdx, lastAssistantIdx)`）替代不可靠的 UUID 匹配。
- 修复 `XMarkdown` 因 `components` 每次渲染重新赋值导致的过度重渲染。
- 修复部分 Agent 状态错误。
- 移除 `AskUserQuestionCard` 的关闭按钮（用户可直接通过输入框作为 Other 自由文本回复）。

## [0.0.3] - 2026-05-04

### 新增

- 聊天输入框改为富文本，支持通过 `Ctrl+V` 粘贴图片 / 文本 / 任意文件并以内联附件形式附加到消息。
- 图片附件在消息中以缩略图展示，外部长文本以独立面板预览。
- 快捷键 `Ctrl+Shift+L` / `Cmd+Shift+L` 在无文本选中时，注入当前文件的全部内容作为代码片段（不带行号）。
- 代码片段 Tag 支持点击跳转：有行范围时打开文件并选中对应行，无行范围时仅打开文件。
- 新增 `pnpm format` 命令（prettier --write）。
- 新增 `pnpm release` 脚本用于一键发布流程。

### 优化

- 调整传给 AI 的消息 / 附件数据格式，减少冗余、提升模型可读性。
- 代码片段的选择与展示逻辑。
- 聊天输入框 `Ctrl` / `Shift` / `Alt` / 系统键 + `Enter` 均可换行。

### 修复

- 添加代码片段失败时不再弹出错误提示。

## [0.0.2] - 2026-05-04

### 变更

- 完善 README 文档。

## [0.0.1] - 2026-05-04

首次发布。

### 核心特性

- 可视化 Agent 工作流：以有向图的方式编排 Agent，每个节点独立配置模型（opus / sonnet / haiku）与思考强度。
- 上下文隔离 + `shareValues` 跨 Agent 数据共享。
- 通过 `@anthropic-ai/claude-agent-sdk` 执行 Agent，内建 `AskUserQuestion` / `Bash` / `Read` 等 Claude Code 工具。
- 工作流启动 / 中断 / 回答问题 / 工具权限审批全链路。
- 自由复制粘贴：Agent 节点（保留内部连接、ID 重映射）、整条 Flow（JSON 序列化导入 / 导出）。
- 内置示例工作流：`工作流生成器`、示例 Agent（模型理解能力测试、飞书通知等）。
- VSCode 编辑器联动：`Ctrl+Shift+L` / `Cmd+Shift+L` 把选区作为带行号的代码引用发送到活跃输入框。
