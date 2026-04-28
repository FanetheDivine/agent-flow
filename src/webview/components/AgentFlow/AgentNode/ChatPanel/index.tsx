import { useMemo, useRef, useState, type FC } from 'react'
import { Button, Tag, Tooltip } from 'antd'
import { CloseOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome } from '@ant-design/x'
import { match } from 'ts-pattern'
import type { AskUserQuestionItem, AskUserQuestionOutput } from '@/common'
import {
  useFlowStore,
  selectAgentPhase,
  selectFlowPhase,
  selectPendingQuestionFor,
  agentCanSendMessage,
  agentCanInterrupt,
  flowCanInterrupt,
  type AgentPhase,
  type AgentSession,
} from '@/webview/store/flow'
import { ChatInput } from './ChatInput'
import type { AnsweredInfo, BubbleCtx } from './MessageBubble'
import { MessageList } from './MessageList'

type Props = {
  flowId: string
  agentId: string
  agentName: string
  /** 普通用户消息（非 AskUserQuestion 回答）——由上层决定是启动/续跑还是追加消息 */
  onSend: (text: string) => void
  onClose?: () => void
}

/** 从 answeredQuestions 构建 toolUseId -> AnsweredInfo 映射 */
function buildAnsweredMap(
  answeredQuestions: Record<string, AskUserQuestionOutput>,
  answeredFreeText: Record<string, boolean>,
): Map<string, AnsweredInfo> {
  const answeredMap = new Map<string, AnsweredInfo>()
  for (const [toolUseId, output] of Object.entries(answeredQuestions)) {
    const values: Record<string, string[]> = {}
    for (const [q, a] of Object.entries(output.answers ?? {})) {
      values[q] = (a ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    answeredMap.set(toolUseId, { values, byFreeText: !!answeredFreeText[toolUseId] })
  }
  return answeredMap
}

/** 自由文本 → AskUserQuestionOutput：把整段文本映射到每个 question 的答案上 */
function freeTextToOutput(questions: AskUserQuestionItem[], text: string): AskUserQuestionOutput {
  const answers: Record<string, string> = {}
  for (const q of questions) answers[q.question] = text
  return { questions, answers }
}

export const ChatPanel: FC<Props> = ({ flowId, agentId, agentName, onSend, onClose }) => {
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const answerQuestion = useFlowStore((s) => s.answerQuestion)

  const phase = useFlowStore(selectAgentPhase(flowId, agentId))
  const flowPhase = useFlowStore(selectFlowPhase(flowId))
  const pending = useFlowStore(selectPendingQuestionFor(flowId, agentId))
  const allSessions = useFlowStore((s) => s.flowStates[flowId]?.sessions)
  const sessions = useMemo<AgentSession[]>(
    () => allSessions?.filter((s) => s.agentId === agentId) ?? [],
    [allSessions, agentId],
  )
  const answeredQuestions = useFlowStore((s) => s.flowStates[flowId]?.answeredQuestions)

  const canSend = agentCanSendMessage(phase)
  const canInterrupt = agentCanInterrupt(phase)
  const canInterruptFlow = flowCanInterrupt(flowPhase)

  // 自由文本作答标记（本地 UI 状态，仅用于历史态显示 tag）
  const [freeTextMap, setFreeTextMap] = useState<Record<string, boolean>>({})
  const answeredMap = buildAnsweredMap(answeredQuestions ?? {}, freeTextMap)

  const [cardDismissed, setCardDismissed] = useState(false)
  const prevToolUseIdRef = useRef<string | undefined>(undefined)
  if (pending?.toolUseId !== prevToolUseIdRef.current) {
    prevToolUseIdRef.current = pending?.toolUseId
    if (cardDismissed) setCardDismissed(false)
  }

  const showCard = !!pending && !cardDismissed
  const inputDisabled = !canSend && !canInterrupt

  const ctx: BubbleCtx = {
    pendingToolUseId: showCard ? pending?.toolUseId : undefined,
    answeredMap,
    onActiveSubmit: (toolUseId, output) => answerQuestion(flowId, toolUseId, output),
    onActiveDismiss: () => setCardDismissed(true),
  }

  const { text: statusText, color: statusColor } = match<
    AgentPhase,
    { text: string; color: 'processing' | 'warning' | 'default' | 'success' | 'error' }
  >(phase)
    .with('starting', () => ({ text: '启动中', color: 'default' }))
    .with('running', () => ({ text: '生成中', color: 'processing' }))
    .with('awaiting-message', () => ({ text: '等待输入', color: 'warning' }))
    .with('awaiting-question', () => ({ text: '等待回答', color: 'warning' }))
    .with('completed', () => ({ text: '已完成', color: 'success' }))
    .with('error', () => ({ text: '出错', color: 'error' }))
    .with('idle', () => ({ text: '就绪', color: 'default' }))
    .exhaustive()

  const placeholder =
    phase === 'idle' ? '输入消息以运行...' : pending ? '输入文本自由回答...' : '输入消息...'

  const handleSend = (text: string) => {
    if (pending) {
      const output = freeTextToOutput(pending.input.questions, text)
      setFreeTextMap((prev) => ({ ...prev, [pending.toolUseId]: true }))
      answerQuestion(flowId, pending.toolUseId, output)
      return
    }
    onSend(text)
  }

  return (
    <div
      className='flex h-[40vh] w-[30vw] flex-col overflow-hidden rounded-lg bg-[#1e1e2e]'
      onWheel={(e) => e.stopPropagation()}
      onKeyDownCapture={(e) => e.stopPropagation()}
      onPasteCapture={(e) => {
        e.stopPropagation()
      }}
      onMouseDownCapture={(e) => {
        e.stopPropagation()
      }}
    >
      {/* Header */}
      <div className='flex items-center justify-between border-b border-[#45475a] px-3 py-2'>
        <div className='flex items-center gap-2'>
          <span className='text-xs font-semibold text-[#cdd6f4]'>{agentName}</span>
          <Tag color={statusColor} className='m-0 text-[10px]'>
            {statusText}
          </Tag>
        </div>
        {canInterruptFlow && (
          <Tooltip title='中断工作流'>
            <Button
              size='small'
              danger
              type='text'
              icon={<StopOutlined />}
              onClick={() => interruptAgent(flowId)}
            />
          </Tooltip>
        )}
        <Button
          size='small'
          type='text'
          icon={<CloseOutlined />}
          onClick={onClose}
          style={{ color: '#6c7086' }}
        />
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

      {/* Input (always shown; send button becomes cancel button during chatting) */}
      <ChatInput
        onSend={handleSend}
        placeholder={placeholder}
        disabled={inputDisabled}
        loading={canInterrupt}
        onCancel={() => interruptAgent(flowId)}
      />
    </div>
  )
}
