import { produce } from 'immer'
import { match } from 'ts-pattern'
import type {
  SDKAssistantMessage,
  SDKPartialAssistantMessage,
  SDKResultMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  AIMessageType,
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  UserMessageType,
} from './event'
import type { Agent, Code, Flow } from './index'
import { pickInjectedShareValues } from './index'
import type {
  AgentPhase,
  FlowPhase,
  MessageEffect,
  PendingToolPermission,
} from './flowRunState'

// ── 复用工具的再导出（不重复定义，使本模块成为完整等价 surface） ──────────────
//
// 纯工具（TokenUsage / ModelTokenUsage / format / Phase 类型 / MessageEffect /
// PendingToolPermission / UI helper）只依赖 Phase 类型,与消息模型无关,直接从
// ./flowRunState 复用并透传。新消息模型相关的类型（ChatMessage / AgentRun /
// FlowRunState / reducer / phase 推断 / selector）在本文件重定义。
export {
  addTokenUsage,
  agentChatInputState,
  emptyModelTokenUsage,
  emptyTokenUsage,
  extractModelTokenUsage,
  extractTokenUsage,
  flowCanBeKilled,
  formatTokenCost,
  formatTokenCount,
  isModelTokenUsageNonZero,
  subtractModelTokenUsage,
  subtractTokenUsage,
} from './flowRunState'
export type {
  AgentChatInputState,
  AgentPhase,
  FlowPhase,
  MessageEffect,
  ModelTokenUsage,
  PendingToolPermission,
  TokenPricing,
  TokenUsage,
} from './flowRunState'

// ── SDK 类型派生（indexed access + Extract，零额外依赖） ───────────────────────
//
// claude-agent-sdk 未 re-export Beta 命名,顶层消息类型已携带,用 indexed access
// 派生内容块 / 流式事件 / delta 子类型,Extract 取具体判别分支。

type BetaMessage = SDKAssistantMessage['message']
type ContentBlock = BetaMessage['content'][number]
type StreamEvent = SDKPartialAssistantMessage['event']
type UserContent = SDKUserMessage['message']['content']
type ContentBlockOf<T extends ContentBlock['type']> = Extract<ContentBlock, { type: T }>
type StreamEventOf<T extends StreamEvent['type']> = Extract<StreamEvent, { type: T }>
type DeltaOf<T extends StreamEventOf<'content_block_delta'>['delta']['type']> = Extract<
  StreamEventOf<'content_block_delta'>['delta'],
  { type: T }
>

// ── 累加态消息模型 ────────────────────────────────────────────────────────────
//
// 与原始 SDK 信号流不同:接收事件时即累加成半渲染态的 ChatMessage:
// 流式片段直接累加进 text/thinking 项、tool_result 合并进 tool_use 项、每项带
// status、保留 parentToolUseId。消息列表只增不删（无 strip、无下标漂移）。

/** text/thinking 项的流式状态 */
export type StreamStatus = 'streaming' | 'done' | 'interrupted'
/** tool_use 项的执行状态 */
export type ToolStatus = 'pending' | 'done' | 'interrupted'
export type ToolResult = { isError: boolean; text: string }

/**
 * 所有 ChatMessage 共有字段。
 * - id:`run.acc.seq++` 单调分配、永不复用 —— 稳定渲染 key。
 * - parentToolUseId:非空 = 来自该 tool_use 的 subagent,用于归组到父气泡下。
 * - uuid:透传 SDK 原生 uuid（供将来 fork 寻址）;result 项无 uuid（SDK transcript 不含）。
 */
type Base = { id: string; parentToolUseId?: string; uuid?: string }

export type TextMessage = Base & { kind: 'text'; status: StreamStatus; text: string }
export type ThinkingMessage = Base & {
  kind: 'thinking'
  status: StreamStatus
  text: string
  signature?: string
}
export type ToolUseMessage = Base & {
  kind: 'tool_use'
  status: ToolStatus
  toolUseId: string
  /** mcp → `${server_name}::${name}`,普通工具 → name */
  toolName: string
  /** 以 assistant 完整 block.input 为准（流式占位期为 {}） */
  input: unknown
  /** tool_result 合并后填充 */
  result?: ToolResult
}
export type UserMessage = Base & { kind: 'user'; rawContent: UserContent }
export type ResultMessage = Base & {
  kind: 'result'
  isError: boolean
  subtype: string
  raw: SDKResultMessage
}

