import { type FC } from 'react'
import { App, Button, Tooltip, Typography } from 'antd'
import { HolderOutlined, DeleteOutlined } from '@ant-design/icons'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import type { Flow } from '@/common'
import type { FlowRunState } from '@/webview/store/flow'
import { cn } from '@/webview/utils'

const PHASE_CONFIG: Record<
  Exclude<FlowRunState['phase'], 'idle'>,
  { color: string; label: string; animate: boolean }
> = {
  starting: { color: 'bg-[#f9e2af]', label: '启动中', animate: true },
  running: { color: 'bg-[#a6e3a1]', label: 'AI 生成中', animate: true },
  awaiting: { color: 'bg-[#89b4fa]', label: '等待用户', animate: true },
  completed: { color: 'bg-[#a6e3a1]/60', label: '已完成', animate: false },
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
  const { message } = App.useApp()
  const { id, name } = flow
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
      style={style}
      className={cn(
        'group flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-[13px] transition-colors',
        isActive ? 'bg-[#313244] text-[#cdd6f4]' : 'text-[#a6adc8] hover:bg-[#1e1e2e]',
      )}
      onClick={onClick}
    >
      <span
        className='cursor-grab text-[#585b70] opacity-0 transition-opacity group-hover:opacity-100'
        {...attributes}
        {...listeners}
      >
        <HolderOutlined />
      </span>

      {statusConfig && (
        <Tooltip title={statusConfig.label} mouseEnterDelay={0.3}>
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              statusConfig.color,
              statusConfig.animate && 'animate-pulse',
            )}
          />
        </Tooltip>
      )}

      <Typography.Text
        editable={{
          onChange: (val) => {
            if (val && val !== name) {
              onRename?.(val)
            }
          },
        }}
        ellipsis
        className='flex-1'
        style={style}
      >
        {name}
      </Typography.Text>
      <span className='flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100'>
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
  )
}
