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
        const { flowId, runKey, agentId, flow, initMessage, forkFrom } =
          data as ExtensionFlowCommandEvents['flow.command.flowStart'] & { flow: Flow }
        // 快照源 Flow 的 shareValues（若 forkFrom 指定）。必须在 disposeRunner 之前读取——
        // 自 fork 的源与新 Flow 的 flowId 本应不同，但兜底：不在自 fork 场景下读自己。
        let initialShareValues: Record<string, string> | undefined
        if (forkFrom && forkFrom.sourceFlowId !== flowId) {
          const source = this.runners.get(forkFrom.sourceFlowId)
          if (source) initialShareValues = source.getShareValues()
        }
        this.disposeRunner(flowId)
        const runner = new FlowRunner(flow, { initialShareValues })
        runner.listenAllSignals((type, data) => {
          this.postMessage({ type, data: { ...data, flowId } } as ExtensionToWebviewMessage)
        })
        this.runners.set(flowId, runner)
        runner.emit('flow.command.flowStart', { runKey, agentId, initMessage, forkFrom })
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
}
