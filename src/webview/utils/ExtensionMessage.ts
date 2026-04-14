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

window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data as ExtensionToWebviewMessage
  const sessionId = getSessionId(msg)
  if (sessionId) {
    const prev = messagesMap.get(sessionId) ?? []
    messagesMap = new Map(messagesMap).set(sessionId, [...prev, msg])
  }
  emitChange()
})

// ── Session ID 提取 ──────────────────────────────────────────────────────

function getSessionId(msg: ExtensionToWebviewMessage): string | undefined {
  if ('sessionId' in msg.data) {
    return (msg.data as { sessionId: string }).sessionId
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
