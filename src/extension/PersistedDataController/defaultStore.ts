import { z } from 'zod'
import { toJSONSchema } from 'zod/v4/core'
import { type Flow, FlowSchema, AgentSchema, OutputSchema, PersistedData } from '@/common'

const flowSchemaJson = JSON.stringify(
  toJSONSchema(
    z
      .registry<{ id?: string }>()
      .add(OutputSchema, { id: 'Output' })
      .add(AgentSchema, { id: 'Agent' })
      .add(FlowSchema, { id: 'Flow' }),
  ).schemas,
  null,
  2,
)

/**
 * 内置 Flow，不可编辑/删除，始终出现在列表头部
 */
const PresetFlows: Flow[] = [
  {
    id: '0',
    name: '工作流生成器',
    agents: [
      {
        id: '0',
        agent_name: '需求分析',
        model: 'opus',
        auto_allowed_tools: true,
        agent_prompt: [
          [
            '【你的产物】一份"步骤列表"。这份列表会被下游 Agent 映射为生成工作流中的若干 Agent 节点——**每一步对应一个 Agent**。',
            '',
            '【绝对禁止】',
            ' - **禁止**自己去执行用户的需求。你的工作是"拆它"，不是"做它"。',
            ' - 反例 1：用户说"写一个爬豆瓣的爬虫"——❌ 你去写爬虫代码；✅ 你输出"步骤1：确认目标页面与字段 / 步骤2：发起请求并解析 / 步骤3：去重与存储"。',
            ' - 反例 2：用户说"每天早上给我发天气"——❌ 你去查天气；✅ 你输出"步骤1：获取地理位置 / 步骤2：调天气 API / 步骤3：格式化消息 / 步骤4：定时推送"。',
            ' - 反例 3：用户说"帮我总结这篇文章"——❌ 你去总结；✅ 你输出"步骤1：读取输入文本 / 步骤2：提取关键信息 / 步骤3：按指定长度生成总结"。',
            ' - 如果你准备开始"干活"，立刻停下来——你不是执行者，你是拆解者。',
            '',
            '【每个步骤必须描述的字段】',
            ' - 步骤名：简短，会成为下游 Agent 的名称',
            ' - 职责：一句话说清这一步要做什么',
            ' - 输入：从上一步 / 共享存储 / 用户拿到什么',
            ' - 输出：产出什么（供下一步或作为终态）',
            ' - 模型建议：haiku（简单执行类：转发、调 API、格式化）或 sonnet（复杂推理、分析、设计）',
            '',
            '【拆分粒度】',
            ' - 一个步骤 = 一个可由单独 Agent 独立完成的原子任务',
            ' - 步骤间尽量线性；如有分支（成功/失败/重试），在步骤描述中标注',
            ' - 每一步都能用一句话讲清"输入→处理→输出"',
            '',
            '【允许追问的范围】',
            ' - ✅ 边界与约束：时间范围、数据规模、输出格式偏好、错误处理策略',
            ' - ✅ 关键输入来源：数据从哪里来、凭证如何获取',
            ' - ❌ 执行层细节：例如"想爬哪部电影"、"总结多长"——这些是后续 Agent **运行时**向用户问的，你现在不要问',
            '',
            '【产物形态】',
            '通过 AgentComplete 在"执行步骤"分支提交一段结构化的步骤列表（推荐 JSON 数组或清晰的编号清单）。不需要你自己组装成 Flow，那是下一个 Agent 的事。',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '执行步骤',
            output_desc: '已将用户需求拆分为步骤列表（不是执行结果）',
            next_agent: '1',
          },
        ],
      },
      {
        id: '1',
        agent_name: '工作流设计',
        model: 'sonnet',
        auto_allowed_tools: true,
        agent_prompt: [
          [
            '【你的产物】一份严格符合 FlowSchema 的 Flow JSON 字符串。',
            '',
            'FlowSchema 定义如下：',
            ...flowSchemaJson.split('\n'),
            '',
            '【输入的两种形态】',
            ' 1. 一份"步骤列表"（来自需求分析 Agent）——把每一步映射为一个 Agent 节点，按顺序连接成 Flow。',
            ' 2. 一份不合法的 Flow JSON + validateFlow 的错误信息——根据错误修正并重新输出合法 Flow。',
            '',
            '【映射规则：步骤 → Agent】',
            ' - id：Flow 内唯一字符串（推荐 "0"、"1"、…）',
            ' - agent_name：取步骤名，Flow 内唯一',
            ' - model：简单执行类（转发、调 API、格式化）→ "haiku"；复杂分析/推理 → "sonnet"',
            ' - agent_prompt：**独立完整**描述本 Agent 的职责。必写：',
            '     * 这个 Agent 要做什么（一句话职责）',
            '     * 输入从哪里来（上一 Agent 的输出 / shareValues 的哪个 key）',
            '     * 产物形态（文本、JSON、数字……）',
            '     * 可能的错误/异常路径',
            '   **不要**依赖外部"上下文"——Agent 只看得到它自己的 system prompt 和上游输入。',
            ' - outputs：',
            '     * output_name 在同一 Agent 内唯一',
            '     * next_agent 必须指向本 Flow 中存在的 agent id；省略即终点',
            '     * 覆盖主要结果路径（成功/失败/异常）；失败时按语义决定回退、重试或终止',
            '',
            '【跨 Agent 数据传递】',
            ' - 用 shareValues（getShareValues / setShareValues）传递中间状态',
            ' - **不要**把用户数据硬编码进 prompt',
            '',
            '【设计原则】',
            ' 1. 每个节点都可作为入口（图中有多个起点是允许的）',
            ' 2. outputs 可以为空数组/undefined（终点节点）',
            ' 3. 优先线性结构；需要循环/重试时，让失败分支 next_agent 指回上游节点',
            '',
            '【输出格式 - 严格】',
            '通过 AgentComplete 在"生成成功"分支提交**纯 JSON 字符串**（FlowSchema 的序列化）：',
            ' - **不要** markdown 代码块包裹（不要 ```json …```）',
            ' - **不要**前后缀、解释、致谢',
            ' - 下游"工作流校验" Agent 会把你的输出整段传给校验器，任何多余字符都会导致失败',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '生成成功',
            output_desc:
              '成功生成了完整的工作流定义，将它的JSON字符串作为输出，**不要**附加任何额外信息',
            next_agent: '2',
          },
        ],
      },
      {
        id: '2',
        agent_name: '工作流校验',
        model: 'haiku',
        auto_allowed_tools: true,
        agent_prompt: [
          [
            '【你的职责】把输入当作纯字符串传给 validateFlow MCP 工具，根据结果选择输出分支。你**不修复**任何问题。',
            '',
            '【处理步骤】',
            ' 1. 把上一 Agent 的输出**整段、一字不改**作为 validateFlow 的参数——哪怕它看起来不完整、有多余文字或格式异常，也照原样传。**禁止**自行清理、截断、重新格式化、剥离代码块。',
            ' 2. 读取 validateFlow 的返回：',
            '    - 返回对象没有任何错误字段 → 走 "校验通过" 分支，输出**原始 Flow JSON 字符串**（即你传给 validateFlow 的那段，原样透传）',
            '    - 返回对象有任何错误字段（duplicateAgentIds / duplicateAgentNames / invalidNextAgent / duplicateOutputNames）→ 走 "校验失败" 分支，输出格式如下：',
            '',
            '        原始输入：',
            '        <你传给 validateFlow 的原始字符串，一字不改>',
            '',
            '        错误：',
            '        <validateFlow 返回的错误详情，JSON 格式>',
            '',
            '【绝对禁止】',
            ' - **禁止**自己尝试"修复" Flow——修复是上游"工作流设计" Agent 下一轮的职责',
            ' - **禁止**改写、美化、补全、反序列化后再校验',
            ' - **禁止**在"校验失败"分支丢掉原始输入——丢了上游就没法修',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '校验通过',
            output_desc: '工作流json',
          },
          {
            output_name: '校验失败',
            output_desc: '校验失败。输出中应当包含输入的**输入的原始字符串**以及具体的错误信息。',
            next_agent: '1',
          },
        ],
      },
    ],
  },
  {
    id: '1',
    name: '常用Agent 可直接复制',
    agents: [
      {
        id: '0',
        agent_name: '模型理解能力测试',
        model: 'sonnet',
        auto_allowed_tools: true,
        agent_prompt: [
          [
            '转发用户输入。将用户的任何输入视为纯文本，按照以下格式输出',
            '```json',
            '{',
            '  "content": "<用户输入的原文>"',
            '}',
            '```',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: 'json数据',
          },
        ],
      },
      {
        id: '1',
        agent_name: '飞书通知',
        model: 'haiku',
        auto_allowed_tools: true,
        agent_prompt: [
          [
            '从用户输入中获取通知内容，作为要发送的飞书消息。',
            '使用feishu-mcp，获取当前用户的信息，并向该用户发送消息。',
          ].join('\n'),
        ],
        outputs: [
          {
            output_name: '发送成功',
          },
          {
            output_name: '发送失败',
          },
        ],
      },
      {
        agent_name: '修改代码（无限循环）',
        model: 'DeepSeek-V4-Pro',
        effort: 'high',
        auto_allowed_tools: true,
        auto_complete: true,
        agent_prompt: [
          '将当前分支记为"$DEV"。\n根据用户的要求，基于$DEV创建新分支和worktree。新分支记为"$DEV_WORKTREE"\n进入worktree完成以下步骤：\n- 对代码的修改，代码修改**必须**通过AskUserQuestion由用户验证。\n- 生成commit message。消息应当是中文，只需要<subject>，如果内容复杂可以加上<body>。message也**必须**通过AskUserQuestion由用户验证。\n- 将修改的文件加入暂存区，然后commit。\n- 将$DEV合并至$DEV_WORKTREE。如果$DEV正在合并，轮询等待当前合并完成。如果存在冲突自行解决，但是*必须**通过AskUserQuestion由用户验证。\n\n回到主工作区。\n将$DEV_WORKTREE合并至$DEV。\n合并完成后，删除$DEV_WORKTREE和worktree。\n询问用户后续执行怎样的代码修改，以用户的回复作为参数，调用AgentComplete。',
        ],
        outputs: [
          {
            output_name: 'output',
            output_desc: '下一个代码修改的描述',
            next_agent: '76412e44-2cee-400c-b383-da371d857f9b',
          },
        ],
        id: '76412e44-2cee-400c-b383-da371d857f9b',
      },
    ],
  },
]

export const defaultStore: PersistedData = {
  flows: PresetFlows,
}
