import { produce } from 'immer'
import { match } from 'ts-pattern'
import type { ExtensionFlowSignalMessage, ExtensionToWebviewMessage } from './event'
import type { AskUserQuestionInput, AskUserQuestionOutput, Flow } from './index'

// ── Phase ────────────────────────────────────────────────────────────────────

/**
 * Flow 级 phase —— 只描述整个 flow 的生命周期。
 * - idle: 未启动
 * - starting: flowStart 命令已发送，等待 signal.flowStart
 * - running: AI 在产出 / 工具在执行
 * - awaiting: 当前 agent 停下，等待用户动作（普通消息或回答 AskUserQuestion）
 * - completed: 全部 agent 完成（终态）
 * - stopped: 用户主动停止（终态）
 * - error: 出错（终态）
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
 * - idle: 该 agent 未参与过 / 后续 agent 已接管（也是未启动 flow 的默认）
 * - starting / running / error: 直接映射 flow phase（仅对 currentAgent 有效）
 * - awaiting-message: 等用户消息
 * - awaiting-question: 有未回答的 AskUserQuestion
 * - completed: 该 agent 的 session 已结束
 * - stopped: 用户主动停止整个 flow
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

export type ChatDrawerState = {
  flowId: string
  agentId: string
  agentName: string
}

export type FlowState = {
  loading: boolean
  flows: Flow[]
  activeFlowId?: string
  /** flow的state */
  flowStates: Record<string, FlowRunState>
  globalError?: string
  chatDrawer?: ChatDrawerState
  flowListCollapsed: boolean
  /** 当前正在编辑的 agent（全局唯一，用于判断是否有弹窗阻塞切换） */
  editingAgent?: { flowId: string; agentId: string }
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

// ── 选择器 ───────────────────────────────────────────────────────────────────

export const selectAgentPhase =
  (flowId: string, agentId: string) =>
  (s: FlowState): AgentPhase => {
    const fs = s.flowStates[flowId]
    if (!fs) return 'idle'
    const currentAgentId = getLastSession(fs)?.agentId
    if (currentAgentId === agentId) {
      if (fs.phase === 'awaiting') {
        return fs.pendingQuestion ? 'awaiting-question' : 'awaiting-message'
      }
      if (fs.phase === 'idle') return 'idle'
      return fs.phase
    }
    // 非当前 agent：看这个 agent 的最后一个 session 是否完成
    const last = [...fs.sessions].reverse().find((sess) => sess.agentId === agentId)
    if (last?.completed) return 'completed'
    return 'idle'
  }

export const selectPendingQuestionFor =
  (flowId: string, agentId: string) =>
  (s: FlowState): PendingQuestion | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs || getLastSession(fs)?.agentId !== agentId) return undefined
    return fs.pendingQuestion
  }

export const selectPendingToolPermissionFor =
  (flowId: string, agentId: string) =>
  (s: FlowState): PendingToolPermission | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs || getLastSession(fs)?.agentId !== agentId) return undefined
    return fs.pendingToolPermission
  }

const EMPTY_ANSWERED: Record<string, { allow: boolean }> = {}
export const selectAnsweredToolPermissions =
  (flowId: string) =>
  (s: FlowState): Record<string, { allow: boolean }> =>
    s.flowStates[flowId]?.answeredToolPermissions ?? EMPTY_ANSWERED

export const selectFlowPhase =
  (flowId: string) =>
  (s: FlowState): FlowPhase =>
    s.flowStates[flowId]?.phase ?? 'idle'

/** 派生：当前活跃的 session（第一个未完成的） */
export const selectCurrentSession =
  (flowId: string) =>
  (s: FlowState): AgentSession | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs) return undefined
    return getCurrentSession(fs)
  }

/** 派生：当前 agent id（取最后一个 session） */
export const selectCurrentAgentId =
  (flowId: string) =>
  (s: FlowState): string | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs) return undefined
    return getLastSession(fs)?.agentId
  }

/** 派生：当前 agent name（通过 agentId 从 flow 定义查找） */
export const selectCurrentAgentName =
  (flowId: string) =>
  (s: FlowState): string | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs) return undefined
    const agentId = getLastSession(fs)?.agentId
    if (!agentId) return undefined
    const flow = s.flows.find((f) => f.id === flowId)
    return flow?.agents?.find((a) => a.id === agentId)?.agent_name
  }

// ── UI helper ────────────────────────────────────────────────────────────────

