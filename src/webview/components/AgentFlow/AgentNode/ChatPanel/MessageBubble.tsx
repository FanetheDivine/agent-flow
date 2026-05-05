import { memo, useState, type FC, type ReactNode } from 'react'
import { Tag } from 'antd'
import { CheckCircleOutlined, CheckOutlined, CopyOutlined, ToolOutlined } from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import { XMarkdown } from '@ant-design/x-markdown'
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ExtensionToWebviewMessage,
} from '@/common'
import { CodeRefChip } from '@/webview/components/CodeRefChip'
import { FileRefChip } from '@/webview/components/FileRefChip'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { ToolPermissionCard } from './ToolPermissionCard'

type Props = {
  msg: ExtensionToWebviewMessage
}

export type AnsweredInfo = {
  values: Record<string, string[]>
  byFreeText: boolean
}

export type BubbleCtx = {
  pendingToolUseId?: string
  answeredMap: Map<string, AnsweredInfo>
  onActiveSubmit?: (toolUseId: string, output: AskUserQuestionOutput) => void
  onActiveDismiss?: (toolUseId: string) => void
  /** 当前挂起的工具权限请求 toolUseId（若有） */
  pendingToolPermissionToolUseId?: string
  /** 已回答的工具权限历史 */
  answeredToolPermissions?: Record<string, { allow: boolean }>
  onToolPermissionAllow?: (toolUseId: string) => void
  onToolPermissionDeny?: (toolUseId: string) => void
}

type RenderedBubble = {
  key: string
  role: 'user' | 'ai' | 'system' | 'divider'
  content: ReactNode
}

const Md: FC<{ content: string }> = ({ content }) => (
  <XMarkdown className='x-markdown-dark' content={content} openLinksInNewTab escapeRawHtml />
)

const CopyButton: FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false)
  return (
    <span
      className='cursor-pointer text-[11px] text-[#6c7086] transition-colors hover:text-[#cdd6f4]'
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <CheckOutlined /> : <CopyOutlined />}
    </span>
  )
}

const Copyable: FC<{ text: string; children: ReactNode }> = ({ text, children }) => (
  <div className='flex'>
    {children}
    <div className='ml-1'>
      <CopyButton text={text} />
    </div>
  </div>
)

// ChatInput 把代码片段 / 文件引用 / 附件序列化为下列 XML：
//   <code_snippet path="..." lines="N[-M]" language="...">\n...body...\n</code_snippet>
//   <file_ref path="..." />
//   <attachment name="..." mime="...">\n...body...\n</attachment>
// 属性值用 escapeAttr 做最小转义（& → &amp;、" → &quot;、< → &lt;），展示时要反转义。

type UserPart =
  | { kind: 'text'; text: string }
  | { kind: 'code_snippet'; path: string; line?: [number, number]; language?: string }
  | { kind: 'file_ref'; path: string }
  | { kind: 'attachment'; name: string; mime: string; text?: string }

function unescapeAttr(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
}

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /(\w+)="([^"]*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) attrs[m[1]] = unescapeAttr(m[2])
  return attrs
}

function parseUserParts(text: string): UserPart[] {
  const parts: UserPart[] = []
  // 可选前导 HTML 注释 + 三种 tag 之一：自闭合（file_ref）或成对（code_snippet / attachment）
  const re =
    /(?:<!--[\s\S]*?-->\n?)?<(code_snippet|file_ref|attachment)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g
  let lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ kind: 'text', text: text.slice(lastIndex, m.index) })
    }
    const tag = m[1]
    const attrs = parseAttrs(m[2])
    if (tag === 'code_snippet') {
      let line: [number, number] | undefined
      const lm = (attrs.lines ?? '').match(/^(\d+)(?:-(\d+))?$/)
      if (lm) {
        const start = parseInt(lm[1], 10)
        const end = lm[2] ? parseInt(lm[2], 10) : start
        line = [start, end]
      }
      parts.push({ kind: 'code_snippet', path: attrs.path ?? '', line, language: attrs.language })
    } else if (tag === 'file_ref') {
      parts.push({ kind: 'file_ref', path: attrs.path ?? '' })
    } else if (tag === 'attachment') {
      const body = m[3] ?? ''
      // 去掉序列化时额外包裹的首尾换行（见 attachmentToXml）
      const text = body.replace(/^\n/, '').replace(/\n$/, '')
      parts.push({ kind: 'attachment', name: attrs.name ?? '', mime: attrs.mime ?? '', text })
    }
    lastIndex = m.index + m[0].length
  }
  if (lastIndex < text.length) parts.push({ kind: 'text', text: text.slice(lastIndex) })
  return parts
}

