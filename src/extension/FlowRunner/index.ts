import { match } from 'ts-pattern'
import {
  type Agent,
  type FlowCommandEvents,
  type Flow,
  type RunState,
  type FlowSignalEvents,
} from '@/common'
import { ClaudeExecutor, type ExecutorResult } from './ClaudeExecutor'

type SignalHandler<K extends keyof FlowSignalEvents> = (...args: FlowSignalEvents[K]) => void

export class FlowRunner {
  readonly flow: Flow

  private runState: RunState = { steps: [], shareValues: {} }
  private currentExecutor: ClaudeExecutor | null = null
  private currentId: string | null = null
  private currentSessionId: string | null = null
  private currentAgentName: string | null = null
  private signalListeners = new Map<keyof FlowSignalEvents, Set<SignalHandler<any>>>()

  constructor(flow: Flow) {
    this.flow = flow
  }

  /** 监听 Flow 发出的 signal 事件 */
  on<K extends keyof FlowSignalEvents>(event: K, handler: SignalHandler<K>): void {
    let set = this.signalListeners.get(event)
    if (!set) {
      set = new Set()
      this.signalListeners.set(event, set)
    }
    set.add(handler)
  }

  /** 移除 signal 事件监听器 */
  off<K extends keyof FlowSignalEvents>(event: K, handler: SignalHandler<K>): void {
    this.signalListeners.get(event)?.delete(handler)
  }

  /** 向 Flow 发送 command 指令 */
  emit<K extends keyof FlowCommandEvents>(event: K, ...args: FlowCommandEvents[K]): void {
    match(event as keyof FlowCommandEvents)
      .with('flow.command.flowStart', () => {
        this.handleFlowStart(...(args as FlowCommandEvents['flow.command.flowStart']))
      })
      .with('flow.command.userMessage', () => {
        this.handleUserMessage(...(args as FlowCommandEvents['flow.command.userMessage']))
      })
      .with('flow.command.interrupt', () => {
        this.handleInterrupt(...(args as FlowCommandEvents['flow.command.interrupt']))
      })
      .exhaustive()
  }

  /** 销毁 FlowRunner，终止当前执行 */
  dispose(): void {
    this.killCurrentExecutor()
    this.signalListeners.clear()
  }

  // ── signal 发射 ─────────────────────────────────────────────────────────

  private fire<K extends keyof FlowSignalEvents>(event: K, ...args: FlowSignalEvents[K]): void {
    const set = this.signalListeners.get(event)
    if (!set) return
    for (const handler of set) {
      try {
        handler(...args)
      } catch (err) {
        console.error(`[FlowRunner] signal handler error (${event}):`, err)
      }
    }
  }

  // ── command 处理 ────────────────────────────────────────────────────────

  private handleFlowStart(...[key, agentName]: FlowCommandEvents['flow.command.flowStart']): void {
    // 中断当前运行
    this.killCurrentExecutor()

    // 校验 agent 存在且为 entry
    const agent = this.findAgent(agentName)
    if (!agent) {
      this.fire('flow.signal.error', `Agent "${agentName}" not found in flow`)
      return
    }

    // 重置运行状态
    this.runState = { steps: [], shareValues: {} }
    this.currentId = crypto.randomUUID()

    // 启动 agent（session_id 由 executor 从 SDK 获取后回调）
    const id = this.currentId!
    this.runAgent(agent, (sessionId) => {
      this.fire('flow.signal.flowStart', id, key, sessionId, agent.agent_name)
    })
  }

  private handleUserMessage(
    ...[id, sessionId, message]: FlowCommandEvents['flow.command.userMessage']
  ): void {
    if (!this.checkSession(id, sessionId)) return
    if (!this.currentExecutor) return

    // 直接转发完整 UserMessageType 给 executor
    this.currentExecutor.sendUserMessage(message)

    // 回显
    this.fire('flow.signal.userMessage', id, sessionId, message)
  }

  private async handleInterrupt(...[id, sessionId]: FlowCommandEvents['flow.command.interrupt']) {
    if (!this.checkSession(id, sessionId)) return
    if (!this.currentExecutor) return

    // 调用 executor 的 interrupt，内部处理中断+后续 resume 逻辑
    await this.currentExecutor.interrupt()
    this.updateAgentStatus('ready')
    this.fire('flow.signal.agentInterruptted', this.currentId!, this.currentSessionId!)
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private runAgent(agent: Agent, onSessionId: (sessionId: string) => void): void {
    this.currentAgentName = agent.agent_name
    this.updateAgentStatus('preparing')

    const id = this.currentId!

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
        this.fire('flow.signal.aiMessage', id, sessionId, message)
      },
      onComplete: (result) => {
        this.onAgentComplete(agent, result)
      },
      onError: (err) => {
        this.fire('flow.signal.agentError', id, agent.agent_name, err)
        this.updateAgentStatus('completed')
      },
    })
  }

  private onAgentComplete(agent: Agent, result: ExecutorResult): void {
    const id = this.currentId!
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
    const nextAgentName = selectedOutput?.next_agent

    if (nextAgentName) {
      const nextAgent = this.findAgent(nextAgentName)
      if (!nextAgent) {
        this.fire('flow.signal.error', `Next agent "${nextAgentName}" not found`)
        this.updateAgentStatus('completed')
        return
      }

      // 切换到下一个 agent
      this.runAgent(nextAgent, (newSessionId) => {
        this.currentSessionId = newSessionId
        this.fire('flow.signal.agentComplete', id, sessionId, result.content, {
          name: result.outputName!,
          session_id: newSessionId,
        })
      })
    } else {
      // Flow 结束
      this.fire('flow.signal.agentComplete', id, sessionId, result.content, undefined)
      this.updateAgentStatus('completed')
    }
  }

  // ── 工具方法 ────────────────────────────────────────────────────────────

  private findAgent(name: string): Agent | undefined {
    return (this.flow.agents ?? []).find((a) => a.agent_name === name)
  }

  private checkSession(id: string, sessionId: string): boolean {
    if (id !== this.currentId || sessionId !== this.currentSessionId) {
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
    if (this.currentAgentName) {
      this.runState.currentAgent = { name: this.currentAgentName, status }
    }
  }
}
