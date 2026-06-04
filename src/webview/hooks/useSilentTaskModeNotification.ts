import { App } from 'antd'

let notified = false

export function useSilentTaskModeNotification() {
  const { modal } = App.useApp()

  return () => {
    if (notified) return
    notified = true
    modal.warning({
      title: '谨慎使用静默模式',
      content:
        '静默模式下，AI提问、计划生成与结束生成时会被自动应答，直到 Agent 自行完成任务。请谨慎选择模型、effort，并确保输入和提示词的完整。',
    })
  }
}
