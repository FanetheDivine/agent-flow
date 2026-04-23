import { query, type Query, Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import * as vscode from 'vscode'
import { Agent, AIMessageType, buildAgentSystemPrompt, UserMessageType } from '@/common'
import { buildAgentMcpServer } from '@/common/extension'

export type ExecutorResult = {
  outputName?: string
  content: string
}

export type ExecutorEvents = {
  /** 首次获取到 SDK session_id 时触发，保证先于任何 onMessage */
  onSessionId: (sessionId: string) => void
  /** SDK 原始消息透传，不做拆解或缩减 */
  onMessage: (message: AIMessageType) => void
  /** Agent 完成，选择了输出分支 */
  onComplete: (result: ExecutorResult) => void
  /** 错误 */
  onError: (err: Error) => void
}

/**
 * Claude SDK 中间层
 *
 * 职责：
 * - 使用完整的 SDK 类型（AIMessageType / UserMessageType）进行交互
 * - 隐藏内部实现细节（中断后重新 query 等）
 * - 在首次获取到 session_id 后通知外部，然后才转发 AI 消息
 */
export class ClaudeExecutor {
  private readonly agent: Agent
  private readonly prompt: string
  private readonly mcpServer: ReturnType<typeof buildAgentMcpServer>
  private readonly userInputStream: ReturnType<typeof createMessageChannel<SDKUserMessage>>

  private queryInstance: Query | null = null
  private completed = false
  private disposed = false

  private sessionId: string | null = null
  private events: ExecutorEvents

  /**
   * @param agent - Agent 定义（model、outputs、prompt 等）
   * @param shareValues - Flow 全局共享上下文（引用传递，MCP 工具直接读写）
   * @param previousOutput - 上一个 Agent 的输出，用于注入 prompt 上下文
   */
  constructor(
    initMessage: UserMessageType,
    agent: Agent,
    shareValues: Record<string, string>,
    events: ExecutorEvents,
  ) {
    this.agent = agent
    this.events = events
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    this.prompt = buildAgentSystemPrompt(agent)
    this.mcpServer = buildAgentMcpServer({ agent, shareValues, onComplete: events.onComplete })
    this.createQuery(initMessage)
  }

  /** 转发用户消息 */
  async sendUserMessage(message: SDKUserMessage) {
    if (this.disposed || this.completed) return
    if (this.queryInstance) {
      // 当前 query 仍在运行（如等待 AskUserQuestion 的 tool_result），直接推入流
      this.userInputStream.push(message)
    } else {
      // query 已结束（中断/完成），创建新 query 并 resume
      this.createQuery(message)
    }
  }

  /**
   * 中断当前生成
   *
   * 内部处理：中断当前 query 但保留 session_id，
   * 后续 sendUserMessage 时自动通过 resume 恢复会话。
   * 对外部来说这些细节不可见。
   */
  async interrupt() {
    if (!this.queryInstance) return
    await this.queryInstance.interrupt()
    this.queryInstance = null
  }

  /** 终止执行，销毁 executor */
  kill(): void {
    this.disposed = true
    this.abortCurrentQuery()
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private async createQuery(message: UserMessageType) {
    const options: Options = {
      maxTurns: 100,
      model: this.agent.model,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.prompt },
      mcpServers: { AgentControllerMcp: this.mcpServer },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
    }
    if (this.sessionId) {
      options.resume = this.sessionId
    }
    this.queryInstance = query({
      prompt: this.userInputStream.iterable,
      options,
    })
    this.userInputStream.push(message)
    try {
      for await (const msg of this.queryInstance) {
        if (this.disposed) break
        if (!this.sessionId) {
          if (!msg.session_id) {
            this.events.onError(new Error(JSON.stringify(msg)))
            break
          }
          this.sessionId = msg.session_id
          this.events.onSessionId(msg.session_id)
          this.events.onMessage(message)
        }
        this.events?.onMessage(msg)
      }
    } finally {
      this.queryInstance = null
    }
  }

  private abortCurrentQuery(): void {
    this.queryInstance?.close()
    this.queryInstance = null
  }
}

/** 可由外部 push 数据的 AsyncIterable */
function createMessageChannel<T>() {
  const queue: T[] = []
  let resolve: (() => void) | null = null

  const push = (value: T) => {
    queue.push(value)
    resolve?.()
    resolve = null
  }

  const iterable: AsyncIterable<T> = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          while (queue.length === 0) {
            await new Promise<void>((r) => (resolve = r))
          }
          if (queue.length > 0) {
            return { value: queue.shift()!, done: false }
          }
          return { value: undefined as any, done: true }
        },
      }
    },
  }

  return { push, iterable }
}
