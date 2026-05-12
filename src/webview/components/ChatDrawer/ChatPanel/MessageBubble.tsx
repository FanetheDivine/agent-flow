import {
  isValidElement,
  memo,
  useEffect,
  useId,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react'
import { Spin, Tag } from 'antd'
import {
  CheckCircleFilled,
  CheckCircleOutlined,
  CheckOutlined,
  CloseCircleFilled,
  CopyOutlined,
  LoadingOutlined,
} from '@ant-design/icons'
import { Bubble, Think } from '@ant-design/x'
import { XMarkdown, type ComponentProps as XMarkdownComponentProps } from '@ant-design/x-markdown'
import mermaid from 'mermaid'
import type { AskUserQuestionOutput, ExtensionToWebviewMessage, TokenUsage } from '@/common'
import { calculateTokenCost, formatTokenCount, formatTokenCost } from '@/common'
import { CodeRefChip } from '@/webview/components/CodeRefChip'
import { FileRefChip } from '@/webview/components/FileRefChip'
import { AskUserQuestionCard } from './AskUserQuestionCard'
import { ToolPermissionCard } from './ToolPermissionCard'
import {
  buildRenderItems,
  clearBuildCache,
  clearBuildCacheForSessions,
  type RenderItem,
  type ToolResult,
} from './buildRenderItems'

type Props = {
  msg: ExtensionToWebviewMessage
}

export type AnsweredInfo = {
  values: Record<string, string[]>
}

export type BubbleCtx = {
  pendingToolUseId?: string
  answeredMap: Map<string, AnsweredInfo>
  onActiveSubmit?: (toolUseId: string, output: AskUserQuestionOutput) => void
  /** 当前挂起的工具权限请求 toolUseId（若有） */
  pendingToolPermissionToolUseId?: string
  /** 已回答的工具权限历史 */
  answeredToolPermissions?: Record<string, { allow: boolean }>
  onToolPermissionAllow?: (toolUseId: string) => void
  onToolPermissionDeny?: (toolUseId: string) => void
  /** 当前 Agent 的模型，用于计算费用 */
  model?: string
}

type RenderedBubble = {
  key: string
  role: 'user' | 'ai' | 'system' | 'divider'
  content: ReactNode
}

mermaid.initialize({
  startOnLoad: false,
  theme: 'dark',
  securityLevel: 'loose',
})

const getTextContent = (node: ReactNode): string => {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(getTextContent).join('')
  if (isValidElement(node)) {
    const children = (node.props as { children?: ReactNode }).children
    return getTextContent(children)
  }
  return ''
}

const PreBlock: FC<XMarkdownComponentProps> = ({ children, className }) => {
  const text = getTextContent(children)
  return (
    <div className='group relative'>
      <div className='absolute top-1.5 right-1.5 z-10 opacity-0 transition-opacity group-hover:opacity-100'>
        <CopyButton text={text} />
      </div>
      <pre className={className}>{children}</pre>
    </div>
  )
}

const MermaidDiagram: FC<{ code: string }> = ({ code }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [svg, setSvg] = useState<string>('')
  const [error, setError] = useState<string>('')
  const id = useId()

  useEffect(() => {
    let cancelled = false
    const render = async () => {
      try {
        const { svg } = await mermaid.render(id, code)
        if (!cancelled) setSvg(svg)
      } catch (e: any) {
        if (!cancelled) setError(e?.message ?? 'Mermaid render error')
      }
    }
    render()
    return () => {
      cancelled = true
    }
  }, [code, id])

  if (error) {
    return (
      <div className='rounded border border-[#f38ba8]/30 bg-[#f38ba8]/5 p-2 text-[12px] text-[#f38ba8]'>
        Mermaid 渲染失败：{error}
        <details className='mt-1'>
          <summary className='cursor-pointer'>查看源码</summary>
          <pre className='mt-1 max-h-40 overflow-auto text-[10px]'>{code}</pre>
        </details>
      </div>
    )
  }

  if (!svg) {
    return (
      <div className='flex items-center gap-2 py-2 text-[12px] text-[#6c7086]'>
        <Spin size='small' /> 渲染中...
      </div>
    )
  }

  return (
    <div ref={containerRef} className='overflow-auto' dangerouslySetInnerHTML={{ __html: svg }} />
  )
}

const CodeBlock: FC<XMarkdownComponentProps> = ({ children, lang, block, streamStatus }) => {
  if (block && lang === 'mermaid' && streamStatus === 'done') {
    const code = getTextContent(children)
    return <MermaidDiagram code={code} />
  }
  // 流式进行中 mermaid 代码尚未完整，先按普通代码块展示
  if (block && lang === 'mermaid' && streamStatus === 'loading') {
    const code = getTextContent(children)
    return (
      <pre className='overflow-auto'>
        <code>{code}</code>
      </pre>
    )
  }
  return <code>{children}</code>
}

const MD_COMPONENTS = { pre: PreBlock, code: CodeBlock }

const Md: FC<{ content: string }> = memo(({ content }) => (
  <XMarkdown
    className='x-markdown-dark'
    content={content}
    components={MD_COMPONENTS}
    openLinksInNewTab
    escapeRawHtml
  />
))

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

/** 根据工具名和输入参数生成一行摘要 */
function getToolSummary(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return toolName
  const name = toolName.replace(/^mcp__\w+__/, '')
  switch (name) {
    case 'Read':
      return input.file_path ? `${name} ${input.file_path}` : name
    case 'Write':
      return input.file_path ? `${name} ${input.file_path}` : name
    case 'Edit':
      return input.file_path ? `${name} ${input.file_path}` : name
    case 'Bash':
      return input.command ? `${name} ${input.command}` : name
    case 'Grep':
      return input.pattern ? `${name} ${input.pattern}` : name
    case 'Glob':
      return input.pattern ? `${name} ${input.pattern}` : name
    case 'WebFetch':
      return input.url ? `${name} ${input.url}` : name
    case 'WebSearch':
      return input.query ? `${name} ${input.query}` : name
    case 'Agent':
      return input.description ? `${name} ${input.description}` : name
    case 'TodoWrite':
      return name
    default:
      return name
  }
}

// ── 渲染层 ───────────────────────────────────────────────────────────────
// 纯把 RenderItem 转 React 节点，不再涉及消息流的语义合并。

function TokenUsageBadge({
  usage,
  model,
  cost,
}: {
  usage: TokenUsage
  model?: string
  cost?: number
}) {
  const parts: string[] = []
  if (usage.input_tokens > 0) parts.push(`in ${formatTokenCount(usage.input_tokens)}`)
  if (usage.output_tokens > 0) parts.push(`out ${formatTokenCount(usage.output_tokens)}`)
  if (usage.cache_creation_input_tokens > 0)
    parts.push(`cache write ${formatTokenCount(usage.cache_creation_input_tokens)}`)
  if (usage.cache_read_input_tokens > 0)
    parts.push(`cache read ${formatTokenCount(usage.cache_read_input_tokens)}`)
  if (parts.length === 0) return null
  const costStr =
    cost !== undefined
      ? formatTokenCost(cost)
      : model
        ? formatTokenCost(calculateTokenCost(usage, model))
        : ''
  return (
    <span className='text-[10px] text-[#6c7086]'>
      {parts.join(' · ')} tokens{costStr ? ` · ${costStr}` : ''}
    </span>
  )
}

function renderToolUseDetails(
  toolName: string,
  input: unknown,
  result: ToolResult | undefined,
  /** 无 result 时是否视为成功——仅用于 AgentComplete：调用后 executor 立刻 kill，
   *  正常情况下永远收不到 mcp_tool_result，需结合 session.completed 判断 */
  treatNoResultAsSuccess = false,
): ReactNode {
  const summary = getToolSummary(toolName, input)
  const hasInput = !!input && typeof input === 'object' && Object.keys(input as object).length > 0
  return (
    <details className='text-[11px] text-[#a6adc8]'>
      <summary className='cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap'>
        {result ? (
          result.isError ? (
            <CloseCircleFilled className='mr-1 text-[#f38ba8]' />
          ) : (
            <CheckCircleFilled className='mr-1 text-[#a6e3a1]' />
          )
        ) : treatNoResultAsSuccess ? (
          <CheckCircleFilled className='mr-1 text-[#a6e3a1]' />
        ) : (
          <Spin
            size='small'
            indicator={<LoadingOutlined className='text-[10px]!' />}
            className='mr-1'
          />
        )}
        {summary}
      </summary>
      {hasInput ? (
        <pre className='mt-1 max-h-40 overflow-auto text-[10px] break-all whitespace-pre-wrap text-[#7f849c]'>
          {JSON.stringify(input, null, 2)}
        </pre>
      ) : null}
      {result && (
        <pre className='mt-1 max-h-60 overflow-auto border-t border-[#313244] pt-1 text-[10px] break-all whitespace-pre-wrap text-[#7f849c]'>
          {result.text}
        </pre>
      )}
    </details>
  )
}

function renderItemToBubble(
  item: RenderItem,
  ctx?: BubbleCtx,
  sessionCompleted = false,
): RenderedBubble | null {
  switch (item.kind) {
    case 'user': {
      const { copyText, node } = renderUserContent(item.rawContent)
      return {
        key: item.key,
        role: 'user',
        content: (
          <div>
            <Copyable text={copyText}>{node}</Copyable>
            {item.usage && (
              <div className='mt-1 text-left'>
                <TokenUsageBadge usage={item.usage} model={ctx?.model} cost={item.cost} />
              </div>
            )}
          </div>
        ),
      }
    }
    case 'text': {
      const md = <Md content={item.text} />
      const content = item.streaming ? md : <Copyable text={item.text}>{md}</Copyable>
      return {
        key: item.key,
        role: 'ai',
        content: item.usage ? (
          <div>
            {content}
            <div className='mt-1'>
              <TokenUsageBadge usage={item.usage} model={ctx?.model} cost={item.cost} />
            </div>
          </div>
        ) : (
          content
        ),
      }
    }
    case 'thinking': {
      const inner = (
        <Think title='思考中' defaultExpanded={item.streaming}>
          <Md content={item.text} />
        </Think>
      )
      const content = item.streaming ? inner : <Copyable text={item.text}>{inner}</Copyable>
      return {
        key: item.key,
        role: 'ai',
        content: item.usage ? (
          <div>
            {content}
            <div className='mt-1'>
              <TokenUsageBadge usage={item.usage} model={ctx?.model} cost={item.cost} />
            </div>
          </div>
        ) : (
          content
        ),
      }
    }
    case 'ask_user_question': {
      if (!ctx) {
        // 无 ctx（单气泡调试场景）：降级为静态历史卡片
        return {
          key: item.key,
          role: 'system',
          content: <AskUserQuestionCard input={item.input} mode='historical' />,
        }
      }
      const isPending = ctx.pendingToolUseId === item.toolUseId
      // pending 卡片不在消息列表中渲染（改为固定在输入框上方），只渲染已回答的历史卡片
      if (isPending) return null
      const answered = ctx.answeredMap.get(item.toolUseId)
      return {
        key: item.key,
        role: 'system',
        content: (
          <AskUserQuestionCard
            input={item.input}
            mode='historical'
            answeredValues={answered?.values}
          />
        ),
      }
    }
    case 'tool_use': {
      if (ctx) {
        const isPendingPerm = ctx.pendingToolPermissionToolUseId === item.toolUseId
        const answeredPerm = ctx.answeredToolPermissions?.[item.toolUseId]
        if (isPendingPerm || answeredPerm) {
          return {
            key: item.key,
            role: 'system',
            content: (
              <ToolPermissionCard
                toolName={item.toolName}
                input={item.input}
                mode={isPendingPerm ? 'active' : 'historical'}
                answered={answeredPerm}
                onAllow={() => ctx.onToolPermissionAllow?.(item.toolUseId)}
                onDeny={() => ctx.onToolPermissionDeny?.(item.toolUseId)}
              />
            ),
          }
        }
      }
      return {
        key: item.key,
        role: 'ai',
        content: renderToolUseDetails(
          item.toolName,
          item.input,
          item.result,
          sessionCompleted && item.toolName.includes('AgentComplete'),
        ),
      }
    }
    case 'turn_end': {
      return {
        key: item.key,
        role: 'divider',
        content: (
          <span className='text-[10px] text-[#6c7086]'>
            <CheckCircleOutlined className={item.isError ? 'text-[#f38ba8]' : 'text-[#a6e3a1]'} />
            <span className='ml-1'>{item.isError ? '执行出错' : '回合结束'}</span>
            {item.usage && (
              <span className='ml-2'>
                <TokenUsageBadge usage={item.usage} model={ctx?.model} cost={item.cost} />
              </span>
            )}
          </span>
        ),
      }
    }
    case 'agent_complete': {
      const completionText = [
        item.outputName ? `完成 → ${item.outputName}` : '完成',
        item.displayContent,
      ]
        .filter(Boolean)
        .join('\n')
      return {
        key: item.key,
        role: 'ai',
        content: (
          <Copyable text={completionText}>
            <div>
              <Tag color='green' className='m-0 text-[10px]'>
                完成{item.outputName ? ` → ${item.outputName}` : ''}
              </Tag>
              {item.displayContent && (
                <div className='mt-2'>
                  <Md content={item.displayContent} />
                </div>
              )}
            </div>
          </Copyable>
        ),
      }
    }
  }
}

export function toBubbleItems(
  sessionId: string,
  msgs: ExtensionToWebviewMessage[],
  ctx?: BubbleCtx,
  sessionCompleted = false,
): RenderedBubble[] {
  const renderItems = buildRenderItems(sessionId, msgs)
  const out: RenderedBubble[] = []
  for (const item of renderItems) {
    const bubble = renderItemToBubble(item, ctx, sessionCompleted)
    if (bubble) out.push(bubble)
  }
  return out
}

export { clearBuildCache, clearBuildCacheForSessions }

/**
 * 保留单气泡渲染入口（可用于调试或非列表场景）。
 * 列表场景请直接使用 Bubble.List + toBubbleItems。
 */
const MessageBubbleInner: FC<Props> = ({ msg }) => {
  const items = toBubbleItems('__debug__', [msg])
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
