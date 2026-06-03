import { useLayoutEffect, useRef, useState, type FC } from 'react'
import { Button, Tag } from 'antd'
import { CheckOutlined, SafetyOutlined, StopOutlined } from '@ant-design/icons'
import { RadioWithInput } from './RadioWithInput'

const ALLOW_VALUE = 'allow'
const DENY_VALUE = 'deny'

const ALLOW_DENY_OPTIONS = [
  { value: ALLOW_VALUE, label: '允许' },
  { value: DENY_VALUE, label: '拒绝' },
]

const EXIT_PLAN_OPTIONS = [
  { value: ALLOW_VALUE, label: '确认' },
  { value: DENY_VALUE, label: '拒绝' },
]

type Props = {
  toolName: string
  input: unknown
  mode: 'active' | 'historical'
  /** 历史态下的结果 */
  answered?: { allow: boolean }
  onAllow?: () => void
  onDeny?: (reason?: string) => void
  /** ExitPlanMode 专属：显示"计划已生成"样式 */
  exitPlan?: {
    planFilePath: string
    onViewPlan?: () => void
  }
  onChangeHeight?: (height: number) => void
}

function formatInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return String(input)
  }
}

export const ToolPermissionCard: FC<Props> = ({
  toolName,
  input,
  mode,
  answered,
  onAllow,
  onDeny,
  exitPlan,
  onChangeHeight,
}) => {
  const isActive = mode === 'active'
  const isExitPlan = !!exitPlan
  const [selection, setSelection] = useState<string | undefined>(undefined)
  const [denyReason, setDenyReason] = useState('')
  const containerRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!onChangeHeight) return
    const raf = requestAnimationFrame(() => {
      if (containerRef.current) {
        onChangeHeight(containerRef.current.getBoundingClientRect().height + 30)
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [selection, onChangeHeight])

  const handleSubmit = () => {
    if (!selection) return
    if (selection === ALLOW_VALUE) {
      onAllow?.()
    } else {
      onDeny?.(denyReason.trim() || undefined)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return
    e.preventDefault()
    if (selection) handleSubmit()
  }

  const options = isExitPlan ? EXIT_PLAN_OPTIONS : ALLOW_DENY_OPTIONS
  const historicalValue = answered ? (answered.allow ? ALLOW_VALUE : DENY_VALUE) : undefined

  return (
    <div
      ref={containerRef}
      className='flex flex-col gap-2 overflow-x-hidden rounded-md border border-[#45475a] bg-[#181825] px-3 py-2'
    >
      <div className='flex items-center gap-2'>
        <SafetyOutlined className='text-[#f9e2af]' />
        <span className='font-semibold text-[#cdd6f4]'>
          {isExitPlan ? '计划已生成' : '请求使用工具'}
        </span>
        {!isExitPlan && (
          <Tag color='warning' className='m-0 text-xs'>
            {toolName}
          </Tag>
        )}
        {mode === 'historical' && answered && (
          <Tag
            color={answered.allow ? 'success' : 'error'}
            className='m-0 ml-auto text-[10px]'
            icon={answered.allow ? <CheckOutlined /> : <StopOutlined />}
          >
            {isExitPlan
              ? answered.allow
                ? '已确认'
                : '已拒绝'
              : answered.allow
                ? '已允许'
                : '已拒绝'}
          </Tag>
        )}
      </div>

      {isExitPlan ? (
        <span className='text-[#cdd6f4]'>
          计划已生成，
          <a
            href='#'
            onClick={(e) => {
              e.preventDefault()
              exitPlan.onViewPlan?.()
            }}
            className='text-[#89b4fa] hover:underline'
          >
            点击查看
          </a>
        </span>
      ) : (
        <pre className='m-0 max-h-40 overflow-auto rounded bg-[#11111b] p-2 text-[10.5px] whitespace-pre-wrap text-[#cdd6f4]'>
          {formatInput(input)}
        </pre>
      )}

      <RadioWithInput
        options={options}
        inputTriggerValue={DENY_VALUE}
        value={isActive ? selection : historicalValue}
        inputValue={isActive ? denyReason : undefined}
        disabled={!isActive}
        inputPlaceholder={'输入拒绝原因...'}
        onChange={setSelection}
        onInputChange={setDenyReason}
        onInputKeyDown={handleKeyDown}
      />

      {isActive && (
        <div className='flex justify-end'>
          <Button type='primary' size='small' disabled={!selection} onClick={handleSubmit}>
            发送
          </Button>
        </div>
      )}
    </div>
  )
}
