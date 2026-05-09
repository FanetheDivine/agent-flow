import { produce } from 'immer'
import { match } from 'ts-pattern'
import type { ExtensionFlowSignalMessage, ExtensionToWebviewMessage } from './event'
import type { AskUserQuestionInput, AskUserQuestionOutput, Agent, Flow } from './index'

// ── Phase ────────────────────────────────────────────────────────────────────

/**
 * Flow 级 phase —— 只描述整个 flow 的生命周期。
 */
export type FlowPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'awaiting'
  | 'completed'
  | 'stopped'
  | 'error'

/**
 * Agent 级 phase —— 每个 ChatPanel 只关心自己的状态。
 */
export type AgentPhase =
  | 'idle'
  | 'starting'
  | 'running'
  | 'awaiting-message'
  | 'awaiting-question'
  | 'completed'
  | 'stopped'
  | 'error'

// ── State 数据结构 ───────────────────────────────────────────────────────────

export type AgentSession = {
  sessionId: string
  agentId: string
  /** 当前session的message */
  messages: ExtensionToWebviewMessage[]
  completed: boolean
  outputName?: string
}

export type PendingQuestion = {
  toolUseId: string
  input: AskUserQuestionInput
  /** 所属 session，用于切换 agent 时自然失效 */
  sessionId: string
}

export type PendingToolPermission = {
  toolUseId: string
  toolName: string
  input: unknown
  /** 所属 session，用于切换 agent 时自然失效 */
  sessionId: string
}

/**
 * 单个 Flow 的运行态状态 —— extension 与 webview 同步的核心数据。
 * 只包含与一次 run 生命周期相关的信息。
 */
export type FlowRunState = {
  /** webview 生成，用于防止多次 run的竞态问题 仅在flowStart使用 */
  runKey: string
  /** extension 生成的唯一ID 在校验runKey后生成 */
  runId?: string
  phase: FlowPhase
  /** 每个flow拥有的session */
  sessions: AgentSession[]
  /** 已回答的 AskUserQuestion：toolUseId -> 用户提交的答案，用于 UI 回显历史态 */
  answeredQuestions: Record<string, AskUserQuestionOutput>
  /** 当前未回答的 AskUserQuestion，显式存储（不从消息反推） */
  pendingQuestion?: PendingQuestion
  /** 已回答的工具权限请求：toolUseId -> allow，用于 UI 回显历史态 */
  answeredToolPermissions: Record<string, { allow: boolean }>
  /** 当前未回答的工具权限请求 */
  pendingToolPermission?: PendingToolPermission
}

// ── Notification 描述 ────────────────────────────────────────────────────────

export type NotifyReason =
  | 'awaiting-message'
  | 'awaiting-question'
  | 'flow-completed'
  | 'agent-error'

export type NotifyEffect = {
  flowId: string
  flowName: string
  agentId: string
  agentName: string
  reason: NotifyReason
}

// ── updateFlowRunState 参数与返回值 ─────────────────────────────────────────────────

export type UpdateFlowRunStateOptions = {
  /** 最新的 flow 定义列表，用于从 agentId 查找 agentName 等 */
  flows: Flow[]
}

export type UpdateFlowRunStateResult = {
  state: FlowRunState
  /** 调用者需要根据这些 effect 弹出通知或打开ChatPanel */
  notifications: NotifyEffect[]
}

/**
 * 处理来自 extension 的 flow.signal 消息，返回新的 FlowRunState 与待触发的通知列表。
 *
 * 仅处理 `flow.signal.*` 信号。调用方负责：
 * - runId 校验（本函数内部对需要 runId 的信号做校验）
 * - 通知的实际展示（本函数只产出 NotifyEffect，不含 UI 逻辑）
 */
