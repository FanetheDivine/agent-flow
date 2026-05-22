import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type FC,
} from 'react'
import { App, Button, Skeleton, Tag, Tooltip } from 'antd'
import { CloseOutlined, RobotOutlined, StopOutlined } from '@ant-design/icons'
import { Welcome } from '@ant-design/x'
import { AnimatePresence, motion } from 'motion/react'
import { match, P } from 'ts-pattern'
import type { AskUserQuestionOutput, PendingQuestion, PendingToolPermission } from '@/common'
import {
  formatTokenCount,
  formatTokenCost,
  getAgentPhase,
  getAnsweredToolPermissions,
  getFlowPhase,
  getPendingQuestionsFor,
  getPendingToolPermissionsFor,
  getRunPhase,
} from '@/common'
import type { AgentRun } from '@/webview/store/flow'
import { useFlowStore, flowCanBeKilled, type AgentPhase } from '@/webview/store/flow'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import type { AnsweredInfo, BubbleCtx } from './MessageBubble'
import { MessageList, type MessageListRef } from './MessageList'

// 模块级常量 —— 用于 useMemo 在「无 pending」时返回稳定空数组,
// 避免每次渲染产生新引用触发上层 effect / virtuoso 重测量
const EMPTY_PENDING_QUESTIONS: PendingQuestion[] = []
const EMPTY_PENDING_TOOL_PERMS: PendingToolPermission[] = []

export type ChatPanelRef = {
  forceScrollToBottom: () => void
}

type Props = {
  flowId: string
  agentId: string
  /**
   * 单 run 视图模式:仅展示该 runId 的消息,phase / pendings 也限定到这一条 run。
   * 不传则按 agentId 视图,展示该 agent 全部 runs 的拼接(原有行为)。
   */
  runId?: string
  /**
   * Token / cost 累计口径。默认 'flow' = 跨 Flow 全部 runs(原有行为);
   * 'view' = 跟随当前视图(runId 视图 = 单 run;agentId 视图 = 该 agent 全部 runs)。
   */
  tokenMode?: 'flow' | 'view'
  onClose?: () => void
  ref?: React.Ref<ChatPanelRef>
}

