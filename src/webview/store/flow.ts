import type { NotificationInstance } from 'antd/es/notification/interface'
import { produce } from 'immer'
import { match, P } from 'ts-pattern'
import { create } from 'zustand'
import {
  type Agent,
  type AskUserQuestionOutput,
  type ExtensionToWebviewMessage,
  type Flow,
  type FlowState,
  type NotifyEffect,
  type UserMessageType,
  updateState,
} from '@/common'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

// 选择器、phase helper、state 类型已迁移至 @/common/flowState；此处 re-export，保持现有引用兼容
export type {
  AgentPhase,
  AgentSession,
  ChatDrawerState,
  FlowPhase,
  FlowRunState,
  FlowState,
  PendingQuestion,
  PendingToolPermission,
} from '@/common'
export {
  agentCanInterrupt,
  agentCanSendMessage,
  agentIsRunning,
  flowCanInterrupt,
  flowIsDestructiveReadOnly,
  selectAgentPhase,
  selectAnsweredToolPermissions,
  selectFlowPhase,
  selectPendingQuestionFor,
  selectPendingToolPermissionFor,
} from '@/common'

/** init 参数 —— 从 App.useApp() 拿到的主题化 api（至少包含 notification） */
export type AppApi = { notification: NotificationInstance }

type FlowStoreType = FlowState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: (app: AppApi) => () => void
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

export const useFlowStore = create<FlowStoreType>((set, get) => {
  const immerSet = (updateFn: (draft: FlowStoreType) => void) => {
    set(produce(updateFn))
  }

  /** 由 init 注入，来自 <AntdApp> 的 App.useApp()，保证 notification 继承 ConfigProvider 主题 */
  let notificationApi: NotificationInstance | null = null

  /** 追踪当前所有已弹出的通知 key，便于按 flow 批量销毁 */
  const activeNotificationKeys = new Set<string>()
  const destroyFlowNotifications = (flowId: string) => {
    const prefix = `flow-notify-${flowId}-`
    for (const key of [...activeNotificationKeys]) {
      if (key.startsWith(prefix)) {
        notificationApi?.destroy(key)
        activeNotificationKeys.delete(key)
      }
    }
  }

  /** 把 updateState 返回的 notifications 翻译成 antd notification.info 调用 */
  const fireNotifications = (effects: NotifyEffect[]) => {
    for (const n of effects) {
      const key = `flow-notify-${n.flowId}-${n.agentId}-${n.reason}`
      activeNotificationKeys.add(key)
      notificationApi?.info({
        key,
        duration: 0,
        message: match(n.reason)
          .with('flow-completed', () => `工作流「${n.flowName}」已完成`)
          .with('agent-error', () => `Agent「${n.agentName}」运行出错`)
          .with(
            P.union('awaiting-message', 'awaiting-question'),
            () => `Agent「${n.agentName}」正在等待回复`,
          )
          .exhaustive(),
        onClose: () => {
          activeNotificationKeys.delete(key)
        },
        onClick: () => {
          notificationApi?.destroy(key)
          activeNotificationKeys.delete(key)
          immerSet((d) => {
            d.activeFlowId = n.flowId
            d.chatDrawer = { flowId: n.flowId, agentId: n.agentId, agentName: n.agentName }
            d.editingAgent = undefined
          })
        },
      })
    }
  }

  return {
    loading: true,
    flows: [],
    activeFlowId: undefined,
    chatDrawer: undefined,
    flowStates: {},
    flowListCollapsed: false,

    init: (app) => {
      notificationApi = app.notification
      const onMessage = (msg: ExtensionToWebviewMessage) => {
        // 全局事件（非 flow.signal.*）不进入 updateState：直接落到 store
        if (msg.type === 'load') {
          immerSet((draft) => {
            draft.loading = false
            draft.flows = msg.data.flows
            draft.flowStates = msg.data.flowStates
            draft.activeFlowId = msg.data.flows[0]?.id
          })
          return
        }
        if (msg.type === 'error') {
          console.error(msg)
          immerSet((draft) => {
            draft.globalError = (msg.data as { message?: string })?.message ?? String(msg.data)
          })
          return
        }
        if (msg.type === 'insertSelection') {
          // 由 App 层订阅处理，store 不参与
          return
        }
        // 其余皆为 flow.signal.*：交给 updateState 这一信号驱动的 reducer
        let pendingNotifications: NotifyEffect[] = []
        set((prev) => {
          const panelVisible =
            typeof document === 'undefined' ? false : document.visibilityState === 'visible'
          const { state, notifications } = updateState(prev, msg, { panelVisible })
          pendingNotifications = notifications
          // updateState 通过 immer 产出新的 state；此处把 store 的 action 方法保留下来
          return state as FlowStoreType
        })
        fireNotifications(pendingNotifications)
      }

      const cleanup = subscribeExtensionMessage(onMessage)
      postMessageToExtension({ type: 'load', data: undefined })
      return cleanup
    },
    runFlow: (flowId, agentId, initMessage) => {
      const { flows } = get()
      const flow = flows.find((f) => f.id === flowId)
      if (!flow) return
      const agent = flow.agents?.find((a) => a.id === agentId)
      if (agent?.no_input) {
        initMessage = {
          type: 'user',
          message: { role: 'user', content: '开始' },
          parent_tool_use_id: null,
        }
      }
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
      destroyFlowNotifications(id)
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
        s.phase = 'running'
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
        s.phase = 'running'
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
