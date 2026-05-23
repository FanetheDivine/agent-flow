import { forwardRef, useImperativeHandle, useLayoutEffect, useMemo, useRef } from 'react'
import { Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import type { BubbleItemType } from '@ant-design/x/es/bubble/interface'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemoizedFn } from 'ahooks'
import { match } from 'ts-pattern'
import type { AgentRun } from '@/webview/store/flow'
import { toBubbleItems, type BubbleCtx } from './MessageBubble'

type Item = BubbleItemType

type Props = {
  runs: AgentRun[]
  ctx?: BubbleCtx
  loading?: boolean
}

/**
 * 暴露给 ChatPanel 的命令式 API。
 * - scrollBoxNativeElement: 兼容旧调用方,可能用于读取滚动容器
 * - scrollToBottom: 强制贴底,流式新消息时由 ChatPanel 调用
 */
export type MessageListRef = {
  scrollBoxNativeElement: HTMLElement | null
  scrollToBottom: (behavior?: 'auto' | 'smooth') => void
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

export const MessageList = forwardRef<MessageListRef, Props>(function MessageList(
  { runs, ctx, loading },
  ref,
) {
  const items = useMemo<Item[]>(() => {
    const result: Item[] = []
    runs.forEach((run, idx) => {
      if (idx > 0) {
        result.push({
          key: `divider-${run.runId}`,
          role: 'divider',
          content: (
            <Divider className='my-1 text-[10px]! text-[#6c7086]!'>第 {idx + 1} 次执行</Divider>
          ),
        })
      }
      // buildRenderItems 内部按 cacheKey 缓存(用 runId 作 key,与 store 端 clearBuildCacheForRuns 对齐)
      toBubbleItems(run.runId, run.messages, ctx, run.completed).forEach((item) => {
        result.push({
          key: `${run.runId}-${item.key}`,
          role: item.role,
          content: item.content,
        })
      })
    })
    return result
  }, [runs, ctx])

  const lastRunCompleted = runs.at(-1)?.completed
  const finalItems = useMemo<Item[]>(() => {
    if (!loading || lastRunCompleted) return items
    return [
      ...items,
      {
        key: '__loading__',
        role: 'ai',
        content: null,
        loading: true,
      },
    ]
  }, [items, loading, lastRunCompleted])

  const scrollerElRef = useRef<HTMLDivElement | null>(null)
  // 是否粘底:用户向上滚则置 false,滚回底部 32px 内置 true
  const shouldScrollRef = useRef(true)

  const virtualizer = useVirtualizer({
    count: finalItems.length,
    getScrollElement: () => scrollerElRef.current,
    // estimateSize 尽量贴近真实平均高度。常规一行气泡 ~50px、tooluse ~30px,
    estimateSize: () => 50,
    // 视口上下预渲染窗口
    overscan: 20,
    getItemKey: (idx) => String(finalItems[idx].key),
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
          return (
            <div
              key={vi.key}
              data-index={vi.index}
              ref={virtualizer.measureElement}
              className='absolute top-0 left-0 w-full px-3'
              style={{ transform: `translateY(${vi.start}px)` }}
            >
              {renderItem(item)}
            </div>
          )
        })}
      </div>
    </div>
  )
})

function renderItem(item: Item) {
  // key 必须从 spread 中剥离 —— React 19 禁止把 key 通过 props 对象间接传入 JSX
  const { key, ...rest } = item
  return match(item.role)
    .with('divider', () => <Bubble.Divider key={key} {...rest} />)
    .with('system', () => <Bubble.System key={key} {...rest} />)
    .otherwise((role) => {
      const cfg = roleStyles[role as keyof typeof roleStyles] ?? {}
      return <Bubble key={key} {...cfg} {...rest} />
    })
}
