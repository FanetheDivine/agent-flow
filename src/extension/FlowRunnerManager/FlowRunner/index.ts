import { match } from 'ts-pattern'
import {
  type Agent,
  type AIMessageType,
  type FlowRunnerCommandEvents,
  type Flow,
  type FlowRunnerSignalEvents,
  buildHostSystemPrompt,
  HOST_AGENT_ID,
  UserMessageType,
} from '@/common'
import { buildHostMcpServer, type RunAgentOutput } from '@/common/extension'
import { logError } from '../../logger'
import { ClaudeExecutor, type ExecutorResult } from './ClaudeExecutor'

type SignalHandler<K extends keyof FlowRunnerSignalEvents> = (
  data: FlowRunnerSignalEvents[K],
) => void

type WildcardSignalHandler = (
  event: keyof FlowRunnerSignalEvents,
  data: FlowRunnerSignalEvents[keyof FlowRunnerSignalEvents],
) => void

export type FlowRunnerOptions = {
  /**
   * 取当前 Flow 最新的 shareValues。
   * FlowRunner 不再自己维护 shareValues 副本：构造 ClaudeExecutor 注入 systemPrompt
   * 时调用此回调，由外部（reducer 镜像 FlowRunStateManager）作为唯一真相源。
   */
  getLatestShareValues: () => Record<string, string>
}

/**
 * 子 run 完成 / 错误时的 promise resolver,用于把 onAgentComplete / onError 与
 * host AI 调用 runAgent 工具的 await 串起来。
 */
type RunAgentHandler = {
  resolve: (output: RunAgentOutput) => void
  reject: (err: Error) => void
}

/**
 * 运行时容器:按 runId 持有 ClaudeExecutor。
 *
 * 支持多 executor 并发(host 模式下 host run + 多个子 run 并发);Map 寻址。
 *
 * 路由规则:所有 command 按 runId 在 Map 中寻址,Executor 自身不持有任何 run 路由信息。
 *
 * host 模式:
 * - flowStart 时 agentId === HOST_AGENT_ID,FlowRunner 创建 host executor
 *   (buildHostSystemPrompt + buildHostMcpServer,仅暴露 runAgent 工具)
 * - host AI 调用 runAgent → FlowRunner.runSubAgent 创建子 executor 并把对应
 *   resolve/reject 注册到 pendingRunAgentHandlers,等子 run agentComplete 时 resolve
 * - 子 run 走普通 buildAgentMcpServer + buildAgentSystemPrompt
 */
export class FlowRunner {
  readonly flow: Flow

  private executors = new Map<string, ClaudeExecutor>()
  private signalListeners = new Map<keyof FlowRunnerSignalEvents, Set<SignalHandler<any>>>()
  private wildcardListeners = new Set<WildcardSignalHandler>()
  private readonly getLatestShareValues: () => Record<string, string>
  /** runId → 该 run 当前 mode('manual' / 'host' parent / 'host' sub-run) */
  private runMode = new Map<string, 'manual' | 'host-parent' | 'host-sub'>()
  /** 子 run 完成 / 失败时 resolve / reject 对应 host AI 的 runAgent promise */
  private pendingRunAgentHandlers = new Map<string, RunAgentHandler>()
  /** 子 run → host run runId(用于 host run interrupt 时级联 kill 子 executor) */
  private subRunToHost = new Map<string, string>()

  constructor(flow: Flow, options: FlowRunnerOptions) {
    this.flow = flow
    this.getLatestShareValues = options.getLatestShareValues
  }

  /** 监听所有 signal 事件（通配） */
  listenAllSignals(handler: WildcardSignalHandler): void {
    this.wildcardListeners.add(handler)
  }

  /** 移除通配 signal 事件监听器 */
  removeAllSignalsListener(handler: WildcardSignalHandler): void {
    this.wildcardListeners.delete(handler)
  }

  /** 监听 Flow 发出的 signal 事件 */
  on<K extends keyof FlowRunnerSignalEvents>(event: K, handler: SignalHandler<K>): void {
    let set = this.signalListeners.get(event)
    if (!set) {
      set = new Set()
      this.signalListeners.set(event, set)
    }
    set.add(handler)
  }