export type ChatMessage =
  | TextMessage
  | ThinkingMessage
  | ToolUseMessage
  | UserMessage
  | ResultMessage

// ── State 数据结构 ───────────────────────────────────────────────────────────

/**
 * 单个 Agent 运行实例。phase 由 [getRunPhase] 从 messages + 显式标志推断,不存字段。
 *
 * 相对原 AgentRun 的差异:
 * - messages 改为累加态 ChatMessage[]（原 ExtensionToWebviewMessage[] 原始信号流）。
 * - error/interrupted:累加态无 raw signal 可扫,运行态显式标志承载（原靠扫描信号流推断）。
 * - acc:累加中间态,reducer 跨调用保留。Record 而非 Map（immer 友好 + postMessage 可序列化）。
 */
export type AgentRun = {
  /** 主键 —— flowStart 路径由 webview 生成,next_agent / fork 路径由 extension 生成 */
  runId: string
  agentId: string
  /** SDK 首条消息送达后由 reducer 从 message.session_id 回填 */
  sessionId?: string
  /** 当前 run 的累加态消息流 */
  messages: ChatMessage[]
  completed: boolean
  outputName?: string
  /**
   * run 启动时点注入 system prompt 的 shareValues 快照:
   * agent 节点按 allowed_read_values_keys 过滤,code 节点为全量 shareValues。仅展示用。
   */
  injectedShareValues?: Record<string, string | null>
  /** agentError / error 分支写入 → phase=error */
  error?: string
  /** agentInterrupted→true;下一条 aiMessage 累加时清 false */
  interrupted?: boolean
  /**
   * 累加中间态:
   * - activeBlocks:`${parentToolUseId??''}#${blockIndex}` → messages 下标。
   *   主线与各 subagent 的 blockIndex 各自从 0 计会冲突,复合 key 区分。
   * - toolUseIndex:toolUseId → messages 下标（result 可能先于完整 assistant 到达,故 start 即登记）。
   * - seq:id 计数器。消息只增不删 → 下标稳定。
   */
  acc: {
    activeBlocks: Record<string, number>
    toolUseIndex: Record<string, number>
    seq: number
  }
}

/**
 * 单个 Flow 的运行态状态 —— extension 与 webview 同步的核心数据。
 * 字段与原 FlowRunState 一致,仅 runs 元素换成新 AgentRun。
 */
export type FlowRunState = {
  /** killFlow 后置 true;[getRunPhase] 据此把所有非终态 run 投影为 stopped */
  killed: boolean
  /** 按追加顺序排列的 AgentRun;首项是 flowStart 创建,后续由 next_agent */
  runs: AgentRun[]
  /** 已回答的工具权限请求:toolUseId -> { allow, updatedInput },用于 UI 回显历史态 */
  answeredToolPermissions: Record<
    string,
    { allow: boolean; updatedInput?: unknown; message?: string }
  >
  /** 当前未回答的工具权限请求队列（按 runId 区分归属） */
  pendingToolPermissions: PendingToolPermission[]
  /** Flow 运行时的共享数据 */
  shareValues: Record<string, string>
}

// ── 累加辅助 ──────────────────────────────────────────────────────────────────

const emptyAcc = (): AgentRun['acc'] => ({ activeBlocks: {}, toolUseIndex: {}, seq: 0 })

/** id 计数器 —— 单调自增、永不复用 */
function nextId(run: AgentRun): string {
  return String(run.acc.seq++)
}

