import { useEffect } from 'react'
import type { FC } from 'react'
import { Modal, Form, Input, Switch, Select, AutoComplete, Button, Tooltip } from 'antd'
import { useWatch } from 'antd/es/form/Form'
import { PlusOutlined, MinusCircleOutlined } from '@ant-design/icons'
import { InfoCircleOutlined } from '@ant-design/icons'
import type { Agent } from '@/common'
import { BUILTIN_TOOL_NAMES, MCP_WILDCARD, buildAgentSystemPrompt } from '@/common'

const FormItem = Form.Item<Agent>

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
      const newFormValue: Omit<Agent, 'id'> = {
        agent_name: agent.agent_name,
        agent_desc: agent.agent_desc,
        model: agent.model,
        effort: agent.effort,
        agent_prompt: agent.agent_prompt,
        auto_allowed_tools: agent.auto_allowed_tools,
        must_confirm_tools: agent.must_confirm_tools,
        work_mode: agent.work_mode ?? 'auto_complete',
        no_input: agent.no_input ?? false,
        enable_share_values: agent.enable_share_values ?? false,
        outputs: (agent.outputs ?? []).map((o) => ({
          output_name: o.output_name,
          output_desc: o.output_desc,
          next_agent: o.next_agent,
        })),
      }
      form.setFieldsValue(newFormValue)
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
      modalRender={(node) => <div onPaste={(e) => e.stopPropagation()}>{node}</div>}
    >
      <Form
        form={form}
        layout='vertical'
        autoComplete='off'
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') {
            e.stopPropagation()
          }
        }}
      >
        <FormItem
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
        </FormItem>

        <FormItem
          name='agent_desc'
          label='Agent 简介'
          tooltip='简要描述该 Agent 的职责与定位，会在系统提示词中作为任务上下文注入'
        >
          <Input placeholder='例如：负责代码评审，检查潜在 bug 与性能问题' />
        </FormItem>

        <div className='flex gap-4'>
          <FormItem
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
                { label: 'gpt-5.5', value: 'gpt-5.5' },
                { label: 'glm-5.1', value: 'glm-5.1' },
                { label: 'DeepSeek-V4-Pro', value: 'DeepSeek-V4-Pro' },
                { label: 'opus4.7', value: 'claude-opus-4-7' },
                { label: 'opus4.6', value: 'claude-opus-4-6-v1' },
                { label: 'sonnet', value: 'sonnet' },
                { label: 'haiku', value: 'haiku' },
                { label: 'gpt-5.4', value: 'gpt-5.4' },
                { label: 'MiniMax-M2.7', value: 'MiniMax-M2.7' },
                { label: 'DeepSeek-V4-flash', value: 'DeepSeek-V4-flash' },
              ]}
              filterOption={(inputValue, option) =>
                option?.value?.toLowerCase().includes(inputValue.toLowerCase()) ?? false
              }
            />
          </FormItem>

          <FormItem name='effort' label='努力程度' className='mb-0 w-56'>
            <Select
              placeholder='默认（不指定）'
              allowClear
              options={[
                { label: 'low — 简单任务', value: 'low' },
                { label: 'medium — 日常任务', value: 'medium' },
                { label: 'high — 复杂任务', value: 'high' },
                { label: 'xhigh — 长程任务(opus4.7+)', value: 'xhigh' },
                { label: 'max — 最大性能(opus4.6+)', value: 'max' },
              ]}
            />
          </FormItem>
        </div>

        <FormItem
          name='auto_allowed_tools'
          label='自动允许的工具'
          tooltip={`不需要用户确认、自动执行的工具。开启「允许全部」或留空表示全部放行；特殊值 "${MCP_WILDCARD}" 匹配所有 mcp__* 工具`}
        >
          <AutoAllowedToolsField />
        </FormItem>

        <FormItem
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
        </FormItem>

        <div className='flex gap-4'>
          <FormItem
            name='work_mode'
            label='完成方式'
            tooltip='auto：直接调用 AgentComplete；confirm：需先用 AskUserQuestion 确认；never：禁止调用 AgentComplete'
          >
            <Select
              options={[
                { value: 'auto_complete', label: '自动完成' },
                { value: 'require_confirm', label: '用户确认后完成' },
                { value: 'never_complete', label: '永不完成' },
              ]}
            />
          </FormItem>

          <FormItem
            name='no_input'
            label='无输入'
            tooltip='开启后节点操作区显示启动按钮，点击时始终以"开始"为初始消息自动运行（忽略用户实际输入）'
            valuePropName='checked'
          >
            <Switch />
          </FormItem>

          <FormItem
            name='enable_share_values'
            label='共享存储'
            tooltip='开启后才会注入 setShareValues / getShareValues / getAllShareValues 工具，并在系统提示词中告知 Agent 共享存储的存在；关闭时本 Agent 完全无感知'
            valuePropName='checked'
          >
            <Switch />
          </FormItem>
        </div>
        <FormItem
          label={
            <span className='flex items-center gap-1 whitespace-nowrap'>
              提示词
              {currentAgent?.agent_prompt ? (
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
          <FormItem
            name='agent_prompt'
            rules={[{ required: true, message: '请输入提示词' }]}
            className='mb-0'
          >
            <Input.TextArea rows={6} placeholder='请输入提示词' />
          </FormItem>
        </FormItem>

        <FormItem label='输出分支'>
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
        </FormItem>
      </Form>
    </Modal>
  )
}
