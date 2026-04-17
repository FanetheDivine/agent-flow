import { match } from 'ts-pattern'
import type {
  Flow,
  ExtensionFlowCommandEvents,
  FlowRunnerSignalEvents,
  ExtensionToWebviewMessage,
} from '@/common'
import { FlowRunner } from './FlowRunner'

type PostMessage = (msg: ExtensionToWebviewMessage) => void

export class FlowRunnerManager {
  private runners = new Map<string, FlowRunner>()
  private postMessage: PostMessage

  constructor(postMessage: PostMessage) {
    this.postMessage = postMessage
  }

  handleCommand(type: string, data: any): void {
    match(type)
      .with('flow.command.flowStart', () => {
        const { flowId, runKey, agentId, flow } =
          data as ExtensionFlowCommandEvents['flow.command.flowStart'] & { flow: Flow }
        this.disposeRunner(flowId)
        const runner = new FlowRunner(flow)
        this.registerSignals(flowId, runner)
        this.runners.set(flowId, runner)
        runner.emit('flow.command.flowStart', { runKey, agentId })
      })
      .with('flow.command.userMessage', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.userMessage']
        this.runners.get(flowId)?.emit('flow.command.userMessage', rest)
      })
      .with('flow.command.interrupt', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.interrupt']
        this.runners.get(flowId)?.emit('flow.command.interrupt', rest)
      })
      .otherwise(() => {})
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose()
    }
    this.runners.clear()
  }

  private disposeRunner(flowId: string): void {
    const existing = this.runners.get(flowId)
    if (existing) {
      existing.dispose()
      this.runners.delete(flowId)
    }
  }

  private registerSignals(flowId: string, runner: FlowRunner): void {
    const signalTypes: (keyof FlowRunnerSignalEvents)[] = [
      'flow.signal.flowStart',
      'flow.signal.aiMessage',
      'flow.signal.userMessage',
      'flow.signal.agentComplete',
      'flow.signal.agentInterrupted',
      'flow.signal.agentError',
      'flow.signal.error',
    ]

    for (const type of signalTypes) {
      runner.on(type, (data: any) => {
        this.postMessage({ type, data: { ...data, flowId } } as ExtensionToWebviewMessage)
      })
    }
  }
}