/** 从 tool_result 的 content 中提取纯文本（移植 buildRenderItems.ts:161-175） */
function extractToolResultText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => {
        if (typeof b === 'string') return b
        if (b && typeof b === 'object' && b.type === 'text') return b.text ?? ''
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/** 新建流式 text/thinking 占位项,登记 activeBlocks,返回下标 */
function pushStreamItem(
  run: AgentRun,
  blockKey: string,
  kind: 'text' | 'thinking',
  parentToolUseId: string | undefined,
): number {
  const item: ChatMessage =
    kind === 'text'
      ? { id: nextId(run), kind: 'text', status: 'streaming', text: '', parentToolUseId }
      : { id: nextId(run), kind: 'thinking', status: 'streaming', text: '', parentToolUseId }
  run.messages.push(item)
  const idx = run.messages.length - 1
  run.acc.activeBlocks[blockKey] = idx
  return idx
}

/** 新建 pending tool_use 占位项,登记 activeBlocks + toolUseIndex */
function startTool(
  run: AgentRun,
  blockKey: string,
  toolUseId: string,
  toolName: string,
  parentToolUseId: string | undefined,
): void {
  const item: ToolUseMessage = {
    id: nextId(run),
    kind: 'tool_use',
    status: 'pending',
    toolUseId,
    toolName,
    input: {},
    parentToolUseId,
  }
  run.messages.push(item)
  const idx = run.messages.length - 1
  run.acc.activeBlocks[blockKey] = idx
  run.acc.toolUseIndex[toolUseId] = idx
}

/** content_block_delta:按 blockKey 取项累加;项不存在则 lazy-create */
function applyDelta(
  run: AgentRun,
  blockKey: string,
  delta: DeltaOf<'text_delta' | 'thinking_delta' | 'signature_delta'> | { type: string },
  parentToolUseId: string | undefined,
): void {
  match(delta)
    .with({ type: 'text_delta' }, (d: DeltaOf<'text_delta'>) => {
      const idx = run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'text', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'text') it.text += d.text
    })
    .with({ type: 'thinking_delta' }, (d: DeltaOf<'thinking_delta'>) => {
      const idx =
        run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'thinking', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'thinking') it.text += d.thinking
    })
    .with({ type: 'signature_delta' }, (d: DeltaOf<'signature_delta'>) => {
      const idx =
        run.acc.activeBlocks[blockKey] ?? pushStreamItem(run, blockKey, 'thinking', parentToolUseId)
      const it = run.messages[idx]
      if (it && it.kind === 'thinking') it.signature = (it.signature ?? '') + d.signature
    })
    // input_json_delta（partial JSON 不可信,以 assistant 完整 input 为准）、citations 等忽略
    .otherwise(() => {})
}

/** assistant 定稿 text/thinking:覆盖占位转 done;无占位则新建 done */
function finalizeStream(
  run: AgentRun,
  blockKey: string,
  block: ContentBlockOf<'text'> | ContentBlockOf<'thinking'>,
  parentToolUseId: string | undefined,
  uuid: string | undefined,
): void {
  const idx = run.acc.activeBlocks[blockKey]
  if (block.type === 'text') {
    if (idx !== undefined) {
      const it = run.messages[idx]
      if (it && it.kind === 'text') {
        it.text = block.text
        it.status = 'done'
        it.uuid = uuid
        return
      }
    }
    run.messages.push({
      id: nextId(run),
      kind: 'text',
      status: 'done',
      text: block.text,
      parentToolUseId,
      uuid,
    })
    return
  }
  // thinking
  if (idx !== undefined) {
    const it = run.messages[idx]
    if (it && it.kind === 'thinking') {
      it.text = block.thinking
      it.signature = block.signature
      it.status = 'done'
      it.uuid = uuid
      return
    }
  }
  run.messages.push({
    id: nextId(run),
    kind: 'thinking',
    status: 'done',
    text: block.thinking,
    signature: block.signature,
    parentToolUseId,
    uuid,
  })
}

/** assistant 定稿 tool_use:补完整 input/toolName,不写 status（防 result 先到的 done 回退）;无占位则新建 pending */
function finalizeTool(
  run: AgentRun,
  toolUseId: string,
  toolName: string,
  input: unknown,
  parentToolUseId: string | undefined,
  uuid: string | undefined,
): void {
  const idx = run.acc.toolUseIndex[toolUseId]
  if (idx !== undefined) {
    const it = run.messages[idx]
    if (it && it.kind === 'tool_use') {
      it.input = input
      it.toolName = toolName
      it.uuid = uuid
      return
    }
  }
  run.messages.push({
    id: nextId(run),
    kind: 'tool_use',
    status: 'pending',
    toolUseId,
    toolName,
    input,
    parentToolUseId,
    uuid,
  })
  run.acc.toolUseIndex[toolUseId] = run.messages.length - 1
}

