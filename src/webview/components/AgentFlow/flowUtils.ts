import { type Node, type Edge, MarkerType } from '@xyflow/react'
import type { Agent, Flow } from '@/common'

// ── Node / Edge 数据类型 ────────────────────────────────────────────────────

/** Agent 节点携带的额外数据（其他数据通过 FlowStore 获取） */
export type AgentNodeData = {
  flowId: string
  agentId: string
  agentName: string
}

/** Agent 节点类型 */
export type AgentNode = Node<AgentNodeData, 'agent'>

// ── Flow → ReactFlow 转换 ──────────────────────────────────────────────────

/** 将 Flow 中的 Agent 列表布局为 ReactFlow 节点 */
function agentsToNodes(flowId: string, agents: Agent[]): AgentNode[] {
  const ids = new Set(agents.map((a) => a.id))

  // BFS 分层
  const levelMap = new Map<string, number>()
  const queue: Array<{ id: string; level: number }> = agents.map((a) => ({
    id: a.id,
    level: 0,
  }))

  // 未被连接的节点放到最后一层
  const maxLevel = agents.length
  for (const a of agents) {
    if (!ids.has(a.id)) {
      levelMap.set(a.id, maxLevel)
    }
  }

  while (queue.length > 0) {
    const { id, level } = queue.shift()!
    if (levelMap.has(id) && levelMap.get(id)! <= level) continue
    levelMap.set(id, level)

    const agent = agents.find((a) => a.id === id)
    if (!agent?.outputs) continue
    for (const output of agent.outputs) {
      if (
        output.next_agent &&
        (!levelMap.has(output.next_agent) || levelMap.get(output.next_agent)! > level + 1)
      ) {
        queue.push({ id: output.next_agent, level: level + 1 })
      }
    }
  }

  // 按层级分组，计算 x, y
  const levelGroups = new Map<number, Agent[]>()
  for (const agent of agents) {
    const level = levelMap.get(agent.id) ?? maxLevel
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
        id: agent.id,
        type: 'agent',
        position: { x: idx * X_GAP - totalWidth / 2 + 400, y: level * Y_GAP + 60 },
        data: {
          flowId,
          agentId: agent.id,
          agentName: agent.agent_name,
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
        id: `${agent.id}->${output.next_agent}:${output.output_name}`,
        source: agent.id,
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
    nodes: agentsToNodes(flow.id, agents),
    edges: agentsToEdges(agents),
  }
}

// ── ReactFlow → Flow 转换 ──────────────────────────────────────────────────

/** 从 ReactFlow 的节点和边还原 Flow */
export function reactFlowToFlow(
  id: string,
  name: string,
  agents: Agent[],
  nodes: AgentNode[],
  edges: Edge[],
): Flow {
  const agentMap = new Map<string, Agent>()

  // 先把节点还原为 Agent，保留原始 outputs（清空 next_agent 以便从边重建）
  for (const node of nodes) {
    const originalAgent = agents.find((a) => a.id === node.id)
    agentMap.set(node.id, {
      ...(originalAgent ?? {
        id: node.id,
        agent_name: node.data.agentName,
        model: '',
        agent_prompt: [],
      }),
      agent_name: node.data.agentName,
      outputs: originalAgent?.outputs?.map((o) => ({ ...o, next_agent: undefined })) ?? [],
    })
  }

  // 从边还原 outputs 的 next_agent
  for (const edge of edges) {
    const sourceAgent = agentMap.get(edge.source)
    if (!sourceAgent) continue
    const outputName = edge.sourceHandle?.startsWith('output-')
      ? edge.sourceHandle.slice('output-'.length)
      : 'default'
    const existingOutput = sourceAgent.outputs?.find((o) => o.output_name === outputName)
    if (existingOutput) {
      existingOutput.next_agent = edge.target
    } else {
      // edge 引用了原始 agent 中不存在的 output，追加
      const originalAgent = agents.find((a) => a.id === edge.source)
      const originalOutput = originalAgent?.outputs?.find((o) => o.output_name === outputName)
      sourceAgent.outputs = sourceAgent.outputs ?? []
      sourceAgent.outputs.push({
        output_name: outputName,
        output_desc: originalOutput?.output_desc ?? '',
        next_agent: edge.target,
      })
    }
  }

  return {
    id,
    name,
    agents: [...agentMap.values()],
  }
}
