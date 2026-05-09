import { produce } from 'immer'
import {
  type ExtensionFlowSignalMessage,
  type Flow,
  type FlowRunState,
  type FlowState,
  updateState,
} from '@/common'

/**
 * extension 端镜像 webview 的 `flowStates`：把 webview 关闭时仍在运行的 flow 状态留在 extension 内。
 *
 * 数据流：
 * - flow.command.flowStart 抵达时 → initFlowStart 初始化条目
 * - 任何 flow.signal.* 经 postMessage 出去前 → applySignal 走一遍 common 的 updateState reducer
 * - 工作流 load/save 触发 flows 变更 → applyFlows 清理已删除 flow 的 state（caller 负责 kill runner）
 */
export class FlowStateManager {
  private flowStates: Record<string, FlowRunState> = {}
  private flows: Flow[] = []

  /** 当前所有 flow 的运行态快照 */
  getFlowStates(): Record<string, FlowRunState> {
    return this.flowStates
  }

  /** 处理 flow.command.flowStart：初始化运行态条目，与 webview runFlow 行为一致 */
  initFlowStart(flowId: string, runKey: string): void {
    this.flowStates = produce(this.flowStates, (draft) => {
      draft[flowId] = {
        runKey,
        phase: 'starting',
        sessions: [],
        answeredQuestions: {},
        answeredToolPermissions: {},
      }
    })
  }

  /** 应用一条 flow.signal.* 消息（复用 common reducer 保证两端逻辑一致） */
  applySignal(msg: ExtensionFlowSignalMessage): void {
    const fakeState: FlowState = {
      loading: false,
      flows: this.flows,
      flowStates: this.flowStates,
      flowListCollapsed: false,
    }
    // panelVisible 仅影响 chatDrawer/notification 派发，flowStates 更新与之无关
    const { state } = updateState(fakeState, msg, { panelVisible: false })
    this.flowStates = state.flowStates
  }

  /**
   * 同步最新 flows 列表，并清理被删除 flow 对应的运行态。
   * 对每个被删除的 flowId 先回调 onRemove（caller 在此 kill runner），再删 state。
   */
  applyFlows(newFlows: Flow[], onRemove: (flowId: string) => void): void {
    const validIds = new Set(newFlows.map((f) => f.id))
    const removedIds = Object.keys(this.flowStates).filter((id) => !validIds.has(id))
    for (const flowId of removedIds) {
      onRemove(flowId)
    }
    if (removedIds.length > 0) {
      this.flowStates = produce(this.flowStates, (draft) => {
        for (const flowId of removedIds) delete draft[flowId]
      })
    }
    this.flows = newFlows
  }
}