/** 合并 tool_result 到对应 tool_use 项:置 done + 填 result;interrupted 项不被迟到 result 翻转 */
function mergeToolResult(
  run: AgentRun,
  toolUseId: string,
  isError: boolean,
  content: unknown,
): void {
  const idx = run.acc.toolUseIndex[toolUseId]
  if (idx === undefined) return
  const it = run.messages[idx]
  if (!it || it.kind !== 'tool_use') return
  if (it.status === 'interrupted') return
  it.status = 'done'
  it.result = { isError: !!isError, text: extractToolResultText(content) }
}

/** 中断:streaming 的 text/thinking、pending 的 tool_use 置 interrupted;done 不回退 */
function markInterrupted(run: AgentRun): void {
  for (const m of run.messages) {
    if ((m.kind === 'text' || m.kind === 'thinking') && m.status === 'streaming') {
      m.status = 'interrupted'
    } else if (m.kind === 'tool_use' && m.status === 'pending') {
      m.status = 'interrupted'
    }
  }
}

const isToolResultBlock = (b: unknown): boolean =>
  !!b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'

/**
 * 把一条 SDK 消息累加进 run.messages（操作 immer draft 的 run 与 run.acc）。
 * 外层 match 取 stream_event/assistant/user/result,.otherwise 忽略其余 30+ 分支
 * （SDK 传输 union 用 .otherwise,不用 .exhaustive）。
 */
function appendSdkMessage(run: AgentRun, sdkMsg: AIMessageType): void {
  match(sdkMsg)
    // ── 流式事件 ──────────────────────────────────────────────
    .with({ type: 'stream_event' }, (m: SDKPartialAssistantMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const event = m.event
      match(event)
        .with({ type: 'content_block_start' }, (e: StreamEventOf<'content_block_start'>) => {
          const blockKey = `${parent ?? ''}#${e.index}`
          match(e.content_block)
            .with({ type: 'text' }, () => pushStreamItem(run, blockKey, 'text', parent))
            .with({ type: 'thinking' }, () => pushStreamItem(run, blockKey, 'thinking', parent))
            .with({ type: 'tool_use' }, (b) => startTool(run, blockKey, b.id, b.name, parent))
            .with({ type: 'mcp_tool_use' }, (b) =>
              startTool(run, blockKey, b.id, `${b.server_name}::${b.name}`, parent),
            )
            .otherwise(() => {})
        })
        .with({ type: 'content_block_delta' }, (e: StreamEventOf<'content_block_delta'>) => {
          const blockKey = `${parent ?? ''}#${e.index}`
          applyDelta(run, blockKey, e.delta, parent)
        })
        // content_block_stop / message_* → no-op（统一由 assistant 定稿转 done）
        .otherwise(() => {})
    })
    // ── 完整 assistant ────────────────────────────────────────
    .with({ type: 'assistant' }, (m: SDKAssistantMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const uuid = m.uuid
      const blocks = m.message.content
      blocks.forEach((block, bIdx) => {
        const blockKey = `${parent ?? ''}#${bIdx}`
        match(block)
          .with({ type: 'text' }, (b) => finalizeStream(run, blockKey, b, parent, uuid))
          .with({ type: 'thinking' }, (b) => finalizeStream(run, blockKey, b, parent, uuid))
          .with({ type: 'tool_use' }, (b) =>
            finalizeTool(run, b.id, b.name, b.input, parent, uuid),
          )
          .with({ type: 'mcp_tool_use' }, (b) =>
            finalizeTool(run, b.id, `${b.server_name}::${b.name}`, b.input, parent, uuid),
          )
          // tool_result 来源二:assistant 内联 mcp_tool_result
          .with({ type: 'mcp_tool_result' }, (b) =>
            mergeToolResult(run, b.tool_use_id, b.is_error, b.content),
          )
          .otherwise(() => {})
      })
      // 清掉本条 parent 已处理的 activeBlocks key（下一回合 blockIndex 重新从 0 计）
      const prefix = `${parent ?? ''}#`
      for (const k of Object.keys(run.acc.activeBlocks)) {
        if (k.startsWith(prefix)) delete run.acc.activeBlocks[k]
      }
    })
    // ── user（tool_result 优先） ───────────────────────────────
    .with({ type: 'user' }, (m: SDKUserMessage) => {
      const parent = m.parent_tool_use_id ?? undefined
      const content = m.message.content
      if (
        Array.isArray(content) &&
        content.length > 0 &&
        content.every((b) => isToolResultBlock(b))
      ) {
        // tool_result 来源一:user 消息全是 tool_result 块,逐块合并,不建气泡
        for (const b of content) {
          const blk = b as { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown }
          if (blk.type === 'tool_result' && blk.tool_use_id) {
            mergeToolResult(run, blk.tool_use_id, !!blk.is_error, blk.content)
          }
        }
        return
      }
      if (m.isSynthetic) return
      // 注入 subAgent 的 prompt 不展示
      if (m.parent_tool_use_id != null) return
      run.messages.push({
        id: nextId(run),
        kind: 'user',
        rawContent: content,
        parentToolUseId: parent,
        uuid: m.uuid,
      })
    })
    // ── result（普通回合的 SDK result onMessage / agentComplete 注入） ──
    .with({ type: 'result' }, (m: SDKResultMessage) => {
      run.messages.push({
        id: nextId(run),
        kind: 'result',
        isError: m.is_error,
        subtype: m.subtype,
        raw: m,
      })
    })
    // 其余 30+ SDK 分支（system/tool_progress/...）忽略
    .otherwise(() => {})
}

