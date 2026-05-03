import { notification } from 'antd'
import { produce } from 'immer'
import { match } from 'ts-pattern'
import { create } from 'zustand'
import type {
  Agent,
  Flow,
  ExtensionToWebviewMessage,
  UserMessageType,
  AskUserQuestionInput,
  AskUserQuestionOutput,
} from '@/common'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

export type AgentSession = {
  sessionId: string
  agentId: string
  /** 当前session的message */
  messages: ExtensionToWebviewMessage[]
  completed: boolean
  outputName?: string
}

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
  runKey: string
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
  runId?: string
  currentSessionId?: string
  currentAgentId?: string
  currentAgentName?: string
}

export type FlowState = {
  loading: boolean
  flows: Flow[]
  activeFlowId?: string
  /** flow的state */
  flowStates: Record<string, FlowRunState>
  globalError?: string
  chatDrawer?: {
    flowId: string
    agentId: string
    agentName: string
  }
  flowListCollapsed: boolean
  /** 当前正在编辑的 agent（全局唯一，用于判断是否有弹窗阻塞切换） */
  editingAgent?: { flowId: string; agentId: string }
}

type FlowStoreType = FlowState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: () => () => void
  setActiveFlowId: (id: string) => void
  setFlowListCollapsed: (collapsed: boolean) => void
  runFlow: (flowId: string, agentId: string, initMessage: UserMessageType) => void
  save: (updateFn: (val: Flow[]) => void) => void
  sendUserMessage: (flowId: string, content: UserMessageType['message']['content']) => void
  answerQuestion: (flowId: string, toolUseId: string, output: AskUserQuestionOutput) => void
  answerToolPermission: (flowId: string, toolUseId: string, allow: boolean) => void
  interruptAgent: (flowId: string) => void
  killFlow: (flowId: string) => void
  openChatDrawer: (flowId: string, agentId: string, agentName: string) => void
  closeChatDrawer: () => void
  setEditingAgent: (agent?: { flowId: string; agentId: string }) => void
  copyAgents: (newAgents: Agent[], flowId: string) => Agent[] | undefined
}

// ── Agent 级派生状态 ──────────────────────────────────────────────────────────

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

