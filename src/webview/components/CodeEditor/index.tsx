import { useEffect, useMemo, useRef, useState } from 'react'
import type { FC } from 'react'
import { codeToHtml } from 'shiki'
import { buildCodeJSDoc } from '@/common'
import './code-editor.css'

export type CodeEditorProps = {
  value?: string
  onChange?: (value: string) => void
  /** 当前 Flow 的 shareValues key 列表 —— 注入到补全项 */
  shareValueKeys?: string[]
  /** 当前节点的输出分支名称列表 —— 注入到 CodeResult 返回值类型 */
  outputs?: string[]
  /** 只读模式：禁止编辑，用于 webview 内展示（实际编辑在 VSCode 中完成） */
  readOnly?: boolean
  /** 跳过内部 JSDoc 拼接：外部已单独展示 JSDoc 类型声明时使用 */
  hideJSDoc?: boolean
}

/**
 * Code 节点的代码展示组件。
 * 使用 Shiki（底层 vscode-textmate + dark-plus 主题）渲染，
 * 与 VSCode 编辑器语法高亮像素级一致。
 */
export const CodeEditor: FC<CodeEditorProps> = ({
  value = '',
  shareValueKeys,
  outputs,
  hideJSDoc,
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [html, setHtml] = useState('')
  const reqId = useRef(0)

  const displayValue = useMemo(() => {
    if (hideJSDoc) return value
    const jsdoc = buildCodeJSDoc(shareValueKeys ?? [], outputs ?? [])
    return jsdoc + '\n' + value
  }, [value, shareValueKeys, outputs, hideJSDoc])

  useEffect(() => {
    const id = ++reqId.current
    codeToHtml(displayValue, { lang: 'javascript', theme: 'dark-plus' }).then((h) => {
      if (id === reqId.current) setHtml(h)
    })
  }, [displayValue])

  return (
    <div
      ref={containerRef}
      className='code-editor-shiki flex-1 overflow-auto font-mono text-[14px] leading-relaxed'
      style={{
        backgroundColor: 'var(--vscode-editor-background)',
        color: 'var(--vscode-editor-foreground)',
      }}
    >
      <div className='h-full' dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
