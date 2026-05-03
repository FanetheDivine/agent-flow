import { useEffect, type FC } from 'react'
import { notification, Spin } from 'antd'
import { useEventListener } from 'ahooks'
import { z } from 'zod'
import { FlowSchema } from '@/common'
import { AgentFlow } from './components/AgentFlow'
import { ChatDrawer } from './components/ChatDrawer'
import { FlowListPanel } from './components/FlowListPanel'
import { useFlowStore } from './store/flow'
import { addReferenceToActiveInput } from './utils/activeInputRegistry'
import { subscribeExtensionMessage } from './utils/ExtensionMessage'

export const App: FC = () => {
  const { loading, flows, init } = useFlowStore()
  const globalError = useFlowStore((s) => s.globalError)
  useEffect(() => init(), [init])

  useEffect(() => {
    if (!globalError) return
    notification.error({
      key: 'globalError',
      duration: 0,
      message: '拓展出现未知错误 请保存数据后重新打开页面',
      description: globalError,
    })
  }, [globalError])
  usePasteFlow()
  useInsertSelection()

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
      <ChatDrawer />
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
    try { parsed = JSON.parse(text) } catch { return }
    // 只复制flow agent在<AgentFlow />复制 需要放置在画布里合适的位置
    const { saveFlows, setActiveFlowId, setFlowListCollapsed } = useFlowStore.getState()
    const singleFlow = FlowSchema.safeParse(parsed)
    if (singleFlow.success) {
      const newId = crypto.randomUUID()
      saveFlows((flows) => {
        flows.push({ ...singleFlow.data, id: newId })
      })
      setActiveFlowId(newId)
      setFlowListCollapsed(false)
      return
    }

    const flowArray = z.array(FlowSchema).safeParse(parsed)
    if (flowArray.success) {
      let lastId = ''
      saveFlows((flows) => {
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

const useInsertSelection = () => {
  useEffect(() => {
    return subscribeExtensionMessage((msg) => {
      if (msg.type !== 'insertSelection') return
      const { text, languageId, filename, startLine, endLine } = msg.data
      const ok = addReferenceToActiveInput({
        id: crypto.randomUUID(),
        text,
        languageId: languageId ?? '',
        filename: filename ?? '',
        startLine: startLine ?? 1,
        endLine: endLine ?? startLine ?? 1,
      })
      if (!ok) {
        notification.info({ message: '请先打开一个 ChatPanel 再使用 Ctrl+L' })
      }
    })
  }, [])
}
