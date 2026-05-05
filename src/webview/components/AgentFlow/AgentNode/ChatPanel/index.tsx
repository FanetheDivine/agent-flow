import { useMemo, useRef, useState, type FC } from 'react'
import { Button, Skeleton, Tag, Tooltip } from 'antd'
import { CloseOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome, XProvider } from '@ant-design/x'
import { match, P } from 'ts-pattern'
import type { AskUserQuestionItem, AskUserQuestionOutput, UserMessageType } from '@/common'
import {
  useFlowStore,
  selectAgentPhase,
  selectFlowPhase,
  selectPendingQuestionFor,
  selectPendingToolPermissionFor,
  selectAnsweredToolPermissions,
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
  /** 普通用户消息（非 AskUserQuestion 回答）——由上层决定是启动/续跑还是追加消息。
   *  返回 true 表示消息被接受（ChatInput 会清空输入框），false 表示未发送（保留输入）。 */
  onSend: (content: UserMessageType['message']['content']) => boolean | Promise<boolean>
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

/** 把 user message content 折叠为纯文本（非 text block 丢弃），用于自由文本作答 */
function contentToPlainText(content: UserMessageType['message']['content']): string {
  if (typeof content === 'string') return content
  return content
    .map((b) => (b.type === 'text' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

export const ChatPanel: FC<Props> = ({ flowId, agentId, agentName, onSend, onClose }) => {
  const interruptAgent = useFlowStore((s) => s.interruptAgent)
  const killFlow = useFlowStore((s) => s.killFlow)
  const answerQuestion = useFlowStore((s) => s.answerQuestion)
  const answerToolPermission = useFlowStore((s) => s.answerToolPermission)

  const phase = useFlowStore(selectAgentPhase(flowId, agentId))
  const flowPhase = useFlowStore(selectFlowPhase(flowId))
  const pending = useFlowStore(selectPendingQuestionFor(flowId, agentId))
  const pendingToolPerm = useFlowStore(selectPendingToolPermissionFor(flowId, agentId))
  const answeredToolPermissions = useFlowStore(selectAnsweredToolPermissions(flowId))
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
  const inputDisabled = false

  const ctx: BubbleCtx = {
    pendingToolUseId: showCard ? pending?.toolUseId : undefined,
    answeredMap,
    onActiveSubmit: (toolUseId, output) => answerQuestion(flowId, toolUseId, output),
    onActiveDismiss: () => setCardDismissed(true),
    pendingToolPermissionToolUseId: pendingToolPerm?.toolUseId,
    answeredToolPermissions,
    onToolPermissionAllow: (toolUseId) => answerToolPermission(flowId, toolUseId, true),
    onToolPermissionDeny: (toolUseId) => answerToolPermission(flowId, toolUseId, false),
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
    .with('stopped', () => ({ text: '已停止', color: 'default' }))
    .with('error', () => ({ text: '出错', color: 'error' }))
    .with('idle', () => ({ text: '就绪', color: 'default' }))
    .exhaustive()

  const placeholder =
    phase === 'idle' ? '输入消息以运行...' : pending ? '输入文本自由回答...' : '输入消息...'

  const handleSend = (
    content: UserMessageType['message']['content'],
  ): boolean | Promise<boolean> => {
    if (pending) {
      const text = contentToPlainText(content)
      const output = freeTextToOutput(pending.input.questions, text)
      setFreeTextMap((prev) => ({ ...prev, [pending.toolUseId]: true }))
      answerQuestion(flowId, pending.toolUseId, output)
      return true
    }
    return onSend(content)
  }

  return (
    <div
      className='flex h-full flex-col overflow-hidden bg-[#1e1e2e]'
      tabIndex={-1}
      onWheel={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          e.stopPropagation()
        }
      }}
      onPaste={(e) => {
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
        {canInterruptFlow && flowPhase !== 'starting' && (
          <Tooltip title='停止工作流'>
            <Button
              size='small'
              danger
              type='text'
              icon={<StopOutlined />}
              onClick={() => killFlow(flowId)}
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
      {match({
        length: sessions.length,
        phase,
        flowPhase,
      })
        .with(
          {
            phase: 'idle',
            flowPhase: P.not('starting'),
          },
          () => (
            <div className='flex flex-1 items-center justify-center px-3'>
              <Welcome
                variant='borderless'
                icon={<RobotOutlined style={{ fontSize: 28, color: '#a6adc8' }} />}
                title={agentName}
                description='暂无消息，发送一条消息以运行当前 Agent。'
              />
            </div>
          ),
        )
        .with({ length: 0 }, () => <Skeleton active className='flex-1 p-4' />)
        .otherwise(() => (
          <MessageList
            sessions={sessions}
            ctx={ctx}
            loading={phase === 'running' || phase === 'starting'}
          />
        ))}

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