function codeRefLabel(path: string, line?: [number, number]): string {
  if (!line) return path
  return line[0] === line[1] ? `${path}:${line[0]}` : `${path}:${line[0]}-${line[1]}`
}

/** 渲染单个 text block 的各 part（文本/代码片段/文件引用/附件） */
function renderTextBlockParts(
  text: string,
  keyPrefix: string,
  copyParts: string[],
  nodes: ReactNode[],
): void {
  const parts = parseUserParts(text)
  parts.forEach((p, j) => {
    const key = `${keyPrefix}-${j}`
    if (p.kind === 'text') {
      if (p.text.length === 0) return
      copyParts.push(p.text)
      nodes.push(
        <span key={key} className='whitespace-pre-wrap'>
          {p.text}
        </span>,
      )
      return
    }
    if (p.kind === 'code_snippet') {
      copyParts.push(codeRefLabel(p.path, p.line))
      nodes.push(
        <span key={key} className='mx-0.5 inline-flex align-middle'>
          <CodeRefChip codeRef={{ filename: p.path, line: p.line }} />
        </span>,
      )
      return
    }
    if (p.kind === 'file_ref') {
      copyParts.push(p.path)
      nodes.push(
        <span key={key} className='mx-0.5 inline-flex align-middle'>
          <CodeRefChip codeRef={{ filename: p.path }} />
        </span>,
      )
      return
    }
    // attachment
    copyParts.push(`📎 ${p.name}`)
    nodes.push(
      <span key={key} className='mx-0.5 inline-flex align-middle'>
        <FileRefChip data={{ id: `att-${key}`, name: p.name, mimeType: p.mime, text: p.text }} />
      </span>,
    )
  })
}

/** 渲染用户消息内容 —— 代码片段 / 文件 / 图片均以 chip 形式内联展示，允许换行 */
function renderUserContent(rawContent: unknown): { copyText: string; node: ReactNode } {
  if (typeof rawContent === 'string') {
    const copyParts: string[] = []
    const nodes: ReactNode[] = []
    renderTextBlockParts(rawContent, 'str', copyParts, nodes)
    return {
      copyText: copyParts.join(''),
      node: <div className='leading-relaxed wrap-break-word'>{nodes}</div>,
    }
  }
  if (!Array.isArray(rawContent)) {
    const s = JSON.stringify(rawContent)
    return {
      copyText: s,
      node: <div className='wrap-break-word whitespace-pre-wrap'>{s}</div>,
    }
  }
  const copyParts: string[] = []
  const nodes: ReactNode[] = []
  rawContent.forEach((block: any, i: number) => {
    if (!block || typeof block !== 'object') return
    if (block.type === 'text') {
      renderTextBlockParts(block.text ?? '', String(i), copyParts, nodes)
      return
    }
    if (block.type === 'image') {
      const mime = block.source?.media_type ?? 'image/png'
      const base64 = block.source?.data ?? ''
      copyParts.push('[图片]')
      nodes.push(
        <span key={i} className='mx-0.5 inline-flex align-middle'>
          <FileRefChip data={{ id: `img-${i}`, name: '图片', mimeType: mime, base64 }} />
        </span>,
      )
    }
  })
  return {
    copyText: copyParts.join('\n'),
    node: <div className='leading-relaxed wrap-break-word'>{nodes}</div>,
  }
}

