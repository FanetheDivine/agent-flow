import { forwardRef, useImperativeHandle, useMemo, useRef } from 'react'
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso'
import { Divider } from 'antd'
import { Bubble } from '@ant-design/x'
import type { BubbleItemType } from '@ant-design/x/es/bubble/interface'
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

  const virtuosoRef = useRef<VirtuosoHandle>(null)
  const scrollerElRef = useRef<HTMLElement | null>(null)
  // 仅在首次挂载时定位到末尾;后续长度变化由 followOutput='auto' 接管
  const initialIndexRef = useRef<number>(Math.max(0, finalItems.length - 1))

  useImperativeHandle(
    ref,
    () => ({
      get scrollBoxNativeElement() {
        return scrollerElRef.current
      },
      scrollToBottom(behavior: 'auto' | 'smooth' = 'auto') {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({
            index: 'LAST',
            align: 'end',
            behavior,
          })
        })
      },
    }),
    [],
  )

  return (
    <Virtuoso
      ref={virtuosoRef}
      data={finalItems}
      computeItemKey={(_idx, it) => String(it.key)}
      followOutput='auto'
      atBottomThreshold={30}
      increaseViewportBy={400}
      initialTopMostItemIndex={initialIndexRef.current}
      scrollerRef={(el) => {
        scrollerElRef.current = (el as HTMLElement | null) ?? null
      }}
      // 只锁 X 溢出 — Virtuoso 的 viewport 是 absolute,scroller 的 padding 会被吃掉
      // 所以左右 padding 改到 components.List(普通 div,padding 生效)
      className='chat-bubble-compact min-h-0 flex-1 overflow-x-hidden'
      components={virtuosoComponents}
      itemContent={(_idx, item) => renderItem(item)}
    />
  )
})

// padding-inline 给 List 层(普通定位 div),左右留白才会生效
// padding-block 不要写在这里 — Virtuoso 会通过 inline style 设 paddingTop/paddingBottom
// 占位被回收 item 的高度,我们的 class padding-block 会被 inline 覆盖
const VirtuosoList: NonNullable<Components<BubbleItemType>['List']> = forwardRef(
  function VirtuosoList({ style, ...rest }, ref) {
    return <div {...rest} ref={ref} style={style} className='px-3' />
  },
)

const virtuosoComponents: Components<BubbleItemType> = {
  List: VirtuosoList,
}

function renderItem(item: Item) {
  return match(item.role)
    .with('divider', () => <Bubble.Divider {...item} />)
    .with('system', () => <Bubble.System {...item} />)
    .otherwise((role) => {
      const cfg = roleStyles[role as keyof typeof roleStyles] ?? {}
      return <Bubble {...cfg} {...item} />
    })
}
