import { useState, type FC } from 'react'
import { App, Button, Typography, Modal, Input, Empty } from 'antd'
import {
  HolderOutlined,
  DeleteOutlined,
  BlockOutlined,
  DatabaseOutlined,
  PlusOutlined,
  MinusCircleOutlined,
} from '@ant-design/icons'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Flow } from '@/common'
import type { FlowRunState } from '@/webview/store/flow'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'

const PHASE_CONFIG: Record<
  Exclude<FlowRunState['phase'], 'idle'>,
  { color: string; label: string; animate: boolean }
> = {
  starting: { color: 'bg-[#f9e2af]', label: '启动中', animate: true },
  running: { color: 'bg-[#a6e3a1]', label: 'AI 生成中', animate: true },
  result: { color: 'bg-[#89b4fa]', label: '生成完毕', animate: true },
  interrupted: { color: 'bg-[#f9e2af]', label: '已中断', animate: true },
  'awaiting-question': { color: 'bg-[#cba6f7]', label: '需要回答', animate: true },
  'awaiting-tool-permission': { color: 'bg-[#f9e2af]', label: '请求授权', animate: true },
  completed: { color: 'bg-[#a6e3a1]/60', label: '已完成', animate: false },
  stopped: { color: 'bg-[#9399b2]', label: '已停止', animate: false },
  error: { color: 'bg-[#f38ba8]', label: '出错', animate: false },
}

export type SortableFlowItemProps = {
  flow: Flow
  isActive: boolean
  phase?: FlowRunState['phase']
  onClick: () => void
  onDelete: () => void
  onRename: (name: string) => void
}

export const SortableFlowItem: FC<SortableFlowItemProps> = (props) => {
  const { flow, isActive, phase, onClick, onDelete, onRename } = props
  const { save, setActiveFlowId, setFlowListCollapsed, setShareValues, flowRunStates } =
    useFlowStore()
  const { message } = App.useApp()
  const { id, name } = flow
  const [editing, setEditing] = useState(false)
  const [shareValuesModalOpen, setShareValuesModalOpen] = useState(false)
  const [editValues, setEditValues] = useState<Record<string, string>>({})
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const statusConfig = phase && phase !== 'idle' ? PHASE_CONFIG[phase] : undefined

  return (
    <div
      ref={setNodeRef}
      data-flow-id={id}
      style={style}
      className={cn(
        'group cursor-pointer rounded-md px-2 py-1.5 text-[13px] transition-colors',
        isActive ? 'bg-[#313244] text-[#cdd6f4]' : 'text-[#a6adc8] hover:bg-[#1e1e2e]',
      )}
      onClick={onClick}
    >
      <div className='flex items-center gap-1'>
        <span
          className='cursor-grab text-[#585b70] opacity-0 transition-opacity group-hover:opacity-100'
          {...attributes}
          {...listeners}
          onClick={(e) => e.stopPropagation()}
        >
          <HolderOutlined />
        </span>

        <div
          className='flex-1'
          onClick={(e) => {
            const t = e.target as HTMLElement
            if (editing || t.closest('.ant-typography-edit')) {
              e.stopPropagation()
            }
          }}
        >
          <Typography.Text
            editable={{
              editing,
              onStart: () => setEditing(true),
              onEnd: () => setEditing(false),
              onChange: (val) => {
                setEditing(false)
                if (val && val !== name) {
                  onRename?.(val)
                }
              },
            }}
            ellipsis
            className='w-full'
          >
            {name}
          </Typography.Text>
        </div>
        <Button
          title='共享数据'
          type='text'
          size='small'
          icon={<DatabaseOutlined />}
          onClick={(e) => {
            e.stopPropagation()
            const current = flowRunStates[id]?.shareValues ?? {}
            setEditValues(structuredClone(current))
            setShareValuesModalOpen(true)
          }}
          className={cn(
            'text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100',
            Object.keys(flowRunStates[id]?.shareValues ?? {}).length > 0
              ? 'hover:bg-[#45475a]! hover:text-[#a6e3a1]!'
              : 'hover:bg-[#45475a]! hover:text-[#89b4fa]!',
          )}
        />
        <Button
          title='克隆'
          type='text'
          size='small'
          icon={<BlockOutlined />}
          onClick={(e) => {
            e.stopPropagation()
            const newId = crypto.randomUUID()
            const cloned = structuredClone(flow)
            cloned.id = newId
            save((flows) => flows.push(cloned))
            setActiveFlowId(newId)
            setFlowListCollapsed(false)
          }}
          className='text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100 hover:bg-[#45475a]! hover:text-[#89b4fa]!'
        />
        <span
          className='flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'
          onClick={(e) => e.stopPropagation()}
        >
          <Typography.Text
            copyable={{
              onCopy: async () => {
                await navigator.clipboard.writeText(JSON.stringify(flow, null, 2))
                message.success('复制成功')
              },
              tooltips: false,
            }}
          />

          <Button
            type='text'
            size='small'
            icon={<DeleteOutlined />}
            onClick={(e) => {
              e.stopPropagation()
              onDelete()
            }}
            className='text-[#a6adc8]! hover:bg-[#45475a]! hover:text-[#f38ba8]!'
          />
        </span>
      </div>

      {statusConfig && (
        <div className='mt-0.5 flex items-center gap-1.5 pl-6 text-[11px] text-[#a6adc8]'>
          <span
            className={cn(
              'h-1.5 w-1.5 shrink-0 rounded-full',
              statusConfig.color,
              statusConfig.animate && 'animate-pulse',
            )}
          />
          <span>{statusConfig.label}</span>
        </div>
      )}

      <Modal
        title={`${name} - 共享数据`}
        open={shareValuesModalOpen}
        onCancel={() => setShareValuesModalOpen(false)}
        onOk={() => {
          setShareValues(id, editValues)
          setShareValuesModalOpen(false)
        }}
        okText='保存'
        width={480}
      >
        {Object.keys(editValues).length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description='暂无共享数据'
          >
            <Button
              type='dashed'
              icon={<PlusOutlined />}
              onClick={() =>
                setEditValues((prev) => ({ ...prev, '': '' }))
              }
            >
              添加
            </Button>
          </Empty>
        ) : (
          <div className='flex flex-col gap-2'>
            {Object.entries(editValues).map(([key, value], index) => (
              <div key={index} className='flex items-center gap-2'>
                <Input
                  placeholder='Key'
                  value={key}
                  size='small'
                  onChange={(e) => {
                    const newValues: Record<string, string> = {}
                    Object.entries(editValues).forEach(([k, v], i) => {
                      newValues[i === index ? e.target.value : k] = v
                    })
                    setEditValues(newValues)
                  }}
                  className='flex-1'
                />
                <Input
                  placeholder='Value'
                  value={value}
                  size='small'
                  onChange={(e) =>
                    setEditValues((prev) => ({
                      ...prev,
                      [key]: e.target.value,
                    }))
                  }
                  className='flex-1'
                />
                <Button
                  type='text'
                  size='small'
                  danger
                  icon={<MinusCircleOutlined />}
                  onClick={() => {
                    const newValues = { ...editValues }
                    delete newValues[key]
                    setEditValues(newValues)
                  }}
                />
              </div>
            ))}
            <Button
              type='dashed'
              icon={<PlusOutlined />}
              onClick={() =>
                setEditValues((prev) => ({ ...prev, '': '' }))
              }
              block
            >
              添加
            </Button>
          </div>
        )}
      </Modal>
    </div>
  )
}