  /** 移除 signal 事件监听器 */
  off<K extends keyof FlowRunnerSignalEvents>(event: K, handler: SignalHandler<K>): void {
    this.signalListeners.get(event)?.delete(handler)
  }

  /** 向 Flow 发送 command 指令 */
  emit<K extends keyof FlowRunnerCommandEvents>(event: K, data: FlowRunnerCommandEvents[K]): void {
    match(event as keyof FlowRunnerCommandEvents)
      .with('flow.command.flowStart', () => {
        this.handleFlowStart(data as FlowRunnerCommandEvents['flow.command.flowStart'])
      })
      .with('flow.command.userMessage', () => {
        this.handleUserMessage(data as FlowRunnerCommandEvents['flow.command.userMessage'])
      })
      .with('flow.command.interrupt', () => {
        this.handleInterrupt(data as FlowRunnerCommandEvents['flow.command.interrupt'])
      })
      .with('flow.command.answerQuestion', () => {
        this.handleAnswerQuestion(data as FlowRunnerCommandEvents['flow.command.answerQuestion'])
      })
      .with('flow.command.toolPermissionResult', () => {
        this.handleToolPermissionResult(
          data as FlowRunnerCommandEvents['flow.command.toolPermissionResult'],
        )
      })
      .with('flow.command.killFlow', () => {
        // killFlow 走 FlowRunnerManager.disposeRunner，不在此处处理
      })
      .with('flow.command.setShareValues', () => {
        // FlowRunner 不再维护 shareValues 副本：reducer（webview/FlowRunStateManager）
        // 是唯一真相源，构造 ClaudeExecutor 时通过 getLatestShareValues() 实时取。
      })
      .with('flow.command.fork', () => {
        // fork 由 extension 端 handleFork 直接处理，不进入 FlowRunner
      })
      .exhaustive()
  }

  /** 销毁 FlowRunner，终止全部 executor */
  dispose(): void {
    for (const [, executor] of this.executors) {
      executor.kill()
    }
    this.executors.clear()
    this.signalListeners.clear()
    this.wildcardListeners.clear()
    // 拒绝所有 pending runAgent 等待者:host run 销毁后子 Agent 调度无人接收
    for (const [, h] of this.pendingRunAgentHandlers) {
      try {
        h.reject(new Error('FlowRunner disposed'))
      } catch {
        // ignore
      }
    }
    this.pendingRunAgentHandlers.clear()
    this.runMode.clear()
    this.subRunToHost.clear()
  }

