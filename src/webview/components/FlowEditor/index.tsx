import { useEffect, useRef, useState, type FC } from 'react'
import { Drawer, Form, Input, Button, Select, Tag, Switch } from 'antd'
import { CloseOutlined, EyeOutlined, EditOutlined } from '@ant-design/icons'
import { XMarkdown } from '@ant-design/x-markdown'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import { Md } from '../text-components'

type FormValues = {
  name: string
  shareValuesKeys: string[]
  shareValues: Record<string, string>
}

export const FlowEditor: FC = () => {
  const editingFlowId = useFlowStore((s) => s.editingFlowId)
  const flows = useFlowStore((s) => s.flows)
  const save = useFlowStore((s) => s.save)
  const setEditingFlowId = useFlowStore((s) => s.setEditingFlowId)
  const setShareValues = useFlowStore((s) => s.setShareValues)
  const runShareValues = useFlowStore((s) =>
    editingFlowId ? s.flowRunStates[editingFlowId]?.shareValues : undefined,
  )

  const open = !!editingFlowId
  const flow = flows.find((f) => f.id === editingFlowId)

  const [form] = Form.useForm<FormValues>()
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [previewMode, setPreviewMode] = useState<'edit' | 'preview'>('edit')

  const watchedShareValues = (Form.useWatch('shareValues', form) ?? {}) as Record<string, string>
  useEffect(() => {
    if (open && flow) {
      // shareValues 是运行时数据，不持久化；未运行时为空对象。
      form.setFieldsValue({
        name: flow.name,
        shareValuesKeys: flow.shareValuesKeys ?? [],
        shareValues: runShareValues ?? {},
      })
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEditingKey(null)
    }
  }, [open, flow, runShareValues, form])

  if (!flow) return null

  const handleClose = () => setEditingFlowId(undefined)

  const handleFinish = (values: FormValues) => {
    const keys = values.shareValuesKeys ?? []
    const sourceValues = form.getFieldsValue(true)?.shareValues ?? {}
    const cleanedValues = Object.fromEntries(
      keys
        .map((k) => (typeof sourceValues[k] === 'string' ? [k, sourceValues[k]] : null))
        .filter(Boolean) as [string, string][],
    )
    const removedKeys = (flow.shareValuesKeys ?? []).filter((k) => !keys.includes(k))
    save((draft) => {
      const target = draft.find((f) => f.id === flow.id)
      if (!target) return
      target.name = values.name.trim() || target.name
      target.shareValuesKeys = keys
      for (const agent of target.agents ?? []) {
        if (agent.allowed_read_share_values_keys) {
          agent.allowed_read_share_values_keys = agent.allowed_read_share_values_keys.filter(
            (k) => !removedKeys.includes(k),
          )
        }
        if (agent.allowed_write_share_values_keys) {
          agent.allowed_write_share_values_keys = agent.allowed_write_share_values_keys.filter(
            (k) => !removedKeys.includes(k),
          )
        }
      }
    })
    // shareValues 是运行时数据，不进入持久化的 Flow 定义；
    // 通过单独的 setShareValues 命令同步到运行中的 RunState（无 active run 时为 no-op）。
    setShareValues(flow.id, cleanedValues)
    handleClose()
  }

  const editingValue = editingKey ? (watchedShareValues[editingKey] ?? '') : ''

  return (
    <Drawer
      key={flow.id}
      title={null}
      placement='left'
      open={open}
      onClose={handleClose}
      size='auto'
      styles={{
        header: { display: 'none' },
        body: { padding: 0 },
        wrapper: { transition: 'none' },
      }}
      footer={null}
    >
      <Form
        form={form}
        layout='vertical'
        autoComplete='off'
        className='flex h-full'
        onKeyDown={(e) => {
          if (e.key === 'Escape' || e.key === 'Tab') return
          e.stopPropagation()
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onPaste={(e) => e.stopPropagation()}
        onFinish={handleFinish}
      >
        <div className='flex flex-col' style={{ width: 480 }}>
          <div className='border-b border-[#313244] px-3 py-2 text-xs font-bold'>
            <CloseOutlined onClick={handleClose} className='mr-2' />
            <span>编辑工作流</span>
          </div>
          <div className='flex-1 overflow-auto'>
            <div className='p-4'>
              <Form.Item
                name='name'
                label='名称'
                rules={[{ required: true, message: '请输入名称' }]}
              >
                <Input placeholder='工作流名称' />
              </Form.Item>

              <Form.Item
                name='shareValuesKeys'
                label='共享数据'
                tooltip='点 tag 打开右侧面板编辑值；点叉号删除该 key'
                rules={[
                  {
                    validator: (_, val: string[] = []) =>
                      val.length === new Set(val).size
                        ? Promise.resolve()
                        : Promise.reject(new Error('Key 不能重复')),
                  },
                ]}
              >
                <Select
                  mode='tags'
                  placeholder='输入 key 后回车添加'
                  tokenSeparators={[',', ' ']}
                  open={false}
                  suffixIcon={null}
                  tagRender={({ label, value, closable, onClose }) => {
                    const key = String(value)
                    const isActive = key === editingKey
                    return (
                      <Tag
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                        }}
                        closable={closable}
                        onClose={(e) => {
                          e.preventDefault()
                          onClose()
                          if (editingKey === key) setEditingKey(null)
                        }}
                        onClick={() => {
                          setEditingKey(key)
                          setPreviewMode('preview')
                        }}
                        color={isActive ? 'blue' : undefined}
                        style={{ cursor: 'pointer', marginInlineEnd: 4 }}
                      >
                        {label}
                      </Tag>
                    )
                  }}
                />
              </Form.Item>
            </div>
          </div>
          <div className='border-t border-[#313244] px-4 py-3'>
            <Button type='primary' htmlType='submit' block>
              保存
            </Button>
          </div>
        </div>

        {editingKey && (
          <div className='flex h-full w-150 flex-col overflow-hidden border-l border-[#313244]'>
            <div className='flex items-center gap-2 px-3 py-2'>
              <span className='text-[12px] text-[#a6adc8]'>{editingKey}</span>
              <Switch
                size='small'
                checked={previewMode === 'preview'}
                onChange={(v) => setPreviewMode(v ? 'preview' : 'edit')}
                checkedChildren={<EyeOutlined />}
                unCheckedChildren={<EditOutlined />}
              />
            </div>
            <div className={cn('flex-1 overflow-hidden', { 'px-2': previewMode === 'edit' })}>
              <Form.Item key={editingKey} name={['shareValues', editingKey]} noStyle>
                <Input.TextArea
                  className={cn('hidden h-full w-full resize-none overflow-auto', {
                    block: previewMode === 'edit',
                  })}
                  placeholder='输入共享数据内容'
                />
              </Form.Item>
              {previewMode === 'preview' && (
                <Md
                  content={editingValue}
                  className='h-full overflow-auto p-3 break-all whitespace-pre-wrap'
                ></Md>
              )}
            </div>
          </div>
        )}
      </Form>
    </Drawer>
  )
}