// ── 消息的副作用 ────────────────────────────────────────────────────────────
//
// MessageEffect 复用自 ./flowRunState。

/**
 * 根据现有的 state 和 flows，处理一条 flow.signal.* 或 flow.command.* 消息，
 * 返回新的 FlowRunState 与待触发的 MessageEffect 列表。
 *
 * 输入/输出契约与原 reducer 一致:
 * - signal 路径:extension 发出前 / webview 收到后各 reduce 一次
 * - command 路径:webview 发出前 / extension 收到后各 reduce 一次
 *
 * 特殊入口（绕过终态守卫）:flow.command.flowStart（覆盖式初始化）、killFlow（任意状态幂等）。
 * 终态守卫:所有 run 都 stopped/completed/error 时,其余消息忽略。
 * runId 守卫:非 flowStart 的消息按 msg.data.runId 在 runs 中找 AgentRun,找不到则忽略。
 *
 * 相对原 reducer 的核心差异:不再把 raw signal 直接 push 进 messages,改由各分支调
 * appendSdkMessage 累加成 ChatMessage;不再 stripStreamEvents（消息只增不删）。
 */
export function updateFlowRunState(
  msg: ExtensionFlowSignalMessage | ExtensionFlowCommandMessage,
  options: { state: FlowRunState | undefined; flows: Flow[] },
): { state: FlowRunState | undefined; effects: MessageEffect[] } {
  const effects: MessageEffect[] = []
  const { flows, state } = options

  // ── command.flowStart：覆盖式初始化（可在任何 state 下进入，包括 undefined） ──
  if (msg.type === 'flow.command.flowStart') {
    const baseValues = state?.shareValues ?? {}
    const startAgent = flows
      .find((f) => f.id === msg.data.flowId)
      ?.agents?.find((a) => a.id === msg.data.agentId)
    const injectedShareValues =
      startAgent?.node_type === 'code'
        ? { ...baseValues }
        : startAgent
          ? pickInjectedShareValues(startAgent.allowed_read_values_keys ?? [], baseValues)
          : undefined
    const firstRun: AgentRun = {
      runId: msg.data.runId,
      agentId: msg.data.agentId,
      sessionId: undefined,
      messages: [],
      completed: false,
      injectedShareValues,
      acc: emptyAcc(),
    }
    // 把 initMessage 累加为首条 user 项（替代直接塞 raw signal）
    appendSdkMessage(firstRun, msg.data.initMessage)
    const fresh: FlowRunState = {
      killed: false,
      runs: [firstRun],
      answeredToolPermissions: {},
      pendingToolPermissions: [],
      shareValues: baseValues,
    }
    return { state: fresh, effects }
  }

  if (msg.type === 'flow.command.setShareValues') {
    const base: FlowRunState = {
      killed: false,
      runs: [],
      answeredToolPermissions: {},
      pendingToolPermissions: [],
      ...state,
      shareValues: msg.data.values,
    }
    return { state: base, effects }
  }

  if (!state) return { state: undefined, effects }

  const findFlow = (flowId: string): Flow | undefined => flows.find((f) => f.id === flowId)
  const findAgent = (flow: Flow | undefined, agentId: string): Agent | Code | undefined =>
    flow?.agents?.find((a) => a.id === agentId)

  const pushEffect = (opts: Omit<MessageEffect, 'flowName' | 'agentName'>) => {
    const flow = findFlow(opts.flowId)
    const agent = findAgent(flow, opts.agentId)
    // silent_task / code 节点减少通知:只放行 agent-error / flow-completed /
    // CompleteTask|ExitPlanMode 的确认;result、AskUserQuestion 自动应答、普通工具授权静默。
    if (agent && (agent.node_type === 'code' || agent.work_mode === 'silent_task')) {
      const isConfirmPermission =
        opts.reason === 'awaiting-tool-permission' &&
        (!!opts.toolName?.includes('CompleteTask') || !!opts.toolName?.includes('ExitPlanMode'))
      const allowed =
        opts.reason === 'agent-error' || opts.reason === 'flow-completed' || isConfirmPermission
      if (!allowed) return
    }
    effects.push({
      ...opts,
      flowName: flow?.name ?? '',
      agentName: agent?.agent_name ?? '',
    })
  }

  const next = produce(state, (draft) => {
    const flowId = msg.data.flowId
    const clearPendings = () => {
      // 未回答的权限请求标记为拒绝,供历史卡片回显"已拒绝"状态
      for (const p of draft.pendingToolPermissions) {
        if (!draft.answeredToolPermissions[p.toolUseId]) {
          draft.answeredToolPermissions[p.toolUseId] = { allow: false, message: undefined }
        }
      }
      draft.pendingToolPermissions = []
    }

    // ── command.killFlow:任何状态下强制终止（包括终态,幂等） ──────────
    if (msg.type === 'flow.command.killFlow') {
      draft.killed = true
      clearPendings()
      return
    }

    // ── 终态守卫:已被 killFlow 停止 / 所有 run 都终态时,其余消息忽略 ──
    if (draft.killed) return
    if (draft.runs.length > 0 && draft.runs.every((r) => isTerminalPhase(getRunPhase(r, draft)))) {
      return
    }

    // 寻址当前消息所属 AgentRun（flowStart 信号已建好,后续 signal/command 都按 runId 找）
    const runId = 'runId' in msg.data ? (msg.data.runId as string | undefined) : undefined
    const findRun = (id: string | undefined) =>
      id ? draft.runs.find((r) => r.runId === id) : undefined
    const run = findRun(runId)
    if (!run) return

    // SDK aiMessage 带 session_id,首次见到时回填到对应 AgentRun.sessionId
    if (msg.type === 'flow.signal.aiMessage' && !run.sessionId) {
      const sid = (msg.data.message as { session_id?: string }).session_id
      if (sid) run.sessionId = sid
    }

    match(msg)
      // ── signals ──────────────────────────────────────────────
      .with({ type: 'flow.signal.flowStart' }, () => {})
      .with({ type: 'flow.signal.aiMessage' }, (m) => {
        const { message } = m.data
        // 恢复运行:清中断标志
        run.interrupted = false
        appendSdkMessage(run, message)
        // 完整 result 到达 → 本 run 无未回答权限时触发"生成完毕"
        if (message.type === 'result') {
          if (draft.pendingToolPermissions.every((p) => p.runId !== run.runId)) {
            pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'result' })
          }
        }
      })
      .with({ type: 'flow.signal.agentComplete' }, ({ data }) => {
        // 合并 agentComplete 携带的 values 到 Flow shareValues
        if (data.values) {
          draft.shareValues = { ...draft.shareValues, ...data.values }
        }
        run.completed = true
        run.outputName = data.output?.name
        // result 注入:data.result 存在则累加为 result 项（替代旧"整条 signal 进 messages"）
        if (data.result) appendSdkMessage(run, data.result)
        clearPendings()
        const flow = findFlow(flowId)
        const output = data.output
          ? flow?.agents
              ?.find((a) => a.id === run.agentId)
              ?.outputs?.find((o) => o.output_name === data.output!.name)
          : undefined
        const nextAgent = output ? flow?.agents?.find((a) => a.id === output.next_agent) : undefined
        if (nextAgent && data.output.newRunId) {
          // 追加新 AgentRun(由 extension 端生成的 newRunId),把 CompleteTask 的 content 作为
          // 下一个 Agent 的首条用户消息回显（no_input 的 next agent 用 '执行任务',与
          // FlowRunner.doOnCompleteTask 的 nextInitMessage 同源）。
          const nextInitMessage: UserMessageType = {
            type: 'user',
            message: {
              role: 'user',
              content: nextAgent.no_input || !data.content ? '执行任务' : data.content,
            },
            parent_tool_use_id: null,
          }
          const newRun: AgentRun = {
            runId: data.output.newRunId,
            agentId: nextAgent.id,
            sessionId: undefined,
            messages: [],
            completed: false,
            injectedShareValues:
              nextAgent.node_type === 'code'
                ? { ...draft.shareValues }
                : pickInjectedShareValues(
                    nextAgent.allowed_read_values_keys ?? [],
                    draft.shareValues,
                  ),
            acc: emptyAcc(),
          }
          appendSdkMessage(newRun, nextInitMessage)
          draft.runs.push(newRun)
        } else {
          // Flow 走到末端:全部 run 完成,清空 shareValues 防污染下次启动
          draft.shareValues = {}
          pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'flow-completed' })
        }
      })
      .with({ type: 'flow.signal.toolPermissionRequest' }, ({ data }) => {
        // 队列追加（toolUseId 去重）
        if (!draft.pendingToolPermissions.some((p) => p.toolUseId === data.toolUseId)) {
          draft.pendingToolPermissions.push({
            toolUseId: data.toolUseId,
            toolName: data.toolName,
            input: data.input,
            runId: run.runId,
          })
        }
        pushEffect({
          flowId,
          runId: run.runId,
          agentId: run.agentId,
          reason: 'awaiting-tool-permission',
          toolName: data.toolName,
        })
      })
      .with({ type: 'flow.signal.agentInterrupted' }, () => {
        run.interrupted = true
        markInterrupted(run)
        clearPendings()
      })
      .with({ type: 'flow.signal.toolPermissionResult' }, ({ data }) => {
        // silent_task 自动应答路径:与 command.toolPermissionResult 同语义,仅入口为 signal,
        // 且不 pushEffect（自动应答无需通知用户）。
        draft.answeredToolPermissions[data.toolUseId] = {
          allow: data.allow,
          updatedInput: data.updatedInput,
          message: data.message,
        }
        draft.pendingToolPermissions = draft.pendingToolPermissions.filter(
          (p) => p.toolUseId !== data.toolUseId,
        )
      })
      .with({ type: 'flow.signal.agentError' }, ({ data }) => {
        run.error = data.err
        clearPendings()
        pushEffect({ flowId, runId: run.runId, agentId: run.agentId, reason: 'agent-error' })
      })
      .with({ type: 'flow.signal.error' }, ({ data }) => {
        run.error = data.msg
        clearPendings()
      })
      // ── commands ────────────────────────────────────────────
      .with({ type: 'flow.command.userMessage' }, ({ data }) => {
        // 把用户消息累加为 user 项,消费者侧统一
        appendSdkMessage(run, data.message)
      })
      .with({ type: 'flow.command.interrupt' }, () => {
        // 等待 flow.signal.agentInterrupted 实际处理
      })
      .with({ type: 'flow.command.toolPermissionResult' }, ({ data }) => {
        draft.answeredToolPermissions[data.toolUseId] = {
          allow: data.allow,
          updatedInput: data.updatedInput,
          message: data.message,
        }
        draft.pendingToolPermissions = draft.pendingToolPermissions.filter(
          (p) => p.toolUseId !== data.toolUseId,
        )
      })
      // ── fork：源 Flow 状态不变,新 Flow 的 RunState 由调用方在 store 外侧写入 ──
      .with({ type: 'flow.signal.fork' }, () => {})
      .with({ type: 'flow.command.fork' }, () => {})
      .exhaustive()
  })

  return { state: next, effects }
}

