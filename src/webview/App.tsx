import { FC, useState } from 'react'
import type { Flow } from '@/common'
import { AgentFlow } from './components/AgentFlow'
import { presetFlow } from './components/AgentFlow/presetFlow'

export const App: FC = () => {
  const [flow, setFlow] = useState<Flow>(presetFlow)

  return <AgentFlow flow={flow} onFlowChange={setFlow} />
}
