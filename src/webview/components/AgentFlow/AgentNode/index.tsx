import { memo, useCallback, useEffect, useState } from 'react'
import type { FC } from 'react'
import { App, Badge, Popover, Tag, Tooltip, Typography } from 'antd'
import { EditOutlined, MessageOutlined, RobotOutlined } from '@ant-design/icons'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { Agent, UserMessageType } from '@/common'
import { useFlowStore, selectAgentPhase, flowIsDestructiveReadOnly } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import type { AgentNode } from '../flowUtils'
import { AgentEditModal } from './AgentEditModal'
import { ChatPanel } from './ChatPanel'

const handleStyle = {
  height: 16,
  width: 16,
  border: '2px solid #1e1e2e',
  background: '#6366f1',
}

const AgentNodeInner: FC<NodeProps<AgentNode>> = (props) => {
  const { data } = props
  const { flowId, agentId, agentName } = data

  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))
  const agent: Agent | undefined = flow?.agents?.find((a) => a.id === agentId)
  const flowPhase = useFlowStore((s) => s.flowStates[flowId]?.phase)
  const agentPhase = useFlowStore(selectAgentPhase(flowId, agentId))
  const activeFlowId = useFlowStore((s) => s.activeFlowId)
  const setActiveFlowId = useFlowStore((s) => s.setActiveFlowId)
  const saveFlows = useFlowStore((s) => s.saveFlows)
  const runFlow = useFlowStore((s) => s.runFlow)
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)

  const { message, modal } = App.useApp()

  const destructiveReadOnly = flowPhase ? flowIsDestructiveReadOnly(flowPhase) : false

  const isCurrentAgent = agentPhase !== 'idle' && agentPhase !== 'completed'
  const outputs = agent?.outputs ?? []
  const allAgents = (flow?.agents ?? []).map((a) => ({ id: a.id, agent_name: a.agent_name }))

  // ── Chat popover state ──
  const [chatOpen, setChatOpen] = useState(false)

  useEffect(() => {
    return useFlowStore.subscribe((state, prev) => {
      const currState = state.flowStates[flowId]
      const prevState = prev.flowStates[flowId]
      const isCurrent = currState?.currentAgentId === agentId
      const wasCurrent = prevState?.currentAgentId === agentId

      if (!wasCurrent && isCurrent) {
        setChatOpen(true)
      } else if (wasCurrent && !isCurrent) {
        setChatOpen(false)
      }
    })
  }, [flowId, agentId])

  // ── Handlers ──
  const handleSaveAgent = useCallback(
    (originalId: string, updated: Agent) => {
      saveFlows((flows) => {
        const f = flows.find((f) => f.id === flowId)
        if (!f) return
        f.agents = (f.agents ?? []).map((a) => (a.id === originalId ? updated : a))
      })
    },
    [flowId, saveFlows],
  )

  const handleRun = useCallback(
    (initMessage: UserMessageType) => runFlow(flowId, agentId, initMessage),
    [flowId, agentId, runFlow],
  )

  const onSend = useCallback(
    (text: string) => {
      if (agentPhase === 'awaiting-message' || agentPhase === 'awaiting-question') {
        sendUserMessage(flowId, text)
        return
      }

      const initMessage: UserMessageType = {
        type: 'user',
        message: { role: 'user', content: text },
        parent_tool_use_id: null,
      }

      if (agentPhase === 'idle') {
        handleRun(initMessage)
        return
      }

      modal.confirm({
        title: '确认运行',
        content: '当前工作流数据会被清空，如果想保留数据，可以复制工作流再运行',
        onOk: () => handleRun(initMessage),
      })
    },
    [agentPhase, flowId, sendUserMessage, handleRun, modal],
  )

  const [editOpen, setEditOpen] = useState(false)

  return (
    <>
      <div
        className={cn(
          'max-w-60 min-w-45 rounded-[10px] border border-[#45475a] bg-[#1e1e2e] p-0 text-[13px] shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition-[box-shadow,border-color] duration-200 hover:border-[#6366f1] hover:shadow-[0_4px_24px_rgba(99,102,241,0.25)]',
          isCurrentAgent && 'agent-node-running border-[#a6e3a1]',
        )}
      >
        {/* target handle：只接受连线，不允许从此拖出连线 */}
        <Handle
          type='target'
          position={Position.Left}
          id='input'
          isConnectableStart={false}
          style={{ ...handleStyle, left: -8 }}
        />

        {/* 头部 */}
        <div
          className='flex items-center gap-1.5 rounded-t-[10px] border-b border-[#313244] px-3 py-2'
          style={{ background: 'linear-gradient(135deg, #313244, #1e1e2e)' }}
        >
          <span className='text-sm text-[#cba6f7]'>
            <RobotOutlined />
          </span>
          <div
            className='flex-1 overflow-hidden'
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <Typography.Text ellipsis className='mb-0! text-[13px]! font-semibold text-[#cdd6f4]!'>
              {agentName}
            </Typography.Text>
          </div>

          <Typography.Text
            copyable={{
              onCopy: async () => {
                await navigator.clipboard.writeText(JSON.stringify(agent, null, 2))
                message.success('复制成功')
              },
              tooltips: false,
            }}
          />

          <Popover
            open={chatOpen && flowId === activeFlowId}
            content={
              <ChatPanel flowId={flowId} agentId={agentId} agentName={agentName} onSend={onSend} onClose={() => setChatOpen(false)} />
            }
            placement='rightTop'
            arrow={false}
            autoAdjustOverflow={false}
            overlayInnerStyle={{ padding: 0, overflow: 'hidden' }}
            getPopupContainer={(trigger) =>
              (trigger.closest('.react-flow__node') as HTMLElement) ?? document.body
            }
          >
            <span className='cursor-pointer text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'>
              <Badge dot={isCurrentAgent} offset={[-2, 2]}>
                <MessageOutlined
                  onClick={() => setChatOpen((v) => !v)}
                  className='text-xs text-[#a6adc8]'
                />
              </Badge>
            </span>
          </Popover>
          <span
            className='cursor-pointer text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
            onClick={(e) => {
              e.stopPropagation()
              if (destructiveReadOnly) {
                message.warning('当前状态不允许编辑 agent')
                return
              }
              setEditOpen(true)
            }}
          >
            <EditOutlined />
          </span>
        </div>

        {/* Agent 信息 */}
        {agent?.model && (
          <div className='px-3 pt-1'>
            <Tag color='blue' style={{ fontSize: 10 }}>
              {agent.model}
            </Tag>
          </div>
        )}

        {/* 输出端口列表 */}
        {outputs.length > 0 && (
          <div className='flex flex-col gap-1 px-3 pt-1.5 pb-2'>
            {outputs.map((output) => (
              <div
                key={output.output_name}
                className='relative flex items-center justify-between rounded bg-[#313244] px-1.5 py-0.5'
              >
                <Tooltip title={output.output_desc || output.output_name} placement='right'>
                  <span className='overflow-hidden text-[11px] text-ellipsis whitespace-nowrap text-[#a5b4fc]'>
                    {output.output_name}
                  </span>
                </Tooltip>
                <Handle
                  type='source'
                  position={Position.Right}
                  id={`output-${output.output_name}`}
                  style={{ ...handleStyle, right: -8 }}
                />
              </div>
            ))}
          </div>
        )}

        {/* 无输出时显示一个默认 source handle */}
        {outputs.length === 0 && (
          <Handle
            type='source'
            position={Position.Bottom}
            id='output-default'
            style={{ visibility: 'hidden' }}
          />
        )}
      </div>

      <AgentEditModal
        open={editOpen}
        agent={agent ?? null}
        allAgents={allAgents}
        onSave={(updated) => {
          handleSaveAgent(agentId, updated)
          setEditOpen(false)
        }}
        onCancel={() => setEditOpen(false)}
      />
    </>
  )
}

const AgentNodeComponent = memo(AgentNodeInner)
export default AgentNodeComponent
