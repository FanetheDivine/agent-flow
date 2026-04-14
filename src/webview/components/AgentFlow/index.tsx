import { useCallback, useEffect, useMemo } from 'react'
import type { FC } from 'react'
import { App } from 'antd'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  SelectionMode,
  type Connection,
  type Edge,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { AgentSchema, type Flow } from '@/common'
import { cn } from '@/webview/utils'
import AgentNodeComponent from './AgentNode'
import MidArrowEdge from './MidArrowEdge'
import { flowToReactFlow, reactFlowToFlow, type AgentNode } from './flowUtils'

export type AgentFlowProps = {
  /** Flow 定义 */
  flow: Flow
  /** Flow 变更回调 */
  onFlowChange?: (flow: Flow) => void
} & Style

const nodeTypes = { agent: AgentNodeComponent }
const edgeTypes = { midArrow: MidArrowEdge }

const defaultEdgeOptions: Partial<Edge> = {
  type: 'midArrow',
  animated: false,
  style: { stroke: '#6366f1', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
}

export const AgentFlow: FC<AgentFlowProps> = (props) => {
  const { flow, onFlowChange, className, style } = props
  const { message } = App.useApp()
  const initial = useMemo(() => flowToReactFlow(flow), [flow])

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  const syncToFlow = useCallback(
    (currentNodes: AgentNode[], currentEdges: Edge[]) => {
      if (!onFlowChange) return
      onFlowChange(reactFlowToFlow(flow.name, currentNodes, currentEdges))
    },
    [flow.name, onFlowChange],
  )

  const onConnect = (connection: Connection) => {
    const newEdges = addEdge(
      {
        ...connection,
        type: 'midArrow',
        animated: false,
        style: { stroke: '#6366f1', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
      },
      edges.filter(
        (e) => e.source !== connection.source || e.sourceHandle !== connection.sourceHandle,
      ),
    )
    setEdges(newEdges)
    syncToFlow(nodes, newEdges)
  }

  // 复制粘贴node（支持多选）
  useEffect(() => {
    const onCopy = () => {
      const selected = nodes.filter((n) => n.selected)
      if (selected.length === 0) return
      navigator.clipboard
        .writeText(JSON.stringify(selected.map((n) => n.data.agent)))
        .then(() => {
          message.success(selected.length > 1 ? `已复制 ${selected.length} 个节点` : '复制成功')
        })
        .catch(() => {
          message.warning('复制失败')
        })
    }
    const onPaste = async () => {
      const text = await navigator.clipboard.readText()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return
      }
      const candidates = Array.isArray(parsed) ? parsed : [parsed]
      const existingNames = new Set(nodes.map((n) => n.id))
      const newNodes: AgentNode[] = []
      for (const item of candidates) {
        const result = AgentSchema.safeParse(item)
        if (!result.success) continue
        const agent = result.data
        let newName = agent.agent_name
        if (existingNames.has(newName)) {
          newName = `${agent.agent_name}_copy`
          let i = 2
          while (existingNames.has(newName)) {
            newName = `${agent.agent_name}_copy${i++}`
          }
        }
        existingNames.add(newName)
        const newAgent = {
          ...agent,
          agent_name: newName,
          outputs: agent.outputs?.map((o) => ({ ...o, next_agent: undefined })),
        }
        newNodes.push({
          id: newName,
          type: 'agent',
          position: { x: 200 + Math.random() * 100, y: 200 + Math.random() * 100 },
          data: {
            agent: newAgent,
            label: newName,
            isEntry: !!newAgent.is_entry,
            outputs: newAgent.outputs ?? [],
          },
        })
      }
      if (newNodes.length === 0) return
      const allNodes = [...nodes, ...newNodes]
      setNodes(allNodes)
      syncToFlow(allNodes, edges)
    }
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'c') onCopy()
      if (e.ctrlKey && e.key === 'v') onPaste()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [message, nodes, edges, setNodes, syncToFlow])

  return (
    <div
      className={cn('h-full w-full', className)}
      style={style}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDelete={({ nodes: deletedNodes, edges: deletedEdges }) => {
          const nodeIds = new Set(deletedNodes.map((n) => n.id))
          const edgeIds = new Set(deletedEdges.map((e) => e.id))
          syncToFlow(
            nodes.filter((n) => !nodeIds.has(n.id)),
            edges.filter((e) => !edgeIds.has(e.id)),
          )
        }}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={['Meta', 'Control']}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        deleteKeyCode='Delete'
        proOptions={{ hideAttribution: true }}
        style={{ background: '#11111b' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color='#313244' />
        <Controls style={{ background: '#1e1e2e', borderColor: '#45475a', borderRadius: 8 }} />
        <MiniMap
          style={{ background: '#1e1e2e', borderColor: '#45475a', borderRadius: 8 }}
          nodeColor={() => '#6366f1'}
          maskColor='rgba(0,0,0,0.6)'
        />
      </ReactFlow>
    </div>
  )
}
