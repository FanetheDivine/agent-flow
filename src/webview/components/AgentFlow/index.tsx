import { memo, useCallback, useEffect, useMemo, useRef } from 'react'
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
import { useEventListener } from 'ahooks'
import { type Agent } from '@/common'
import { useFlowStore } from '@/webview/store/flow'
import { cn } from '@/webview/utils'
import AgentNodeComponent from './AgentNode'
import MidArrowEdge from './MidArrowEdge'
import './flow.css'
import { flowToReactFlow, reactFlowToFlow, type AgentNode } from './flowUtils'

const nodeTypes = { agent: AgentNodeComponent }
const edgeTypes = { midArrow: MidArrowEdge }

const defaultEdgeOptions: Partial<Edge> = {
  type: 'midArrow',
  animated: false,
  style: { stroke: '#6366f1', strokeWidth: 2 },
  markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1', width: 20, height: 20 },
}

export const AgentFlow: FC<{ flowId: string }> = ({ flowId }) => {
  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))
  const hidden = useFlowStore((s) => s.activeFlowId !== flowId)
  const rendered = useRef(false)
  if (!flow) return null
  // 第一次需要展示时才实际渲染
  // eslint-disable-next-line react-hooks/refs
  if (hidden && !rendered.current) return null
  // eslint-disable-next-line react-hooks/refs
  rendered.current = true
  return <AgentFlowInner flowId={flowId} hidden={hidden} />
}

const AgentFlowInner: FC<{ flowId: string; hidden?: boolean }> = memo(({ flowId, hidden }) => {
  const flow = useFlowStore((s) => s.flows.find((f) => f.id === flowId))!
  const state = useFlowStore((s) => s.flowStates[flowId])
  const saveFlows = useFlowStore((s) => s.saveFlows)
  const runFlow = useFlowStore((s) => s.runFlow)
  const readOnly = state?.status === 'chatting' || state?.status === 'waiting-user'
  const runningAgentName = state?.currentAgentName ?? null
  const { message } = App.useApp()
  const initial = useMemo(() => flowToReactFlow(flow), [flow])

  const [nodes, setNodes, onNodesChange] = useNodesState<AgentNode>(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  // 标记内部变更，避免外部同步覆盖
  const isInternalChange = useRef(false)

  // 外部 flow 变更（如编辑弹窗保存）时，同步节点和边，保留拖拽位置
  useEffect(() => {
    if (isInternalChange.current) {
      isInternalChange.current = false
      return
    }
    const { nodes: newNodes, edges: newEdges } = flowToReactFlow(flow)
    setNodes((prev) => {
      const posMap = new Map(prev.map((n) => [n.id, n.position]))
      return newNodes.map((n) => ({
        ...n,
        position: posMap.get(n.id) ?? n.position,
      }))
    })
    setEdges(newEdges)
  }, [flow, setNodes, setEdges])

  const syncToFlow = useCallback(
    (currentNodes: AgentNode[], currentEdges: Edge[]) => {
      isInternalChange.current = true
      const newFlow = reactFlowToFlow(flow.id, flow.name, currentNodes, currentEdges)
      saveFlows((flows) => {
        const idx = flows.findIndex((f) => f.id === flowId)
        if (idx >= 0) flows[idx] = newFlow
      })
    },
    [flow.id, flow.name, flowId, saveFlows],
  )

  const handleSaveAgent = useCallback(
    (originalName: string, agent: Agent) => {
      saveFlows((flows) => {
        const f = flows.find((f) => f.id === flowId)
        if (!f) return
        f.agents = (f.agents ?? []).map((a) => (a.agent_name === originalName ? agent : a))
      })
    },
    [flowId, saveFlows],
  )

  const handleRun = useCallback(
    (agentName: string) => runFlow(flowId, agentName),
    [flowId, runFlow],
  )

  const allAgentNames = useMemo(() => (flow.agents ?? []).map((a) => a.agent_name), [flow.agents])

  // 注入 readOnly / runningAgentName / allAgentNames / onSaveAgent / onRun 到节点 data
  const enrichedNodes = useMemo(
    () =>
      nodes.map((node) => ({
        ...node,
        data: {
          ...node.data,
          readOnly,
          runningAgentName,
          allAgentNames,
          onSaveAgent: handleSaveAgent,
          onRun: handleRun,
        },
      })),
    [nodes, readOnly, runningAgentName, allAgentNames, handleSaveAgent, handleRun],
  )

  const onConnect = (connection: Connection) => {
    if (readOnly) return
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

  // 复制agent node（支持多选）
  const flowContainerRef = useRef<HTMLDivElement | null>(null)
  useEventListener(
    'keydown',
    (e) => {
      if (e.ctrlKey && e.key === 'c') {
        const selected = nodes.filter((n) => n.selected)
        if (selected.length === 0) return
        e.preventDefault()
        navigator.clipboard
          .writeText(JSON.stringify(selected))
          .then(() => {
            message.success(selected.length > 1 ? `已复制 ${selected.length} 个 Agent` : '复制成功')
          })
          .catch(() => {
            message.warning('复制失败')
          })
      }
    },
    { target: flowContainerRef },
  )

  return (
    <div className={cn('h-full w-full', { hidden })} ref={flowContainerRef} tabIndex={-1}>
      <ReactFlow
        nodes={enrichedNodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={onConnect}
        onDelete={
          readOnly
            ? undefined
            : ({ nodes: deletedNodes, edges: deletedEdges }) => {
                const nodeIds = new Set(deletedNodes.map((n) => n.id))
                const edgeIds = new Set(deletedEdges.map((e) => e.id))
                const remainingNodes = nodes.filter((n) => !nodeIds.has(n.id))
                const remainingEdges = edges.filter((e) => !edgeIds.has(e.id))

                // Clear next_agent references pointing to deleted nodes
                const updatedNodes = remainingNodes.map((n) => {
                  const updatedOutputs = n.data.agent.outputs?.map((o) =>
                    nodeIds.has(o.next_agent ?? '') ? { ...o, next_agent: undefined } : o,
                  )
                  if (!updatedOutputs) return n
                  return {
                    ...n,
                    data: { ...n.data, agent: { ...n.data.agent, outputs: updatedOutputs } },
                  }
                })

                syncToFlow(updatedNodes, remainingEdges)
              }
        }
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={defaultEdgeOptions}
        nodesDraggable
        nodesConnectable={!readOnly}
        elementsSelectable
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        panOnDrag={[1, 2]}
        multiSelectionKeyCode={['Meta', 'Control']}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        deleteKeyCode={readOnly ? null : 'Delete'}
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
})
