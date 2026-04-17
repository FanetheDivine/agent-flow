import { useEffect, type FC } from 'react'
import { notification, Spin } from 'antd'
import { useEventListener } from 'ahooks'
import { z } from 'zod'
import { FlowSchema } from '@/common'
import { AgentFlow } from './components/AgentFlow'
import { FlowListPanel } from './components/FlowListPanel'
import { useFlowStore } from './store/flow'

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

  if (loading) {
    return (
      <div className='flex h-full w-full items-center justify-center bg-[#11111b]'>
        <Spin size='large' />
      </div>
    )
  }

  return (
    <div className='flex h-full w-full'>
      <FlowListPanel />
      <div className='relative flex-1'>
        {flows.map((flow) => (
          <AgentFlow key={flow.id} flowId={flow.id} />
        ))}
      </div>
    </div>
  )
}

const usePasteFlow = () => {
  useEventListener('paste', (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text')
    if (!text) return
    const parsed: unknown = JSON.parse(text)
    // 只复制flow agent在<AgentFlow />复制 需要放置在画布里合适的位置
    const { saveFlows } = useFlowStore.getState()
    const singleFlow = FlowSchema.safeParse(parsed)
    if (singleFlow.success) {
      saveFlows((flows) => {
        flows.push({ ...singleFlow.data, id: crypto.randomUUID() })
      })
      return
    }

    const flowArray = z.array(FlowSchema).safeParse(parsed)
    if (flowArray.success) {
      saveFlows((flows) => {
        for (const flow of flowArray.data) {
          flows.push({ ...flow, id: crypto.randomUUID() })
        }
      })
      return
    }
  })
}
