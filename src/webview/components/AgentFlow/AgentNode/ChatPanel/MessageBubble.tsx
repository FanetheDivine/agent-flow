import { memo, useState, type FC, type ReactNode } from 'react'
import { Tag } from 'antd'
import { Bubble, Think } from '@ant-design/x'
import {
  BranchesOutlined,
  CheckCircleOutlined,
  CheckOutlined,
  CopyOutlined,
  ToolOutlined,
} from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import type {
  AskUserQuestionInput,
  AskUserQuestionOutput,
  ExtensionToWebviewMessage,
} from '@/common'
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
  /** Fork：从指定 session 的指定消息 uuid 处分叉 */
  onFork?: (sessionId: string, messageUuid: string) => void
}

type RenderedBubble = {
  key: string
  role: 'user' | 'ai' | 'system' | 'divider'
  content: ReactNode
}

const Md: FC<{ content: string }> = ({ content }) => (
  <XMarkdown
    className='x-markdown-dark'
    content={content}
    openLinksInNewTab
    escapeRawHtml
  />
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

const ForkButton: FC<{ onFork: () => void }> = ({ onFork }) => (
  <span
    className='cursor-pointer text-[11px] text-[#6c7086] transition-colors hover:text-[#cdd6f4]'
    title='从此处 fork 为新工作流'
    onClick={onFork}
  >
    <BranchesOutlined />
  </span>
)

const BubbleActions: FC<{
  children: ReactNode
  copyText?: string
  onFork?: () => void
}> = ({ children, copyText, onFork }) => {
  if (!copyText && !onFork) return <>{children}</>
  return (
    <div className='group/copy'>
      {children}
      <div className='mt-1 flex justify-end gap-2 opacity-0 transition-opacity group-hover/copy:opacity-100'>
        {onFork && <ForkButton onFork={onFork} />}
        {copyText && <CopyButton text={copyText} />}
      </div>
    </div>
  )
}

/** Back-compat alias: 旧调用点使用 Copyable（仅 copy，无 fork）。 */
const Copyable: FC<{ text: string; children: ReactNode }> = ({ text, children }) => (
  <BubbleActions copyText={text}>{children}</BubbleActions>
)

export function toBubbleItems(
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  seenToolUseIds = new Set<string>(),
  sessionId?: string,
): RenderedBubble[] {
  const items: RenderedBubble[] = []
  const forkHandler = (uuid?: string): (() => void) | undefined => {
    if (!uuid || !sessionId || !ctx?.onFork) return undefined
    return () => ctx.onFork!(sessionId, uuid)
  }
  msgs.forEach((msg, mIdx) => {
    if (msg.type === 'flow.signal.aiMessage') {
      const { message } = msg.data
      const msgUuid = (message as { uuid?: string }).uuid
      const onFork = forkHandler(msgUuid)
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
        const content =
          typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent)
        items.push({
          key: `${mIdx}-user`,
          role: 'user',
          content: (
            <BubbleActions copyText={content} onFork={onFork}>
              <Md content={content} />
            </BubbleActions>
          ),
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
                <BubbleActions copyText={block.text} onFork={onFork}>
                  <Md content={block.text} />
                </BubbleActions>
              ),
            })
            return
          }
          if (block.type === 'thinking') {
            items.push({
              key,
              role: 'ai',
              content: (
                <BubbleActions copyText={block.thinking} onFork={onFork}>
                  <Think title='思考中' defaultExpanded={false}>
                    <Md content={block.thinking} />
                  </Think>
                </BubbleActions>
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
                content: (
                  <BubbleActions onFork={onFork}>
                    {isPending ? (
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
                    )}
                  </BubbleActions>
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
                    <BubbleActions onFork={onFork}>
                      <ToolPermissionCard
                        toolName={toolName}
                        input={block.input}
                        mode={isPendingPerm ? 'active' : 'historical'}
                        answered={answeredPerm}
                        onAllow={() => ctx.onToolPermissionAllow?.(block.id)}
                        onDeny={() => ctx.onToolPermissionDeny?.(block.id)}
                      />
                    </BubbleActions>
                  ),
                })
                return
              }
            }
            items.push({
              key,
              role: 'ai',
              content: (
                <BubbleActions onFork={onFork}>
                  <details className='text-[11px] text-[#a6adc8]'>
                    <summary className='cursor-pointer'>
                      <ToolOutlined className='mr-1 text-[#f9e2af]' />
                      {toolName}
                    </summary>
                    {block.input &&
                      typeof block.input === 'object' &&
                      Object.keys(block.input as object).length > 0 ? (
                        <pre className='mt-1 text-[10px] text-[#7f849c] whitespace-pre-wrap break-all max-h-40 overflow-auto'>
                          {JSON.stringify(block.input, null, 2)}
                        </pre>
                      ) : null}
                  </details>
                </BubbleActions>
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
      ].filter(Boolean).join('\n')
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
