import { useEffect, type FC } from 'react'
import { App as AntdApp, Spin } from 'antd'
import { useEventListener } from 'ahooks'
import { z } from 'zod'
import { FlowSchema, HOST_AGENT_ID } from '@/common'
import { AgentEditor } from './components/AgentEditor'
import { AgentFlow } from './components/AgentFlow'
import { ChatDrawer } from './components/ChatDrawer'
import { FlowEditor } from './components/FlowEditor'
import { FlowListPanel } from './components/FlowListPanel'
import { useFlowStore } from './store/flow'

export const App: FC = () => {
  const { notification } = AntdApp.useApp()
  const { loading, flows, init } = useFlowStore()
  const globalError = useFlowStore((s) => s.globalError)
  const hostDrawer = useFlowStore((s) => s.hostDrawer)
  const subAgentDrawer = useFlowStore((s) => s.subAgentDrawer)
  const closeHostDrawer = useFlowStore((s) => s.closeHostDrawer)
  const closeSubAgentDrawer = useFlowStore((s) => s.closeSubAgentDrawer)
  const activeFlowId = useFlowStore((s) => s.activeFlowId)

  useEffect(() => init({ notification }), [init, notification])

  // activeFlowId 切换时,按运行模式决定 hostDrawer:
  // - host 模式:默认指向 host run(无 host run 则不打开)
  // - manual 模式:沿用 runs 末位 agent 逻辑
  // 切换 Flow 时同时关闭 subAgentDrawer(子 Drawer 状态不跨 Flow 保留)
  // 依赖只放 activeFlowId,flow 定义/runs 现取,避免编辑 Agent 等无关变更触发自动开关。
  useEffect(() => {
    const { openChatDrawer, closeHostDrawer, closeSubAgentDrawer } = useFlowStore.getState()
    closeSubAgentDrawer()
    if (!activeFlowId) {
      closeHostDrawer()
      return
    }
    const fs = useFlowStore.getState().flowRunStates[activeFlowId]
    if (fs?.mode === 'host') {
      const hostRun = fs.runs.find((r) => r.agentId === HOST_AGENT_ID)
      if (hostRun) {
        openChatDrawer({
          flowId: activeFlowId,
          agentId: HOST_AGENT_ID,
          agentName: 'AI 托管',
          runId: hostRun.runId,
        })
      } else {
        closeHostDrawer()
      }
      return
    }
    const targetAgentId = fs?.runs.at(-1)?.agentId
    if (targetAgentId) {
      const latestFlow = useFlowStore.getState().flows.find((f) => f.id === activeFlowId)
      const agent = latestFlow?.agents?.find((a) => a.id === targetAgentId)
      openChatDrawer({
        flowId: activeFlowId,
        agentId: targetAgentId,
        agentName: agent?.agent_name ?? '',
      })
    } else {
      closeHostDrawer()
    }
  }, [activeFlowId])

  useEffect(() => {
    if (!globalError) return
    notification.error({
      key: 'globalError',
      duration: 0,
      message: '拓展出现未知错误 请保存数据后重新打开页面',
      description: globalError,
    })
  }, [globalError, notification])
  usePasteFlow()

  if (loading) {
    return (
      <div className='flex h-full w-full items-center justify-center bg-[#11111b]'>
        <Spin size='large' />
      </div>
    )
  }

  return (
    <div className='flex h-full w-full'>
      <div className='relative flex-1'>
        {flows.map((flow) => (
          <AgentFlow key={flow.id} flowId={flow.id} />
        ))}
        <FlowListPanel />
      </div>
      {/* host run Drawer:默认 700,host 模式下持续保留 */}
      <ChatDrawer
        flowId={hostDrawer?.flowId}
        agentId={hostDrawer?.agentId}
        runId={hostDrawer?.runId}
        open={!!hostDrawer}
        defaultSize={700}
        kind='host'
        onClose={closeHostDrawer}
      />
      {/* sub agent Drawer:默认 540,后渲染 → 层级在 host Drawer 之上 */}
      <ChatDrawer
        flowId={subAgentDrawer?.flowId}
        agentId={subAgentDrawer?.agentId}
        runId={subAgentDrawer?.runId}
        open={!!subAgentDrawer}
        defaultSize={540}
        kind='sub'
        onClose={closeSubAgentDrawer}
      />
      <AgentEditor />
      <FlowEditor />
    </div>
  )
}

const isInputTarget = (e: Event) => {
  const el = e.target
  if (!(el instanceof HTMLElement)) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

const usePasteFlow = () => {
  useEventListener('paste', (e: ClipboardEvent) => {
    if (isInputTarget(e)) return
    const text = e.clipboardData?.getData('text')
    if (!text) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    // 只复制flow agent在<AgentFlow />复制 需要放置在画布里合适的位置
    const { save, setActiveFlowId, setFlowListCollapsed } = useFlowStore.getState()
    const singleFlow = FlowSchema.safeParse(parsed)
    if (singleFlow.success) {
      const newId = crypto.randomUUID()
      save((flows) => {
        flows.push({ ...singleFlow.data, id: newId })
      })
      setActiveFlowId(newId)
      setFlowListCollapsed(false)
      return
    }

    const flowArray = z.array(FlowSchema).safeParse(parsed)
    if (flowArray.success) {
      let lastId = ''
      save((flows) => {
        for (const flow of flowArray.data) {
          lastId = crypto.randomUUID()
          flows.push({ ...flow, id: lastId })
        }
      })
      if (lastId) {
        setActiveFlowId(lastId)
        setFlowListCollapsed(false)
      }
      return
    }
  })
}
