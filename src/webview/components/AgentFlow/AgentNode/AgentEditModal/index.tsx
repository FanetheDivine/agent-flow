import { useEffect } from 'react'
import type { FC } from 'react'
import { Modal, Form, Input, Switch, Select, AutoComplete, Button, Tooltip } from 'antd'
import { useWatch } from 'antd/es/form/Form'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { InfoCircleOutlined } from '@ant-design/icons'
import type { Agent } from '@/common'
import { BUILTIN_TOOL_NAMES, MCP_WILDCARD, buildAgentSystemPrompt } from '@/common'

export type AgentEditModalProps = {
  open: boolean
  agent: Agent | null
  allAgents: { id: string; agent_name: string }[]
  onSave: (agent: Agent) => void
  onCancel: () => void
}

const TOOL_OPTIONS = [
  { label: `${MCP_WILDCARD} — 匹配所有 mcp__* 工具`, value: MCP_WILDCARD },
  ...BUILTIN_TOOL_NAMES.map((n) => ({ label: n, value: n })),
]

type AutoAllowedValue = true | string[] | undefined

/** 受控：Switch 开 → true；关 → string[]（默认 []）。兼容 undefined 初值 */
const AutoAllowedToolsField: FC<{
  value?: AutoAllowedValue
  onChange?: (v: AutoAllowedValue) => void
}> = ({ value, onChange }) => {
  const allowAll = value === true
  const list = Array.isArray(value) ? value : []
  return (
    <div className='flex flex-col gap-2'>
      <div className='flex items-center gap-2'>
        <Switch
          size='small'
          checked={allowAll}
          onChange={(checked) => onChange?.(checked ? true : [])}
        />
        <span className='text-[12px] text-[#cdd6f4]'>允许全部工具</span>
      </div>
      {!allowAll && (
        <Select
          mode='tags'
          placeholder='选择或输入工具名（回车添加自定义）'
          value={list}
          onChange={(v) => onChange?.(v as string[])}
          options={TOOL_OPTIONS}
          tokenSeparators={[',', ' ']}
        />
      )}
    </div>
  )
}

