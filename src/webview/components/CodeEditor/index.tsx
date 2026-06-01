import { useEffect, useRef } from 'react'
import type { FC } from 'react'

/**
 * Monaco 由 webview HTML 的 <script> 标签本地加载（不走 CDN），
 * 此处仅声明类型，运行时通过 window.monaco 访问。
 * _monacoReady 是 HTML 中 AMD require 完成后 resolve 的 Promise。
 */
declare const monaco: typeof import('monaco-editor')
declare global {
  interface Window {
    monaco: typeof import('monaco-editor')
    _monacoReady: Promise<typeof import('monaco-editor')>
  }
}

type ExtraLib = { dispose(): void }

export type CodeEditorProps = {
  value?: string
  onChange?: (value: string) => void
  /** 当前 Flow 的 shareValues key 列表 —— 注入到类型声明供 IntelliSense 补全 */
  shareValueKeys?: string[]
  /** 当前节点的输出分支名称列表 —— 注入到返回值类型约束 */
  outputs?: string[]
}

/**
 * 构建注入给 Monaco TypeScript 语言服务的类型声明 ——
 * 让编辑器对 input / values / runCommand 做类型检查与补全。
 */
function buildTypeDeclarations(shareValueKeys: string[], outputs: string[]): string {
  const outputUnion =
    outputs.length > 0 ? outputs.map((n) => `'${n}'`).join(' | ') : 'string'
  return [
    '// ── Code 节点函数签名（由 FlowRunner 注入） ──',
    'declare const input: string;',
    `declare const values: Record<string, string>;`,
    'declare function runCommand(command: string, timeout?: number): Promise<string>;',
    '',
    '// ── 返回值类型 ──',
    `type CodeResult = { output_name?: ${outputUnion}; content?: string; values?: Record<string, string> } | string | void;`,
  ].join('\n')
}

/**
 * Code 节点的 Monaco 编辑器 —— 替代 Input.TextArea，提供：
 * - JavaScript 语法高亮
 * - Shift+Alt+F 自动格式化
 * - 基于注入类型声明的 IntelliSense 与类型检查
 *
 * 生命周期：mount 时 create → unmount 时 dispose，中间通过 ref 同步 value。
 */
export const CodeEditor: FC<CodeEditorProps> = ({
  value = '',
  onChange,
  shareValueKeys = [],
  outputs = [],
}) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<ReturnType<typeof monaco.editor.create> | null>(null)
  const modelRef = useRef<ReturnType<typeof monaco.editor.createModel> | null>(null)
  const extraLibRef = useRef<ExtraLib | null>(null)
  // 防止 editor → onChange → form → value prop → set editor value 形成回环
  const suppressNextChangeRef = useRef(false)

  // ── 初始化编辑器 ──
  useEffect(() => {
    if (!containerRef.current) return
    const container = containerRef.current
    let disposed = false

    // 等待 Monaco AMD loader 异步加载 editor.main 完成
    window._monacoReady.then((monacoInstance) => {
      if (disposed || !container) return

      const content = value ?? ''
      const model = monacoInstance.editor.createModel(content, 'javascript')
      modelRef.current = model

      const editor = monacoInstance.editor.create(container, {
        model,
        theme: 'vs-dark',
        minimap: { enabled: false },
        automaticLayout: true,
        fontSize: 12,
        tabSize: 2,
        scrollBeyondLastLine: false,
        lineNumbers: 'on',
        renderLineHighlight: 'line',
        wordWrap: 'on',
        padding: { top: 8, bottom: 8 },
        overviewRulerBorder: false,
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      })
      editorRef.current = editor

      // editor → onChange：用户编辑时通知外部（Form）
      editor.onDidChangeModelContent(() => {
        if (suppressNextChangeRef.current) {
          suppressNextChangeRef.current = false
          return
        }
        onChange?.(editor.getValue())
      })
    })

    return () => {
      disposed = true
      editorRef.current?.dispose()
      modelRef.current?.dispose()
      extraLibRef.current?.dispose()
      editorRef.current = null
      modelRef.current = null
      extraLibRef.current = null
    }
    // 仅 mount 时执行一次；value / shareValueKeys / outputs 变化由下面的 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ── 外部 value → editor（form.setFieldsValue / 切换 agent 时） ──
  useEffect(() => {
    const editor = editorRef.current
    if (!editor) return
    const current = editor.getValue()
    if (current !== value) {
      // 标记：接下来 set Value 触发的 onDidChangeModelContent 不回调 onChange
      suppressNextChangeRef.current = true
      editor.setValue(value ?? '')
    }
  }, [value])

  // ── shareValueKeys / outputs 变化 → 更新类型声明 ──
  useEffect(() => {
    if (!window.monaco) return
    // 先释放旧声明
    extraLibRef.current?.dispose()
    // monaco.languages.typescript 在 ESM 类型中标记为 deprecated，运行时 API 仍可用
    const tsLang = window.monaco.languages.typescript as unknown as {
      javascriptDefaults: { addExtraLib(content: string, filePath: string): ExtraLib }
    }
    const lib = tsLang.javascriptDefaults.addExtraLib(
      buildTypeDeclarations(shareValueKeys, outputs),
      'inmemory://code-node-signature.d.ts',
    )
    extraLibRef.current = lib
  }, [shareValueKeys, outputs])

  return (
    <div
      ref={containerRef}
      className='h-full w-full'
      // 阻止 Form 的全局 onKeyDown 拦截 Tab（Monaco 需要 Tab 做缩进）
      onKeyDown={(e) => e.stopPropagation()}
    />
  )
}
