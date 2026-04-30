import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { type PersistedFlows, PersistedFlowsSchema, validateFlow } from '@/common'
import { defaultStore } from './defaultStore'

const FLOWS_FILENAME = '.agent-flows.json'

function getFlowsPath(): string {
  return path.join(os.homedir(), FLOWS_FILENAME)
}

/** 本地 flows 持久化读写 */
export class PersistedFlowsController {
  private filePath = getFlowsPath()

  async loadFlows(): Promise<PersistedFlows> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const json = JSON.parse(raw)
      const parsed = PersistedFlowsSchema.safeParse(json)

      if (!parsed.success || parsed.data.flows.length === 0) {
        return { ...defaultStore }
      }

      // 对每个 flow 做语义校验
      const hasSemanticError = parsed.data.flows.some((flow) => {
        const result = validateFlow(flow)
        return result.duplicateAgentNames || result.invalidNextAgent || result.duplicateOutputNames
      })

      if (hasSemanticError) {
        return { ...defaultStore }
      }

      return parsed.data
    } catch {
      return { ...defaultStore }
    }
  }

  async saveFlows(data: PersistedFlows): Promise<void> {
    const tmpPath = this.filePath + '.tmp'
    const content = JSON.stringify(data, null, 2)
    await fs.writeFile(tmpPath, content, 'utf-8')
    // Windows 上 rename 在目标文件已存在时会失败，先尝试删除旧文件
    try {
      await fs.unlink(this.filePath)
    } catch {
      // 旧文件不存在，忽略
    }
    await fs.rename(tmpPath, this.filePath)
  }
}