/** 从 answeredQuestions 构建 toolUseId -> AnsweredInfo 映射 */
function buildAnsweredMap(
  answeredQuestions: Record<string, AskUserQuestionOutput>,
): Map<string, AnsweredInfo> {
  const answeredMap = new Map<string, AnsweredInfo>()
  for (const [toolUseId, output] of Object.entries(answeredQuestions)) {
    const values: Record<string, string[]> = {}
    for (const [q, a] of Object.entries(output.answers ?? {})) {
      values[q] = (a ?? '')
        .split('\x1F')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    answeredMap.set(toolUseId, { values })
  }
  return answeredMap
}

export const ChatPanel: FC<Props> = ({
  flowId,
  agentId,
  runId,
  tokenMode = 'flow',
  onClose,
  ref,
}) => {
  const killFlow = useFlowStore((s) => s.killFlow)
  const answerQuestion = useFlowStore((s) => s.answerQuestion)
  const answerToolPermission = useFlowStore((s) => s.answerToolPermission)
  const forkFlow = useFlowStore((s) => s.forkFlow)
  const { modal } = App.useApp()

  const agentName = useFlowStore(
    (s) =>
      s.flows.find((f) => f.id === flowId)?.agents?.find((a) => a.id === agentId)?.agent_name ?? '',
  )

  // runId 视图:phase 用 getRunPhase 限定到单 run;agentId 视图:跨该 agent 全部 run 聚合
  const phase = useFlowStore((s): AgentPhase => {
    const fs = s.flowRunStates[flowId]
    if (runId) {
      const r = fs?.runs.find((r) => r.runId === runId)
      if (!r || !fs) return 'idle'
      return getRunPhase(r, fs)
    }
    return getAgentPhase(fs, agentId)
  })
  const flowPhase = useFlowStore((s) => getFlowPhase(s.flowRunStates[flowId]))
  // pendingQuestions / pendingToolPerms:
  // selector 必须返回稳定引用,否则 useSyncExternalStore 在 store 未变时仍因引用不同
  // 持续判定快照变化触发重渲染 → "Maximum update depth exceeded"。
  // 直接取 fs(immer 保证 fs 在状态未变时引用稳定),在 useMemo 内做过滤;
  // 过滤前后长度相同则透传原数组,空结果用模块级常量,保证不变时引用稳定。
  const fs = useFlowStore((s) => s.flowRunStates[flowId])
  const pendingQuestions = useMemo(() => {
    if (!fs) return EMPTY_PENDING_QUESTIONS
    if (runId) {
      const list = fs.pendingQuestions
      const filtered = list.filter((q) => q.runId === runId)
      if (filtered.length === list.length) return list
      if (filtered.length === 0) return EMPTY_PENDING_QUESTIONS
      return filtered
    }
    return getPendingQuestionsFor(fs, agentId)
  }, [fs, runId, agentId])
  const pendingToolPerms = useMemo(() => {
    if (!fs) return EMPTY_PENDING_TOOL_PERMS
    if (runId) {
      const list = fs.pendingToolPermissions
      const filtered = list.filter((p) => p.runId === runId)
      if (filtered.length === list.length) return list
      if (filtered.length === 0) return EMPTY_PENDING_TOOL_PERMS
      return filtered
    }
    return getPendingToolPermissionsFor(fs, agentId)
  }, [fs, runId, agentId])
  const answeredToolPermissions = useFlowStore((s) =>
    getAnsweredToolPermissions(s.flowRunStates[flowId]),
  )
  const allRuns = useFlowStore((s) => s.flowRunStates[flowId]?.runs)
  // runs:runId 视图 = 单条 run(找不到则空);agentId 视图 = 该 agent 全部 runs
  const runs = useMemo<AgentRun[]>(() => {
    if (!allRuns) return []
    if (runId) {
      const r = allRuns.find((r) => r.runId === runId)
      return r ? [r] : []
    }
    return allRuns.filter((r) => r.agentId === agentId)
  }, [allRuns, agentId, runId])
  const answeredQuestions = useFlowStore((s) => s.flowRunStates[flowId]?.answeredQuestions)

  // Token / cost 累计:tokenMode = 'flow' 跨 Flow 全部 runs;'view' 用当前视图选出的 runs。
  // modelUsage 与 total_cost_usd 都是 session 累计快照,因此每个 run 都只取「最后一条 result」,
  // 再跨 run 相加。tokens 含 4 字段 (input + output + cacheCreation + cacheRead),
  // 与 turn_end / agent_complete 口径一致。
  const tokenSourceRuns = tokenMode === 'view' ? runs : allRuns
  const { totalTokens, totalCost, modelBreakdown } = useMemo(() => {
    if (!tokenSourceRuns)
      return {
        totalTokens: 0,
        totalCost: 0,
        modelBreakdown: [] as Array<{ model: string; tokens: number; cost: number }>,
      }
    let totalTokens = 0
    let totalCost = 0
    const modelMap = new Map<string, { tokens: number; cost: number }>()
    for (const run of tokenSourceRuns) {
      let lastModelUsage: Record<string, unknown> | undefined
      let lastResultCost: number | undefined
      let runModel: string | undefined
      for (const msg of run.messages) {
        if (msg.type === 'flow.signal.aiMessage' && msg.data.message.type === 'result') {
          const result = msg.data.message as any
          if (result.modelUsage && typeof result.modelUsage === 'object') {
            lastModelUsage = result.modelUsage
          }
          if (typeof result.total_cost_usd === 'number') {
            lastResultCost = result.total_cost_usd
          }
          if (typeof result.model === 'string') {
            runModel = result.model
          }
        }
      }
      let runTokens = 0
      if (lastModelUsage) {
        for (const mu of Object.values(lastModelUsage) as any[]) {
          runTokens +=
            (mu.inputTokens ?? 0) +
            (mu.outputTokens ?? 0) +
            (mu.cacheCreationInputTokens ?? 0) +
            (mu.cacheReadInputTokens ?? 0)
        }
      }
      totalTokens += runTokens
      if (lastResultCost !== undefined) totalCost += lastResultCost
      const m = runModel ?? run.agentId
      const entry = modelMap.get(m) ?? { tokens: 0, cost: 0 }
      entry.tokens += runTokens
      if (lastResultCost !== undefined) entry.cost += lastResultCost
      modelMap.set(m, entry)
    }
    const modelBreakdown = Array.from(modelMap.entries()).map(([m, v]) => ({ model: m, ...v }))
    return { totalTokens, totalCost, modelBreakdown }
  }, [tokenSourceRuns])

  const canKillFlow = flowCanBeKilled(flowPhase)

  // AskUserQuestionCard 容器高度,用户可上下拖动调整
  const [cardHeight, setCardHeight] = useState(240)
  const [dragging, setDragging] = useState(false)
  const answeredMap = useMemo(() => buildAnsweredMap(answeredQuestions ?? {}), [answeredQuestions])

  // 合并所有 pending questions 的 questions 数组到一张卡片
  const mergedInput = useMemo(() => {
    if (pendingQuestions.length === 0)
      return {
        questions: [] as import('@/common').AskUserQuestionItem[],
        toolUseIds: [] as string[],
      }
    const allQuestions: import('@/common').AskUserQuestionItem[] = []
    const toolUseIds: string[] = []
    for (const pq of pendingQuestions) {
      toolUseIds.push(pq.toolUseId)
      for (const q of pq.input.questions ?? []) {
        allQuestions.push(q)
      }
    }
    return { questions: allQuestions, toolUseIds }
  }, [pendingQuestions])

  const showCard = mergedInput.questions.length > 0
  const onToolPermissionAllow = useCallback(
    (toolUseId: string) => {
      const p = pendingToolPerms.find((p) => p.toolUseId === toolUseId)
      if (!p) return
      answerToolPermission(flowId, p.runId, toolUseId, true)
    },
    [answerToolPermission, flowId, pendingToolPerms],
  )
  const onToolPermissionDeny = useCallback(
    (toolUseId: string) => {
      const p = pendingToolPerms.find((p) => p.toolUseId === toolUseId)
      if (!p) return
      answerToolPermission(flowId, p.runId, toolUseId, false)
    },
    [answerToolPermission, flowId, pendingToolPerms],
  )

  /**
   * fork 触发入口：sessionCompleted=true（历史 session）时弹 modal 提示
   * 「shareValues 一致性不保证」并由用户确认后再发 command；当前 session 直接发。
   * target 已携带 runId,extension 端按 runId 单 loop 定位 run,无需再传 agentId。
   */
  const onForkRequest = useCallback(
    (
      target: { kind: 'message'; runId: string; messageUuid: string },
      sessionCompleted: boolean,
    ) => {
      const doFork = () => forkFlow(flowId, target)
      if (!sessionCompleted) {
        doFork()
        return
      }
      modal.confirm({
        title: '从历史会话 fork',
        content: '该会话已完成，shareValues 在 fork 后可能与原值不一致。是否继续？',
        okText: 'fork',
        cancelText: '取消',
        onOk: doFork,
      })
    },
    [forkFlow, flowId, modal],
  )

  // 消息列表自动滚动:Virtuoso 内部 followOutput='auto' 已实现「在底部时跟随、用户上滑后停留」,
  // ChatPanel 只需在主动场景(回答 question 后、外部 forceScrollToBottom)强制贴底。
  // MessageList.scrollToBottom 内部用双 RAF 等 React commit + Virtuoso 测量后再滚,无需在外面 setTimeout。
  const messageListRef = useRef<MessageListRef>(null)

  const scrollToBottom = useCallback(() => {
    messageListRef.current?.scrollToBottom('auto')
  }, [])

  const onActiveSubmit = useCallback(
    (_toolUseId: string, output: AskUserQuestionOutput) => {
      // 把合并后的 answers 按原 pendingQuestions 的顺序拆分回每个 toolUseId
      const answersPerQuestion: Record<string, string[]> = {}
      for (const [qText, qAnswers] of Object.entries(output.answers ?? {})) {
        answersPerQuestion[qText] = qAnswers
          .split('\x1F')
          .map((s) => s.trim())
          .filter(Boolean)
      }

      for (const pq of pendingQuestions) {
        const pqAnswers: Record<string, string> = {}
        for (const q of pq.input.questions ?? []) {
          const ans = answersPerQuestion[q.question] ?? []
          pqAnswers[q.question] = ans.join('\x1F')
        }
        answerQuestion(flowId, pq.runId, pq.toolUseId, {
          questions: pq.input.questions,
          answers: pqAnswers,
        })
      }

      scrollToBottom()
    },
    [answerQuestion, flowId, pendingQuestions, scrollToBottom],
  )

  const pendingToolUseId = showCard ? mergedInput.toolUseIds[0] : undefined
  const pendingToolPermissionToolUseIds = useMemo(
    () =>
      pendingToolPerms.length > 0 ? new Set(pendingToolPerms.map((p) => p.toolUseId)) : undefined,
    [pendingToolPerms],
  )
  const pendingToolUseIds = useMemo(
    () => (mergedInput.toolUseIds.length > 0 ? new Set(mergedInput.toolUseIds) : undefined),
    [mergedInput.toolUseIds],
  )
  const ctx = useMemo<BubbleCtx>(
    () => ({
      pendingToolUseId,
      pendingToolUseIds,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      onFork: onForkRequest,
    }),
    [
      pendingToolUseId,
      pendingToolUseIds,
      answeredMap,
      onActiveSubmit,
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow,
      onToolPermissionDeny,
      onForkRequest,
    ],
  )

  useImperativeHandle(
    ref,
    () => ({
      forceScrollToBottom: () => {
        scrollToBottom()
      },
    }),
    [scrollToBottom],
  )

  const { text: statusText, color: statusColor } = match<
    AgentPhase,
    { text: string; color: 'processing' | 'warning' | 'default' | 'success' | 'error' }
  >(phase)
    .with('starting', () => ({ text: '启动中', color: 'processing' }))
    .with('running', () => ({ text: '生成中', color: 'processing' }))
    .with('result', () => ({ text: '生成完毕', color: 'success' }))
    .with('interrupted', () => ({ text: '已中断', color: 'warning' }))
    .with('awaiting-question', () => ({ text: '需要回答', color: 'warning' }))
    .with('awaiting-tool-permission', () => ({ text: '请求授权', color: 'warning' }))
    .with('completed', () => ({ text: '已完成', color: 'success' }))
    .with('stopped', () => ({ text: '已停止', color: 'default' }))
    .with('error', () => ({ text: '出错', color: 'error' }))
    .with('idle', () => ({ text: '就绪', color: 'default' }))
    .exhaustive()

  return (
    <div
      className='flex h-full flex-col overflow-hidden'
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
          {totalTokens > 0 && (
            <Tag color='default' className='m-0 text-[10px]'>
              {formatTokenCount(totalTokens)} tokens
              {totalCost > 0 ? ` · ${formatTokenCost(totalCost)}` : ''}
            </Tag>
          )}
        </div>
        {canKillFlow && (
          <Tooltip title='停止工作流，不清空shareValues'>
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
        length: runs.length,
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
                description='暂无消息,发送一条消息以运行当前 Agent。'
              />
            </div>
          ),
        )
        .with({ length: 0 }, () => <Skeleton active className='flex-1 p-4' />)
        .otherwise(() => (
          <MessageList
            ref={messageListRef}
            runs={runs}
            ctx={ctx}
            loading={phase === 'running' || phase === 'starting'}
          />
        ))}

      {/* Pending AskUserQuestion — 固定在输入框上方,不随消息滚动;顶部 handle 可上下拖动调整高度 */}
      <AnimatePresence>
        {showCard && (
          <motion.div
            key={`ask-card-${mergedInput.toolUseIds.join('-')}`}
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
            <div className='relative flex-1 overflow-auto px-3 py-2'>
              <AskUserQuestionCard
                input={mergedInput}
                mode='active'
                onSubmit={(output) => onActiveSubmit(mergedInput.toolUseIds[0], output)}
                onChangeHeight={(h) => {
                  setCardHeight(Math.max(80, Math.min(600, h)))
                }}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
