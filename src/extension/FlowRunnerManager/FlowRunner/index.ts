import { match } from 'ts-pattern'
import { z } from 'zod'
import {
  type Agent,
  type FlowRunnerCommandEvents,
  type Flow,
  type FlowRunnerSignalEvents,
  UserMessageType,
} from '@/common'
import { logError } from '../../logger'
import { ClaudeExecutor, type ExecutorResult } from './ClaudeExecutor'

const MessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  content: z.string(),
  timestamp: z.string(),
})

type Message = z.infer<typeof MessageSchema>

const StepSchema = z.object({
  agentName: z.string(),
  messages: z.array(MessageSchema),
  output: z
    .object({
      output_name: z.string().optional(),
      content: z.string(),
    })
    .optional(),
})

type Step = z.infer<typeof StepSchema>

const RunStateSchema = z.object({
  currentAgent: z
    .object({
      id: z.string(),
      status: z.enum(['preparing', 'ready', 'generating', 'completed']),
    })
    .optional(),
  steps: z.array(StepSchema),
  shareValues: z.record(z.string(), z.string()),
})

type RunState = z.infer<typeof RunStateSchema>

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
      .with('flow.command.answerQuestion', () => {
        this.handleAnswerQuestion(data as FlowRunnerCommandEvents['flow.command.answerQuestion'])
      })
      .with('flow.command.toolPermissionResult', () => {
        this.handleToolPermissionResult(
          data as FlowRunnerCommandEvents['flow.command.toolPermissionResult'],
        )
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
    runKey,
    agentId,
    initMessage,
  }: FlowRunnerCommandEvents['flow.command.flowStart']): void {
    // 中断当前运行
    this.killCurrentExecutor()

    // 校验 agent 存在
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
    this.runAgent(initMessage, agent, (sessionId) => {
      this.currentSessionId = sessionId
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
    this.fire('flow.signal.aiMessage', { runId, sessionId, message })
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

  private handleAnswerQuestion({
    runId,
    sessionId,
    toolUseId,
    output,
  }: FlowRunnerCommandEvents['flow.command.answerQuestion']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return
    this.currentExecutor.answerQuestion(toolUseId, output)
  }

  private handleToolPermissionResult({
    runId,
    sessionId,
    toolUseId,
    allow,
  }: FlowRunnerCommandEvents['flow.command.toolPermissionResult']): void {
    if (!this.checkSession(runId, sessionId)) return
    if (!this.currentExecutor) return
    this.currentExecutor.answerToolPermission(toolUseId, allow)
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private runAgent(
    initMessage: UserMessageType,
    agent: Agent,
    onSessionId: (sessionId: string) => void,
  ): void {
    this.currentAgentId = agent.id
    this.updateAgentStatus('preparing')

    const runId = this.currentRunId!

    // 初始化当前 step
    this.runState.steps.push({
      agentName: agent.agent_name,
      messages: [],
    })

    this.updateAgentStatus('generating')

    // 本次 executor 专属 session 快照，防止过渡期间被 this.currentSessionId 覆盖污染
    let executorSessionId: string | null = null

    this.currentExecutor = new ClaudeExecutor(initMessage, agent, this.runState.shareValues, {
      onSessionId: (sessionId) => {
        executorSessionId = sessionId
        onSessionId(sessionId)
      },
      onMessage: (message) => {
        if (!executorSessionId) return
        this.fire('flow.signal.aiMessage', { runId, sessionId: executorSessionId, message })
      },
      onComplete: (result) => {
        // 只接受当前 executor 的完成事件，防止旧 executor 残留回调污染过渡后的状态
        if (this.currentAgentId !== agent.id) return
        this.onAgentComplete(agent, result)
      },
      onToolPermissionRequest: ({ toolUseId, toolName, input }) => {
        if (!executorSessionId) return
        this.fire('flow.signal.toolPermissionRequest', {
          runId,
          sessionId: executorSessionId,
          toolUseId,
          toolName,
          input,
        })
      },
      onAwaitingUser: (reason) => {
        if (this.currentAgentId !== agent.id) return
        this.fire('flow.signal.notifyUser', {
          runId,
          agentId: agent.id,
          agentName: agent.agent_name,
          flowId: this.flow.id,
          flowName: this.flow.name,
          reason,
        })
      },
      onError: (err) => {
        logError(`[FlowRunner] agent ${agent.id} error:`, err)
        this.fire('flow.signal.agentError', { runId, agentId: agent.id, err })
        this.updateAgentStatus('completed')
      },
    })
  }

  private onAgentComplete(agent: Agent, result: ExecutorResult): void {
    const { outputName, content } = result
    const runId = this.currentRunId!
    const sessionId = this.currentSessionId!

    // 记录 step output
    const currentStep = this.runState.steps[this.runState.steps.length - 1]
    if (currentStep && outputName) {
      currentStep.output = {
        output_name: outputName,
        content,
      }
    }

    // 查找下一个 agent
    const selectedOutput = (agent.outputs ?? []).find((o) => o.output_name === outputName)
    const nextAgentId = selectedOutput?.next_agent

    if (nextAgentId) {
      const nextAgent = this.findAgentById(nextAgentId)
      if (!nextAgent) {
        this.fire('flow.signal.error', { msg: `Next agent "${nextAgentId}" not found` })
        this.updateAgentStatus('completed')
        return
      }

      // 终结旧 executor（query 仍可能在发送 AgentComplete 的 tool_result 尾音），
      // 必须 kill 后再建新 executor，否则旧消息会被错误地挂到新 session 上。
      this.killCurrentExecutor()
      // 过渡期间清空 currentSessionId：此时 webview 仍持有旧 sessionId，
      // 若保留旧值会让 checkSession 放行命令，导致把 interrupt/userMessage
      // 错误地派发给已经切到下一个 agent 的 currentExecutor。
      this.currentSessionId = null

      // 切换到下一个 agent
      this.runAgent(
        {
          type: 'user',
          message: {
            role: 'user',
            content,
          },
          parent_tool_use_id: null,
        },
        nextAgent,
        (newSessionId) => {
          this.currentSessionId = newSessionId
          this.fire('flow.signal.agentComplete', {
            runId,
            sessionId,
            content: result.content,
            output: { name: result.outputName!, newSessionId },
          })
        },
      )
    } else {
      // Flow 结束
      this.killCurrentExecutor()
      this.fire('flow.signal.agentComplete', { runId, sessionId, content: result.content })
      this.updateAgentStatus('completed')
      this.currentSessionId = null
      this.currentAgentId = null
      // Flow 完成通知
      this.fire('flow.signal.notifyUser', {
        runId,
        agentId: agent.id,
        agentName: agent.agent_name,
        flowId: this.flow.id,
        flowName: this.flow.name,
        reason: 'flow-completed',
      })
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
