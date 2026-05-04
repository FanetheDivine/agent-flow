import { useCallback, useEffect, useRef, useState } from 'react'
import type { FC } from 'react'
import { Button, Tag, type GetRef, type UploadFile } from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import { Attachments, Sender } from '@ant-design/x'
import {
  promoteActiveInput,
  registerActiveInput,
  type CodeRef,
} from '@/webview/utils/activeInputRegistry'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'

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
      if (loading) return
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
    [onSend, attachments, references, loading],
  )

  // 注册自身为“当前 active 输入框”栈的一员；聚焦时置顶
  useEffect(() => {
    const input = {
      addReference: (ref: CodeRef) => setReferences((prev) => [...prev, ref]),
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

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if ((e.nativeEvent as KeyboardEvent).isComposing) return

    if (loading) {
      e.preventDefault()
      return
    }

    if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault()
      return false
    }
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
      e.preventDefault()
      const target = e.target as HTMLTextAreaElement
      const start = target.selectionStart ?? value.length
      const end = target.selectionEnd ?? value.length
      const next = value.slice(0, start) + '\n' + value.slice(end)
      setValue(next)
      requestAnimationFrame(() => {
        target.selectionStart = target.selectionEnd = start + 1
      })
      return false
    }
  }

  const handlePasteFile = (files: FileList) => {
    const newFiles: UploadFile[] = Array.from(files).map((file, i) => ({
      uid: `paste-${Date.now()}-${i}`,
      name: file.name || `pasted.${file.type.split('/')[1] || 'bin'}`,
      status: 'done' as const,
      originFileObj: file as any,
    }))
    setAttachments((prev) => [...prev, ...newFiles])
    setHeaderOpen(true)
  }

  const removeReference = (id: string) => setReferences((prev) => prev.filter((r) => r.id !== id))

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
              <Tag
                key={ref.id}
                closable
                onClose={() => removeReference(ref.id)}
                style={{ margin: 0, cursor: 'pointer' }}
                onClick={() =>
                  postMessageToExtension({
                    type: 'openFile',
                    data: { filename: ref.filename, line: ref.startLine },
                  })
                }
              >
                <LinkOutlined /> {ref.filename} {range}
              </Tag>
            )
          })}
        </div>
      )}
      <Sender
        ref={senderRef}
        onPasteFile={handlePasteFile}
        value={value}
        onChange={setValue}
        onSubmit={handleSubmit}
        onKeyDown={handleKeyDown}
        onCancel={onCancel}
        loading={loading}
        placeholder={placeholder}
        disabled={disabled}
        autoSize={{ minRows: 1, maxRows: 4 }}
        submitType='enter'
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
              onChange={({ fileList }: { fileList: UploadFile[] }) => setAttachments(fileList)}
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
