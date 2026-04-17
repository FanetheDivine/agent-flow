import { useState, useCallback } from 'react'
import type { FC } from 'react'
import { Input, Button } from 'antd'
import { SendOutlined } from '@ant-design/icons'
import { useFlowStore } from '@/webview/store/flow'

type Props = {
  flowId: string
  disabled: boolean
}

export const ChatInput: FC<Props> = ({ flowId, disabled }) => {
  const [text, setText] = useState('')
  const sendUserMessage = useFlowStore((s) => s.sendUserMessage)

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    sendUserMessage(flowId, trimmed)
    setText('')
  }, [text, flowId, sendUserMessage])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className='flex items-end gap-2 border-t border-[#45475a] px-3 py-2'>
      <Input.TextArea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={disabled ? '等待中...' : '输入消息...'}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        className='flex-1 text-xs'
      />
      <Button
        type='primary'
        size='small'
        icon={<SendOutlined />}
        disabled={disabled || !text.trim()}
        onClick={handleSend}
      />
    </div>
  )
}
