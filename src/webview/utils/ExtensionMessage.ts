import { useCallback, useSyncExternalStore } from 'react'
import type { ExtensionToWebviewMessage, ExtensionFromWebviewMessage } from '@/common'

// ── vscode api ────────────────────────────────────────────────────────

type VsCodeApi = ReturnType<typeof acquireVsCodeApi>

let api: VsCodeApi | undefined

function getApi(): VsCodeApi {
  if (!api) {
    api = acquireVsCodeApi()
  }
  return api
}

/** 类型安全地向 extension 发送消息 */
export function postMessageToExtension(msg: ExtensionFromWebviewMessage): void {
  getApi().postMessage(msg)
}

// ── Message Store ────────────────────────────────────────────────────────

let messagesMap = new Map<string, ExtensionToWebviewMessage[]>()
const listeners = new Set<() => void>()

function emitChange() {
  listeners.forEach((l) => l())
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getMessagesBySession(sessionId: string): readonly ExtensionToWebviewMessage[] {
  return messagesMap.get(sessionId) ?? []
}

// 流式 delta 期间一秒可达数十条消息;每条都新建 Map + emitChange 会让所有
// 订阅者(尤其是 markdown 渲染)在一帧内重算多次。把多个消息
// 合批,只在flush做一次 Map 克隆 + emit。
const pendingBySession = new Map<string, ExtensionToWebviewMessage[]>()
let flushScheduled = false

function flushPending() {
  flushScheduled = false
  if (pendingBySession.size === 0) return
  const next = new Map(messagesMap)
  pendingBySession.forEach((msgs, sessionId) => {
    const prev = next.get(sessionId) ?? []
    next.set(sessionId, prev.concat(msgs))
  })
  pendingBySession.clear()
  messagesMap = next
  emitChange()
}

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ExtensionToWebviewMessage
  const sessionId = getSessionId(msg)
  if (!sessionId) return
  const queue = pendingBySession.get(sessionId)
  if (queue) {
    queue.push(msg)
  } else {
    pendingBySession.set(sessionId, [msg])
  }
  if (!flushScheduled) {
    flushScheduled = true
    requestIdleCallback(flushPending)
  }
})

// ── Session ID 提取 ──────────────────────────────────────────────────────

function getSessionId(msg: ExtensionToWebviewMessage): string | undefined {
  const data: unknown = msg.data
  if (typeof data === 'object' && data !== null && 'sessionId' in data) {
    const sid = (data as { sessionId: unknown }).sessionId
    return typeof sid === 'string' ? sid : undefined
  }
  return undefined
}

// ── subscribeExtensionMessage ────────────────────────────────────────────

/**
 * 注册一个回调，每当收到新的 extension 消息时调用
 *
 * @returns 取消订阅的函数
 */
export function subscribeExtensionMessage(
  handler: (msg: ExtensionToWebviewMessage) => void,
): () => void {
  const listener = (e: MessageEvent) => {
    handler(e.data as ExtensionToWebviewMessage)
  }
  window.addEventListener('message', listener)
  return () => window.removeEventListener('message', listener)
}

// ── Hook ─────────────────────────────────────────────────────────────────

/**
 * 按 sessionId 订阅 extension 消息，返回该 session 的所有消息
 *
 * @example
 * ```tsx
 * const messages = useSessionMessage(sessionId)
 * ```
 */
export function useSessionMessage(sessionId: string): readonly ExtensionToWebviewMessage[] {
  const getSnapshot = useCallback(() => getMessagesBySession(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, getSnapshot)
}
