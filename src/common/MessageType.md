# SDK 消息类型说明

本项目通过 `@anthropic-ai/claude-agent-sdk` 与 Claude 交互，
以下是两个核心消息类型的自然语言描述。

---

## AIMessageType (`SDKMessage`)

会话中**一切事件**的统一类型，是一个由 `type` 字段区分的判别联合（discriminated union）。
可以用 `SDKMessage[]` 完整描述整个会话流。

### 子类型一览

| `type`                                       | 具体类型                        | 含义                                                                                                                          |
| -------------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `'user'`                                     | `SDKUserMessage`                | 用户发送的消息（文本、图片、工具结果等）                                                                                      |
| `'user'`                                     | `SDKUserMessageReplay`          | 用户消息的重放                                                                                                                |
| `'assistant'`                                | `SDKAssistantMessage`           | AI 的完整回复，包含文本、thinking、tool_use 等内容块                                                                          |
| `'stream_event'`                             | `SDKPartialAssistantMessage`    | 流式传输的增量事件                                                                                                            |
| `'result'` subtype `'success'`               | `SDKResultSuccess`              | 会话成功结束                                                                                                                  |
| `'result'` subtype `'error_*'`               | `SDKResultError`                | 会话异常结束（`error_during_execution` / `error_max_turns` / `error_max_budget_usd` / `error_max_structured_output_retries`） |
| `'system'` subtype `'init'`                  | `SDKSystemMessage`              | 初始化信息：可用工具、模型、权限模式等                                                                                        |
| `'system'` subtype `'status'`                | `SDKStatusMessage`              | 状态变更（`status: 'compacting' \| null`）                                                                                    |
| `'system'` subtype `'task_notification'`     | `SDKTaskNotificationMessage`    | 后台任务完成/失败/停止通知                                                                                                    |
| `'system'` subtype `'api_retry'`             | `SDKAPIRetryMessage`            | API 重试事件                                                                                                                  |
| `'tool_progress'`                            | `SDKToolProgressMessage`        | 工具执行中的进度更新                                                                                                          |
| `'system'` subtype `'hook_started'`          | `SDKHookStartedMessage`         | Hook 开始执行                                                                                                                 |
| `'system'` subtype `'hook_progress'`         | `SDKHookProgressMessage`        | Hook 执行进度                                                                                                                 |
| `'system'` subtype `'hook_response'`         | `SDKHookResponseMessage`        | Hook 执行结果                                                                                                                 |
| `'system'` subtype `'local_command_output'`  | `SDKLocalCommandOutputMessage`  | 本地命令输出                                                                                                                  |
| `'system'` subtype `'compact_boundary'`      | `SDKCompactBoundaryMessage`     | 上下文压缩边界标记                                                                                                            |
| `'system'` subtype `'task_started'`          | `SDKTaskStartedMessage`         | 后台任务启动                                                                                                                  |
| `'system'` subtype `'task_updated'`          | `SDKTaskUpdatedMessage`         | 后台任务状态更新                                                                                                              |
| `'system'` subtype `'task_progress'`         | `SDKTaskProgressMessage`        | 后台任务进度                                                                                                                  |
| `'system'` subtype `'session_state_changed'` | `SDKSessionStateChangedMessage` | 会话状态变更                                                                                                                  |
| `'system'` subtype `'files_persisted'`       | `SDKFilesPersistedEvent`        | 文件持久化事件                                                                                                                |
| `'tool_use_summary'`                         | `SDKToolUseSummaryMessage`      | 工具使用摘要                                                                                                                  |
| `'rate_limit_event'`                         | `SDKRateLimitEvent`             | 速率限制事件                                                                                                                  |
| `'system'` subtype `'elicitation_complete'`  | `SDKElicitationCompleteMessage` | 引导式输入完成                                                                                                                |
| `'prompt_suggestion'`                        | `SDKPromptSuggestionMessage`    | 提示建议                                                                                                                      |
| `'auth_status'`                              | `SDKAuthStatusMessage`          | 认证状态                                                                                                                      |

### AI 回复的内容块（`SDKAssistantMessage.message.content`）

AI 回复的 `content` 是 `BetaContentBlock[]`，可能的内容块：

- **BetaTextBlock** — 文本回复
- **BetaThinkingBlock** — 思考过程（extended thinking）
- **BetaRedactedThinkingBlock** — 被编辑的思考内容
- **BetaToolUseBlock** — 工具调用请求
- **BetaServerToolUseBlock** — 服务端工具调用（web_search、code_execution 等）
- **BetaMCPToolUseBlock** — MCP 工具调用
- **BetaMCPToolResultBlock** — MCP 工具结果
- **BetaWebSearchToolResultBlock** — 网页搜索结果
- **BetaWebFetchToolResultBlock** — 网页抓取结果
- **BetaCodeExecutionToolResultBlock** — 代码执行结果
- **BetaBashCodeExecutionToolResultBlock** — Bash 代码执行结果
- **BetaTextEditorCodeExecutionToolResultBlock** — 文本编辑器代码执行结果
- **BetaToolSearchToolResultBlock** — 工具搜索结果
- **BetaCompactionBlock** — 上下文压缩块
- **BetaContainerUploadBlock** — 容器上传块

---

## UserMessageType (`SDKUserMessage`)

用户侧发送的消息，可表述**一切用户行为**。

### 结构

```
SDKUserMessage {
  type: 'user'
  message: MessageParam          // 消息主体
  parent_tool_use_id: string | null  // 关联的 tool_use ID（用于返回工具结果）
  isSynthetic?: boolean          // 是否为系统合成的消息（非真人输入）
  tool_use_result?: unknown      // 附加的工具执行结果
  priority?: 'now' | 'next' | 'later'  // 消息优先级
  timestamp?: string             // ISO 时间戳
  uuid?: UUID                    // 唯一标识
  session_id?: string            // 所属会话
}
```

### 消息主体（`MessageParam.content`）

`content` 可以是纯字符串，也可以是 `ContentBlockParam[]`，支持的内容块：

- **TextBlockParam** — 纯文本
- **ImageBlockParam** — 图片（base64 或 URL），支持 jpeg/png/gif/webp
- **DocumentBlockParam** — 文档（PDF base64/URL、纯文本、嵌套内容块）
- **ToolResultBlockParam** — 工具执行结果，`is_error: true` 可表示工具调用失败/被中止
- **ToolUseBlockParam** — 工具调用（用于构造历史上下文）
- **SearchResultBlockParam** — 搜索结果
- **ThinkingBlockParam / RedactedThinkingBlockParam** — 思考块（用于构造历史上下文）
- **ServerToolUseBlock / WebSearch/WebFetch/CodeExecution 等结果块** — 服务端工具相关

### 典型用户行为映射

| 用户行为     | 实现方式                                      |
| ------------ | --------------------------------------------- |
| 发送文本     | `content: "文本"` 或 `TextBlockParam`         |
| 发送图片     | `ImageBlockParam`（base64 或 URL）            |
| 发送文档     | `DocumentBlockParam`                          |
| 返回工具结果 | `ToolResultBlockParam` + `parent_tool_use_id` |
| 中止工具调用 | `ToolResultBlockParam` 设 `is_error: true`    |
| 系统注入消息 | 设 `isSynthetic: true`                        |
| 控制执行顺序 | 设 `priority` 字段                            |
