import { type Node, type Edge, MarkerType } from '@xyflow/react'
import type { Agent, Flow, Output } from '@/common'

// ── Node / Edge 数据类型 ────────────────────────────────────────────────────

/** Agent 节点携带的额外数据 */
export type AgentNodeData = {
  agent: Agent
  label: string
  isEntry: boolean
  outputs: Output[]
  allAgentNames?: string[]
  onSaveAgent?: (originalName: string, agent: Agent) => void
  onOpenChat?: (agentName: string) => void
  onRun?: (agentName: string) => void
  readOnly?: boolean
  runningAgentName?: string | null
}

/** Agent 节点类型 */
export type AgentNode = Node<AgentNodeData, 'agent'>

// ── Flow → ReactFlow 转换 ──────────────────────────────────────────────────

/** 将 Flow 中的 Agent 列表布局为 ReactFlow 节点 */
function agentsToNodes(agents: Agent[]): AgentNode[] {
  // 简易分层布局：entry 节点在顶层，之后按 BFS 层级递增 y
  const entryAgents = agents.filter((a) => a.is_entry)
  const entryNames = new Set(entryAgents.map((a) => a.agent_name))

  // BFS 分层
  const levelMap = new Map<string, number>()
  const queue: Array<{ name: string; level: number }> = entryAgents.map((a) => ({
    name: a.agent_name,
    level: 0,
  }))

  // 未被连接的节点放到最后一层
  const maxLevel = agents.length
  for (const a of agents) {
    if (!entryNames.has(a.agent_name)) {
      levelMap.set(a.agent_name, maxLevel)
    }
  }

  while (queue.length > 0) {
    const { name, level } = queue.shift()!
    if (levelMap.has(name) && levelMap.get(name)! <= level) continue
    levelMap.set(name, level)

    const agent = agents.find((a) => a.agent_name === name)
    if (!agent?.outputs) continue
    for (const output of agent.outputs) {
      if (
        output.next_agent &&
        (!levelMap.has(output.next_agent) || levelMap.get(output.next_agent)! > level + 1)
      ) {
        queue.push({ name: output.next_agent, level: level + 1 })
      }
    }
  }

  // 按层级分组，计算 x, y
  const levelGroups = new Map<number, Agent[]>()
  for (const agent of agents) {
    const level = levelMap.get(agent.agent_name) ?? maxLevel
    if (!levelGroups.has(level)) levelGroups.set(level, [])
    levelGroups.get(level)!.push(agent)
  }

  const X_GAP = 280
  const Y_GAP = 160

  const nodes: AgentNode[] = []
  const sortedLevels = [...levelGroups.entries()].sort(([a], [b]) => a - b)

  for (const [level, group] of sortedLevels) {
    const totalWidth = (group.length - 1) * X_GAP
    group.forEach((agent, idx) => {
      nodes.push({
        id: agent.agent_name,
        type: 'agent',
        position: { x: idx * X_GAP - totalWidth / 2 + 400, y: level * Y_GAP + 60 },
        data: {
          agent,
          label: agent.agent_name,
          isEntry: !!agent.is_entry,
          outputs: agent.outputs ?? [],
        },
      })
    })
  }

  return nodes
}

/** 将 Flow 中 Agent 的 outputs 转换为 ReactFlow 边 */
function agentsToEdges(agents: Agent[]): Edge[] {
  const edges: Edge[] = []
  for (const agent of agents) {
    for (const output of agent.outputs ?? []) {
      if (!output.next_agent) continue
      edges.push({
        id: `${agent.agent_name}->${output.next_agent}:${output.output_name}`,
        source: agent.agent_name,
        target: output.next_agent,
        sourceHandle: `output-${output.output_name}`,
        type: 'midArrow',
        animated: false,
        style: { stroke: '#6366f1', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
      })
    }
  }
  return edges
}

/** 将 Flow 转换为 ReactFlow 的节点和边 */
export function flowToReactFlow(flow: Flow): { nodes: AgentNode[]; edges: Edge[] } {
  const agents = flow.agents ?? []
  return {
    nodes: agentsToNodes(agents),
    edges: agentsToEdges(agents),
  }
}

// ── ReactFlow → Flow 转换 ──────────────────────────────────────────────────

/** 从 ReactFlow 的节点和边还原 Flow */
export function reactFlowToFlow(id: string, name: string, nodes: AgentNode[], edges: Edge[]): Flow {
  const agentMap = new Map<string, Agent>()

  // 先把节点还原为 Agent（不含 outputs）
  for (const node of nodes) {
    agentMap.set(node.id, {
      ...node.data.agent,
      agent_name: node.id,
      outputs: [],
    })
  }

  // 从边还原 outputs
  for (const edge of edges) {
    const sourceAgent = agentMap.get(edge.source)
    if (!sourceAgent) continue
    const outputName = edge.sourceHandle?.startsWith('output-')
      ? edge.sourceHandle.slice('output-'.length)
      : 'default'
    const sourceNode = nodes.find((n) => n.id === edge.source)
    const originalOutput = sourceNode?.data.agent.outputs?.find((o) => o.output_name === outputName)
    sourceAgent.outputs = sourceAgent.outputs ?? []
    sourceAgent.outputs.push({
      output_name: outputName,
      output_desc: originalOutput?.output_desc ?? '',
      next_agent: edge.target,
    })
  }

  return {
    id,
    name,
    agents: [...agentMap.values()],
  }
}
