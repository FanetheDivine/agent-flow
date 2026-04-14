import { useCallback, useMemo } from 'react'
import type { FC } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  type Connection,
  type Edge,
  BackgroundVariant,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { Flow } from '@/common'
import { cn } from '@/webview/utils'
import AgentNodeComponent from './AgentNode'
import MidArrowEdge from './MidArrowEdge'
import { flowToReactFlow, reactFlowToFlow, type AgentNode } from './flowUtils'

export type AgentFlowProps = {
  /** Flow 定义 */
  flow: Flow
  /** Flow 变更回调 */
  onFlowChange?: (flow: Flow) => void
  /** 模式：edit 允许调整连线，run 为只读 */
  mode?: 'edit' | 'run'
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
  const { flow, onFlowChange, mode = 'edit', className, style } = props
  const readOnly = mode === 'run'

  const initial = useMemo(() => flowToReactFlow(flow), [flow])

  const [nodes, , onNodesChange] = useNodesState<AgentNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  const onConnect = useCallback(
    (connection: Connection) => {
      if (readOnly) return
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: 'midArrow',
            animated: false,
            style: { stroke: '#6366f1', strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
          },
          eds,
        ),
      )
    },
    [readOnly, setEdges],
  )

  const syncToFlow = useCallback(() => {
    if (!onFlowChange) return
    const newFlow = reactFlowToFlow(flow.name, nodes, edges)
    onFlowChange(newFlow)
  }, [flow.name, nodes, edges, onFlowChange])

  return (
    <div className={cn('h-full w-full', className)} style={style}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={onConnect}
        onNodeDragStop={syncToFlow}
        onEdgesDelete={syncToFlow}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        nodesDraggable
        elementsSelectable
        nodesConnectable={!readOnly}
        deleteKeyCode={readOnly ? null : 'Delete'}
        proOptions={{ hideAttribution: true }}
        style={{ background: '#11111b' }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color='#313244' />
        <Controls
          style={{ background: '#1e1e2e', borderColor: '#45475a', borderRadius: 8 }}
          showInteractive={!readOnly}
        />
        <MiniMap
          style={{ background: '#1e1e2e', borderColor: '#45475a', borderRadius: 8 }}
          nodeColor={() => '#6366f1'}
          maskColor='rgba(0,0,0,0.6)'
        />
      </ReactFlow>
    </div>
  )
}
