import { match } from 'ts-pattern'
import type { AskUserQuestionInput, ExtensionToWebviewMessage } from '@/common'
import { addTokenUsage, emptyTokenUsage, extractTokenUsage, type TokenUsage } from '@/common'

// ── 类型 ──────────────────────────────────────────────────────────────────

export type ToolResult = { isError: boolean; text: string }

export type RenderItem =
  | { kind: 'user'; key: string; rawContent: unknown; usage?: TokenUsage; cost?: number }
  | {
      kind: 'text'
      key: string
      text: string
      streaming: boolean
      usage?: TokenUsage
      cost?: number
    }
  | {
      kind: 'thinking'
      key: string
      text: string
      streaming: boolean
      usage?: TokenUsage
      cost?: number
    }
  | {
      kind: 'tool_use'
      key: string
      toolUseId: string
      toolName: string
      input: unknown
      result?: ToolResult
    }
  | {
      kind: 'ask_user_question'
      key: string
      toolUseId: string
      input: AskUserQuestionInput
    }
  | {
      kind: 'turn_end'
      key: string
      isError: boolean
      usage?: TokenUsage
      cost?: number
      model?: string
    }
  | {
      kind: 'agent_complete'
      key: string
      outputName?: string
      displayContent?: string
    }

type StreamingBlock = { type: 'text' | 'thinking'; content: string }
type PartialMessage = { mIdx: number; blocks: Map<number, StreamingBlock> }

type ScanState = {
  items: RenderItem[]
  seenToolUseIds: Set<string>
  toolUseIdToResult: Map<string, ToolResult>
  completedBlockCounts: Map<string, { thinking: number; text: number }>
  renderedAssistantTexts: Set<string>
  partialsByMessageId: Map<string, PartialMessage>
  currentRenderingPartialMsgId: string | null
  partialBlockSeen: Map<string, { thinking: number; text: number }>
  /** 当前回合内累加的 assistant 消息 usage */
  turnAccUsage: TokenUsage
  /** 上一个 session 的 result 累计费用，用于计算 per-turn 费用差值 */
  prevSessionTotalCost: number
}

type CacheEntry = {
  nextScanStart: number
  state: ScanState
}

// ── 缓存 ─────────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>()

export function clearBuildCache(sessionId?: string): void {
  if (sessionId) {
    cache.delete(sessionId)
  } else {
    cache.clear()
  }
}

/** 按 sessionId 列表批量清除缓存 */
export function clearBuildCacheForSessions(sessionIds: string[]): void {
  for (const id of sessionIds) {
    cache.delete(id)
  }
}

// ── 辅助函数 ─────────────────────────────────────────────────────────────

/** 从 tool_result 的 content 中提取纯文本 */
function extractToolResultText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && b.type === 'text') return b.text ?? ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// ── 核心构建 ─────────────────────────────────────────────────────────────

