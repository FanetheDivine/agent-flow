import { useCallback, useEffect, useRef, useState } from 'react'
import type { FC } from 'react'
import { Button, Tag, Tooltip, type GetRef, type UploadFile } from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import { Attachments, Sender } from '@ant-design/x'
import {
  promoteActiveInput,
  registerActiveInput,
  type CodeRef,
} from '@/webview/utils/activeInputRegistry'

type Props = {
  onSend: (text: string, files: File[], references: CodeRef[]) => void
  placeholder?: string
  disabled?: boolean
  loading?: boolean
  onCancel?: () => void
}

export const ChatInput: FC<Props> = ({
  onSend,
  placeholder = '输入消息...',
  disabled,
  loading,
  onCancel,
}) => {
  const [value, setValue] = useState('')
  const [attachments, setAttachments] = useState<UploadFile[]>([])
  const [references, setReferences] = useState<CodeRef[]>([])
  const [headerOpen, setHeaderOpen] = useState(false)
  const senderRef = useRef<GetRef<typeof Sender>>(null)
  const attachmentsRef = useRef<GetRef<typeof Attachments>>(null)

  const handleSubmit = useCallback(
    (msg: string) => {
      const trimmed = msg.trim()
      const files = attachments
        .map((a) => a.originFileObj as File | undefined)
        .filter((f): f is File => !!f)
      if (!trimmed && files.length === 0 && references.length === 0) return
      onSend(trimmed, files, references)
      setValue('')
      setAttachments([])
      setReferences([])
      setHeaderOpen(false)
    },
    [onSend, attachments, references],
  )

  // 注册自身为“当前 active 输入框”栈的一员；聚焦时置顶
  useEffect(() => {
    const input = {
      addReference: (ref: CodeRef) =>
        setReferences((prev) => [...prev, ref]),
      focus: () => senderRef.current?.focus(),
    }
    const unregister = registerActiveInput(input)
    const el = senderRef.current?.nativeElement
    const handleFocus = () => promoteActiveInput(input)
    el?.addEventListener('focusin', handleFocus)
    return () => {
      el?.removeEventListener('focusin', handleFocus)
      unregister()
    }
  }, [])

  const removeReference = (id: string) =>
    setReferences((prev) => prev.filter((r) => r.id !== id))

  return (
    <div className='shrink-0 border-t border-[#45475a] px-2 py-2'>
      {references.length > 0 && (
        <div className='mb-2 flex flex-wrap gap-1'>
          {references.map((ref) => {
            const range =
              ref.startLine === ref.endLine
                ? `L${ref.startLine}`
                : `L${ref.startLine}-${ref.endLine}`
            return (
              <Tooltip
                key={ref.id}
                title={
                  <pre className='m-0 max-h-40 overflow-auto text-xs whitespace-pre-wrap'>
                    {ref.text}
                  </pre>
                }
              >
                <Tag
                  closable
                  onClose={() => removeReference(ref.id)}
                  style={{ margin: 0 }}
                >
                  <LinkOutlined /> {ref.filename} {range}
                </Tag>
              </Tooltip>
            )
          })}
        </div>
      )}
      <Sender
        ref={senderRef}
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        onCancel={onCancel}
        loading={loading}
        placeholder={placeholder}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        submitType='enter'
        allowSpeech
        header={
          <Sender.Header
            title='附件'
            open={headerOpen}
            onOpenChange={setHeaderOpen}
            styles={{ content: { padding: 0 } }}
          >
            <Attachments
              ref={attachmentsRef}
              items={attachments}
              beforeUpload={() => false}
              onChange={({ fileList }: { fileList: UploadFile[] }) =>
                setAttachments(fileList)
              }
              overflow='scrollX'
              placeholder={{
                title: '拖放任意数量的文件',
                description: '或点击右上按钮选择',
              }}
            />
          </Sender.Header>
        }
        prefix={
          <Button
            type='text'
            size='small'
            icon={<LinkOutlined />}
            onClick={() => {
              setHeaderOpen(true)
              attachmentsRef.current?.select({ multiple: true })
            }}
          />
        }
      />
    </div>
  )
}
