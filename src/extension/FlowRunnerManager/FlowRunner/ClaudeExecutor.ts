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
  shareValues?: Record<string, string>
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
  readonly runId: string
  readonly agentId: string

  private readonly agent: Agent
  private readonly prompt: string
  private mcpServer: ReturnType<typeof buildAgentMcpServer> | null = null
  private readonly userInputStream: ReturnType<typeof createMessageChannel<SDKUserMessage>>

  private queryInstance: Query | null = null
  private completed = false
  private disposed = false
  /**
   * MCP 端 AgentComplete 工具触发后暂存 result，等本回合的 SDK result 消息到达再
   * fire onComplete。否则上层立即 killCurrentExecutor，最后一条 result（含
   * modelUsage / total_cost_usd）会被吞掉。
   */
  private pendingCompleteResult: ExecutorResult | null = null

  private _sessionId: string | null = null
  private events: ExecutorEvents

  /** SDK 在首条消息中分配的会话 ID；`null` 表示尚未建立会话 */
  get sessionId(): string | null {
    return this._sessionId
  }

  /** 比对外部携带的 (runId, sessionId) 是否绑定到当前 executor */
  matches(runId: string, sessionId: string): boolean {
    return runId === this.runId && sessionId === this._sessionId
  }

  /** 挂起中的 AskUserQuestion 权限请求：toolUseId -> resolver */
  private pendingPermissions = new Map<string, (result: PermissionResult) => void>()

  /** 挂起中的工具权限请求：toolUseId -> { resolver, input } */
  private pendingToolPermissions = new Map<
    string,
    { resolve: (result: PermissionResult) => void; input: Record<string, unknown> }
  >()

  /**
   * @param runId - FlowRunner 分配的本次运行 ID,贯穿整个 Flow 直到结束
   * @param agent - Agent 定义(model、outputs、prompt 等)
   * @param currentShareValues - Flow 全局共享上下文(仅用于注入系统提示词)
   * @param previousOutput - 上一个 Agent 的输出,用于注入 prompt 上下文
   */
  constructor(
    runId: string,
    initMessage: UserMessageType,
    agent: Agent,
    currentShareValues: Record<string, string>,
    events: ExecutorEvents,
  ) {
    this.runId = runId
    this.agentId = agent.id
    this.agent = agent
    this.events = events
    this.userInputStream = createMessageChannel<SDKUserMessage>()
    // shareValues是写在系统提示词里的 不能即时读写 可以直接构造
    this.prompt = buildAgentSystemPrompt(agent, currentShareValues)
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
    // 中断时丢弃尚未通知上层的 AgentComplete pending —— 用户主动打断意味着
    // 不要继续切到下一个 agent / 完成 flow。
    this.pendingCompleteResult = null
    this.rejectAllPendingPermissions('interrupted')
    await this.queryInstance.interrupt()
    // 关闭进程
    this.queryInstance.close()
    this.queryInstance = null
  }

  /** 终止执行，销毁 executor */
  kill(): void {
    this.disposed = true
    this.pendingCompleteResult = null
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
      onComplete: (result) => {
        // AgentComplete 触发后不立即通知上层。等 SDK 的 result 消息到达后再 fire，
        // 否则上层会立刻 killCurrentExecutor，把后续的 result（含 modelUsage /
        // total_cost_usd）切掉，token 统计就丢了。
        if (this.completed || this.disposed) return
        if (this.pendingCompleteResult) return
        this.pendingCompleteResult = result
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
    if (this._sessionId) {
      options.resume = this._sessionId
    }
    try {
      this.queryInstance = query({
        prompt: this.userInputStream.iterable,
        options,
      })
      this.userInputStream.push(message)
      for await (const msg of this.queryInstance) {
        if (this.disposed) break
        if (!this._sessionId) {
          if (!msg.session_id) {
            this.events.onError(new Error(JSON.stringify(msg)))
            break
          }
          this._sessionId = msg.session_id
          this.events.onSessionId(msg.session_id)
          this.events.onMessage(message)
        }
        this.events?.onMessage(msg)
        // result 是本回合最后一条消息（带 modelUsage / total_cost_usd）。如果
        // 之前 AgentComplete 触发过 onComplete 暂存 pending，此刻才把它通知
        // 给上层，让 token 信息进入 webview 后再切换/结束。
        if (msg.type === 'result' && this.pendingCompleteResult && !this.completed) {
          const pending = this.pendingCompleteResult
          this.pendingCompleteResult = null
          this.events.onComplete(pending)
          this.completed = true
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
