export type CodeRef = {
  id: string
  filename: string
  languageId: string
  line?: [number, number]
  text: string
}

type ActiveInput = {
  addReference: (ref: CodeRef) => void
  focus: () => void
}

/**
 * 追踪当前“打开的 ChatPanel 输入框”栈 —— 顶部是最后打开的，
 * 关闭时会自动回退到上一个仍然打开的 Panel。
 */
const stack: ActiveInput[] = []

export function registerActiveInput(input: ActiveInput): () => void {
  stack.push(input)
  return () => {
    const idx = stack.lastIndexOf(input)
    if (idx >= 0) stack.splice(idx, 1)
  }
}

/** 把该输入框置顶（当用户聚焦时调用） */
export function promoteActiveInput(input: ActiveInput): void {
  const idx = stack.lastIndexOf(input)
  if (idx < 0) return
  if (idx === stack.length - 1) return
  stack.splice(idx, 1)
  stack.push(input)
}

export function addReferenceToActiveInput(ref: CodeRef): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.focus()
  top.addReference(ref)
  return true
}