function scanIncremental(
  msgs: ExtensionToWebviewMessage[],
  nextScanStart: number,
  state: ScanState,
): void {
  const {
    items,
    seenToolUseIds,
    toolUseIdToResult,
    completedBlockCounts,
    renderedAssistantTexts,
    partialsByMessageId,
    partialBlockSeen,
  } = state

  // ── 第一遍（增量）：辅助索引 ─────────────────────────────────────────
  let currentPartialMsgId: string | null = state.currentRenderingPartialMsgId

  for (let i = nextScanStart; i < msgs.length; i++) {
    const msg = msgs[i]
    if (msg.type !== 'flow.signal.aiMessage') continue
    const { message } = msg.data

    if (message.type === 'user') {
      const rawContent = message.message.content
      if (!Array.isArray(rawContent)) continue
      rawContent.forEach((block: any) => {
        if (block?.type === 'tool_result' && block.tool_use_id) {
          const text = extractToolResultText(block.content)
          if (text) {
            toolUseIdToResult.set(block.tool_use_id, { isError: !!block.is_error, text })
          }
        }
      })
      continue
    }

    if (message.type === 'assistant') {
      const mid = message.message.id
      const blocks = message.message.content
      if (!Array.isArray(blocks)) continue
      const counts = completedBlockCounts.get(mid) ?? { thinking: 0, text: 0 }
      blocks.forEach((block: any) => {
        if (block?.type === 'text' && typeof block.text === 'string') {
          renderedAssistantTexts.add(block.text)
          counts.text += 1
        }
        if (block?.type === 'thinking') {
          counts.thinking += 1
        }
        if (block?.type === 'mcp_tool_result' && block.tool_use_id) {
          const text = extractToolResultText(block.content)
          if (text) {
            toolUseIdToResult.set(block.tool_use_id, { isError: !!block.is_error, text })
          }
        }
      })
      completedBlockCounts.set(mid, counts)
      continue
    }

    if (message.type === 'stream_event') {
      const event = message.event as any
      if (event?.type === 'message_start') {
        const id = event.message?.id
        if (typeof id !== 'string') continue
        currentPartialMsgId = id
        if (!partialsByMessageId.has(id)) {
          partialsByMessageId.set(id, { mIdx: i, blocks: new Map() })
        }
        continue
      }
      if (!currentPartialMsgId) continue
      const partial = partialsByMessageId.get(currentPartialMsgId)
      if (!partial) continue
      if (event?.type === 'content_block_start') {
        const cb = event.content_block
        if (cb?.type === 'thinking') {
          partial.blocks.set(event.index, { type: 'thinking', content: cb.thinking ?? '' })
        } else if (cb?.type === 'text') {
          partial.blocks.set(event.index, { type: 'text', content: cb.text ?? '' })
        }
      } else if (event?.type === 'content_block_delta') {
        const existing = partial.blocks.get(event.index)
        if (!existing) continue
        const delta = event.delta
        if (delta?.type === 'thinking_delta') existing.content += delta.thinking
        else if (delta?.type === 'text_delta') existing.content += delta.text
      } else if (event?.type === 'message_stop') {
        currentPartialMsgId = null
      }
    }
  }

  // ── 更新已有 tool_use 项的 result ────────────────────────────────────
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'tool_use' && !item.result) {
      const result = toolUseIdToResult.get(item.toolUseId)
      if (result) {
        items[i] = { ...item, result }
      }
    }
  }

  // ── 第二遍（增量）：按时序生成 RenderItem ─────────────────────────────
  for (let i = nextScanStart; i < msgs.length; i++) {
    const mIdx = i
    const msg = msgs[i]

    if (msg.type === 'flow.signal.aiMessage') {
      const { message } = msg.data

      if (message.type === 'user') {
        const rawContent = message.message.content
        if (
          Array.isArray(rawContent) &&
          rawContent.every((b) => b && typeof b === 'object' && b.type === 'tool_result')
        ) {
          continue
        }
        if (message.isSynthetic) continue
        if (message.parent_tool_use_id) continue
        items.push({ kind: 'user', key: `${mIdx}-user`, rawContent })
        continue
      }

      if (message.type === 'assistant') {
        const blocks = message.message.content
        const usage = extractTokenUsage(message.message.usage)
        // 累加到回合 usage
        if (usage.input_tokens > 0 || usage.output_tokens > 0) {
          state.turnAccUsage = addTokenUsage(state.turnAccUsage, usage)
        }
        if (!Array.isArray(blocks)) continue
        const hasUsage = usage.input_tokens > 0 || usage.output_tokens > 0
        // 记录该 assistant 消息所有 text/thinking 的 index（用于挂 usage）
        const contentIndices: number[] = []
        blocks.forEach((block: any, bIdx: number) => {
          const key = `${mIdx}-${bIdx}`
          if (block.type === 'text' && typeof block.text === 'string') {
            items.push({ kind: 'text', key, text: block.text, streaming: false })
            contentIndices.push(items.length - 1)
            return
          }
          if (block.type === 'thinking' && block.thinking) {
            items.push({ kind: 'thinking', key, text: block.thinking, streaming: false })
            contentIndices.push(items.length - 1)
            return
          }
          if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
            if (seenToolUseIds.has(block.id)) return
            seenToolUseIds.add(block.id)
            const toolName =
              'server_name' in block ? `${block.server_name}::${block.name}` : block.name
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
              const input = block.input as AskUserQuestionInput | undefined
              if (input && Array.isArray(input.questions)) {
                items.push({ kind: 'ask_user_question', key, toolUseId: block.id, input })
              }
              return
            }
            const result = toolUseIdToResult.get(block.id)
            items.push({
              kind: 'tool_use',
              key,
              toolUseId: block.id,
              toolName,
              input: block.input,
              result,
            })
            return
          }
        })
        // 把 usage 挂到该消息的所有 text/thinking item 上
        if (hasUsage && contentIndices.length > 0) {
          for (const idx of contentIndices) {
            const it = items[idx]
            if (it.kind === 'text' || it.kind === 'thinking') {
              items[idx] = { ...it, usage }
            }
          }
        }
        continue
      }

      if (message.type === 'result') {
        const isError = 'error' in message && !!message.error
        // 回合级 usage：优先用累加的 assistant usage，回退到 result.usage
        const accUsage = state.turnAccUsage
        const resultUsage = extractTokenUsage((message as any).usage)
        const turnUsage: TokenUsage | undefined =
          accUsage.input_tokens > 0 || accUsage.output_tokens > 0
            ? accUsage
            : resultUsage.input_tokens > 0 || resultUsage.output_tokens > 0
              ? resultUsage
              : undefined
        // 从 result 消息提取累计费用，计算 per-turn 差值
        const cumulativeCost: number | undefined =
          typeof (message as any).total_cost_usd === 'number'
            ? (message as any).total_cost_usd
            : undefined
        const perTurnCost: number | undefined =
          cumulativeCost !== undefined ? cumulativeCost - state.prevSessionTotalCost : undefined
        state.prevSessionTotalCost = cumulativeCost ?? state.prevSessionTotalCost
        // 从 result 消息提取模型名称
        const resultModel: string | undefined = (message as any).model ?? undefined
        // 回填本轮 AI text/thinking 的 usage 和 cost（若尚未从 assistant 消息获取到）
        if (turnUsage) {
          const itemsToUpdate: number[] = []
          for (let j = items.length - 1; j >= 0; j--) {
            const it = items[j]
            if (it.kind === 'text' || it.kind === 'thinking') {
              if (!it.usage) {
                itemsToUpdate.push(j)
              } else if (perTurnCost !== undefined && it.cost === undefined) {
                items[j] = { ...it, cost: perTurnCost }
              }
            }
          }
          for (const j of itemsToUpdate) {
            const it = items[j]
            items[j] = {
              ...(it as RenderItem & { kind: 'text' | 'thinking' }),
              usage: turnUsage,
              cost: perTurnCost,
            }
          }
        }
        state.turnAccUsage = { ...emptyTokenUsage }
        items.push({
          kind: 'turn_end',
          key: `${mIdx}-result`,
          isError,
          usage: turnUsage,
          cost: perTurnCost,
          model: resultModel,
        })
        continue
      }

      if (message.type === 'stream_event') {
        const event = message.event as any
        if (event?.type === 'message_start') {
          const id = event.message?.id
          if (typeof id === 'string') state.currentRenderingPartialMsgId = id
          continue
        }
        if (event?.type === 'message_stop') {
          state.currentRenderingPartialMsgId = null
          continue
        }
        if (event?.type !== 'content_block_start') continue
        if (!state.currentRenderingPartialMsgId) continue
        const partial = partialsByMessageId.get(state.currentRenderingPartialMsgId)
        if (!partial) continue
        const cbType = event.content_block?.type
        const blockType: 'text' | 'thinking' | null =
          cbType === 'text' ? 'text' : cbType === 'thinking' ? 'thinking' : null
        if (!blockType) continue
        const seen = partialBlockSeen.get(state.currentRenderingPartialMsgId) ?? {
          thinking: 0,
          text: 0,
        }
        seen[blockType] += 1
        partialBlockSeen.set(state.currentRenderingPartialMsgId, seen)
        const completed = completedBlockCounts.get(state.currentRenderingPartialMsgId) ?? {
          thinking: 0,
          text: 0,
        }
        if (seen[blockType] <= completed[blockType]) continue
        const block = partial.blocks.get(event.index)
        if (!block || !block.content) continue
        const key = `${mIdx}-streaming-${event.index}`
        if (block.type === 'text') {
          items.push({ kind: 'text', key, text: block.content, streaming: true })
        } else {
          items.push({ kind: 'thinking', key, text: block.content, streaming: true })
        }
        continue
      }
      continue
    }

    if (msg.type === 'flow.signal.agentComplete') {
      const data = msg.data
      const contentAlreadyShown = !!(data.content && renderedAssistantTexts.has(data.content))
      const displayContent = contentAlreadyShown ? undefined : data.content
      items.push({
        kind: 'agent_complete',
        key: `${mIdx}-complete`,
        outputName: data.output?.name,
        displayContent,
      })
    }
  }
}

