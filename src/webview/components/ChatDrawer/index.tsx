import { useCallback, useMemo, useRef, type FC, type ReactNode } from 'react'
import { App, Drawer, Modal } from 'antd'
import {
  agentChatInputState,
  getRunPhase,
  HOST_AGENT_ID,
  type AgentChatInputState,
  type AgentPhase,
  type UserMessageType,
} from '@/common'
import { useStartFlow } from '@/webview/hooks/useStartFlow'
import { useFlowStore } from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import { ChatPanel } from './ChatPanel'
import type { ChatPanelRef } from './ChatPanel'

type Props = {
  /**
   * 当前 drawerState 中的 flowId / agentId / runId(可选)。
   * 全为 undefined 时 ChatPanel 不渲染,但 ChatInput 仍然挂载(单实例 + forceRender,保留 Slate 草稿)。
   */
  flowId?: string
  /**
   * runId 优先级最高:给定时锁定到该 run 视图(host 模式下从 host run 切到子 run 都走这条)。
   * 不给时按 agentId 反查:
   * - agentId === HOST_AGENT_ID → 找 mode='host' 下的 host run
   * - agentId 是普通 agent → 找 runs 末位且命中 agentId 的 run
   */
  runId?: string
  agentId?: string
  /** Drawer 是否可见。关闭时 forceRender 保留 DOM,ChatInput 仍然挂载,但 ChatPanel 会卸载。 */
  open: boolean
  defaultSize?: number
  title?: ReactNode
  onClose?: () => void
}