// ── 内部辅助 ─────────────────────────────────────────────────────────────────

/** 终态判定 —— stopped / completed / error 三种 */
const isTerminalPhase = (p: AgentPhase): boolean =>
  p === 'completed' || p === 'stopped' || p === 'error'

/**
 * 按 run 自身的数据推断 phase（最简策略）—— SSOT 是 run 上的显式标志 + messages 末项。
 *
 * 优先级:
 * - error                       run.error 非空
 * - completed                   run.completed === true
 * - stopped                     state.killed
 * - awaiting-tool-permission    state.pendingToolPermissions 中有属于本 run 的项
 * - interrupted                 run.interrupted === true
 * - result / running            末项 kind 是 result / 其它
 * - starting                    无任何消息
 */
export function getRunPhase(run: AgentRun, state: FlowRunState): AgentPhase {
  if (run.error) return 'error'
  if (run.completed) return 'completed'
  if (state.killed) return 'stopped'
  if (state.pendingToolPermissions.some((p) => p.runId === run.runId))
    return 'awaiting-tool-permission'
  if (run.interrupted) return 'interrupted'
  const last = run.messages.at(-1)
  if (!last) return 'starting'
  return last.kind === 'result' ? 'result' : 'running'
}

/**
 * 按多 run 优先级聚合 phase —— Flow 与 Agent 同用此函数（FlowPhase ≡ AgentPhase）。
 *
 * 优先级:error > awaiting-tool-permission > result > running > starting >
 * interrupted > stopped > completed。
 */