/**
 * 按 sessionId 缓存的渲染项构建器。
 *
 * - 首次调用：扫描全部消息，将扫描中间态与最终产物缓存。
 * - 后续调用：消息未增长则直接返回缓存；消息增长则从断点继续增量扫描。
 */
export function buildRenderItems(
  sessionId: string,
  msgs: ExtensionToWebviewMessage[],
): RenderItem[] {
  const cached = match(cache.has(sessionId))
    .with(true, () => cache.get(sessionId)!)
    .with(false, () => {
      cache.set(sessionId, {
        nextScanStart: 0,
        state: {
          items: [],
          seenToolUseIds: new Set(),
          toolUseIdToResult: new Map(),
          completedBlockCounts: new Map(),
          renderedAssistantTexts: new Set(),
          partialsByMessageId: new Map(),
          currentRenderingPartialMsgId: null,
          partialBlockSeen: new Map(),
          turnAccUsage: { ...emptyTokenUsage },
          prevSessionTotalCost: 0,
        },
      })
      return cache.get(sessionId)!
    })
    .exhaustive()

  // 消息未增长 → 直接返回缓存
  if (cached.nextScanStart === msgs.length) {
    return cached.state.items
  }

  const nextScanStart = cached.nextScanStart

  scanIncremental(msgs, nextScanStart, cached.state)

  cached.nextScanStart = msgs.length

  return cached.state.items
}
