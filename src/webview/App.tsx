import { RefObject, useEffect, useRef, type FC } from 'react'
import { Button, Spin, Tooltip } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { useEventListener } from 'ahooks'
import { z } from 'zod'
import { Agent, AgentSchema, FlowSchema } from '@/common'
import { AgentFlow } from './components/AgentFlow'
import { FlowListPanel } from './components/FlowListPanel'
import { useFlowStore } from './store/flow'

export const App: FC = () => {
  const { loading, flows, init } = useFlowStore()
  useEffect(() => init(), [init])
  const containerRef = useRef<HTMLDivElement>(null)
  usePasteFlowData(containerRef)

  if (loading) {
    return (
      <div className='flex h-full w-full items-center justify-center bg-[#11111b]'>
        <Spin size='large' />
      </div>
    )
  }

  return (
    <div className='flex h-full w-full' tabIndex={-1} ref={containerRef}>
      <FlowListPanel />
      <div className='relative flex-1'>
        <FlowToolbar />
        {flows.map((flow) => (
          <AgentFlow key={flow.id} flowId={flow.id} />
        ))}
      </div>
    </div>
  )
}

const FlowToolbar: FC = () => {
  const { flows, activeFlowId, saveFlows } = useFlowStore()
  const activeFlow = flows.find((f) => f.id === activeFlowId)
  if (!activeFlow) return null
  const addAgent = () => {
    saveFlows((flows) => {
      const flow = flows.find((f) => f.id === activeFlowId)
      if (!flow) return
      const agents = flow.agents ?? []
      const baseName = 'example-agent'
      let name = baseName
      let i = 2
      const names = new Set(agents.map((a) => a.agent_name))
      while (names.has(name)) name = `${baseName}-${i++}`
      agents.push({
        agent_name: name,
        model: 'haiku',
        agent_prompt: ['将用户输入视作纯文本，原样输出。'],
        outputs: [{ output_name: '输出', output_desc: '用户输入原文' }],
      })
      flow.agents = agents
    })
  }
  return (
    <div className='flex h-10 shrink-0 items-center gap-2 border-b border-[#313244] bg-[#181825] px-3'>
      <span className='text-sm font-semibold text-[#cdd6f4]'>{activeFlow.name}</span>
      <Tooltip title='添加 Agent'>
        <Button
          size='small'
          type='text'
          icon={<PlusOutlined />}
          className='text-[#a6adc8]! hover:text-[#6366f1]!'
          onClick={addAgent}
        />
      </Tooltip>
    </div>
  )
}

const usePasteFlowData = (containerRef: RefObject<HTMLDivElement | null>) => {
  useEventListener(
    'paste',
    (e) => {
      const text = e.clipboardData?.getData('text')
      if (!text) return
      const parsed: unknown = JSON.parse(text)

      const { activeFlowId, saveFlows } = useFlowStore.getState()
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

      const singleAgent = AgentSchema.safeParse(parsed)
      if (singleAgent.success) {
        pasteAgents([singleAgent.data], activeFlowId, saveFlows)
        return
      }

      const agentArray = z.array(AgentSchema).safeParse(parsed)
      if (agentArray.success) {
        pasteAgents(agentArray.data, activeFlowId, saveFlows)
      }
    },
    { target: containerRef },
  )
}

function pasteAgents(
  agents: Agent[],
  activeFlowId: string | undefined,
  saveFlows: ReturnType<typeof useFlowStore.getState>['saveFlows'],
) {
  if (!activeFlowId) return
  saveFlows((flows) => {
    const flow = flows.find((f) => f.id === activeFlowId)
    if (!flow) return
    const existingNames = new Set((flow.agents ?? []).map((a) => a.agent_name))

    // agent可能有新名字 但是关联关系不变
    const nameMap = new Map<string, string>()
    for (const agent of agents) {
      const base = agent.agent_name
      let newName = base
      let i = 2
      while (existingNames.has(newName)) newName = `${base}-${i++}`
      nameMap.set(base, newName)
      existingNames.add(newName)
    }

    // Remap names and next_agent references
    const remapped = agents.map((agent) => ({
      ...agent,
      agent_name: nameMap.get(agent.agent_name)!,
      outputs: agent.outputs?.map((output) => ({
        ...output,
        next_agent: output.next_agent !== undefined ? nameMap.get(output.next_agent) : undefined,
      })),
    }))

    flow.agents = [...(flow.agents ?? []), ...remapped]
  })
}