export function updateFlowRunState(
  state: FlowRunState,
  msg: ExtensionFlowSignalMessage,
  options: UpdateFlowRunStateOptions,
): UpdateFlowRunStateResult {
  const notifications: NotifyEffect[] = []
  const { flows } = options

  const findFlow = (flowId: string): Flow | undefined => flows.find((f) => f.id === flowId)
  const findAgent = (flow: Flow | undefined, agentId: string): Agent | undefined =>
    flow?.agents?.find((a) => a.id === agentId)

  const pushNotification = (opts: Omit<NotifyEffect, 'flowName' | 'agentName'>) => {
    const flow = findFlow(opts.flowId)
    const agent = findAgent(flow, opts.agentId)
    notifications.push({
      ...opts,
      flowName: flow?.name ?? '',
      agentName: agent?.agent_name ?? '',
    })
  }

  const next = produce(state, (draft) => {
    // focusFlow 是纯 UI 导航信号，不参与 flow 状态机
    if (msg.type === 'flow.signal.focusFlow') {
      return
    }

    const flowId = msg.data.flowId
    const runId = 'runId' in msg.data ? msg.data.runId : undefined
    const flow = findFlow(flowId)

    if (msg.type === 'flow.signal.flowStart') {
      if (draft.runKey !== msg.data.runKey) return
      draft.runId = runId
      draft.phase = 'awaiting'
      draft.pendingQuestion = undefined
      draft.pendingToolPermission = undefined
      draft.sessions.push({
        sessionId: msg.data.sessionId,
        agentId: msg.data.agentId,
        messages: [],
        completed: false,
      })
      return
    }
    if (draft.runId !== runId) return

    // 追加消息到当前 session
    const session = getCurrentSession(draft)
    session?.messages.push(msg)

    const prevPendingToolUseId = draft.pendingQuestion?.toolUseId

    match(msg)
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        if (message.type === 'result') {
          // 不要在终态（completed / stopped / error）之后退回 awaiting
          if (draft.phase !== 'completed' && draft.phase !== 'stopped' && draft.phase !== 'error') {
            draft.phase = 'awaiting'
            // result 消息 = turn 结束，若此时没有 pendingQuestion 则为 awaiting-message
            const currentAgentId = getLastSession(draft)?.agentId
            if (!draft.pendingQuestion && currentAgentId) {
              pushNotification({
                flowId,
                agentId: currentAgentId,
                reason: 'awaiting-message',
              })
            }
          }
          return
        }
        const sess = getCurrentSession(draft)
        if (sess) {
          const found = extractPendingQuestion(m, draft.answeredQuestions, sess.sessionId)
          if (found) {
            draft.pendingQuestion = found
            draft.phase = 'awaiting'
            // 只在从无 pending 或换到新 toolUseId 时才通知
            if (found.toolUseId !== prevPendingToolUseId) {
              pushNotification({
                flowId,
                agentId: sess.agentId,
                reason: 'awaiting-question',
              })
            }
            return
          }
        }
        // 只在没有未回答的提问/权限请求时才设为 running
        if (!draft.pendingQuestion && !draft.pendingToolPermission) {
          draft.phase = 'running'
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        if (session) {
          session.completed = true
          session.outputName = data.output?.name
        }
        draft.pendingQuestion = undefined
        draft.pendingToolPermission = undefined
        if (data.output) {
          const completedAgentId = getLastSession(draft)?.agentId
          const output = flow?.agents
            ?.find((a) => a.id === completedAgentId)
            ?.outputs?.find((o) => o.output_name === data.output!.name)
          const nextAgentId = output?.next_agent
          if (nextAgentId) {
            draft.phase = 'awaiting'
            draft.sessions.push({
              sessionId: data.output.newSessionId,
              agentId: nextAgentId,
              messages: [],
              completed: false,
            })
          } else {
            draft.phase = 'completed'
            // flow 结束通知：以刚完成的 agent 作为定位点
            const agentId = getLastSession(draft)?.agentId
            if (agentId) {
              pushNotification({ flowId, agentId, reason: 'flow-completed' })
            }
          }
        } else {
          draft.phase = 'completed'
          const agentId = getLastSession(draft)?.agentId
          if (agentId) {
            pushNotification({ flowId, agentId, reason: 'flow-completed' })
          }
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        draft.pendingToolPermission = {
          toolUseId: data.toolUseId,
          toolName: data.toolName,
          input: data.input,
          sessionId: data.sessionId,
        }
        draft.phase = 'awaiting'
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        draft.phase = 'awaiting'
        draft.pendingQuestion = undefined
        draft.pendingToolPermission = undefined
      })
      .with({ type: 'flow.signal.agentError' }, ({ data }) => {
        draft.phase = 'error'
        draft.pendingQuestion = undefined
        draft.pendingToolPermission = undefined
        pushNotification({ flowId, agentId: data.agentId, reason: 'agent-error' })
      })
      .with({ type: 'flow.signal.error' }, () => {
        draft.phase = 'error'
        draft.pendingQuestion = undefined
        draft.pendingToolPermission = undefined
      })
      .exhaustive()
  })

  return { state: next, notifications }
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 最后一个 session（最新推入的） */
export function getLastSession(fs: FlowRunState): AgentSession | undefined {
  return fs.sessions[fs.sessions.length - 1]
}

function getCurrentSession(fs: FlowRunState): AgentSession | undefined {
  return fs.sessions.find((s) => !s.completed)
}

/** 从 assistant 消息中抽取首个未回答的 AskUserQuestion */
function extractPendingQuestion(
  msg: Extract<ExtensionToWebviewMessage, { type: 'flow.signal.aiMessage' }>,
  answered: Record<string, AskUserQuestionOutput>,
  sessionId: string,
): PendingQuestion | undefined {
  const m = msg.data.message
  if (m.type !== 'assistant') return undefined
  const blocks = m.message.content
  if (!Array.isArray(blocks)) return undefined
  for (const block of blocks) {
    if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue
    if (answered[block.id]) continue
    const input = block.input as AskUserQuestionInput | undefined
    if (!input || !Array.isArray(input.questions)) continue
    return { toolUseId: block.id, input, sessionId }
  }
  return undefined
}

// ── UI helper ────────────────────────────────────────────────────────────────

export const agentCanSendMessage = (p: AgentPhase) =>
  p === 'idle' || p === 'awaiting-message' || p === 'awaiting-question' || p === 'stopped'
export const agentCanInterrupt = (p: AgentPhase) => p === 'running' || p === 'starting'
export const agentIsRunning = (p: AgentPhase) => p === 'running' || p === 'starting'
export const flowIsDestructiveReadOnly = (p: FlowPhase) => p === 'running' || p === 'starting'
export const flowCanInterrupt = (p: FlowPhase) =>
  p === 'starting' || p === 'running' || p === 'awaiting'
