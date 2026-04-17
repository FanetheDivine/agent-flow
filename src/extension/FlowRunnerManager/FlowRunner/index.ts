import { match } from 'ts-pattern'
import {
  type Agent,
  type FlowRunnerCommandEvents,
  type Flow,
  type RunState,
  type FlowRunnerSignalEvents,
} from '@/common'
import { ClaudeExecutor, type ExecutorResult } from './ClaudeExecutor'

type SignalHandler<K extends keyof FlowRunnerSignalEvents> = (
  data: FlowRunnerSignalEvents[K],
) => void

type WildcardSignalHandler = (
  event: keyof FlowRunnerSignalEvents,
  data: FlowRunnerSignalEvents[keyof FlowRunnerSignalEvents],
) => void

export class FlowRunner {
  readonly flow: Flow

  private runState: RunState = { steps: [], shareValues: {} }
  private currentExecutor: ClaudeExecutor | null = null
  private currentRunId: string | null = null
  private currentSessionId: string | null = null
  private currentAgentId: string | null = null
  private signalListeners = new Map<keyof FlowRunnerSignalEvents, Set<SignalHandler<any>>>()
  private wildcardListeners = new Set<WildcardSignalHandler>()

  constructor(flow: Flow) {
    this.flow = flow
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
      .exhaustive()
  }

  /** 销毁 FlowRunner，终止当前执行 */
  dispose(): void {
    this.killCurrentExecutor()
    this.signalListeners.clear()
    this.wildcardListeners.clear()
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
          console.error(`[FlowRunner] signal handler error (${event}):`, err)
        }
      }
    }
    for (const handler of this.wildcardListeners) {
      try {
        handler(event, data)
      } catch (err) {
        console.error(`[FlowRunner] wildcard signal handler error (${event}):`, err)
      }
    }
  }

  // ── command 处理 ────────────────────────────────────────────────────────

  private handleFlowStart({
    runKey,
    agentId,
  }: FlowRunnerCommandEvents['flow.command.flowStart']): void {
    // 中断当前运行
    this.killCurrentExecutor()

    // 校验 agent 存在且为 entry
    const agent = this.findAgentById(agentId)
    if (!agent) {
      this.fire('flow.signal.error', { msg: `Agent "${agentId}" not found in flow` })
      return
    }

    // 重置运行状态
    this.runState = { steps: [], shareValues: {} }
    this.currentRunId = crypto.randomUUID()

    // 启动 agent（sessionId 由 executor 从 SDK 获取后回调）
    const runId = this.currentRunId!
    this.runAgent(agent, (sessionId) => {
      this.fire('flow.signal.flowStart', {
        runId,
        runKey,
        sessionId,
        agentId: agent.id,
      })
    })
  }

  private handleUserMessage({
    runId,
    sessionId,
    message,
  }: FlowRunnerCommandEvents['flow.command.userMessage']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return

    // 直接转发完整 UserMessageType 给 executor
    this.currentExecutor.sendUserMessage(message)

    // 回显
    this.fire('flow.signal.userMessage', { runId, sessionId, message })
  }

  private async handleInterrupt({
    runId,
    sessionId,
  }: FlowRunnerCommandEvents['flow.command.interrupt']) {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return

    // 调用 executor 的 interrupt，内部处理中断+后续 resume 逻辑
    await this.currentExecutor.interrupt()
    this.updateAgentStatus('ready')
    this.fire('flow.signal.agentInterrupted', {
      runId: this.currentRunId!,
      sessionId: this.currentSessionId!,
    })
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private runAgent(agent: Agent, onSessionId: (sessionId: string) => void): void {
    this.currentAgentId = agent.id
    this.updateAgentStatus('preparing')

    const runId = this.currentRunId!

    // 初始化当前 step
    this.runState.steps.push({
      agentName: agent.agent_name,
      messages: [],
    })

    this.updateAgentStatus('generating')

    this.currentExecutor = new ClaudeExecutor(agent, this.runState.shareValues, {
      onSessionId,
      onMessage: (message) => {
        const sessionId = this.currentSessionId
        if (!sessionId) return
        this.fire('flow.signal.aiMessage', { runId, sessionId, message })
      },
      onComplete: (result) => {
        this.onAgentComplete(agent, result)
      },
      onError: (err) => {
        this.fire('flow.signal.agentError', { runId, agentId: agent.id, err })
        this.updateAgentStatus('completed')
      },
    })
  }

  private onAgentComplete(agent: Agent, result: ExecutorResult): void {
    const runId = this.currentRunId!
    const sessionId = this.currentSessionId!

    // 记录 step output
    const currentStep = this.runState.steps[this.runState.steps.length - 1]
    if (currentStep && result.outputName) {
      currentStep.output = {
        output_name: result.outputName,
        content: result.content,
      }
    }

    // 查找下一个 agent
    const selectedOutput = (agent.outputs ?? []).find((o) => o.output_name === result.outputName)
    const nextAgentId = selectedOutput?.next_agent

    if (nextAgentId) {
      const nextAgent = this.findAgentById(nextAgentId)
      if (!nextAgent) {
        this.fire('flow.signal.error', { msg: `Next agent "${nextAgentId}" not found` })
        this.updateAgentStatus('completed')
        return
      }

      // 切换到下一个 agent
      this.runAgent(nextAgent, (newSessionId) => {
        this.currentSessionId = newSessionId
        this.fire('flow.signal.agentComplete', {
          runId,
          sessionId,
          content: result.content,
          output: { name: result.outputName!, newSessionId },
        })
      })
    } else {
      // Flow 结束
      this.fire('flow.signal.agentComplete', { runId, sessionId, content: result.content })
      this.updateAgentStatus('completed')
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────────────────

  private findAgentById(id: string): Agent | undefined {
    return (this.flow.agents ?? []).find((a) => a.id === id)
  }

  private checkSession(runId: string, sessionId: string): boolean {
    if (runId !== this.currentRunId || sessionId !== this.currentSessionId) {
      return false
    }
    return true
  }

  private killCurrentExecutor(): void {
    if (this.currentExecutor) {
      this.currentExecutor.kill()
      this.currentExecutor = null
    }
  }

  private updateAgentStatus(status: NonNullable<RunState['currentAgent']>['status']): void {
    if (this.currentAgentId) {
      this.runState.currentAgent = { id: this.currentAgentId, status }
    }
  }
}