export const agentCanSendMessage = (p: AgentPhase) =>
  p === 'idle' || p === 'awaiting-message' || p === 'awaiting-question' || p === 'stopped'
export const agentCanInterrupt = (p: AgentPhase) => p === 'running' || p === 'starting'
export const agentIsRunning = (p: AgentPhase) => p === 'running' || p === 'starting'
export const flowIsDestructiveReadOnly = (p: FlowPhase) => p === 'running' || p === 'starting'
export const flowCanInterrupt = (p: FlowPhase) =>
  p === 'starting' || p === 'running' || p === 'awaiting'

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 派生：最后一个 session（最新推入的） */
function getLastSession(fs: FlowRunState): AgentSession | undefined {
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

// ── updateState ──────────────────────────────────────────────────────────────

export type UpdateStateOptions = {
  /** webview 面板是否可见，用于决定通知是否自动展开 ChatDrawer 而不弹通知 */
  panelVisible: boolean
}

export type UpdateStateResult = {
  state: FlowState
  /** 调用者需要根据这些 effect 通过 antd notification API 弹出通知 */
  notifications: NotifyEffect[]
}

/**
 * 处理来自 extension 的 flow.signal 消息，返回新的 state 与待触发的通知列表。
 *
 * 仅处理 `flow.signal.*` 信号 —— 全局事件（load / error / insertSelection）
 * 不属于 Flow 状态机，由调用方在 store 层直接处理。
 *
 * 行为与原 webview 内联 reducer 完全一致：
 * - 各 flow.signal.* 信号对 flowStates 的更新
 * - 自动跟随 ChatDrawer 的切换（agentComplete 跳到下一个 agent 时）
 * - dispatchNotification 的三段式决策：可见且当前 flow 且无 drawer → 自动开 drawer；
 *   可见且 drawer 已落在通知 agent → 静默；其余情况 → 推入 notifications 由调用方弹出
 */
export function updateState(
  state: FlowState,
  msg: ExtensionFlowSignalMessage,
  options: UpdateStateOptions,
): UpdateStateResult {
  const notifications: NotifyEffect[] = []

  const dispatchNotification = (draft: FlowState, opts: NotifyEffect) => {
    const { flowId, agentId, agentName } = opts
    const { panelVisible } = options
    const { activeFlowId, chatDrawer } = draft

    const shouldAutoOpen = panelVisible && activeFlowId === flowId && !chatDrawer
    if (shouldAutoOpen) {
      draft.chatDrawer = { flowId, agentId, agentName }
      return
    }

    // 仍在对应 ChatPanel 上不通知
    if (panelVisible && chatDrawer?.flowId === flowId && chatDrawer?.agentId === agentId) return

    notifications.push(opts)
  }

  const next = produce(state, (draft) => {
    // focusFlow 是纯 UI 导航信号，不参与 flow 状态机，无需 runId 校验和 fs 存在性检查
    if (msg.type === 'flow.signal.focusFlow') {
      draft.activeFlowId = msg.data.flowId
      draft.editingAgent = undefined
      return
    }

    const runId = 'runId' in msg.data ? msg.data.runId : undefined
    const flowId = msg.data.flowId
    const fs = draft.flowStates[flowId]
    if (!fs) return
    const flow = draft.flows.find((f) => f.id === flowId)

    if (msg.type === 'flow.signal.flowStart') {
      if (fs.runKey !== msg.data.runKey) return
      fs.runId = runId
      fs.phase = 'awaiting'
      fs.pendingQuestion = undefined
      fs.pendingToolPermission = undefined
      fs.sessions.push({
        sessionId: msg.data.sessionId,
        agentId: msg.data.agentId,
        messages: [],
        completed: false,
      })
      return
    }
    if (fs.runId !== runId) return

    // 追加消息到当前 session
    const session = getCurrentSession(fs)
    session?.messages.push(msg)

    const prevPendingToolUseId = fs.pendingQuestion?.toolUseId

    match(msg)
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        if (message.type === 'result') {
          // 不要在终态（completed / stopped / error）之后退回 awaiting
          if (fs.phase !== 'completed' && fs.phase !== 'stopped' && fs.phase !== 'error') {
            fs.phase = 'awaiting'
            // result 消息 = turn 结束，若此时没有 pendingQuestion 则为 awaiting-message
            const currentAgentId = getLastSession(fs)?.agentId
            if (!fs.pendingQuestion && currentAgentId) {
              const agent = flow?.agents?.find((a) => a.id === currentAgentId)
              dispatchNotification(draft, {
                flowId,
                flowName: flow?.name ?? '',
                agentId: currentAgentId,
                agentName: agent?.agent_name ?? '',
                reason: 'awaiting-message',
              })
            }
          }
          return
        }
        const session = getCurrentSession(fs)
        if (session) {
          const found = extractPendingQuestion(m, fs.answeredQuestions, session.sessionId)
          if (found) {
            fs.pendingQuestion = found
            fs.phase = 'awaiting'
            // 只在从无 pending 或换到新 toolUseId 时才通知
            if (found.toolUseId !== prevPendingToolUseId) {
              const agent = flow?.agents?.find((a) => a.id === session.agentId)
              dispatchNotification(draft, {
                flowId,
                flowName: flow?.name ?? '',
                agentId: session.agentId,
                agentName: agent?.agent_name ?? '',
                reason: 'awaiting-question',
              })
            }
            return
          }
        }
        // 只在没有未回答的提问/权限请求时才设为 running
        if (!fs.pendingQuestion && !fs.pendingToolPermission) {
          fs.phase = 'running'
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        if (session) {
          session.completed = true
          session.outputName = data.output?.name
        }
        fs.pendingQuestion = undefined
        fs.pendingToolPermission = undefined
        if (data.output) {
          // next_agent 存储的是 id，从 flow 定义中查找对应 agent
          const completedAgentId = getLastSession(fs)?.agentId
          const output = flow?.agents
            ?.find((a) => a.id === completedAgentId)
            ?.outputs?.find((o) => o.output_name === data.output!.name)
          const nextAgentId = output?.next_agent
          if (nextAgentId) {
            const nextAgent = flow?.agents?.find((a) => a.id === nextAgentId)
            fs.phase = 'awaiting'
            // 自动跟随：当前 ChatDrawer 显示的是刚完成的 agent，或用户停留在当前 flow 且未打开任何 ChatDrawer，
            // 切到/打开下一个 agent 的 ChatPanel；其余情况（看着别的 agent、不在当前 flow）保持不变，靠通知引导
            const drawerForCompleted =
              draft.chatDrawer?.flowId === flowId && draft.chatDrawer.agentId === completedAgentId
            const inThisFlowWithoutDrawer = !draft.chatDrawer && draft.activeFlowId === flowId
            if (drawerForCompleted || inThisFlowWithoutDrawer) {
              draft.chatDrawer = {
                flowId,
                agentId: nextAgentId,
                agentName: nextAgent?.agent_name ?? '',
              }
            }
            fs.sessions.push({
              sessionId: data.output.newSessionId,
              agentId: nextAgentId,
              messages: [],
              completed: false,
            })
          } else {
            fs.phase = 'completed'
            // flow 结束通知：以刚完成的 agent 作为定位点
            const agentId = getLastSession(fs)?.agentId
            if (agentId) {
              const agent = flow?.agents?.find((a) => a.id === agentId)
              dispatchNotification(draft, {
                flowId,
                flowName: flow?.name ?? '',
                agentId,
                agentName: agent?.agent_name ?? '',
                reason: 'flow-completed',
              })
            }
          }
        } else {
          fs.phase = 'completed'
          const agentId = getLastSession(fs)?.agentId
          if (agentId) {
            const agent = flow?.agents?.find((a) => a.id === agentId)
            dispatchNotification(draft, {
              flowId,
              flowName: flow?.name ?? '',
              agentId,
              agentName: agent?.agent_name ?? '',
              reason: 'flow-completed',
            })
          }
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        fs.pendingToolPermission = {
          toolUseId: data.toolUseId,
          toolName: data.toolName,
          input: data.input,
          sessionId: data.sessionId,
        }
        fs.phase = 'awaiting'
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        fs.phase = 'awaiting'
        fs.pendingQuestion = undefined
        fs.pendingToolPermission = undefined
      })
      .with({ type: 'flow.signal.agentError' }, ({ data }) => {
        fs.phase = 'error'
        fs.pendingQuestion = undefined
        fs.pendingToolPermission = undefined
        const agent = flow?.agents?.find((a) => a.id === data.agentId)
        dispatchNotification(draft, {
          flowId,
          flowName: flow?.name ?? '',
          agentId: data.agentId,
          agentName: agent?.agent_name ?? '',
          reason: 'agent-error',
        })
      })
      .with({ type: 'flow.signal.error' }, () => {
        fs.phase = 'error'
        fs.pendingQuestion = undefined
        fs.pendingToolPermission = undefined
      })
      .exhaustive()
  })

  return { state: next, notifications }
}
