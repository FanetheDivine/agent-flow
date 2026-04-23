import { useMemo, type FC } from 'react'
import { Button, Tag } from 'antd'
import { Welcome } from '@ant-design/x'
import { PauseCircleOutlined, RobotOutlined } from '@ant-design/icons'
import { match } from 'ts-pattern'
import {
  useFlowStore,
  type AgentSession,
  type FlowRunState,
} from '@/webview/store/flow'
import type { AskUserQuestionInput, AskUserQuestionOutput } from '@/common'
import { ChatInput } from './ChatInput'
import { MessageList } from './MessageList'
import type { AnsweredInfo, BubbleCtx } from './MessageBubble'

type Props = {
  flowId: string
  agentId: string
  agentName: string
  /** 第二参数若存在说明需要把文本作为 tool_result 回传给对应的 tool_use */
  onSend: (text: string, pendingToolUseId?: string) => void
}

type DisplayStatus = FlowRunState['status']

type PendingQuestion = {
  toolUseId: string
  input: AskUserQuestionInput
}

function resolveDisplayStatus(
  flowState: FlowRunState | undefined,
  sessions: AgentSession[],
): DisplayStatus {
  if (!flowState) return 'ready'
  const lastSession = sessions[sessions.length - 1]
  if (!lastSession) return 'ready'
  if (lastSession.sessionId === flowState.currentSessionId) return flowState.status
  if (lastSession.completed) return 'completed'
  return 'ready'
}

/** 扫描当前 session 消息，构建已答 toolUseId 的回显数据 + 定位未答的 AskUserQuestion */
function analyzeQuestions(sessions: AgentSession[]): {
  answeredMap: Map<string, AnsweredInfo>
  pending: PendingQuestion | null
} {
  const answeredMap = new Map<string, AnsweredInfo>()
  // 先走一遍，登记所有 user 消息里的 tool_result / parent_tool_use_id
  for (const session of sessions) {
    for (const msg of session.messages) {
      if (msg.type !== 'flow.signal.aiMessage') continue
      const m = msg.data.message
      if (m.type !== 'user') continue
      const parentId = m.parent_tool_use_id
      if (!parentId) continue
      const result = m.tool_use_result as AskUserQuestionOutput | undefined
      if (result?.answers) {
        const values: Record<string, string[]> = {}
        for (const [q, a] of Object.entries(result.answers)) {
          values[q] = (a ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        }
        answeredMap.set(parentId, { values, byFreeText: false })
      } else {
        // 未附带结构化 answers → 视为自由文本作答
        answeredMap.set(parentId, { values: {}, byFreeText: true })
      }
    }
  }

  // 再在最后一个 session 里找未答的 AskUserQuestion tool_use
  const lastSession = sessions[sessions.length - 1]
  let pending: PendingQuestion | null = null
  if (lastSession) {
    outer: for (let i = lastSession.messages.length - 1; i >= 0; i--) {
      const msg = lastSession.messages[i]!
      if (msg.type !== 'flow.signal.aiMessage') continue
      const m = msg.data.message
      if (m.type !== 'assistant') continue
      const blocks = m.message.content
      if (!Array.isArray(blocks)) continue
      for (const block of blocks) {
        if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') continue
        if (answeredMap.has(block.id)) continue
        const input = block.input as AskUserQuestionInput | undefined
        if (!input || !Array.isArray(input.questions)) continue
        pending = { toolUseId: block.id, input }
        break outer
      }
    }
  }
  return { answeredMap, pending }
}

export const ChatPanel: FC<Props> = ({ flowId, agentId, agentName, onSend }) => {
  const flowState = useFlowStore((s) => s.flowStates[flowId])
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const sendToolResult = useFlowStore((s) => s.sendToolResult)

  const allSessions = flowState?.sessions
  const sessions = useMemo<AgentSession[]>(
    () => allSessions?.filter((s) => s.agentId === agentId) ?? [],
    [allSessions, agentId],
  )
  const displayStatus = resolveDisplayStatus(flowState, sessions)
  const canInput = displayStatus === 'waiting-user'
  const canInterrupt = displayStatus === 'chatting'

  const { answeredMap, pending } = useMemo(() => analyzeQuestions(sessions), [sessions])

  const ctx = useMemo<BubbleCtx>(
    () => ({
      pendingToolUseId: pending?.toolUseId,
      answeredMap,
      onAnswer: (toolUseId, output) => sendToolResult(flowId, toolUseId, output),
    }),
    [pending?.toolUseId, answeredMap, flowId, sendToolResult],
  )

  const { text: statusText, color: statusColor } = match(displayStatus)
    .with('chatting', () => ({ text: '生成中', color: 'processing' as const }))
    .with('waiting-user', () => ({ text: '等待输入', color: 'warning' as const }))
    .with('preparing', () => ({ text: '准备中', color: 'default' as const }))
    .with('completed', () => ({ text: '已完成', color: 'success' as const }))
    .with('error', () => ({ text: '出错', color: 'error' as const }))
    .with('ready', () => ({ text: '就绪', color: 'default' as const }))
    .exhaustive()

  const placeholder = canInput
    ? pending
      ? '点击上方选项，或输入文本自由回答...'
      : '输入消息...'
    : '输入消息以运行...'

  const handleSend = (text: string) => onSend(text, pending?.toolUseId)

  return (
    <div className='flex h-[450px] w-[380px] flex-col overflow-hidden rounded-lg bg-[#1e1e2e]'>
      {/* Header */}
      <div className='flex items-center justify-between border-b border-[#45475a] px-3 py-2'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-semibold text-[#cdd6f4]'>{agentName}</span>
          <Tag color={statusColor} className='m-0 text-[10px]'>
            {statusText}
          </Tag>
        </div>
        {canInterrupt && (
          <Button
            type='text'
            size='small'
            danger
            icon={<PauseCircleOutlined />}
            onClick={() => interruptAgent(flowId)}
          >
            中断
          </Button>
        )}
      </div>

      {/* Messages */}
      {sessions.length === 0 ? (
        <div className='flex flex-1 items-center justify-center px-3'>
          <Welcome
            variant='borderless'
            icon={<RobotOutlined style={{ fontSize: 28, color: '#a6adc8' }} />}
            title={agentName}
            description='暂无消息，发送一条消息以运行当前 Agent。'
          />
        </div>
      ) : (
        <MessageList sessions={sessions} ctx={ctx} />
      )}

      {/* Input */}
      <ChatInput onSend={handleSend} placeholder={placeholder} />
    </div>
  )
}

// silence unused warnings for placeholder-only import shape
