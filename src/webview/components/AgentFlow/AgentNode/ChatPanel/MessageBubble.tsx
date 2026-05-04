import { memo, useState, type FC, type ReactNode } from 'react'
import { Tag } from 'antd'
import {
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  LinkOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import { XMarkdown } from '@ant-design/x-markdown'
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ExtensionToWebviewMessage,
} from '@/common'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'
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
  <div className='group/copy'>
    {children}
    <div className='mt-1 flex justify-end opacity-0 transition-opacity group-hover/copy:opacity-100'>
      <CopyButton text={text} />
    </div>
  </div>
)

/** 从 refToText 格式的文本块中提取文件引用信息 */
function parseCodeRefFromText(
  text: string,
): { filename: string; range: string; line: [number, number] } | null {
  const m = text.match(/^📎 (.+?) (L(\d+)(?:-(\d+))?)\n/)
  if (!m) return null
  const start = parseInt(m[3], 10)
  const end = m[4] ? parseInt(m[4], 10) : start
  return { filename: m[1], range: m[2], line: [start, end] }
}

/** 渲染用户消息内容，CodeRef 块显示为可点击的文件引用 Tag */
function renderUserContent(rawContent: unknown): { copyText: string; node: ReactNode } {
  if (typeof rawContent === 'string') {
    return { copyText: rawContent, node: <Md content={rawContent} /> }
  }
  if (!Array.isArray(rawContent)) {
    const s = JSON.stringify(rawContent)
    return { copyText: s, node: <Md content={s} /> }
  }
  const copyParts: string[] = []
  const nodes: ReactNode[] = []
  rawContent.forEach((block: any, i: number) => {
    if (!block || typeof block !== 'object') return
    if (block.type === 'text') {
      const ref = parseCodeRefFromText(block.text)
      if (ref) {
        copyParts.push(`${ref.filename} ${ref.range}`)
        nodes.push(
          <Tag
            key={i}
            style={{ cursor: 'pointer' }}
            onClick={() =>
              postMessageToExtension({
                type: 'openFile',
                data: { filename: ref.filename, line: ref.line },
              })
            }
          >
            <LinkOutlined /> {ref.filename} {ref.range}
          </Tag>,
        )
      } else {
        copyParts.push(block.text)
        nodes.push(<Md key={i} content={block.text} />)
      }
    } else if (block.type === 'image') {
      nodes.push(
        <span key={i} className='text-[10px] text-[#6c7086]'>
          [图片附件]
        </span>,
      )
    }
  })
  return {
    copyText: copyParts.join('\n'),
    node: <div className='flex flex-col gap-1'>{nodes}</div>,
  }
}

export function toBubbleItems(
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  seenToolUseIds = new Set<string>(),
): RenderedBubble[] {
  const items: RenderedBubble[] = []
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
      // stream_event / system / other — skip
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
