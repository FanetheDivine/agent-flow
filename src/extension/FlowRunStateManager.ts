import { produce } from 'immer'
import type { ExtensionFlowSignalMessage, Flow } from '@/common'
import type { FlowRunState, NotifyEffect } from '@/common'
import { updateFlowRunState } from '@/common'

/**
 * extension 端镜像 webview 的 `flowRunStates`：把 webview 关闭时仍在运行的 flow 状态留在 extension 内。
 *
 * 数据流：
 * - flow.command.flowStart 抵达时 → initFlowStart 初始化条目
 * - 任何 flow.signal.* 经 postMessage 出去前 → applySignal 走一遍 common 的 updateFlowRunState reducer
 * - 工作流 load/save 触发 flows 变更 → applyFlows 清理已删除 flow 的 state（caller 负责 kill runner）
 */
export class FlowRunStateManager {
  private flowRunStates: Record<string, FlowRunState> = {}
  private flows: Flow[] = []
  private onNotifyUser?: (effect: NotifyEffect) => void

  setNotifyHandler(handler: (effect: NotifyEffect) => void): void {
    this.onNotifyUser = handler
  }

  /** 当前所有 flow 的运行态快照 */
  getFlowRunStates(): Record<string, FlowRunState> {
    return this.flowRunStates
  }

  /** 处理 flow.command.flowStart：初始化运行态条目 */
  initFlowStart(flowId: string, runKey: string): void {
    this.flowRunStates = produce(this.flowRunStates, (draft) => {
      draft[flowId] = {
        runKey,
        phase: 'starting',
        sessions: [],
        answeredQuestions: {},
        answeredToolPermissions: {},
      }
    })
  }

  /** 应用一条 flow.signal.* 消息 */
  applySignal(msg: ExtensionFlowSignalMessage): void {
    const flowId = msg.data.flowId

    // focusFlow 不参与状态机，但需要转发通知
    if (msg.type === 'flow.signal.focusFlow') return

    const existing = this.flowRunStates[flowId]
    if (!existing) return

    const { state, notifications } = updateFlowRunState(existing, msg, { flows: this.flows })
    this.flowRunStates = produce(this.flowRunStates, (draft) => {
      draft[flowId] = state
    })

    // extension 端自行处理通知（VSCode notification）
    for (const effect of notifications) {
      this.onNotifyUser?.(effect)
    }
  }

  /**
   * 同步最新 flows 列表，并清理被删除 flow 对应的运行态。
   * 对每个被删除的 flowId 先回调 onRemove（caller 在此 kill runner），再删 state。
   */
  applyFlows(newFlows: Flow[], onRemove: (flowId: string) => void): void {
    const validIds = new Set(newFlows.map((f) => f.id))
    const removedIds = Object.keys(this.flowRunStates).filter((id) => !validIds.has(id))
    for (const flowId of removedIds) {
      onRemove(flowId)
    }
    if (removedIds.length > 0) {
      this.flowRunStates = produce(this.flowRunStates, (draft) => {
        for (const flowId of removedIds) delete draft[flowId]
      })
    }
    this.flows = newFlows
  }
}
