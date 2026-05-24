import { useCallback } from 'react'
import { App } from 'antd'
import { getFlowPhase, type FlowPhase, type UserMessageType } from '@/common'
import { useFlowStore } from '@/webview/store/flow'

/**
 * 启动 Flow 的公共逻辑：
 * - idle → 直接调用 runFlow
 * - 非 idle → 弹确认框，确认后清空运行数据再启动
 *
 * `mode` 默认 'manual';host 模式由 host 入口传入 'host',此时 agentId 必须为 HOST_AGENT_ID。
 *
 * 互斥校验:Flow 当前正在以另一种 mode 运行(非 idle / 非 completed)时,弹通知告知,
 * 不发起新启动(用户需要先手动 killFlow)。
 */
export function useStartFlow() {
  const { modal, notification } = App.useApp()

  const startFlow = useCallback(
    (
      flowId: string,
      agentId: string,
      initMessage: UserMessageType,
      mode: 'manual' | 'host' = 'manual',
    ): boolean | Promise<boolean> => {
      const st = useFlowStore.getState()
      const { runFlow } = st
      const runState = st.flowRunStates[flowId]
      const flowPhase: FlowPhase = getFlowPhase(runState)

      // 互斥:Flow 处于另一种 mode 且非 idle/completed/stopped/error,弹通知不启动
      if (
        runState &&
        runState.mode !== mode &&
        flowPhase !== 'idle' &&
        flowPhase !== 'completed' &&
        flowPhase !== 'stopped' &&
        flowPhase !== 'error'
      ) {
        const fromName = runState.mode === 'host' ? 'AI 托管' : '普通'
        const toName = mode === 'host' ? 'AI 托管' : '普通'
        notification.warning({
          message: `当前工作流正在以「${fromName}」模式运行,无法启动「${toName}」模式`,
          description: '请等待运行结束或先停止当前运行',
        })
        return false
      }

      if (flowPhase === 'idle') {
        runFlow(flowId, agentId, initMessage, mode)
        return true
      }

      return new Promise<boolean>((resolve) => {
        modal.confirm({
          title: '确认运行',
          content: '当前工作流数据会被清空，如果想保留数据，可以复制工作流再运行',
          onOk: () => {
            runFlow(flowId, agentId, initMessage, mode)
            resolve(true)
          },
          onCancel: () => resolve(false),
        })
      })
    },
    [modal, notification],
  )

  return startFlow
}
