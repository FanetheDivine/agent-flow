import { produce } from 'immer'
import { match } from 'ts-pattern'
import { create } from 'zustand'
import type { Agent, Flow, ExtensionToWebviewMessage } from '@/common'
import { postMessageToExtension, subscribeExtensionMessage } from '../utils/ExtensionMessage'

export type AgentSession = {
  sessionId: string
  agentId: string
  agentName: string
  messages: ExtensionToWebviewMessage[]
  completed: boolean
  outputName?: string
}

export type FlowRunState = {
  runKey: string
  /** ready: 未启动 | preparing: 启动中 | chatting: AI生成中 | waiting-user: 等待用户输入 | completed: 完成 | error: 出错 */
  status: 'ready' | 'preparing' | 'chatting' | 'waiting-user' | 'completed' | 'error'
  sessions: AgentSession[]
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
}

type FlowStoreType = FlowState & {
  /** 初始化：请求 flows 并订阅 extension 消息，返回 cleanup 函数 */
  init: () => () => void
  setActiveFlowId: (id: string) => void
  runFlow: (flowId: string, agentId: string) => void
  saveFlows: (updateFn: (val: Flow[]) => void) => void
  sendUserMessage: (flowId: string, text: string) => void
  interruptAgent: (flowId: string) => void
  copyAgents: (newAgents: Agent[], flowId: string) => Agent[] | undefined
}

/** 获取当前 session */
function getCurrentSession(fs: FlowRunState): AgentSession | undefined {
  return fs.sessions.find((s) => s.sessionId === fs.currentSessionId)
}

export const useFlowStore = create<FlowStoreType>((set, get) => {
  const immerSet = (updateFn: (draft: FlowStoreType) => void) => {
    set(produce(updateFn))
  }
  return {
    loading: true,
    flows: [],
    activeFlowId: undefined,
    flowStates: {},

    init: () => {
      postMessageToExtension({ type: 'requestFlows', data: undefined })
      const onMessage = (msg: ExtensionToWebviewMessage) => {
        immerSet((draft) => {
          if (msg.type === 'error') {
            console.error(msg)
            draft.globalError = (msg.data as { message?: string })?.message ?? String(msg.data)
            return
          }
          if (msg.type === 'loadFlows') {
            const { data } = msg
            draft.loading = false
            draft.flows = data.flows
            draft.activeFlowId = data.flows[0]?.id
            return
          }
          const runId = msg.data.runId
          const flowId = msg.data.flowId
          const fs = draft.flowStates[flowId]
          if (!fs) return

          if (msg.type === 'flow.signal.flowStart') {
            if (fs.runKey !== msg.data.runKey) return
            fs.runId = runId
            fs.status = 'waiting-user'
            fs.currentSessionId = msg.data.sessionId
            fs.currentAgentId = msg.data.agentId
            // 从 flow 定义中查找 agent name
            const flow = draft.flows.find((f) => f.id === flowId)
            const agent = flow?.agents?.find((a) => a.id === msg.data.agentId)
            fs.currentAgentName = agent?.agent_name
            fs.sessions.push({
              sessionId: msg.data.sessionId,
              agentId: msg.data.agentId,
              agentName: agent?.agent_name ?? '',
              messages: [],
              completed: false,
            })
            return
          }
          if (fs.runId !== runId) return

          // 追加消息到当前 session
          const session = getCurrentSession(fs)
          session?.messages.push(msg)

          match(msg)
            .with({ type: 'flow.signal.userMessage' }, () => {})
            .with({ type: 'flow.signal.aiMessage' }, ({ data }) => {
              const { message } = data
              switch (message.type) {
                case 'result': {
                  fs.status = 'waiting-user'
                  break
                }
                default: {
                  fs.status = 'chatting'
                }
              }
            })
            .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
              if (session) {
                session.completed = true
                session.outputName = data.output?.name
              }
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
                  fs.sessions.push({
                    sessionId: data.output.newSessionId,
                    agentId: nextAgentId,
                    agentName: nextAgent?.agent_name ?? '',
                    messages: [],
                    completed: false,
                  })
                }
              } else {
                fs.status = 'completed'
                fs.currentAgentId = undefined
                fs.currentAgentName = undefined
              }
            })
            .with({ type: 'flow.signal.agentInterrupted' }, () => {
              fs.status = 'waiting-user'
            })
            .with({ type: 'flow.signal.agentError' }, () => {
              fs.status = 'error'
            })
            .with({ type: 'flow.signal.error' }, () => {
              fs.status = 'error'
            })
            .exhaustive()
        })
      }

      return subscribeExtensionMessage(onMessage)
    },
    runFlow: (flowId, agentId) => {
      const { flows } = get()
      const flow = flows.find((f) => f.id === flowId)
      if (!flow) return
      const entryAgent = flow.agents?.find((a) => a.id === agentId && a.is_entry)
      if (!entryAgent) return
      const runKey = crypto.randomUUID()
      immerSet((draft) => {
        draft.flowStates[flowId] = {
          runKey,
          status: 'preparing',
          sessions: [],
        }
      })
      postMessageToExtension({
        type: 'flow.command.flowStart',
        data: { flowId, runKey, agentId },
      })
    },
    setActiveFlowId: (id) => {
      immerSet((draft) => {
        draft.activeFlowId = id
      })
    },
    saveFlows: (updateFn) => {
      immerSet((draft) => {
        updateFn(draft.flows)
      })
      postMessageToExtension({ type: 'saveFlows', data: get().flows })
    },
    sendUserMessage: (flowId, text) => {
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
            message: { role: 'user', content: text },
            parent_tool_use_id: null,
          },
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
    copyAgents: (newAgents, flowId) => {
      let remapped: Agent[] = []
      get().saveFlows((flows) => {
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
            next_agent:
              output.next_agent !== undefined
                ? (idMap.get(output.next_agent) ?? output.next_agent)
                : undefined,
          })),
        }))

        flow.agents = [...(flow.agents ?? []), ...remapped]
      })
      return remapped
    },
  }
})
