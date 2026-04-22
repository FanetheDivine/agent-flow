import { useState, useCallback } from 'react'
import type { FC } from 'react'
import { Input, Button } from 'antd'
import { SendOutlined } from '@ant-design/icons'

type Props = {
  onSend: (text: string) => void
  placeholder?: string
}

export const ChatInput: FC<Props> = ({ onSend, placeholder = '输入消息...' }) => {
  const [text, setText] = useState('')

  const handleSend = useCallback(() => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }, [text, onSend])

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
        placeholder={placeholder}
        autoSize={{ minRows: 1, maxRows: 4 }}
        className='flex-1 text-xs'
      />
      <Button
        type='primary'
        size='small'
        icon={<SendOutlined />}
        disabled={!text.trim()}
        onClick={handleSend}
      />
    </div>
  )
}
