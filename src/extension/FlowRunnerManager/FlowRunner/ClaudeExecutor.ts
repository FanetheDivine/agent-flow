import {
  query,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import * as vscode from 'vscode'
import {
  Agent,
  AIMessageType,
  AskUserQuestionOutput,
  buildAgentSystemPrompt,
  matchTool,
  UserMessageType,
} from '@/common'
import { buildAgentMcpServer } from '@/common/extension'
import { logError } from '../../logger'

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
  /** 工具调用命中 must_confirm 或兜底，等待用户确认 */
  onToolPermissionRequest: (req: { toolUseId: string; toolName: string; input: unknown }) => void
  /**
   * Agent 进入等待用户状态（非 interrupt 触发）：
   * - awaiting-question: 调用了 AskUserQuestion 工具
   * - awaiting-message: turn 结束（result 消息）但未 AgentComplete
   */
  onAwaitingUser: (reason: 'awaiting-question' | 'awaiting-message') => void
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
  private readonly shareValues: Record<string, string>
  private readonly prompt: string
  private mcpServer: ReturnType<typeof buildAgentMcpServer> | null = null
  private readonly userInputStream: ReturnType<typeof createMessageChannel<SDKUserMessage>>

  private queryInstance: Query | null = null
  private completed = false
  private disposed = false
  /** 标记当前 turn 是由中断结束的，跳过随之而来的 result 消息对 onAwaitingUser 的触发 */
  private interrupted = false

  private sessionId: string | null = null
  private events: ExecutorEvents

  /** 挂起中的 AskUserQuestion 权限请求：toolUseId -> resolver */
  private pendingPermissions = new Map<string, (result: PermissionResult) => void>()

  /** 挂起中的工具权限请求：toolUseId -> { resolver, input } */
  private pendingToolPermissions = new Map<
    string,
    { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()

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
    this.shareValues = shareValues
    this.events = events
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    this.prompt = buildAgentSystemPrompt(agent)
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
    this.interrupted = true
    this.rejectAllPendingPermissions('interrupted')
    await this.queryInstance.interrupt()
    this.queryInstance = null
  }

  /** 终止执行，销毁 executor */
  kill(): void {
    this.disposed = true
    this.rejectAllPendingPermissions('executor disposed')
    this.abortCurrentQuery()
    this.mcpServer?.instance.close().catch((err) => {
      logError('[ClaudeExecutor] mcp server close failed:', err)
    })
    this.mcpServer = null
  }

  /**
   * 回答当前挂起的 AskUserQuestion：resolve 对应的 canUseTool Promise，
   * SDK 随后用带 answers 的 updatedInput 执行工具并发出正规 tool_result。
   */
  answerQuestion(toolUseId: string, output: AskUserQuestionOutput): void {
    const resolver = this.pendingPermissions.get(toolUseId)
    if (!resolver) return
    this.pendingPermissions.delete(toolUseId)
    resolver({
      behavior: 'allow',
      updatedInput: {
        questions: output.questions,
        answers: output.answers,
        ...(output.annotations ? { annotations: output.annotations } : {}),
      },
    })
  }

  /**
   * 回答工具权限请求：allow 则原样放行 input；deny 则返回带 message 的拒绝结果，
   * SDK 会在本次工具调用处产生一条 is_error 的 tool_result。
   */
  answerToolPermission(toolUseId: string, allow: boolean): void {
    const pending = this.pendingToolPermissions.get(toolUseId)
    if (!pending) return
    this.pendingToolPermissions.delete(toolUseId)
    if (allow) {
      pending.resolve({ behavior: 'allow', updatedInput: pending.input })
    } else {
      pending.resolve({ behavior: 'deny', message: 'user denied' })
    }
  }

  private rejectAllPendingPermissions(reason: string): void {
    for (const [, resolver] of this.pendingPermissions) {
      resolver({ behavior: 'deny', message: reason })
    }
    this.pendingPermissions.clear()
    for (const [, pending] of this.pendingToolPermissions) {
      pending.resolve({ behavior: 'deny', message: reason })
    }
    this.pendingToolPermissions.clear()
  }

  private canUseTool: CanUseTool = (toolName, input, { toolUseID }) => {
    if (toolName === 'AskUserQuestion') {
      this.events.onAwaitingUser('awaiting-question')
      // 挂起，等待 answerQuestion() 被调用
      return new Promise<PermissionResult>((resolve) => {
        this.pendingPermissions.set(toolUseID, resolve)
      })
    }
    const { auto_allowed_tools, must_confirm_tools } = this.agent
    // 优先级 1：命中 must_confirm 列表，始终要求确认
    if (must_confirm_tools && matchTool(toolName, must_confirm_tools)) {
      return this.requestToolPermission(toolUseID, toolName, input)
    }
    // 优先级 2：auto_allowed 为 true 或命中数组，直接放行
    if (auto_allowed_tools === true) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    if (auto_allowed_tools && matchTool(toolName, auto_allowed_tools)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input })
    }
    // 兜底：未覆盖的工具默认要求用户确认
    return this.requestToolPermission(toolUseID, toolName, input)
  }

  private requestToolPermission(
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<PermissionResult> {
    return new Promise<PermissionResult>((resolve) => {
      this.pendingToolPermissions.set(toolUseId, { resolve, input })
      this.events.onToolPermissionRequest({ toolUseId, toolName, input })
    })
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private async createQuery(message: UserMessageType) {
    this.interrupted = false
    // 同一个 MCP Server 实例不能被 connect 两次（@modelcontextprotocol/sdk
    // Protocol.connect 在 _transport 已存在时直接 throw 'Already connected
    // to a transport'，SDK 把异常吞进 .catch 后只打日志，导致 system message
    // 中 MCP status=failed、AgentControllerMcp 工具集体失效）。
    // 所以每次 createQuery 都释放旧 server 并 build 新的。
    if (this.mcpServer) {
      try {
        await this.mcpServer.instance.close()
      } catch (err) {
        logError('[ClaudeExecutor] previous mcp server close failed:', err)
      }
    }
    this.mcpServer = buildAgentMcpServer({
      agent: this.agent,
      shareValues: this.shareValues,
      onComplete: (result) => {
        // 首次 AgentComplete 触发后置 completed，防止模型重复调用或
        // 旧 query 残存事件再次触发 onAgentComplete。
        // 注意顺序：先调 events.onComplete，成功后才设 completed —— 否则
        // 上层抛错时 completed 已为 true，AI 重试会被直接 return 静默吞掉。
        if (this.completed || this.disposed) return
        this.events.onComplete(result)
        this.completed = true
      },
    })
    const options: Options = {
      maxTurns: 1000,
      model: this.agent.model,
      effort: this.agent.effort,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: this.prompt },
      mcpServers: { AgentControllerMcp: this.mcpServer },
      permissionMode: 'default',
      canUseTool: this.canUseTool,
      cwd: vscode.workspace.workspaceFolders?.[0].uri.fsPath,
      includePartialMessages: true,
    }
    if (this.sessionId) {
      options.resume = this.sessionId
    }
    try {
      this.queryInstance = query({
        prompt: this.userInputStream.iterable,
        options,
      })
      this.userInputStream.push(message)
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
        // turn 结束且未完成、未中断 → 进入 awaiting-message
        if (msg.type === 'result' && !this.completed && !this.interrupted && !this.disposed) {
          this.events.onAwaitingUser('awaiting-message')
        }
      }
    } catch (err) {
      if (!this.disposed) {
        this.events.onError(err instanceof Error ? err : new Error(String(err)))
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
