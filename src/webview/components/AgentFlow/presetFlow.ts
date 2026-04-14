import type { Flow } from '@/common'

/**
 * 预定义示例 Flow — 软件开发工作流
 *
 * 流程：需求分析 → 方案设计 → (并行) 编码实现 / 编写测试 → 代码审查 → 完成
 */
export const presetFlow: Flow = {
  name: '软件开发工作流',
  agents: [
    {
      agent_name: '需求分析',
      agent_prompt: [
        '你是一个需求分析专家。',
        '仔细分析用户提出的需求，将其拆解为清晰的功能点和验收标准。',
        '确认需求后，选择 "方案设计" 进入下一步。',
      ],
      is_entry: true,
      outputs: [
        {
          output_name: '方案设计',
          output_desc: '需求已明确，进入方案设计阶段',
          next_agent: '方案设计',
        },
      ],
    },
    {
      agent_name: '方案设计',
      agent_prompt: [
        '你是一个软件架构师。',
        '根据需求设计技术方案，包括模块划分、接口定义、数据模型等。',
        '方案确定后，并行启动编码和测试编写。',
      ],
      outputs: [
        {
          output_name: '编码实现',
          output_desc: '方案已确认，开始编码',
          next_agent: '编码实现',
        },
        {
          output_name: '编写测试',
          output_desc: '方案已确认，开始编写测试用例',
          next_agent: '编写测试',
        },
      ],
    },
    {
      agent_name: '编码实现',
      agent_prompt: [
        '你是一个资深开发工程师。',
        '根据技术方案编写高质量代码，确保代码风格一致、逻辑清晰。',
        '编码完成后提交代码审查。',
      ],
      outputs: [
        {
          output_name: '代码审查',
          output_desc: '编码完成，提交审查',
          next_agent: '代码审查',
        },
      ],
    },
    {
      agent_name: '编写测试',
      agent_prompt: [
        '你是一个测试工程师。',
        '根据技术方案编写单元测试和集成测试用例，覆盖核心逻辑和边界条件。',
        '测试用例编写完成后提交审查。',
      ],
      outputs: [
        {
          output_name: '代码审查',
          output_desc: '测试编写完成，提交审查',
          next_agent: '代码审查',
        },
      ],
    },
    {
      agent_name: '代码审查',
      agent_prompt: [
        '你是一个代码审查专家。',
        '审查代码和测试的质量，检查潜在问题和改进点。',
        '如果审查通过则完成流程，否则退回修改。',
      ],
      outputs: [
        {
          output_name: '审查通过',
          output_desc: '代码质量合格，流程完成',
        },
        {
          output_name: '需要修改',
          output_desc: '发现问题，退回编码修改',
          next_agent: '编码实现',
        },
      ],
    },
  ],
}