export const ChatDrawer: FC<Props> = ({
  flowId,
  runId: propRunId,
  agentId: propAgentId,
  open,
  defaultSize = 700,
  title,
  onClose,
}) => {
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const startFlow = useStartFlow()
  const chatPanelRef = useRef<ChatPanelRef>(null)
  const { message } = App.useApp()

  // 当前 flow 的运行态(可能为 undefined,表示 flow 未启动)
  const runState = useFlowStore((s) => (flowId ? s.flowRunStates[flowId] : undefined))

  // 反查当前视图所属的 AgentRun:
  // - propRunId 给定 → 直接按 runId 查(host 子 run / fork 后的 run)
  // - propAgentId === HOST_AGENT_ID → host run
  // - propAgentId 普通 agent → 末位且命中 agentId 的 run(沿用原行为)
  const viewRun = useMemo(() => {
    if (!runState) return undefined
    if (propRunId) return runState.runs.find((r) => r.runId === propRunId)
    if (propAgentId === HOST_AGENT_ID) return runState.runs.find((r) => r.agentId === HOST_AGENT_ID)
    if (propAgentId) {
      const last = runState.runs.at(-1)
      return last?.agentId === propAgentId ? last : undefined
    }
    return undefined
  }, [runState, propRunId, propAgentId])

  const viewRunId = viewRun?.runId
  const viewAgentId = viewRun?.agentId ?? propAgentId
  const isSubRun = !!viewRun?.parentToolUseId
  const isHostFlow = runState?.mode === 'host' || propAgentId === HOST_AGENT_ID
  // host 模式下 idle、首次入口(尚未创建 host run)
  const isHostIdle = isHostFlow && !viewRun

  const runPhase: AgentPhase = useMemo(() => {
    if (!viewRun || !runState) return 'idle'
    return getRunPhase(viewRun, runState)
  }, [viewRun, runState])

  // 当前面板对应的 agent 是否为 code 节点 —— 用于发送前的富文本拦截
  const isCodeNode = useFlowStore((s): boolean => {
    if (!flowId || !viewAgentId) return false
    const flow = s.flows.find((f) => f.id === flowId)
    return flow?.agents?.find((a) => a.id === viewAgentId)?.node_type === 'code'
  })

  /**
   * ChatInput 状态:
   * - 无 flowId / viewAgentId → disabled
   * - host idle (host run 尚未创建) → ready,首发即 flowStart(mode='host')
   * - 子 run completed → disabled (场景 9)
   * - 子 run stopped / interrupted → ready,允许向 lazy resume 的子 executor 继续发消息
   * - 其余 → agentChatInputState(runPhase) 投影
   */
  const inputState: AgentChatInputState = (() => {
    if (!flowId || !viewAgentId) return 'disabled'
    if (!viewRun) return 'ready'
    if (isSubRun && runPhase === 'completed') return 'disabled'
    if (isSubRun && (runPhase === 'stopped' || runPhase === 'interrupted')) return 'ready'
    return agentChatInputState(runPhase)
  })()

  /**
   * silent_task 是无人值守模式,运行过程由系统自动驱动(每轮 result 自动续「继续」、
   * AskUserQuestion 自动应答),用户手动中断不符合该模式语义,这里点中断按钮只弹提示。
   */
  const isSilentAgent = useFlowStore((s): boolean => {
    if (!flowId || !viewAgentId) return false
    const flow = s.flows.find((f) => f.id === flowId)
    const found = flow?.agents?.find((a) => a.id === viewAgentId)
    if (!found || found.node_type === 'code') return false
    return found.work_mode === 'silent_task'
  })

  const onSend = useCallback(
    async (content: UserMessageType['message']['content']): Promise<boolean> => {
      if (!flowId || !viewAgentId) return false
      if (inputState === 'disabled' || inputState === 'loading') return false

      // code 节点不接收富文本(图片 / 附件 / 其他非 text 块):弹确认提示
      // 用户确认后仅提取 text 块拼接为字符串再发送。
      // 注:本期 CodeExecutor 是 eager 一次性执行,正常路径不会让用户走到 sendUserMessage,
      // 但发送入口仍按节点类型做这层 UI 拦截,避免用户误以为图片可被代码节点处理。
      let effectiveContent = content
      if (isCodeNode && Array.isArray(content)) {
        const hasNonText = content.some((b: any) => b?.type !== 'text')
        if (hasNonText) {
          const ok = await new Promise<boolean>((resolve) => {
            Modal.confirm({
              title: '代码节点无法接收富文本',
              content: '确定提取其中的纯文本继续发送?',
              okText: '继续发送',
              cancelText: '取消',
              onOk: () => resolve(true),
              onCancel: () => resolve(false),
            })
          })
          if (!ok) return false
          const textOnly = content
            .filter((b: any) => b?.type === 'text')
            .map((b: any) => b.text ?? '')
            .filter(Boolean)
            .join('\n')
          effectiveContent = textOnly
        }
      }

      // 同会话追问:viewRun 已存在且处于 result/interrupted。
      // 子 run 在 host run interrupt 后被级联标记为 stopped(forceStopped),
      // 此时也不允许走 startFlow(会清空整个 host flow);改为 sendUserMessage,
      // FlowRunner 端会 lazy resume 该子 executor。
      if (
        viewRunId &&
        (runPhase === 'result' ||
          runPhase === 'interrupted' ||
          (isSubRun && runPhase === 'stopped'))
      ) {
        sendUserMessage(flowId, viewRunId, effectiveContent)
        chatPanelRef.current?.forceScrollToBottom()
        return true
      }

      // 否则启动 flow:host 入口走 host 分支(agentId 强制 HOST_AGENT_ID),否则按 propAgentId
      const mode: 'manual' | 'host' = isHostFlow || isHostIdle ? 'host' : 'manual'
      const targetAgentId = mode === 'host' ? HOST_AGENT_ID : viewAgentId
      const started = await startFlow(
        flowId,
        targetAgentId,
        {
          type: 'user',
          message: { role: 'user', content: effectiveContent },
          parent_tool_use_id: null,
        },
        mode,
      )
      if (started) chatPanelRef.current?.forceScrollToBottom()
      return started
    },
    [
      flowId,
      viewAgentId,
      viewRunId,
      inputState,
      runPhase,
      isSubRun,
      isHostFlow,
      isHostIdle,
      isCodeNode,
      sendUserMessage,
      startFlow,
    ],
  )

  return (
    <Drawer
      open={open}
      title={title}
      placement='right'
      mask={false}
      closable={false}
      defaultSize={defaultSize}
      resizable
      forceRender
      styles={{
        body: { padding: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
      }}
      onClose={onClose}
    >
      <div className='flex flex-1 flex-col overflow-hidden bg-[#1e1e2e]'>
        {flowId && viewAgentId ? (
          // key 强制 ChatPanel 在 (flowId, agentId, runId) 切换时重新挂载,避免跨 Flow / 跨 run
          // 共用 React 内部状态(特别是 AskUserQuestionCard 的 selections / otherStates,以及
          // motion.div 的 ask-card key 在 toolUseId 相同时被复用)。
          // host 模式下 host run / 子 run 切换时 viewRunId 变化触发 ChatPanel 重建,卡片状态隔离。
          <ChatPanel
            key={`${flowId}-${viewAgentId}-${viewRunId ?? ''}`}
            ref={chatPanelRef}
            flowId={flowId}
            agentId={viewAgentId}
            runId={viewRunId}
            onClose={onClose}
          />
        ) : null}
        {/* 保留草稿 此组件必须始终挂载 */}
        <ChatInput
          onSend={onSend}
          status={inputState}
          onCancel={() => {
            if (isSilentAgent) {
              message.info('静默模式无法中断')
              return
            }
            if (flowId && viewRunId) {
              interruptAgent(flowId, viewRunId)
            }
          }}
        />
      </div>
    </Drawer>
  )
}
