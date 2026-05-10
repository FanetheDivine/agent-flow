import { type FC } from 'react'
import { Button, Tag } from 'antd'
import { CheckOutlined, CloseOutlined, SafetyOutlined, StopOutlined } from '@ant-design/icons'

type Props = {
  toolName: string
  input: unknown
  mode: 'active' | 'historical'
  /** 历史态下的结果 */
  answered?: { allow: boolean }
  onAllow?: () => void
  onDeny?: () => void
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
}) => {
  const isActive = mode === 'active'
  return (
    <div className='flex flex-col gap-2 rounded-md border border-[#45475a] bg-[#181825] px-3 py-2'>
      <div className='flex items-center gap-2'>
        <SafetyOutlined className='text-[#f9e2af]' />
        <span className='text-[11px] font-semibold text-[#cdd6f4]'>请求使用工具</span>
        <Tag color='warning' className='m-0 text-[10px]'>
          {toolName}
        </Tag>
        {mode === 'historical' && answered && (
          <Tag
            color={answered.allow ? 'success' : 'error'}
            className='m-0 ml-auto text-[10px]'
            icon={answered.allow ? <CheckOutlined /> : <StopOutlined />}
          >
            {answered.allow ? '已允许' : '已拒绝'}
          </Tag>
        )}
      </div>

      <pre className='m-0 max-h-40 overflow-auto rounded bg-[#11111b] p-2 text-[10.5px] whitespace-pre-wrap text-[#cdd6f4]'>
        {formatInput(input)}
      </pre>

      {isActive && (
        <div className='flex justify-end gap-2'>
          <Button size='small' icon={<CloseOutlined />} onClick={onDeny}>
            拒绝
          </Button>
          <Button type='primary' size='small' icon={<CheckOutlined />} onClick={onAllow}>
            允许
          </Button>
        </div>
      )}
    </div>
  )
}
