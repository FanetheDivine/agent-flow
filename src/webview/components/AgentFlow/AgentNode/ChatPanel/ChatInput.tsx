import { useState, useCallback } from 'react'
import type { FC } from 'react'
import { Sender } from '@ant-design/x'

type Props = {
  onSend: (text: string) => void
  placeholder?: string
  disabled?: boolean
}

export const ChatInput: FC<Props> = ({ onSend, placeholder = '输入消息...', disabled }) => {
  const [value, setValue] = useState('')

  const handleSubmit = useCallback(
    (msg: string) => {
      const trimmed = msg.trim()
      if (!trimmed) return
      onSend(trimmed)
      setValue('')
    },
    [onSend],
  )

  return (
    <div className='border-t border-[#45475a] px-2 py-2'>
      <Sender
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        placeholder={placeholder}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        submitType='enter'
      />
    </div>
  )
}
