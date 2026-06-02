import { useState, type FC } from 'react'
import { App, Typography } from 'antd'
import {
  HolderOutlined,
  DeleteOutlined,
  BlockOutlined,
  DatabaseOutlined,
  RobotOutlined,
} from '@ant-design/icons'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { getFlowPhase, getRunPhase, HOST_AGENT_ID, type Flow, type FlowPhase } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'

const PHASE_CONFIG: Record<
  Exclude<FlowPhase, 'idle'>,
  { color: string; label: string; animate: boolean }
> = {
  starting: { color: 'bg-[#f9e2af]', label: '启动中', animate: true },
  running: { color: 'bg-[#a6e3a1]', label: 'AI 生成中', animate: true },
  result: { color: 'bg-[#89b4fa]', label: '生成完毕', animate: true },
  interrupted: { color: 'bg-[#f9e2af]', label: '已中断', animate: true },
  'awaiting-question': { color: 'bg-[#cba6f7]', label: '需要回答', animate: true },
  'awaiting-tool-permission': { color: 'bg-[#f9e2af]', label: '请求授权', animate: true },
  'awaiting-complete-confirm': { color: 'bg-[#f9e2af]', label: '等待完成确认', animate: true },
  completed: { color: 'bg-[#a6e3a1]/60', label: '已完成', animate: false },
  stopped: { color: 'bg-[#9399b2]', label: '已停止', animate: false },
  error: { color: 'bg-[#f38ba8]', label: '出错', animate: false },
}

export type SortableFlowItemProps = {
  flow: Flow
  isActive: boolean
  phase?: FlowPhase
  onClick: () => void
  onDelete: () => void
  onRename: (name: string) => void
}

export const SortableFlowItem: FC<SortableFlowItemProps> = (props) => {
  const { flow, isActive, phase, onClick, onDelete, onRename } = props
  const { save, setActiveFlowId, setFlowListCollapsed, openFlowEditor } = useFlowStore()
  const runState = useFlowStore((s) => s.flowRunStates[flow.id])
  const { notification } = App.useApp()
  const { id, name } = flow
  const [editing, setEditing] = useState(false)
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const statusConfig = phase && phase !== 'idle' ? PHASE_CONFIG[phase] : undefined
  // host 模式且非 idle 时,AI icon 闪烁(host AI 正在工作 / 已完成 / 已停止 / 出错都会闪)。
  // 入口分流:无 host_model → 打开 FlowEditor 提示;有 host_model → 切到 ChatDrawer 的 host run 视图。
  // 如果当前 flow 是 manual 模式且非 idle,点 AI icon 弹通知(模式互斥)。
  // 注意:闪烁条件与按钮组可见性解耦 —— 复制 / 删除等其他按钮始终走 hover 显示语义,
  // 仅 host icon 在 hostShouldBlink 时持续显示并闪烁。
  const hostFlowPhase = getFlowPhase(runState)
  const hostShouldBlink = runState?.mode === 'host' && hostFlowPhase !== 'idle'
  const onClickHostIcon = (e: React.MouseEvent) => {
    e.stopPropagation()
    setActiveFlowId(id)
    setFlowListCollapsed(false)
    // 互斥提示:flow 在 manual 模式运行中,不允许启动 host
    if (
      runState?.mode === 'manual' &&
      hostFlowPhase !== 'idle' &&
      hostFlowPhase !== 'completed' &&
      hostFlowPhase !== 'stopped' &&
      hostFlowPhase !== 'error'
    ) {
      notification.warning({
        message: '工作流正在以普通模式运行,无法启动 AI 托管模式',
        description: '请等待当前运行结束或先停止当前运行',
      })
      return
    }
    if (!flow.host_model) {
      openFlowEditor(id, { focus: 'host_model' })
      notification.info({
        message: '请先选择托管模型',
        description: 'AI 托管模式需要先在工作流编辑器里配置「托管模型」',
      })
      return
    }
    // 已配置 host_model:优先看是否有「等待用户处理」的子 run(awaiting-* / result / error),
    // 直接切到该子 run 的 sub agent Drawer,destroy 对应通知。否则呼出 host Drawer。
    const store = useFlowStore.getState()
    const awaitingSubRun = runState?.runs.find((r) => {
      if (!r.parentToolUseId) return false
      const phase = getRunPhase(r, runState)
      return (
        phase === 'awaiting-tool-permission' ||
        phase === 'awaiting-question' ||
        phase === 'result' ||
        phase === 'error'
      )
    })
    if (awaitingSubRun) {
      const subAgent = flow.agents?.find((a) => a.id === awaitingSubRun.agentId)
      store.openSubAgentDrawer({
        flowId: id,
        runId: awaitingSubRun.runId,
        agentId: awaitingSubRun.agentId,
        agentName: subAgent?.agent_name ?? '',
      })
      store.destroyRunNotifications(id, awaitingSubRun.runId)
      return
    }
    const hostRun = runState?.runs.find((r) => r.agentId === HOST_AGENT_ID)
    store.openChatDrawer({
      flowId: id,
      agentId: HOST_AGENT_ID,
      agentName: 'AI 托管',
      runId: hostRun?.runId,
    })
  }

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

        <span
          className='flex shrink-0 items-center gap-1'
          onClick={(e) => e.stopPropagation()}
        >
          <RobotOutlined
            title='AI 托管'
            onClick={onClickHostIcon}
            className={cn(
              'text-[#a6adc8]! transition-opacity hover:text-[#cba6f7]!',
              hostShouldBlink
                ? 'animate-pulse text-[#cba6f7]! opacity-100'
                : 'opacity-0 group-hover:opacity-100',
            )}
          />
          <DatabaseOutlined
            title='编辑工作流'
            onClick={() => {
              useFlowStore.getState().setEditingFlowId(id)
            }}
            className={cn(
              'text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100',
              (flow.shareValuesKeys?.length ?? 0) > 0
                ? 'hover:text-[#a6e3a1]!'
                : 'hover:text-[#89b4fa]!',
            )}
          />
          <BlockOutlined
            title='克隆'
            onClick={() => {
              const newId = crypto.randomUUID()
              const cloned = structuredClone(flow)
              cloned.id = newId
              save((flows) => flows.push(cloned))
              setActiveFlowId(newId)
              setFlowListCollapsed(false)
            }}
            className='text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#89b4fa]!'
          />
          <span className='opacity-0 transition-opacity group-hover:opacity-100'>
            <Typography.Text
              copyable={{ tooltips: false, text: () => JSON.stringify(flow, null, 2) }}
            />
          </span>
          <DeleteOutlined
            className='text-[#a6adc8]! opacity-0 transition-opacity group-hover:opacity-100 hover:text-[#f38ba8]!'
            onClick={onDelete}
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
    </div>
  )
}