export const selectAgentPhase =
  (flowId: string, agentId: string) =>
  (s: FlowState): AgentPhase => {
    const fs = s.flowStates[flowId]
    if (!fs) return 'idle'
    if (fs.currentAgentId === agentId) {
      if (fs.phase === 'awaiting') {
        return fs.pendingQuestion ? 'awaiting-question' : 'awaiting-message'
      }
      // 'idle' 不会出现在 currentAgentId 存在的情况下；但保险起见原样返回
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
    if (!fs || fs.currentAgentId !== agentId) return undefined
    return fs.pendingQuestion
  }

export const selectPendingToolPermissionFor =
  (flowId: string, agentId: string) =>
  (s: FlowState): PendingToolPermission | undefined => {
    const fs = s.flowStates[flowId]
    if (!fs || fs.currentAgentId !== agentId) return undefined
    return fs.pendingToolPermission
  }

const EMPTY_ANSWERED: Record<string, { allow: boolean }> = {}
export const selectAnsweredToolPermissions =
  (flowId: string) =>
  (s: FlowState): Record<string, { allow: boolean }> =>
    s.flowStates[flowId]?.answeredToolPermissions ?? EMPTY_ANSWERED

// ── UI helper ────────────────────────────────────────────────────────────────

export const agentCanSendMessage = (p: AgentPhase) =>
  p === 'idle' || p === 'awaiting-message' || p === 'awaiting-question' || p === 'stopped'
export const agentCanInterrupt = (p: AgentPhase) => p === 'running' || p === 'starting'
export const agentIsRunning = (p: AgentPhase) => p === 'running' || p === 'starting'
export const flowIsDestructiveReadOnly = (p: FlowPhase) => p === 'running' || p === 'starting'
export const flowCanInterrupt = (p: FlowPhase) =>
  p === 'starting' || p === 'running' || p === 'awaiting'

export const selectFlowPhase =
  (flowId: string) =>
  (s: FlowState): FlowPhase =>
    s.flowStates[flowId]?.phase ?? 'idle'

/** 获取当前 session */
function getCurrentSession(fs: FlowRunState): AgentSession | undefined {
  return fs.sessions.find((s) => s.sessionId === fs.currentSessionId)
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

export const useFlowStore = create<FlowStoreType>((set, get) => {
  const immerSet = (updateFn: (draft: FlowStoreType) => void) => {
    set(produce(updateFn))
  }
  return {
    loading: true,
    flows: [],
    activeFlowId: undefined,
    chatDrawer: undefined,
    flowStates: {},
    flowListCollapsed: false,

    init: () => {
      postMessageToExtension({ type: 'load', data: undefined })
      const onMessage = (msg: ExtensionToWebviewMessage) => {
        let notifySwitch: {
          flowId: string
          agentId: string
          agentName: string
          flowName: string
        } | null = null
        immerSet((draft) => {
          if (msg.type === 'error') {
            console.error(msg)
            draft.globalError = (msg.data as { message?: string })?.message ?? String(msg.data)
            return
          }
          if (msg.type === 'load') {
            const { data } = msg
            draft.loading = false
            draft.flows = data.flows
            draft.activeFlowId = data.flows[0]?.id
            return
          }
          if (msg.type === 'insertSelection') {
            // 由 App 层订阅处理，store 不参与
            return
          }
          const runId = msg.data.runId
          const flowId = msg.data.flowId
          const fs = draft.flowStates[flowId]
          if (!fs) return

          if (msg.type === 'flow.signal.flowStart') {
            if (fs.runKey !== msg.data.runKey) return
            fs.runId = runId
            fs.phase = 'awaiting'
            fs.currentSessionId = msg.data.sessionId
            fs.currentAgentId = msg.data.agentId
            fs.pendingQuestion = undefined
            fs.pendingToolPermission = undefined
            // 从 flow 定义中查找 agent name
            const flow = draft.flows.find((f) => f.id === flowId)
            const agent = flow?.agents?.find((a) => a.id === msg.data.agentId)
            fs.currentAgentName = agent?.agent_name
            fs.sessions.push({
              sessionId: msg.data.sessionId,
              agentId: msg.data.agentId,
              messages: [],
              completed: false,
            })
            const agentName = agent?.agent_name ?? ''
            if (draft.activeFlowId === flowId) {
              draft.chatDrawer = { flowId, agentId: msg.data.agentId, agentName }
            } else if (!draft.chatDrawer && !draft.editingAgent) {
              draft.activeFlowId = flowId
              draft.chatDrawer = { flowId, agentId: msg.data.agentId, agentName }
            } else {
              notifySwitch = {
                flowId,
                agentId: msg.data.agentId,
                agentName,
                flowName: flow?.name ?? '',
              }
            }
            return
          }
          if (fs.runId !== runId) return

          // 追加消息到当前 session
          const session = getCurrentSession(fs)
          session?.messages.push(msg)

          match(msg)
            .with({ type: 'flow.signal.aiMessage' }, (m) => {
              const { message } = m.data
              if (message.type === 'result') {
                fs.phase = 'awaiting'
                return
              }
              fs.phase = 'running'
              if (fs.currentSessionId) {
                const found = extractPendingQuestion(m, fs.answeredQuestions, fs.currentSessionId)
                if (found) fs.pendingQuestion = found
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
                fs.currentSessionId = data.output.newSessionId
                // next_agent 存储的是 id，从 flow 定义中查找对应 agent
                const flow = draft.flows.find((f) => f.id === flowId)
                const currentAgent = flow?.agents?.find((a) => a.id === fs.currentAgentId)
                const output = currentAgent?.outputs?.find(
                  (o) => o.output_name === data.output!.name,
                )
                const nextAgentId = output?.next_agent
                if (nextAgentId) {
                  const nextAgent = flow?.agents?.find((a) => a.id === nextAgentId)
                  fs.currentAgentId = nextAgentId
                  fs.currentAgentName = nextAgent?.agent_name
                  fs.phase = 'awaiting'
                  fs.sessions.push({
                    sessionId: data.output.newSessionId,
                    agentId: nextAgentId,
                    messages: [],
                    completed: false,
                  })
                  const nextAgentName = nextAgent?.agent_name ?? ''
                  if (draft.activeFlowId === flowId) {
                    draft.chatDrawer = { flowId, agentId: nextAgentId, agentName: nextAgentName }
                  } else if (!draft.chatDrawer && !draft.editingAgent) {
                    draft.activeFlowId = flowId
                    draft.chatDrawer = { flowId, agentId: nextAgentId, agentName: nextAgentName }
                  } else {
                    notifySwitch = {
                      flowId,
                      agentId: nextAgentId,
                      agentName: nextAgentName,
                      flowName: flow?.name ?? '',
                    }
                  }
                } else {
                  fs.phase = 'completed'
                  fs.currentAgentId = undefined
                  fs.currentAgentName = undefined
                }
              } else {
                fs.phase = 'completed'
                fs.currentAgentId = undefined
                fs.currentAgentName = undefined
              }
            })
            .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
              fs.pendingToolPermission = {
                toolUseId: data.toolUseId,
                toolName: data.toolName,
                input: data.input,
                sessionId: data.sessionId,
              }
            })
            .with({ type: 'flow.signal.agentInterrupted' }, () => {
              fs.phase = 'awaiting'
              fs.pendingQuestion = undefined
              fs.pendingToolPermission = undefined
            })
            .with({ type: 'flow.signal.agentError' }, () => {
              fs.phase = 'error'
              fs.pendingQuestion = undefined
              fs.pendingToolPermission = undefined
            })
            .with({ type: 'flow.signal.error' }, () => {
              fs.phase = 'error'
              fs.pendingQuestion = undefined
              fs.pendingToolPermission = undefined
            })
            .exhaustive()
        })

        if (notifySwitch) {
          const { flowId, agentId, agentName, flowName } = notifySwitch
          const key = `flow-switch-${flowId}`
          notification.info({
            key,
            duration: 0,
            message: `工作流「${flowName}」有新的活跃 Agent`,
            description: `Agent「${agentName}」正在运行，点击切换`,
            onClick: () => {
              notification.destroy(key)
              immerSet((draft) => {
                draft.activeFlowId = flowId
                draft.chatDrawer = { flowId, agentId, agentName }
                draft.editingAgent = undefined
              })
            },
          })
        }
      }

      return subscribeExtensionMessage(onMessage)
    },
    runFlow: (flowId, agentId, initMessage) => {
      const { flows } = get()
      const flow = flows.find((f) => f.id === flowId)
      if (!flow) return
      const runKey = crypto.randomUUID()
      immerSet((draft) => {
        draft.flowStates[flowId] = {
          runKey,
          phase: 'starting',
          sessions: [],
          answeredQuestions: {},
          answeredToolPermissions: {},
        }
      })
      postMessageToExtension({
        type: 'flow.command.flowStart',
        data: { flowId, runKey, agentId, initMessage },
      })
    },
    setActiveFlowId: (id) => {
      notification.destroy(`flow-switch-${id}`)
      immerSet((draft) => {
        draft.activeFlowId = id
        const fs = draft.flowStates[id]
        if (fs?.currentAgentId) {
          const flow = draft.flows.find((f) => f.id === id)
          const agent = flow?.agents?.find((a) => a.id === fs.currentAgentId)
          draft.chatDrawer = {
            flowId: id,
            agentId: fs.currentAgentId,
            agentName: agent?.agent_name ?? fs.currentAgentName ?? '',
          }
        } else {
          draft.chatDrawer = undefined
        }
      })
    },
    setFlowListCollapsed: (collapsed) => {
      immerSet((draft) => {
        draft.flowListCollapsed = collapsed
      })
    },
    openChatDrawer: (flowId, agentId, agentName) => {
      immerSet((draft) => {
        draft.chatDrawer = { flowId, agentId, agentName }
      })
    },
    closeChatDrawer: () => {
      immerSet((draft) => {
        draft.chatDrawer = undefined
      })
    },
    setEditingAgent: (agent) => {
      immerSet((draft) => {
        draft.editingAgent = agent
      })
    },
    save: (updateFn) => {
      immerSet((draft) => {
        updateFn(draft.flows)
      })
      postMessageToExtension({ type: 'save', data: get().flows })
    },
    sendUserMessage: (flowId, content) => {
      const { flowStates } = get()
      const fs = flowStates[flowId]
      if (!fs?.runId || !fs.currentSessionId) return
      postMessageToExtension({
        type: 'flow.command.userMessage',
        data: {
          flowId,
          runId: fs.runId,
          sessionId: fs.currentSessionId,
          message: {
            type: 'user',
            message: { role: 'user', content },
            parent_tool_use_id: null,
          },
        },
      })
    },
    answerQuestion: (flowId, toolUseId, output) => {
      const { flowStates } = get()
      const fs = flowStates[flowId]
      if (!fs?.runId || !fs.currentSessionId) return
      immerSet((draft) => {
        const s = draft.flowStates[flowId]
        if (!s) return
        s.answeredQuestions[toolUseId] = output
        if (s.pendingQuestion?.toolUseId === toolUseId) {
          s.pendingQuestion = undefined
        }
      })
      postMessageToExtension({
        type: 'flow.command.answerQuestion',
        data: {
          flowId,
          runId: fs.runId,
          sessionId: fs.currentSessionId,
          toolUseId,
          output,
        },
      })
    },
    answerToolPermission: (flowId, toolUseId, allow) => {
      const { flowStates } = get()
      const fs = flowStates[flowId]
      if (!fs?.runId || !fs.currentSessionId) return
      immerSet((draft) => {
        const s = draft.flowStates[flowId]
        if (!s) return
        s.answeredToolPermissions[toolUseId] = { allow }
        if (s.pendingToolPermission?.toolUseId === toolUseId) {
          s.pendingToolPermission = undefined
        }
      })
      postMessageToExtension({
        type: 'flow.command.toolPermissionResult',
        data: {
          flowId,
          runId: fs.runId,
          sessionId: fs.currentSessionId,
          toolUseId,
          allow,
        },
      })
    },
    interruptAgent: (flowId) => {
      const { flowStates } = get()
      const fs = flowStates[flowId]
      if (!fs?.runId || !fs.currentSessionId) return
      postMessageToExtension({
        type: 'flow.command.interrupt',
        data: {
          flowId,
          runId: fs.runId,
          sessionId: fs.currentSessionId,
        },
      })
    },
    killFlow: (flowId) => {
      const { flowStates } = get()
      const fs = flowStates[flowId]
      if (!fs?.runId || !fs.currentSessionId) return
      postMessageToExtension({
        type: 'flow.command.interrupt',
        data: {
          flowId,
          runId: fs.runId,
          sessionId: fs.currentSessionId,
        },
      })
      immerSet((draft) => {
        const s = draft.flowStates[flowId]
        if (!s) return
        s.phase = 'stopped'
        s.pendingQuestion = undefined
        s.pendingToolPermission = undefined
        s.runId = undefined
      })
    },
    copyAgents: (newAgents, flowId) => {
      let remapped: Agent[] = []
      get().save((flows) => {
        const flow = flows.find((f) => f.id === flowId)
        if (!flow) return
        const existingNames = new Set((flow.agents ?? []).map((a) => a.agent_name))

        // agent可能有新名字 但是关联关系不变
        const nameMap = new Map<string, string>()
        for (const agent of newAgents) {
          const base = agent.agent_name
          let newName = base
          let i = 2
          while (existingNames.has(newName)) newName = `${base}-${i++}`
          nameMap.set(base, newName)
          existingNames.add(newName)
        }

        // id 重映射：旧 id → 新 id，用于 next_agent 引用更新
        const idMap = new Map<string, string>()
        for (const agent of newAgents) {
          idMap.set(agent.id, crypto.randomUUID())
        }

        // Remap names and next_agent references
        remapped = newAgents.map((agent) => ({
          ...agent,
          id: idMap.get(agent.id)!,
          agent_name: nameMap.get(agent.agent_name)!,
          outputs: agent.outputs?.map((output) => ({
            ...output,
            next_agent: output.next_agent !== undefined ? idMap.get(output.next_agent) : undefined,
          })),
        }))

        flow.agents = [...(flow.agents ?? []), ...remapped]
      })
      return remapped
    },
  }
})