export const AgentEditModal: FC<AgentEditModalProps> = (props) => {
  const { open, agent, allAgents, onSave, onCancel } = props
  const [form] = Form.useForm()

  useEffect(() => {
    if (open && agent) {
      form.setFieldsValue({
        agent_name: agent.agent_name,
        model: agent.model,
        effort: agent.effort,
        agent_prompt: agent.agent_prompt,
        auto_allowed_tools: agent.auto_allowed_tools,
        must_confirm_tools: agent.must_confirm_tools,
        auto_complete: agent.auto_complete ?? true,
        outputs: (agent.outputs ?? []).map((o) => ({
          output_name: o.output_name,
          output_desc: o.output_desc,
          next_agent: o.next_agent,
        })),
      })
    }
  }, [open, agent, form])

  const handleOk = () => {
    form.validateFields().then((val: Omit<Agent, 'id'>) => {
      onSave({ ...val, id: agent?.id ?? crypto.randomUUID() })
    })
  }

  const currentAgent = useWatch([], form)

  return (
    <Modal
      title='编辑 Agent'
      open={open}
      onOk={handleOk}
      onCancel={onCancel}
      width={600}
      destroyOnHidden
      modalRender={(node) => (
        <div
          onKeyDown={(e) => {
            if (e.key === 'Escape') return
            e.stopPropagation()
          }}
          onPaste={(e) => e.stopPropagation()}
        >
          {node}
        </div>
      )}
    >
      <Form form={form} layout='vertical' autoComplete='off'>
        <Form.Item
          name='agent_name'
          label='Agent 名称'
          rules={[
            { required: true, message: '请输入名称' },
            () => ({
              validator(_: any, value: string) {
                const currentName = agent?.agent_name
                const others = allAgents.filter((a) => a.agent_name !== currentName)
                if (others.some((a) => a.agent_name === value)) {
                  return Promise.reject(new Error('名称已存在'))
                }
                return Promise.resolve()
              },
            }),
          ]}
        >
          <Input />
        </Form.Item>

        <div className='flex gap-4'>
          <Form.Item
            name='model'
            label='模型'
            rules={[{ required: true, message: '请选择或输入模型' }]}
            className='mb-0 flex-1'
          >
            <AutoComplete
              placeholder='选择或输入模型名称'
              allowClear
              options={[
                { label: 'opus', value: 'opus' },
                { label: 'glm-5.1', value: 'glm-5.1' },
                { label: 'DeepSeek-V4-Pro', value: 'DeepSeek-V4-Pro' },
                { label: 'qwen3.6-plus', value: 'qwen3.6-plus' },
                { label: 'DeepSeek-V3.2', value: 'DeepSeek-V3.2' },
                { label: 'haiku', value: 'haiku' },
                { label: 'sonnet', value: 'sonnet' },
                { label: 'gpt-5.4', value: 'gpt-5.4' },
                { label: 'Minimax-M2.7', value: 'Minimax-M2.7' },
                { label: 'DeepSeek-V4-flash', value: 'DeepSeek-V4-flash' },
              ]}
            />
          </Form.Item>

          <Form.Item name='effort' label='努力程度' className='mb-0 w-56'>
            <Select
              placeholder='默认（不指定）'
              allowClear
              options={[
                { label: 'low — 最快，最少思考', value: 'low' },
                { label: 'medium — 适中', value: 'medium' },
                { label: 'high — 较多思考', value: 'high' },
                { label: 'max — 最大思考（仅 Opus 支持）', value: 'max' },
              ]}
            />
          </Form.Item>
        </div>

        <Form.Item
          name='auto_allowed_tools'
          label='自动允许的工具'
          tooltip={`不需要用户确认、自动执行的工具。开启「允许全部」或留空表示全部放行；特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`}
        >
          <AutoAllowedToolsField />
        </Form.Item>

        <Form.Item
          name='must_confirm_tools'
          label='必须确认的工具'
          tooltip={`每次调用都必须用户确认的工具，优先级高于「自动允许」。特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`}
        >
          <Select
            mode='tags'
            placeholder='选择或输入工具名（回车添加自定义）'
            options={TOOL_OPTIONS}
            tokenSeparators={[',', ' ']}
          />
        </Form.Item>

        <Form.Item
          name='auto_complete'
          label='自动完成'
          tooltip='开启后 Agent 完成任务时直接调用 AgentComplete，无需先向用户确认'
          valuePropName='checked'
        >
          <Switch />
        </Form.Item>

        <Form.Item
          label={
            <span className='flex items-center gap-1 whitespace-nowrap'>
              提示词
              {currentAgent ? (
                <Tooltip
                  title={`完整提示词：\n\n${buildAgentSystemPrompt(currentAgent)}`}
                  styles={{
                    root: {
                      maxWidth: 300,
                      maxHeight: 300,
                      whiteSpace: 'pre-wrap',
                      overflow: 'auto',
                    },
                  }}
                >
                  <InfoCircleOutlined className='text-[#6366f1]' />
                </Tooltip>
              ) : null}
            </span>
          }
        >
          <Form.List name='agent_prompt'>
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <div key={key} className='mb-2 flex items-start gap-2'>
                    <Form.Item
                      {...restField}
                      name={[name]}
                      rules={[{ required: name === 0, message: '请输入提示词' }]}
                      className='mb-0 flex-1'
                    >
                      <Input.TextArea rows={6} placeholder='请输入提示词' />
                    </Form.Item>
                    {/* {fields.length > 1 && (
                      <MinusCircleOutlined
                        className='mt-1.5 cursor-pointer text-[#f38ba8]'
                        onClick={() => remove(name)}
                      />
                    )} */}
                  </div>
                ))}
                {/* <Button type='dashed' onClick={() => add('')} block icon={<PlusOutlined />}>
                  添加提示词
                </Button> */}
              </>
            )}
          </Form.List>
        </Form.Item>

        <Form.Item label='输出分支'>
          <Form.List name='outputs'>
            {(fields, { add, remove }) => (
              <>
                {fields.map(({ key, name, ...restField }) => (
                  <div key={key} className='mb-2 flex items-start gap-2'>
                    <Form.Item
                      {...restField}
                      name={[name, 'output_name']}
                      rules={[
                        { required: true, message: '名称不能为空' },
                        ({ getFieldValue }) => ({
                          validator(_, value) {
                            const outputs = getFieldValue('outputs') || []
                            const names = outputs.map((o: any) => o?.output_name).filter(Boolean)
                            if (names.filter((n: string) => n === value).length > 1) {
                              return Promise.reject(new Error('名称重复'))
                            }
                            return Promise.resolve()
                          },
                        }),
                      ]}
                      className='mb-0 flex-1'
                    >
                      <Input placeholder='分支名称' size='small' />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'output_desc']} className='mb-0 flex-1'>
                      <Input placeholder='分支描述' size='small' />
                    </Form.Item>
                    <Form.Item {...restField} name={[name, 'next_agent']} className='mb-0 w-36'>
                      <Select
                        placeholder='下一个 Agent'
                        size='small'
                        allowClear
                        // 包含自身，支持循环
                        options={allAgents.map((a) => ({ label: a.agent_name, value: a.id }))}
                      />
                    </Form.Item>
                    <MinusCircleOutlined
                      className='mt-1.5 cursor-pointer text-[#f38ba8]'
                      onClick={() => remove(name)}
                    />
                  </div>
                ))}
                <Button
                  type='dashed'
                  onClick={() =>
                    add({
                      output_name: 'output',
                    })
                  }
                  block
                  icon={<PlusOutlined />}
                >
                  添加输出分支
                </Button>
              </>
            )}
          </Form.List>
        </Form.Item>
      </Form>
    </Modal>
  )
}