function aggregatePhase(phases: AgentPhase[]): FlowPhase {
  if (phases.length === 0) return 'idle'
  if (phases.includes('error')) return 'error'
  const order: AgentPhase[] = [
    'awaiting-tool-permission',
    'result',
    'running',
    'starting',
    'interrupted',
  ]
  for (const phase of order) {
    if (phases.includes(phase)) return phase
  }
  if (phases.includes('stopped')) return 'stopped'
  if (phases.includes('completed')) return 'completed'
  return 'idle'
}

// ── Selector ────────────────────────────────────────────────────────────────

export function getFlowPhase(state: FlowRunState | undefined): FlowPhase {
  if (!state) return 'idle'
  return aggregatePhase(state.runs.map((r) => getRunPhase(r, state)))
}

/** 取该 agent 所有 run 的 phase 聚合;该 agent 无 run 则 idle */
export function getAgentPhase(state: FlowRunState | undefined, agentId: string): AgentPhase {
  if (!state) return 'idle'
  return aggregatePhase(
    state.runs.filter((r) => r.agentId === agentId).map((r) => getRunPhase(r, state)),
  )
}

const EMPTY_PENDING_TOOL_PERMISSIONS: PendingToolPermission[] = []

/**
 * 取属于该 agent 的 pendingToolPermissions —— 引用稳定:全属于→原引用;全不属于→空常量;混合→filter 新数组。
 */
export function getPendingToolPermissionsFor(
  state: FlowRunState | undefined,
  agentId: string,
): PendingToolPermission[] {
  if (!state) return EMPTY_PENDING_TOOL_PERMISSIONS
  const list = state.pendingToolPermissions
  if (list.length === 0) return EMPTY_PENDING_TOOL_PERMISSIONS
  const runIdToAgent = new Map(state.runs.map((r) => [r.runId, r.agentId]))
  let allBelong = true
  let anyBelong = false
  for (const p of list) {
    const a = runIdToAgent.get(p.runId)
    if (a === agentId) anyBelong = true
    else allBelong = false
  }
  if (allBelong) return list
  if (!anyBelong) return EMPTY_PENDING_TOOL_PERMISSIONS
  return list.filter((p) => runIdToAgent.get(p.runId) === agentId)
}

export function getAnsweredToolPermissions(
  state: FlowRunState | undefined,
): Record<string, { allow: boolean; updatedInput?: unknown; message?: string }> | undefined {
  return state?.answeredToolPermissions
}
