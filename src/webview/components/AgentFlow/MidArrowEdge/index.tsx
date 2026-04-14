import type { FC } from 'react'
import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'

/** 曲线路径 */
const MidArrowEdge: FC<EdgeProps> = (props) => {
  const {
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style,
    markerEnd,
  } = props

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.6,
  })

  return <BaseEdge id={id} path={edgePath} style={style} markerEnd={markerEnd} />
}

export default MidArrowEdge