export function toBubbleItems(
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  seenToolUseIds = new Set<string>(),
): RenderedBubble[] {
  const items: RenderedBubble[] = []

  // 预扫描：收集已有完整 assistant 消息的 uuid（这些 stream_event 已被完整消息取代）
  const completedUuids = new Set<string>()
  msgs.forEach((msg) => {
    if (msg.type === 'flow.signal.aiMessage' && msg.data.message.type === 'assistant') {
      completedUuids.add(msg.data.message.uuid)
    }
  })

  // 累积尚未被完整消息取代的 stream_event 内容
  const streamingBlocks = new Map<number, { type: 'text' | 'thinking'; content: string }>()
  msgs.forEach((msg) => {
    if (msg.type !== 'flow.signal.aiMessage') return
    const { message } = msg.data
    if (message.type !== 'stream_event') return
    if (completedUuids.has(message.uuid)) return
    const event = message.event as any
    if (event.type === 'content_block_start') {
      const block = event.content_block
      if (block?.type === 'thinking') {
        streamingBlocks.set(event.index, { type: 'thinking', content: block.thinking ?? '' })
      } else if (block?.type === 'text') {
        streamingBlocks.set(event.index, { type: 'text', content: block.text ?? '' })
      }
    } else if (event.type === 'content_block_delta') {
      const existing = streamingBlocks.get(event.index)
      if (!existing) return
      const delta = event.delta
      if (delta?.type === 'thinking_delta') {
        existing.content += delta.thinking
      } else if (delta?.type === 'text_delta') {
        existing.content += delta.text
      }
    }
  })

  msgs.forEach((msg, mIdx) => {
    if (msg.type === 'flow.signal.aiMessage') {
      const { message } = msg.data
      if (message.type === 'user') {
        if (message.isSynthetic) return
        const rawContent = message.message.content
        // 纯 tool_result 的 user message 属于工具循环内部产物（例如
        // AskUserQuestion 回答后 SDK 发出的 tool_result），UI 不需要单独渲染，
        // 结构化答案已由 AskUserQuestionCard 的历史态展示。
        if (
          Array.isArray(rawContent) &&
          rawContent.every((b) => b && typeof b === 'object' && b.type === 'tool_result')
        ) {
          return
        }
        const { copyText, node } = renderUserContent(rawContent)
        items.push({
          key: `${mIdx}-user`,
          role: 'user',
          content: <Copyable text={copyText}>{node}</Copyable>,
        })
        return
      }
      if (message.type === 'assistant') {
        const blocks = message.message.content
        if (!Array.isArray(blocks)) return
        blocks.forEach((block, bIdx) => {
          const key = `${mIdx}-${bIdx}`
          if (block.type === 'text') {
            items.push({
              key,
              role: 'ai',
              content: (
                <Copyable text={block.text}>
                  <Md content={block.text} />
                </Copyable>
              ),
            })
            return
          }
          if (block.type === 'thinking') {
            items.push({
              key,
              role: 'ai',
              content: (
                <Copyable text={block.thinking}>
                  <Think title='思考中' defaultExpanded={false}>
                    <Md content={block.thinking} />
                  </Think>
                </Copyable>
              ),
            })
            return
          }
          if (block.type === 'tool_use' || block.type === 'mcp_tool_use') {
            if (seenToolUseIds.has(block.id)) return
            seenToolUseIds.add(block.id)
            if (block.type === 'tool_use' && block.name === 'AskUserQuestion' && ctx) {
              const input = block.input as AskUserQuestionInput | undefined
              if (!input || !Array.isArray(input.questions)) return
              const isPending = ctx.pendingToolUseId === block.id
              const answered = ctx.answeredMap.get(block.id)
              items.push({
                key,
                role: 'system',
                content: isPending ? (
                  <AskUserQuestionCard
                    input={input}
                    mode='active'
                    onSubmit={(output) => ctx.onActiveSubmit?.(block.id, output)}
                    onDismiss={() => ctx.onActiveDismiss?.(block.id)}
                  />
                ) : (
                  <AskUserQuestionCard
                    input={input}
                    mode='historical'
                    answeredValues={answered?.values}
                    answeredByFreeText={answered?.byFreeText}
                  />
                ),
              })
              return
            }
            const toolName =
              'server_name' in block ? `${block.server_name}::${block.name}` : block.name
            if (ctx) {
              const isPendingPerm = ctx.pendingToolPermissionToolUseId === block.id
              const answeredPerm = ctx.answeredToolPermissions?.[block.id]
              if (isPendingPerm || answeredPerm) {
                items.push({
                  key,
                  role: 'system',
                  content: (
                    <ToolPermissionCard
                      toolName={toolName}
                      input={block.input}
                      mode={isPendingPerm ? 'active' : 'historical'}
                      answered={answeredPerm}
                      onAllow={() => ctx.onToolPermissionAllow?.(block.id)}
                      onDeny={() => ctx.onToolPermissionDeny?.(block.id)}
                    />
                  ),
                })
                return
              }
            }
            items.push({
              key,
              role: 'ai',
              content: (
                <details className='text-[11px] text-[#a6adc8]'>
                  <summary className='cursor-pointer'>
                    <ToolOutlined className='mr-1 text-[#f9e2af]' />
                    {toolName}
                  </summary>
                  {block.input &&
                  typeof block.input === 'object' &&
                  Object.keys(block.input as object).length > 0 ? (
                    <pre className='mt-1 max-h-40 overflow-auto text-[10px] break-all whitespace-pre-wrap text-[#7f849c]'>
                      {JSON.stringify(block.input, null, 2)}
                    </pre>
                  ) : null}
                </details>
              ),
            })
            return
          }
          // mcp_tool_result & others — skip (verbose)
        })
        return
      }
      if (message.type === 'result') {
        const isError = 'error' in message && message.error
        items.push({
          key: `${mIdx}-result`,
          role: 'divider',
          content: (
            <span className='text-[10px] text-[#6c7086]'>
              <CheckCircleOutlined className={isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'} />
              <span className='ml-1'>{isError ? '执行出错' : '回合结束'}</span>
            </span>
          ),
        })
        return
      }
      // stream_event / system / other — 已在预扫描中累积处理
      return
    }

    if (msg.type === 'flow.signal.agentComplete') {
      const completionText = [
        msg.data.output ? `完成 → ${msg.data.output.name}` : '完成',
        msg.data.content,
      ]
        .filter(Boolean)
        .join('\n')
      items.push({
        key: `${mIdx}-complete`,
        role: 'ai',
        content: (
          <Copyable text={completionText}>
            <div>
              <Tag color='green' className='m-0 text-[10px]'>
                完成{msg.data.output ? ` → ${msg.data.output.name}` : ''}
              </Tag>
              {msg.data.content && (
                <div className='mt-2'>
                  <Md content={msg.data.content} />
                </div>
              )}
            </div>
          </Copyable>
        ),
      })
    }
  })

  // 渲染正在流式生成中的内容（尚未被完整 assistant 消息取代的 stream_event 累积结果）
  const sortedIndices = [...streamingBlocks.keys()].sort((a, b) => a - b)
  for (const index of sortedIndices) {
    const block = streamingBlocks.get(index)!
    if (!block.content) continue
    const key = `streaming-${index}`
    if (block.type === 'text') {
      items.push({
        key,
        role: 'ai',
        content: <Md content={block.content} />,
      })
    } else if (block.type === 'thinking') {
      items.push({
        key,
        role: 'ai',
        content: (
          <Think title='思考中' defaultExpanded>
            <Md content={block.content} />
          </Think>
        ),
      })
    }
  }

  return items
}

/**
 * 保留单气泡渲染入口（可用于调试或非列表场景）。
 * 列表场景请直接使用 Bubble.List + toBubbleItems。
 */
const MessageBubbleInner: FC<Props> = ({ msg }) => {
  const items = toBubbleItems([msg])
  if (items.length === 0) return null
  return (
    <div className='flex flex-col gap-1'>
      {items.map((item) => (
        <Bubble
          key={item.key}
          placement={item.role === 'user' ? 'end' : 'start'}
          content={item.content}
          variant={item.role === 'divider' ? 'borderless' : 'filled'}
        />
      ))}
    </div>
  )
}

export const MessageBubble = memo(MessageBubbleInner)
