import { match } from 'ts-pattern'
import type { Flow, ExtensionFlowCommandEvents, ExtensionToWebviewMessage } from '@/common'
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
        const { flowId, runKey, agentId, flow, initMessage } =
          data as ExtensionFlowCommandEvents['flow.command.flowStart'] & { flow: Flow }
        this.disposeRunner(flowId)
        const runner = new FlowRunner(flow)
        runner.listenAllSignals((eventType, signalData) => {
          this.postMessage({
            type: eventType,
            data: { ...signalData, flowId },
          } as ExtensionToWebviewMessage)
        })
        this.runners.set(flowId, runner)
        runner.emit('flow.command.flowStart', { runKey, agentId, initMessage })
      })
      .with('flow.command.userMessage', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.userMessage']
        this.runners.get(flowId)?.emit('flow.command.userMessage', rest)
      })
      .with('flow.command.interrupt', () => {
        const { flowId, ...rest } = data as ExtensionFlowCommandEvents['flow.command.interrupt']
        this.runners.get(flowId)?.emit('flow.command.interrupt', rest)
      })
      .with('flow.command.answerQuestion', () => {
        const { flowId, ...rest } =
          data as ExtensionFlowCommandEvents['flow.command.answerQuestion']
        this.runners.get(flowId)?.emit('flow.command.answerQuestion', rest)
      })
      .with('flow.command.toolPermissionResult', () => {
        const { flowId, ...rest } =
          data as ExtensionFlowCommandEvents['flow.command.toolPermissionResult']
        this.runners.get(flowId)?.emit('flow.command.toolPermissionResult', rest)
      })
      .with('killFlow', () => {
        const { flowId } = data as ExtensionFlowCommandEvents['flow.command.killFlow'] & {
          flowId: string
        }
        this.disposeRunner(flowId)
      })
      .otherwise(() => {})
  }

  disposeAll(): void {
    for (const runner of this.runners.values()) {
      runner.dispose()
    }
    this.runners.clear()
  }

  disposeRunner(flowId: string): void {
    const existing = this.runners.get(flowId)
    if (existing) {
      existing.dispose()
      this.runners.delete(flowId)
    }
  }
}