  /**
   * fork 路径专用:以 lazy 模式启动一个 ClaudeExecutor。runId 由 extension 端预先分配。
   * 不 fire flow.signal.flowStart(fork 由 extension 端用 flow.signal.fork 替代)。
   *
   * lazy 模式:executor 处于 lazy 态,构造时不 createQuery、不 push initMessage,
   * 等用户首次 sendUserMessage 触发 SDK 启动。fork 切片末端只可能是
   * user/text/thinking/turn_end —— SDK 不支持把 askUserQuestion 作为 fork 终点。
   *
   * `mode`:'manual' / 'host' —— 'host' 时 agentId 可能是 HOST_AGENT_ID(host run)
   * 或具体 sub-agent id(子 run);本方法只复用 host run 的 buildHostSystemPrompt 路径
   * 当 agentId === HOST_AGENT_ID 时;否则按普通 agent 处理。
   */
  spawnForFork(params: {
    runId: string
    agentId: string
    resumeSessionId: string
    mode: 'manual' | 'host'
  }): void {
    const { runId, agentId, resumeSessionId, mode } = params
    // 本期单 executor 约束:fork 时清掉所有现存 executor
    this.killAllExecutors()
    // dummy initMessage:fork 模式下不会被透传到上层、也不会作为 SDK prompt push,
    // 仅作为 ClaudeExecutor 接口占位。
    const dummyInit: UserMessageType = {
      type: 'user',
      message: { role: 'user', content: '' },
      parent_tool_use_id: null,
    }
    if (mode === 'host' && agentId === HOST_AGENT_ID) {
      // host run fork:用 host system prompt + host MCP(仅 runAgent)
      const events = this.buildExecutorEvents(runId, undefined, () => executor)
      const executor: ClaudeExecutor = new ClaudeExecutor(
        dummyInit,
        this.makeHostFakeAgent(),
        this.getLatestShareValues(),
        events,
        resumeSessionId,
        'lazy',
        {
          systemPromptOverride: buildHostSystemPrompt(this.flow),
          mcpServerFactory: () => buildHostMcpServer({ onRunAgent: this.makeRunAgentHandler(runId) }),
        },
      )
      this.executors.set(runId, executor)
      this.runMode.set(runId, 'host-parent')
      return
    }
    // 普通 fork(manual run / host 子 run)
    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }
    const events = this.buildExecutorEvents(runId, agent, () => executor)
    const executor: ClaudeExecutor = new ClaudeExecutor(
      dummyInit,
      agent,
      this.getLatestShareValues(),
      events,
      resumeSessionId,
      'lazy',
    )
    this.executors.set(runId, executor)
    this.runMode.set(runId, mode === 'host' ? 'host-sub' : 'manual')
  }

  // ── signal 发射 ─────────────────────────────────────────────────────────

  private fire<K extends keyof FlowRunnerSignalEvents>(
    event: K,
    data: FlowRunnerSignalEvents[K],
  ): void {
    const set = this.signalListeners.get(event)
    if (set) {
      for (const handler of set) {
        try {
          handler(data)
        } catch (err) {
          logError(`[FlowRunner] signal handler error (${event}):`, err)
        }
      }
    }
    for (const handler of this.wildcardListeners) {
      try {
        handler(event, data)
      } catch (err) {
        logError(`[FlowRunner] wildcard signal handler error (${event}):`, err)
      }
    }
  }

  // ── command 处理 ────────────────────────────────────────────────────────

  private handleFlowStart({
    runId,
    agentId,
    initMessage,
    mode,
  }: FlowRunnerCommandEvents['flow.command.flowStart']): void {
    // flowStart 是整个 Flow 的初始化 → 清掉一切现存 executor 并重置 host 状态
    this.killAllExecutors()
    this.runMode.clear()
    this.subRunToHost.clear()
    for (const [, h] of this.pendingRunAgentHandlers) {
      try {
        h.reject(new Error('flow restarted'))
      } catch {
        // ignore
      }
    }
    this.pendingRunAgentHandlers.clear()

    if (mode === 'host' && agentId === HOST_AGENT_ID) {
      this.startHostRun(runId, initMessage)
      return
    }

    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }

    const effectiveInitMessage = agent.no_input
      ? {
          type: 'user' as const,
          message: { role: 'user' as const, content: '开始' },
          parent_tool_use_id: null,
        }
      : initMessage
    this.runAgent(runId, effectiveInitMessage, agent, this.getLatestShareValues(), true)
    this.runMode.set(runId, 'manual')
  }

  private handleUserMessage({
    runId,
    message,
  }: FlowRunnerCommandEvents['flow.command.userMessage']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.sendUserMessage(message)
  }

  private async handleInterrupt({ runId }: FlowRunnerCommandEvents['flow.command.interrupt']) {
    const executor = this.executors.get(runId)
    if (!executor) return
    const role = this.runMode.get(runId)
    if (role === 'host-parent') {
      // host run interrupt:级联 kill 所有子 executor + reject pending runAgent handlers,
      // 然后 interrupt host executor 自身。
      this.cascadeKillSubExecutors('host run interrupted')
    }
    await executor.interrupt()
    this.fire('flow.signal.agentInterrupted', { runId })
  }

  private handleAnswerQuestion({
    runId,
    toolUseId,
    output,
  }: FlowRunnerCommandEvents['flow.command.answerQuestion']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.answerQuestion(toolUseId, output)
  }

  private handleToolPermissionResult({
    runId,
    toolUseId,
    allow,
  }: FlowRunnerCommandEvents['flow.command.toolPermissionResult']): void {
    const executor = this.executors.get(runId)
    if (!executor) return
    executor.answerToolPermission(toolUseId, allow)
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  /**
   * 启动 host run:用 host system prompt + 仅 runAgent MCP server。
   * host AI 视为 never_complete:不会调 AgentComplete,Flow 终止靠用户主动 killFlow。
   */
  private startHostRun(runId: string, initMessage: UserMessageType): void {
    const fakeHostAgent = this.makeHostFakeAgent()
    const events = this.buildExecutorEvents(runId, undefined, () => executor, true)
    const executor: ClaudeExecutor = new ClaudeExecutor(
      initMessage,
      fakeHostAgent,
      this.getLatestShareValues(),
      events,
      undefined,
      'eager',
      {
        systemPromptOverride: buildHostSystemPrompt(this.flow),
        mcpServerFactory: () => buildHostMcpServer({ onRunAgent: this.makeRunAgentHandler(runId) }),
      },
    )
    this.executors.set(runId, executor)
    this.runMode.set(runId, 'host-parent')
  }

  /**
   * 构造一个供 ClaudeExecutor 使用的"假 Agent"代表 host —— ClaudeExecutor 内部依赖
   * agent.model / agent.effort / agent.work_mode / agent.auto_allowed_tools 等字段。
   * host 视为 never_complete + auto_allowed_tools=true(host AI 调度子 Agent 时
   * runAgent / 其它工具均自动放行)。
   */
  private makeHostFakeAgent(): Agent {
    return {
      id: HOST_AGENT_ID,
      model: this.flow.host_model || 'sonnet',
      effort: this.flow.host_effort,
      work_mode: 'never_complete',
      agent_name: 'AI 托管',
      auto_allowed_tools: true,
    }
  }

  /**
   * 构造 host AI 的 runAgent 工具 handler。每次 host AI 调用 runAgent,
   * 创建子 ClaudeExecutor + 注册 pending handler,等子 run agentComplete / agentError
   * 时 resolve / reject 这个 promise。
   *
   * 限制:无法从 SDK callTool 入参拿到本次 mcp_tool_use 的 toolUseId,所以采用
   * "队列法":在 onMessage 透传过程中扫描 host run.transcript 的 mcp_tool_use(name='runAgent'),
   * 把 toolUseId 入队;handler 执行时按 FIFO 出队。SDK 保证同一 host run
   * 内 mcp_tool_use 与 handler 的 invocation 一一对应,顺序一致。
   */
  private makeRunAgentHandler(hostRunId: string) {
    return async (input: { id: string; message?: string; values?: Record<string, string> }): Promise<RunAgentOutput> => {
      const targetAgentId = input.id
      const subAgent = this.findAgentById(targetAgentId)
      if (!subAgent) {
        throw new Error(
          `runAgent: Agent id "${targetAgentId}" not found in flow. Use the exact id from the agents list.`,
        )
      }
      // 等待对应 mcp_tool_use 抵达 onMessage 流,从队列取出 toolUseId
      const toolUseId = await this.consumePendingRunAgentToolUseId(hostRunId)
      const subRunId = globalThis.crypto.randomUUID()
      // 通知 reducer 创建子 AgentRun(parentToolUseId 用于 webview 端反查跳转)
      this.fire('flow.signal.subAgentStarted', {
        runId: hostRunId,
        subRunId,
        subAgentId: targetAgentId,
        parentToolUseId: toolUseId,
      })
      // 注册 promise:子 run agentComplete 时 resolve;agentError / killFlow 时 reject
      const promise = new Promise<RunAgentOutput>((resolve, reject) => {
        this.pendingRunAgentHandlers.set(subRunId, { resolve, reject })
      })
      this.subRunToHost.set(subRunId, hostRunId)
      // values 合并:host AI 提供的 values + 当前 shareValues 快照(host AI 提供的优先)
      const baseValues = { ...this.getLatestShareValues(), ...(input.values ?? {}) }
      // 子 run initMessage:no_input 的 Agent 强制 '开始',否则用 host 提供的 message(空也允许)
      const subInitMessage: UserMessageType = {
        type: 'user',
        message: {
          role: 'user',
          content: subAgent.no_input ? '开始' : (input.message ?? '开始'),
        },
        parent_tool_use_id: null,
      }
      this.runAgent(subRunId, subInitMessage, subAgent, baseValues, false)
      this.runMode.set(subRunId, 'host-sub')
      return promise
    }
  }

  /** runAgent toolUseId 队列(按 host runId 维护) */
  private pendingRunAgentToolUseIdQueue = new Map<string, string[]>()
  /** 等待 mcp_tool_use 到来的 resolver(host AI 调用 runAgent 后,onMessage 还没流到时的等待) */
  private pendingRunAgentToolUseIdResolvers = new Map<string, Array<(id: string) => void>>()

  /**
   * host AI 的 runAgent handler 调用此方法等取本次 invocation 对应的 toolUseId。
   * 优先从队列出栈;若队列空,挂起等下一个 mcp_tool_use(host run onMessage 流推进时入队)。
   */
  private consumePendingRunAgentToolUseId(hostRunId: string): Promise<string> {
    const q = this.pendingRunAgentToolUseIdQueue.get(hostRunId) ?? []
    if (q.length > 0) {
      const id = q.shift()!
      if (q.length === 0) this.pendingRunAgentToolUseIdQueue.delete(hostRunId)
      else this.pendingRunAgentToolUseIdQueue.set(hostRunId, q)
      return Promise.resolve(id)
    }
    return new Promise<string>((resolve) => {
      const list = this.pendingRunAgentToolUseIdResolvers.get(hostRunId) ?? []
      list.push(resolve)
      this.pendingRunAgentToolUseIdResolvers.set(hostRunId, list)
    })
  }

  /** onMessage 路径调用:host run 中扫到 runAgent mcp_tool_use 时入队 */
  private enqueueRunAgentToolUseId(hostRunId: string, toolUseId: string): void {
    const resolvers = this.pendingRunAgentToolUseIdResolvers.get(hostRunId)
    if (resolvers && resolvers.length > 0) {
      const r = resolvers.shift()!
      if (resolvers.length === 0) this.pendingRunAgentToolUseIdResolvers.delete(hostRunId)
      r(toolUseId)
      return
    }
    const q = this.pendingRunAgentToolUseIdQueue.get(hostRunId) ?? []
    q.push(toolUseId)
    this.pendingRunAgentToolUseIdQueue.set(hostRunId, q)
  }

  /** 从 SDK assistant 消息中扫描 runAgent mcp_tool_use 并入队 */
  private scanHostMessageForRunAgent(hostRunId: string, message: AIMessageType): void {
    if ((message as any).type !== 'assistant') return
    const blocks = (message as any).message?.content
    if (!Array.isArray(blocks)) return
    for (const block of blocks) {
      if (!block || typeof block !== 'object') continue
      const isMcpToolUse =
        block.type === 'mcp_tool_use' &&
        (block as any).server_name === 'AgentControllerMcp' &&
        block.name === 'runAgent'
      const isToolUseRunAgent =
        block.type === 'tool_use' && block.name === 'mcp__AgentControllerMcp__runAgent'
      if (isMcpToolUse || isToolUseRunAgent) {
        this.enqueueRunAgentToolUseId(hostRunId, block.id)
      }
    }
  }

  /**
   * 启动一个 Agent run:创建 ClaudeExecutor 并写入 executors Map。
   * @param fireFlowStartSignal - 是否在首条 SDK 消息抵达时 fire flow.signal.flowStart
   *   (eager 路径需要;fork 路径由外层 spawnForFork 走 signal.fork 替代,故为 false)
   */
  private runAgent(
    runId: string,
    initMessage: UserMessageType,
    agent: Agent,
    currentValues: Record<string, string>,
    fireFlowStartSignal: boolean,
  ): void {
    const events = this.buildExecutorEvents(runId, agent, () => executor, fireFlowStartSignal)
    const executor: ClaudeExecutor = new ClaudeExecutor(initMessage, agent, currentValues, events)
    this.executors.set(runId, executor)
  }

  /**
   * host run interrupt / killFlow 时:reject 所有 pending runAgent handler + kill 全部子 executor。
   */
  private cascadeKillSubExecutors(reason: string): void {
    for (const subRunId of [...this.subRunToHost.keys()]) {
      const handler = this.pendingRunAgentHandlers.get(subRunId)
      if (handler) {
        try {
          handler.reject(new Error(reason))
        } catch {
          // ignore
        }
        this.pendingRunAgentHandlers.delete(subRunId)
      }
      const executor = this.executors.get(subRunId)
      if (executor) {
        executor.kill()
        this.executors.delete(subRunId)
      }
      this.runMode.delete(subRunId)
      this.subRunToHost.delete(subRunId)
      // 子 run 直接 kill,reducer 端将通过 agentInterrupted 推断为 stopped
      this.fire('flow.signal.agentInterrupted', { runId: subRunId })
    }
  }

  /**
   * 构造 ClaudeExecutor 的事件回调 —— 上层路由(runId、kill)在此闭包注入。
   * `agent` 为 undefined 表示 host run(没有真实 agent 定义,签发 signal 时用 HOST_AGENT_ID)。
   */
  private buildExecutorEvents(
    runId: string,
    agent: Agent | undefined,
    getExecutor: () => ClaudeExecutor,
    fireFlowStartSignal: boolean = false,
  ) {
    const agentId = agent?.id ?? HOST_AGENT_ID
    return {
      onStarted: () => {
        if (fireFlowStartSignal) {
          this.fire('flow.signal.flowStart', { runId, agentId })
        }
      },
      onMessage: (message: AIMessageType) => {
        // host run:扫描 mcp_tool_use(name='runAgent') 入 toolUseId 队列,
        // 与 runAgent handler invocation 一一对应。子 run / manual run 不需要。
        if (this.runMode.get(runId) === 'host-parent') {
          this.scanHostMessageForRunAgent(runId, message)
        }
        this.fire('flow.signal.aiMessage', { runId, message })
      },
      onComplete: (result: ExecutorResult) => {
        // 只接受当前 Map 里仍然绑定的 executor 的完成事件;切换到下一个 agent 时
        // 旧 executor 已被 kill 并从 Map 中移除,onComplete 即使到达也丢弃。
        if (this.executors.get(runId) !== getExecutor()) return
        const role = this.runMode.get(runId)
        if (role === 'host-sub') {
          // 子 run AgentComplete:resolve host AI 的 runAgent promise + fire signal
          this.onHostSubAgentComplete(runId, result)
          return
        }
        // host-parent / manual:走原 onAgentComplete 路径
        if (agent) this.onAgentComplete(runId, agent, result)
      },
      onToolPermissionRequest: ({
        toolUseId,
        toolName,
        input,
      }: {
        toolUseId: string
        toolName: string
        input: unknown
      }) => {
        this.fire('flow.signal.toolPermissionRequest', {
          runId,
          toolUseId,
          toolName,
          input,
        })
      },
      onError: (err: Error) => {
        logError(`[FlowRunner] agent ${agentId} error:`, err)
        const role = this.runMode.get(runId)
        if (role === 'host-sub') {
          // 子 run 出错:reject 对应 runAgent handler,host AI 收到错误继续推理
          const handler = this.pendingRunAgentHandlers.get(runId)
          if (handler) {
            try {
              handler.reject(err)
            } catch {
              // ignore
            }
            this.pendingRunAgentHandlers.delete(runId)
          }
          this.subRunToHost.delete(runId)
        }
        this.fire('flow.signal.agentError', { runId, agentId, err })
      },
    }
  }

  /**
   * 子 run AgentComplete:resolve host AI 等待中的 runAgent promise + fire 子 run agentComplete signal。
   * 不追加 next_agent run(host 模式不走 outputs.next_agent)。
   */
  private onHostSubAgentComplete(subRunId: string, result: ExecutorResult): void {
    const handler = this.pendingRunAgentHandlers.get(subRunId)
    if (handler) {
      try {
        handler.resolve({
          content: result.content,
          ...(result.outputName ? { output_name: result.outputName } : {}),
          ...(result.values ? { values: result.values } : {}),
        })
      } catch (err) {
        logError('[FlowRunner] runAgent handler resolve error:', err)
      }
      this.pendingRunAgentHandlers.delete(subRunId)
    }
    this.killExecutor(subRunId)
    this.subRunToHost.delete(subRunId)
    this.runMode.delete(subRunId)
    this.fire('flow.signal.agentComplete', {
      runId: subRunId,
      content: result.content,
      values: result.values,
      result: result.resultMessage,
      // host 模式下子 run 不携带 newRunId(reducer 不再 push 新 run);保留 outputName 用于 UI 展示
      ...(result.outputName ? { output: { name: result.outputName } } : {}),
    })
  }

  private onAgentComplete(runId: string, agent: Agent, result: ExecutorResult): void {
    try {
      this.doOnAgentComplete(runId, agent, result)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      logError(`[FlowRunner] onAgentComplete failed (agent=${agent.id}):`, err)
      this.fire('flow.signal.error', { msg: `agent complete failed: ${msg}` })
      // 继续向上抛，让 MCP withErrorBoundary 也能把 isError 反馈给 AI
      throw err
    }
  }

  private doOnAgentComplete(runId: string, agent: Agent, result: ExecutorResult): void {
    const { outputName, content } = result

    // 查找下一个 agent
    const selectedOutput = (agent.outputs ?? []).find((o) => o.output_name === outputName)
    const nextAgentId = selectedOutput?.next_agent

    if (nextAgentId) {
      const nextAgent = this.findAgentById(nextAgentId)
      if (!nextAgent) {
        this.fire('flow.signal.error', { msg: `Next agent "${nextAgentId}" not found` })
        return
      }

      // 终结旧 executor(query 仍可能在发送 AgentComplete 的 tool_result 尾音)。
      // 必须 kill 后再建新 executor —— 旧消息不会被错误地挂到新 run 上。本期 runtime
      // 单 executor 约束,kill 旧 executor + Map.delete(oldRunId) + Map.set(newRunId,..)
      this.killExecutor(runId)
      // 切换到下一个 agent
      const nextInitMessage = {
        type: 'user' as const,
        message: { role: 'user' as const, content: nextAgent.no_input ? '开始' : content },
        parent_tool_use_id: null,
      }
      // 局部叠加:reducer 此刻尚未收到 agentComplete signal,getLatestShareValues 拿到
      // 的还是合并前的值,因此手动叠加 result.values 给 nextAgent 的 systemPrompt。
      // FlowRunner 自身不持有 shareValues 状态——这是临时计算,不是字段维护。
      const nextValues = result.values
        ? { ...this.getLatestShareValues(), ...result.values }
        : this.getLatestShareValues()
      // extension 端为下一个 agent 生成新 runId
      const newRunId = crypto.randomUUID()
      this.runAgent(newRunId, nextInitMessage, nextAgent, nextValues, false)
      this.runMode.set(newRunId, 'manual')
      this.fire('flow.signal.agentComplete', {
        runId,
        content,
        output: { name: result.outputName!, newRunId },
        values: result.values,
        result: result.resultMessage,
      })
    } else {
      // Flow 结束
      this.killExecutor(runId)
      this.fire('flow.signal.agentComplete', {
        runId,
        content: result.content,
        values: result.values,
        result: result.resultMessage,
      })
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────────────────

  private findAgentById(id: string): Agent | undefined {
    return (this.flow.agents ?? []).find((a) => a.id === id)
  }

  private killExecutor(runId: string): void {
    const executor = this.executors.get(runId)
    if (executor) {
      executor.kill()
      this.executors.delete(runId)
    }
    this.runMode.delete(runId)
    this.subRunToHost.delete(runId)
  }

  private killAllExecutors(): void {
    for (const [, executor] of this.executors) {
      executor.kill()
    }
    this.executors.clear()
  }
}
