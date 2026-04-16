import { memo, useState } from 'react'
import type { FC } from 'react'
import { Tag, Tooltip, Typography } from 'antd'
import { PlayCircleOutlined, RobotOutlined, EditOutlined, MessageOutlined } from '@ant-design/icons'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { cn } from '@/webview/utils'
import type { AgentNode } from '../flowUtils'
import { AgentEditModal } from './AgentEditModal'

const handleStyle = {
  height: 16,
  width: 16,
  border: '2px solid #1e1e2e',
  background: '#6366f1',
}

const AgentNodeInner: FC<NodeProps<AgentNode>> = (props) => {
  const { data } = props
  const {
    label,
    isEntry,
    outputs,
    agent,
    readOnly,
    runningAgentName,
    allAgentNames,
    onSaveAgent,
    onOpenChat,
    onRun,
  } = data
  const isRunning = runningAgentName === agent.agent_name
  const [editOpen, setEditOpen] = useState(false)

  return (
    <>
      <div
        className={cn(
          'max-w-60 min-w-45 rounded-[10px] border border-[#45475a] bg-[#1e1e2e] p-0 text-[13px] shadow-[0_4px_16px_rgba(0,0,0,0.3)] transition-[box-shadow,border-color] duration-200 hover:border-[#6366f1] hover:shadow-[0_4px_24px_rgba(99,102,241,0.25)]',
          isRunning && 'agent-node-running border-[#a6e3a1]',
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
              {label}
            </Typography.Text>
          </div>
          {isEntry && (
            <Tag
              color='green'
              className={cn(
                'm-0 border-0 px-1 py-0 text-[10px] leading-4',
                !readOnly && onRun && 'cursor-pointer hover:opacity-80',
              )}
              onClick={(e) => {
                e.stopPropagation()
                if (!readOnly && onRun) {
                  onRun(agent.agent_name)
                }
              }}
            >
              <PlayCircleOutlined />
            </Tag>
          )}

          {!readOnly && onOpenChat && (
            <span
              className='cursor-pointer text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
              onClick={(e) => {
                e.stopPropagation()
                onOpenChat(agent.agent_name)
              }}
            >
              <MessageOutlined />
            </span>
          )}

          {!readOnly && onSaveAgent && (
            <span
              className='cursor-pointer text-xs text-[#a6adc8] transition-colors hover:text-[#6366f1]'
              onClick={(e) => {
                e.stopPropagation()
                setEditOpen(true)
              }}
            >
              <EditOutlined />
            </span>
          )}
        </div>

        {/* Agent 信息 */}
        {agent.model && (
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
        agent={agent}
        allAgentNames={allAgentNames ?? []}
        onSave={(updated) => {
          onSaveAgent?.(agent.agent_name, updated)
          setEditOpen(false)
        }}
        onCancel={() => setEditOpen(false)}
      />
    </>
  )
}

const AgentNodeComponent = memo(AgentNodeInner)
export default AgentNodeComponent
