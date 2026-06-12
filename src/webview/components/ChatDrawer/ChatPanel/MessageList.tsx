import {
  memo,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { App, Button, Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemoizedFn } from 'ahooks'
import { match } from 'ts-pattern'
import type { ChatMessage, PendingToolPermission } from '@/common'
import { getAnsweredToolPermissions, getPendingToolPermissionsFor } from '@/common'
import type { AgentRun } from '@/webview/store/flow'
import { useFlowStore } from '@/webview/store/flow'
import { postMessageToExtension } from '@/webview/utils'
import {
  type BubbleCtx,
  type RenderedBubble,
  deriveForkUuid,
  indentBubble,
  regroupSubAgentItems,
  renderItemToBubble,
} from './MessageBubble'

// ── 特殊列表项 ────────────────────────────────────────────────────────────────
type LoadingItem = { kind: 'loading' }
type DividerItem = { kind: 'divider'; runId: string; runIndex: number }
type ShowMoreItem = { kind: 'show-more'; runId: string; hiddenCount: number }
type ListItem = ChatMessage | LoadingItem | DividerItem | ShowMoreItem

/** 渲染一条 ChatMessage 时需要的 per-run 上下文（不含 ctx，避免 ctx 变化触发 items 重建） */
type MessageMeta = {
  runId: string
  sessionCompleted: boolean
  forkUuid: string | undefined
  /** 仅首条 user 消息携带 injectedShareValues，其余为 undefined */
  injectedShareValues: Record<string, string | null> | undefined
  isSubAgent: boolean
}

// 模块级常量 —— useMemo / selector 在「无内容」时返回稳定空引用,
// 避免 useSyncExternalStore 因为新 [] / new Set() 误判快照变化触发死循环重渲染。
const EMPTY_RUNS: AgentRun[] = []
const EMPTY_PENDING_TOOL_PERMS: PendingToolPermission[] = []
const EMPTY_ITEMS: ListItem[] = []
const EMPTY_KEYS: string[] = []
const EMPTY_META = new Map<string, MessageMeta>()

/**
 * 暴露给 ChatPanel 的命令式 API。
 * - scrollBoxNativeElement: 兼容旧调用方,可能用于读取滚动容器
 * - scrollToBottom: 强制贴底,流式新消息时由 ChatPanel 调用
 */
export type MessageListRef = {
  scrollBoxNativeElement: HTMLElement | null
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void
}

type Props = {
  flowId: string
  agentId: string
  /** 单 run 视图;未传则按 agentId 聚合该 agent 全部 runs */
  runId?: string
  loading?: boolean
  ref?: Ref<MessageListRef>
}
const roleStyles = {
  user: {
    placement: 'end' as const,
    variant: 'outlined' as const,
    styles: { content: { background: '#2a2d4a', borderColor: '#585b70' } },
  },
  ai: { placement: 'start' as const, variant: 'filled' as const },
  system: { placement: 'start' as const, variant: 'borderless' as const },
}

/** 折叠态轻量选取:首条 non-subAgent user + agent_complete */
function pickLightMessages(msgs: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = []
  const firstUser = msgs.find((m) => m.kind === 'user' && !m.parentToolUseId)
  if (firstUser) result.push(firstUser)
  const complete = msgs.find((m) => m.kind === 'agent_complete')
  if (complete) result.push(complete)
  return result
}

function MessageListInner({ flowId, agentId, runId, loading, ref }: Props) {
  // ── 数据订阅 —— 全部用稳定原始引用,过滤 / 转换在 useMemo 中完成 ──────────────
  const fs = useFlowStore((s) => s.flowRunStates[flowId])
  const allRuns = fs?.runs

  // 注入快照小节标题按 node_type 区分:code 节点展示全量 shareValues(「共享数据」),
  // agent 节点展示按 allowed_read 过滤的注入值(「注入数据」)。MessageList 按 agentId 聚合,
  // 故整列 node_type 一致。
  const flows = useFlowStore((s) => s.flows)
  const injectedTitle = useMemo(() => {
    const agent = flows.find((f) => f.id === flowId)?.agents?.find((a) => a.id === agentId)
    return agent?.node_type === 'code' ? '共享数据' : '注入数据'
  }, [flows, flowId, agentId])

  const runs = useMemo<AgentRun[]>(() => {
    if (!allRuns) return EMPTY_RUNS
    if (runId) {
      const r = allRuns.find((r) => r.runId === runId)
      return r ? [r] : EMPTY_RUNS
    }
    return allRuns.filter((r) => r.agentId === agentId)
  }, [allRuns, agentId, runId])

  const { modal } = App.useApp()

  // ── ctx 构建 —— 历史 AskUserQuestion 卡片 / fork icon / tool 权限卡片用 ──

  const ctx = useMemo<BubbleCtx>(() => {
    const answeredToolPermissions = getAnsweredToolPermissions(fs)
    // 四类挂起统一订阅 pendingToolPermissions(AskUserQuestion / CompleteTask / ExitPlanMode / must_confirm)
    const pendingToolPerms = (() => {
      if (!fs) return EMPTY_PENDING_TOOL_PERMS
      if (runId) {
        const list = fs.pendingToolPermissions
        const filtered = list.filter((p) => p.runId === runId)
        if (filtered.length === list.length) return list
        if (filtered.length === 0) return EMPTY_PENDING_TOOL_PERMS
        return filtered
      }
      return getPendingToolPermissionsFor(fs, agentId)
    })()
    const pendingToolPermissionToolUseIds = (() => {
      if (pendingToolPerms.length === 0) return undefined
      return new Set(pendingToolPerms.map((p) => p.toolUseId))
    })()
    return {
      pendingToolPermissionToolUseIds,
      answeredToolPermissions,
      onToolPermissionAllow: (toolUseId) => {
        const state = useFlowStore.getState()
        const fs = state.flowRunStates[flowId]
        if (!fs) return
        const list = runId
          ? fs.pendingToolPermissions.filter((p) => p.runId === runId)
          : getPendingToolPermissionsFor(fs, agentId)
        const p = list.find((p) => p.toolUseId === toolUseId)
        if (!p) return
        state.answerToolPermission(flowId, p.runId, toolUseId, true)
      },
      // deny:message 供 CompleteTask 拒绝原因(回喂模型);其余工具不传 → executor 用 'user denied'
      onToolPermissionDeny: (toolUseId, message) => {
        const state = useFlowStore.getState()
        const fs = state.flowRunStates[flowId]
        if (!fs) return
        const list = runId
          ? fs.pendingToolPermissions.filter((p) => p.runId === runId)
          : getPendingToolPermissionsFor(fs, agentId)
        const p = list.find((p) => p.toolUseId === toolUseId)
        if (!p) return
        state.answerToolPermission(
          flowId,
          p.runId,
          toolUseId,
          false,
          message ? { message } : undefined,
        )
      },
      onViewPlan: (planFilePath) => {
        postMessageToExtension({
          type: 'openFile',
          data: { filename: planFilePath, placement: 'active' },
        })
      },
      /**
       * fork 触发入口：sessionCompleted=true（历史 session）时弹 modal 提示
       * 「shareValues 一致性不保证」并由用户确认后再发 command；当前 session 直接发。
       */
      onFork: (target, sessionCompleted) => {
        const doFork = () => useFlowStore.getState().forkFlow(flowId, target)
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
    }
  }, [fs, runId, agentId, flowId, modal])

  // ── 折叠状态 ────────────────────────────────────────────────────────────────
  // 同时只展开一个 run；expandedRunId 为空时自动跟随末位（新 run 追加时自动展开最新）
  const [expandedRunId, setExpandedRunId] = useState<string>()
  const lastRunId = runs.at(-1)?.runId
  const effectiveExpanded = expandedRunId ?? lastRunId

  // ── 列表项构建 —— ctx 不在 deps 中，工具权限变化不触发 items 重建 ────────────
  const { items, keys, metaMap } = useMemo<{
    items: ListItem[]
    keys: string[]
    metaMap: Map<string, MessageMeta>
  }>(() => {
    if (runs.length === 0) return { items: EMPTY_ITEMS, keys: EMPTY_KEYS, metaMap: EMPTY_META }

    const items: ListItem[] = []
    const keys: string[] = []
    const metaMap = new Map<string, MessageMeta>()

    const push = (item: ListItem, key: string) => {
      items.push(item)
      keys.push(key)
    }

    runs.forEach((run, idx) => {
      if (idx > 0) {
        const div: DividerItem = { kind: 'divider', runId: run.runId, runIndex: idx }
        push(div, `divider-${run.runId}`)
      }

      const isExpanded = run.runId === effectiveExpanded

      if (!isExpanded) {
        // 折叠态：首条 user + showMore + agent_complete
        const lightMsgs = pickLightMessages(run.messages)
        const firstUser = lightMsgs.find((m) => m.kind === 'user')
        const complete = lightMsgs.find((m) => m.kind === 'agent_complete')
        // hidden = 原始消息数 - firstUser 数 - complete 数
        const hiddenCount = run.messages.length - (firstUser ? 1 : 0) - (complete ? 1 : 0)

        if (firstUser) {
          push(firstUser, `${run.runId}-${firstUser.id}`)
          metaMap.set(firstUser.id, {
            runId: run.runId,
            sessionCompleted: run.completed,
            forkUuid: deriveForkUuid(run.messages, run.messages.indexOf(firstUser)),
            injectedShareValues: run.injectedShareValues,
            isSubAgent: false,
          })
        }
        if (hiddenCount > 0) {
          const showMore: ShowMoreItem = { kind: 'show-more', runId: run.runId, hiddenCount }
          push(showMore, `${run.runId}-show-more`)
        }
        if (complete) {
          push(complete, `${run.runId}-${complete.id}`)
          metaMap.set(complete.id, {
            runId: run.runId,
            sessionCompleted: run.completed,
            forkUuid: deriveForkUuid(run.messages, run.messages.indexOf(complete)),
            injectedShareValues: undefined,
            isSubAgent: false,
          })
        }
        return
      }

      // 展开态：按时间序计算 forkUuid，然后 regroup，逐条压入
      const forkUuidById = new Map<string, string | undefined>()
      run.messages.forEach((msg, i) => forkUuidById.set(msg.id, deriveForkUuid(run.messages, i)))

      const { ordered, subItemKeys } = regroupSubAgentItems(run.messages)

      let firstUserPassed = false
      for (const msg of ordered) {
        push(msg, `${run.runId}-${msg.id}`)
        const isFirstUser = !firstUserPassed && msg.kind === 'user' && !msg.parentToolUseId
        if (isFirstUser) firstUserPassed = true
        metaMap.set(msg.id, {
          runId: run.runId,
          sessionCompleted: run.completed,
          forkUuid: forkUuidById.get(msg.id),
          injectedShareValues: isFirstUser ? run.injectedShareValues : undefined,
          isSubAgent: subItemKeys.has(msg.id),
        })
      }
    })

    return { items, keys, metaMap }
  }, [runs, effectiveExpanded])

  const lastRunCompleted = runs.at(-1)?.completed
  const { finalItems, finalKeys } = useMemo<{ finalItems: ListItem[]; finalKeys: string[] }>(() => {
    if (!loading || lastRunCompleted) return { finalItems: items, finalKeys: keys }
    return {
      finalItems: [...items, { kind: 'loading' } as LoadingItem],
      finalKeys: [...keys, '__loading__'],
    }
  }, [items, keys, loading, lastRunCompleted])

  // 诊断:气泡重叠根因排查
  useEffect(() => {
    const seen = new Map<string, string>()
    for (let i = 0; i < finalKeys.length; i++) {
      const key = finalKeys[i]
      if (seen.has(key)) {
        console.warn('[MessageList] 重复 RenderItem key', {
          key,
          flowId,
          agentId,
          runId,
          existingItem: finalItems[seen.get(key) as unknown as number],
          duplicateItem: finalItems[i],
        })
      } else {
        seen.set(key, String(i))
      }
    }
  }, [finalKeys, finalItems, flowId, agentId, runId])

  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  // 是否粘底:用户向上滚则置 false,滚回底部 32px 内置 true
  const shouldScrollRef = useRef(true)

  const virtualizer = useVirtualizer({
    count: finalItems.length,
    getScrollElement: () => scrollerElRef.current,
    // estimateSize 尽量贴近真实平均高度。常规一行气泡 ~50px、tooluse ~30px,
    estimateSize: () => 50,
    // 视口上下预渲染窗口
    overscan: 30,
    getItemKey: (idx) => finalKeys[idx],
  })

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()
  /**
   * 直接把 scrollTop 怼到 scrollHeight,与 DOM 真实高度对齐 ——
   * 不走 virtualizer.scrollToIndex,避开「估算高度先算偏移、精确高度异步回填」
   * 导致末尾消息越长越偏的老问题。
   */
  const scrollToEnd = useMemoizedFn((behavior: 'auto' | 'smooth' = 'auto') => {
    const el = scrollerElRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  })

  useLayoutEffect(() => {
    if (!shouldScrollRef.current) return
    scrollToEnd()
    // 有AI消息/首次进入/渲染变化时滚动
  }, [finalItems, totalSize, scrollToEnd])

  useImperativeHandle(
    ref,
    () => ({
      get scrollBoxNativeElement() {
        return scrollerElRef.current
      },
      scrollToBottom(behavior: 'auto' | 'smooth' = 'auto') {
        shouldScrollRef.current = true
        setTimeout(() => scrollToEnd(behavior))
      },
    }),
    [scrollToEnd],
  )

  return (
    <div
      ref={scrollerElRef}
      onScroll={(e) => {
        const dom = e.target as HTMLDivElement
        shouldScrollRef.current = dom.scrollHeight - dom.scrollTop - dom.clientHeight < 32
      }}
      className='chat-bubble-compact min-h-0 flex-1 overflow-x-hidden overflow-y-auto'
    >
      <div className='relative w-full max-w-full overflow-hidden' style={{ height: totalSize }}>
        {virtualItems.map((vi) => {
          const item = finalItems[vi.index]
          const meta = 'id' in item ? metaMap.get((item as ChatMessage).id) : undefined
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className='absolute top-0 left-0 w-full px-3 [&:has(.from-sub-agent)]:ml-4'
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              <MessageItem
                item={item}
                ctx={ctx}
                meta={meta}
                injectedTitle={injectedTitle}
                setExpandedRunId={setExpandedRunId}
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

// React 19 允许把 ref 直接放到 props 里。memo 的浅比较仅依赖 (flowId, agentId, runId, loading, ref)
// 几个稳定字段;store 变化由组件内部的 selector 自行订阅,不再因父级重渲染连带刷新。
export const MessageList = memo(MessageListInner)

// ── MessageItem —— 单条列表项渲染，memo 确保 item/ctx 未变时跳过重渲染 ───────────
const MessageItem = memo(function MessageItem({
  item,
  ctx,
  meta,
  injectedTitle,
  setExpandedRunId,
}: {
  item: ListItem
  ctx: BubbleCtx
  meta: MessageMeta | undefined
  injectedTitle: string
  setExpandedRunId: (runId: string) => void
}) {
  if (item.kind === 'divider') {
    return (
      <Divider className='my-1 text-[10px]! text-[#6c7086]!'>第 {item.runIndex + 1} 次执行</Divider>
    )
  }
  if (item.kind === 'show-more') {
    return (
      <div className='flex justify-center'>
        <Button
          size='small'
          type='text'
          className='text-[11px]! text-[#6c7086]!'
          onClick={() => setExpandedRunId(item.runId)}
        >
          显示折叠消息
        </Button>
      </div>
    )
  }
  if (item.kind === 'loading') {
    return <Bubble placement='start' variant='filled' content={null} loading />
  }

  // ChatMessage
  const raw = renderItemToBubble(
    item,
    ctx,
    meta?.sessionCompleted ?? false,
    meta?.runId,
    meta?.forkUuid,
    meta?.injectedShareValues,
    injectedTitle,
  )
  if (!raw) return null
  const bubbles: RenderedBubble[] = Array.isArray(raw) ? raw : [raw]
  const applied = meta?.isSubAgent ? bubbles.map(indentBubble) : bubbles
  return (
    <>
      {applied.map((b) => {
        const { key, ...rest } = b
        return match(b.role)
          .with('divider', () => <Bubble.Divider key={key} {...rest} />)
          .with('system', () => <Bubble.System key={key} {...rest} />)
          .otherwise((role) => {
            const cfg = roleStyles[role as keyof typeof roleStyles] ?? {}
            return <Bubble key={key} {...cfg} {...rest} />
          })
      })}
    </>
  )
})
