import type { FC } from 'react'
import { Button } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { motion, useMotionValue } from 'motion/react'
import { useFlowStore } from '@/webview/store/flow'
import { SortableFlowItem } from './SortableFlowItem'

const MIN_WIDTH = 160
const MAX_WIDTH = 480
const DEFAULT_WIDTH = 300

export const FlowListPanel: FC = () => {
  const { flows, activeFlowId, flowStates, saveFlows, setActiveFlowId } = useFlowStore()

  const panelWidth = useMotionValue(DEFAULT_WIDTH)

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  const onDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIndex = flows.findIndex((f) => f.id === active.id)
    const newIndex = flows.findIndex((f) => f.id === over.id)
    if (oldIndex === -1 || newIndex === -1) return
    saveFlows((flows) => {
      const reordered = arrayMove(flows, oldIndex, newIndex)
      flows.length = 0
      flows.push(...reordered)
    })
  }

  const onAdd = () => {
    const id = crypto.randomUUID()
    saveFlows((flows) => {
      flows.push({ id, name: '新建工作流', agents: [] })
    })
    setActiveFlowId(id)
  }

  const onDelete = (id: string) => {
    saveFlows((flows) => {
      const idx = flows.findIndex((f) => f.id === id)
      if (idx >= 0) flows.splice(idx, 1)
    })
    if (activeFlowId === id) {
      const next = flows.find((f) => f.id !== id)
      setActiveFlowId(next?.id ?? '')
    }
  }

  const onRename = (id: string, name: string) => {
    saveFlows((flows) => {
      const f = flows.find((f) => f.id === id)
      if (f) f.name = name
    })
  }

  return (
    <motion.div
      onKeyDownCapture={(e) => e.stopPropagation()}
      style={{ width: panelWidth }}
      className='relative flex h-full shrink-0 flex-col border-r border-[#313244] bg-[#181825]'
    >
      <div className='flex items-center justify-between border-b border-[#313244] px-3 py-2'>
        <span className='text-sm font-semibold text-[#cdd6f4]'>工作流列表</span>
        <Button
          type='text'
          size='small'
          icon={<PlusOutlined />}
          onClick={onAdd}
          className='text-[#6366f1]! hover:bg-[#313244]!'
        />
      </div>

      <div className='flex-1 overflow-y-auto p-1.5'>
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={flows.map((f) => f.id)} strategy={verticalListSortingStrategy}>
            {flows.map((flow) => (
              <SortableFlowItem
                key={flow.id}
                flow={flow}
                isActive={flow.id === activeFlowId}
                phase={flowStates[flow.id]?.phase}
                onClick={() => setActiveFlowId(flow.id)}
                onDelete={() => onDelete(flow.id)}
                onRename={(name) => onRename(flow.id, name)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* 拖拽调整宽度的手柄 */}
      <motion.div
        className='absolute top-0 -right-0.5 bottom-0 w-1 cursor-col-resize'
        drag='x'
        dragConstraints={{ left: 0, right: 0 }}
        dragElastic={0}
        dragMomentum={false}
        whileHover={{ backgroundColor: 'rgba(99, 102, 241, 0.3)' }}
        whileTap={{ backgroundColor: 'rgba(99, 102, 241, 0.5)' }}
        onDrag={(_, info) => {
          panelWidth.set(Math.min(Math.max(panelWidth.get() + info.delta.x, MIN_WIDTH), MAX_WIDTH))
        }}
        onDragStart={() => {
          document.body.style.cursor = 'col-resize !important'
          document.body.style.userSelect = 'none'
        }}
        onDragEnd={() => {
          document.body.style.cursor = ''
          document.body.style.userSelect = ''
        }}
      />
    </motion.div>
  )
}
