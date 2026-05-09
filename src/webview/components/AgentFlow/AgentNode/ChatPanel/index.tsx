import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type UIEventHandler,
} from 'react'
import { Button, Skeleton, Tag, Tooltip } from 'antd'
import { CloseOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome, XProvider } from '@ant-design/x'
import type { BubbleListRef } from '@ant-design/x/es/bubble/interface'
import { AnimatePresence, motion } from 'motion/react'
import { match, P } from 'ts-pattern'
import type { AskUserQuestionItem, AskUserQuestionOutput, UserMessageType } from '@/common'
import type { AgentSession } from '@/webview/store/flow'
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
} from '@/webview/store/flow'
import { AskUserQuestionCard } from './AskUserQuestionCard'
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
  freeTextQuestionIndicesMap: Record<string, number[]>,
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
    const indices = freeTextQuestionIndicesMap[toolUseId] ?? []
    answeredMap.set(toolUseId, { values, freeTextQuestionIndices: new Set(indices) })
  }
  return answeredMap
}

/** 自由文本 → AskUserQuestionOutput：把整段文本映射到每个 question 的答案上。
 * 同时返回被自由文本作答的 question 索引集合（用于历史展示时跳过选项匹配）。 */
function freeTextToOutput(
  questions: AskUserQuestionItem[],
  text: string,
): { output: AskUserQuestionOutput; questionIndices: Set<number> } {
  const answers: Record<string, string> = {}
  for (const q of questions) answers[q.question] = text
  return {
    output: { questions, answers },
    questionIndices: new Set(questions.map((_, i) => i)),
  }
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
  const allSessions = useFlowStore((s) => s.flowRunStates[flowId]?.sessions)
  const sessions = useMemo<AgentSession[]>(
    () => allSessions?.filter((s) => s.agentId === agentId) ?? [],
    [allSessions, agentId],
  )
  const answeredQuestions = useFlowStore((s) => s.flowRunStates[flowId]?.answeredQuestions)

  const canInterrupt = agentCanInterrupt(phase)
  const canInterruptFlow = flowCanInterrupt(flowPhase)

  // 自由文本作答标记（本地 UI 状态，按 toolUseId -> question 索引集合追踪）
  const [freeTextQuestionIndicesMap, setFreeTextQuestionIndicesMap] = useState<
    Record<string, number[]>
  >({})
  // AskUserQuestionCard 容器高度,用户可上下拖动调整
  const [cardHeight, setCardHeight] = useState(240)
  const [dragging, setDragging] = useState(false)
  const answeredMap = useMemo(
    () => buildAnsweredMap(answeredQuestions ?? {}, freeTextQuestionIndicesMap),
    [answeredQuestions, freeTextQuestionIndicesMap],
  )

  const showCard = !!pending
  const inputDisabled = false

  const onActiveSubmit = useCallback(
    (toolUseId: string, output: AskUserQuestionOutput) => answerQuestion(flowId, toolUseId, output),
    [answerQuestion, flowId],
  )
  const onToolPermissionAllow = useCallback(
    (toolUseId: string) => answerToolPermission(flowId, toolUseId, true),
    [answerToolPermission, flowId],
  )
  const onToolPermissionDeny = useCallback(
    (toolUseId: string) => answerToolPermission(flowId, toolUseId, false),
    [answerToolPermission, flowId],
  )

  const pendingToolUseId = showCard ? pending?.toolUseId : undefined
  const pendingToolPermissionToolUseId = pendingToolPerm?.toolUseId
  const ctx = useMemo<BubbleCtx>(
    () => ({
      pendingToolUseId,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseId,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
    }),
    [
      pendingToolUseId,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseId,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
    ],
  )

  // 消息列表自动滚动控制：默认贴底，用户向上滚后停止跟随，滚回底部时恢复
  const messageListRef = useRef<BubbleListRef>(null)
  const shouldScrollRef = useRef(true)

  const handleListScroll = useCallback<UIEventHandler<HTMLDivElement>>((e) => {
    const dom =
      (e.target as HTMLDivElement).scrollTop !== undefined
        ? (e.target as HTMLDivElement)
        : messageListRef.current?.scrollBoxNativeElement
    if (!dom) return
    const atBottom = dom.scrollHeight - dom.scrollTop - dom.clientHeight < 10
    shouldScrollRef.current = atBottom
  }, [])

  // 切换 agent 时
  useEffect(() => {
    shouldScrollRef.current = true
    // const id = requestAnimationFrame(() => conso
  }, [flowId, agentId])

  // 新消息到达时按需滚到底
  useEffect(() => {
    setTimeout(() => {
      const dom = messageListRef.current?.scrollBoxNativeElement
      if (shouldScrollRef.current && dom) {
        dom.scroll({
          top: dom.scrollHeight,
          behavior: 'instant',
        })
      }
    }, 0)
  }, [sessions])

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
    shouldScrollRef.current = true
    if (pending) {
      const text = contentToPlainText(content)
      const { output, questionIndices } = freeTextToOutput(pending.input.questions, text)
      setFreeTextQuestionIndicesMap((prev) => ({
        ...prev,
        [pending.toolUseId]: [...questionIndices],
      }))
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
          className='ml-auto'
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
            ref={messageListRef}
            sessions={sessions}
            ctx={ctx}
            loading={phase === 'running' || phase === 'starting'}
            onScroll={handleListScroll}
          />
        ))}

      {/* Pending AskUserQuestion — 固定在输入框上方,不随消息滚动;顶部 handle 可上下拖动调整高度 */}
      <AnimatePresence>
        {showCard && pending && (
          <motion.div
            key='ask-card'
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: cardHeight, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={
              dragging ? { duration: 0 } : { type: 'spring', damping: 24, stiffness: 240 }
            }
            className='flex shrink-0 flex-col overflow-hidden border-t border-[#45475a]'
          >
            <motion.div
              drag='y'
              dragMomentum={false}
              dragElastic={0}
              dragConstraints={{ top: 0, bottom: 0 }}
              onDragStart={() => setDragging(true)}
              onDrag={(_, info) => {
                setCardHeight((h) => Math.max(80, Math.min(600, h - info.delta.y)))
              }}
              onDragEnd={() => setDragging(false)}
              whileHover={{ backgroundColor: '#585b70' }}
              whileDrag={{ backgroundColor: '#74758a' }}
              className='flex h-2 shrink-0 cursor-row-resize items-center justify-center bg-[#313244]'
            >
              <div className='h-0.5 w-8 rounded-full bg-[#6c7086]' />
            </motion.div>
            <div className='flex-1 overflow-auto px-3 py-2'>
              <AskUserQuestionCard
                input={pending.input}
                mode='active'
                onSubmit={(output) => answerQuestion(flowId, pending.toolUseId, output)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input (always shown; send button becomes cancel button during chatting) */}
      <ChatInput
        onSend={handleSend}
        placeholder={placeholder}
        disabled={inputDisabled}
        loading={canInterrupt || phase === 'awaiting-question'}
        onCancel={() => interruptAgent(flowId)}
      />
    </div>
  )
}
