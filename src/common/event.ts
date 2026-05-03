import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { AskUserQuestionOutput, Flow, PersistedData } from '.'

/**
 * AI消息类型 — 会话中一切事件的统一类型（判别联合），
 * 包含用户消息、AI回复、流式事件、系统通知、工具进度等全部子类型，
 * 可用 `SDKMessage[]` 完整描述整个会话流。
 *
 * @see sdk-message-types.md
 */
export type AIMessageType = SDKMessage
/**
 * 用户消息类型 — 可表述一切用户行为，
 * 支持文本、图片、文档、工具结果返回、中止工具调用等。
 *
 * @see sdk-message-types.md
 */
export type UserMessageType = SDKUserMessage

/** 为类型的 key 加前缀 */
export type TypeWithPrefix<T extends Record<string, any>, P extends string> = {
  [K in keyof T as `${P}${K & string}`]: T[K]
}

/** 为类型的每个值追加 flowId 字段 */
type WithFlowId<T extends Record<string, any>> = {
  [K in keyof T]: T[K] & { flowId: string }
}

/**
 * 从事件类型得到实际的message类型
 *
 * @example
 * ```ts
 * panel.webview.onDidReceiveMessage((e: EventMessage<ExtensionReceivedEvents>)=>{
 *
 * })
 *
 * const message: EventMessage<ExtensionPostEvents> = //xx
 * panel.webview.postMessage(message)
 * ```
 */
export type EventMessageType<T extends Record<string, any>> = {
  [K in keyof T]: { type: K; data: T[K] }
}[keyof T]

/** extension接受 webview发出的事件 */
export type ExtensionFromWebviewEvents = {
  /** webview 启动时请求所有 flows */
  load: undefined
  /** 全量保存 flows */
  save: Flow[]
} & ExtensionFlowCommandEvents

/** extension发出 webview接受的事件 */
export type ExtensionToWebviewEvents = {
  /** 返回所有 flows */
  load: PersistedData
  /** extension异常 */
  error: string
  /** 向当前 active 的输入框注入文本（由 VSCode 编辑器侧快捷键触发） */
  insertSelection: {
    text: string
    languageId?: string
    filename?: string
    startLine?: number
    endLine?: number
  }
} & ExtensionFlowSignalEvents

/** extension接受 webview发出的消息 */
export type ExtensionFromWebviewMessage = EventMessageType<ExtensionFromWebviewEvents>

/** extension发出 webview接受的消息 */
export type ExtensionToWebviewMessage = EventMessageType<ExtensionToWebviewEvents>

/**
 * Flow 事件
 *
 * 事件参数中的标识符：
 * - runId: extension 端分配的运行 ID，标识一次 Flow 运行实例
 * - runKey: webview 端分配的 key，传入 flow 内部用于校验响应归属
 * - sessionId: 当前 agent session 的标识，消息交互必须在两端 sessionId 对齐的基础上发生
 *
 * 开启 Flow 的流程：
 * 1. webview 生成 runKey，发起 flowStart command
 * 2. extension 中断当前 Flow，将 runKey 传入新 Flow 内部进行校验，分配新 runId，创建 agent session，发出 flowStart signal
 * 3. webview 校验 signal 中的 runKey 与自己发出的一致后，保存 runId 和 sessionId
 *    （用户可随时开始新 Flow，通过 runKey 校验确保 runId 对应当前请求）
 *
 * 消息交互：
 * - 所有消息（AI/用户）均携带 runId + sessionId，确保归属明确
 * - flow 收到 userMessage command 后，通过 userMessage signal 回显，保证两端数据一致
 *
 * Agent 切换：
 * - agent 选择 output 后，agentComplete 携带新 sessionId 供后续交互使用
 */

/** Flow 信号基础 payload（不含 flowId） */
type FlowSignalPayload = {
  /** Flow 启动成功，携带 key 供 webview 校验归属 */
  flowStart: { runId: string; runKey: string; sessionId: string; agentId: string }
  /** AI 输出（流式），必须在 runId + sessionId 对齐下发生。用户消息会也会被视作aiMessage。 */
  aiMessage: { runId: string; sessionId: string; message: AIMessageType }
  /** Agent 执行完成，选择了输出分支；output.newSessionId 为下一轮交互的新 session */
  agentComplete: {
    runId: string
    sessionId: string
    content: string
    output?: { name: string; newSessionId: string }
  }
  /** Agent被中断了 */
  agentInterrupted: { runId: string; sessionId: string }
  /** agent错误 */
  agentError: { runId: string; agentId: string; err: Error }
  /** flow运行错误 */
  error: { runId?: string; msg: string }
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  toolPermissionRequest: {
    runId: string
    sessionId: string
    toolUseId: string
    toolName: string
    input: unknown
  }
}

/** FlowRunner 内部信号（不含 flowId，由 FlowRunnerManager 外部注入） */
export type FlowRunnerSignalEvents = TypeWithPrefix<FlowSignalPayload, 'flow.signal.'>

/** Extension 发出的Flow信号（含 flowId，用于 webview 通信） */
export type ExtensionFlowSignalEvents = TypeWithPrefix<
  WithFlowId<FlowSignalPayload>,
  'flow.signal.'
>

/** Flow 指令基础 payload（不含 flowId） */
type FlowCommandPayload = {
  /** webview 发起启动，key 传入 flow 内部用于校验响应归属 */
  flowStart: { runKey: string; agentId: string; initMessage: UserMessageType }
  /** 向当前 Agent 发送用户消息，必须在 runId + sessionId 对齐下发生 */
  userMessage: { runId: string; sessionId: string; message: UserMessageType }
  /** 中断当前 Agent，使其等待用户输入 */
  interrupt: { runId: string; sessionId: string }
  /** 回答 SDK 内建 AskUserQuestion 工具的问题，resolve 对应的 canUseTool 挂起 */
  answerQuestion: {
    runId: string
    sessionId: string
    toolUseId: string
    output: AskUserQuestionOutput
  }
  /** 回答工具权限请求：允许或拒绝当前挂起的工具调用 */
  toolPermissionResult: {
    runId: string
    sessionId: string
    toolUseId: string
    allow: boolean
  }
}

/** FlowRunner 内部指令（不含 flowId） */
export type FlowRunnerCommandEvents = TypeWithPrefix<FlowCommandPayload, 'flow.command.'>

/** Extension 接收的Flow指令（含 flowId，用于 webview 通信） */
export type ExtensionFlowCommandEvents = TypeWithPrefix<
  WithFlowId<FlowCommandPayload>,
  'flow.command.'
>
