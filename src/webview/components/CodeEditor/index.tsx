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
 * 构建注入给 Monaco JavaScript 语言服务的 .d.ts 声明 ——
 * addExtraLib 只认 TypeScript 声明语法（.d.ts），纯 JS + JSDoc 不会生效。
 */
function buildTypeDeclarations(shareValueKeys: string[], outputs: string[]): string {
  const outputUnion = outputs.length > 0 ? outputs.map((n) => `'${n}'`).join(' | ') : 'undefined'
  const valuesProps =
    shareValueKeys.length > 0 ? shareValueKeys.map((k) => `  ${k}?: string`).join('\n') : ''
  return `\
/** 上游节点 AgentComplete.content 传入的文本；no_input 模式时为 "开始" */
declare var input: string;

/**
 * Flow 级共享存储（按 key 授权读写）。
 * Code 节点可全量读写所有 shareValues，不受 allowed_read/write_values_keys 约束。
 */
declare var values: {
${valuesProps}
};

/**
 * 在 VSCode workspaceFolder 下执行 shell 命令。
 * @param command - 要执行的 shell 命令
 * @param timeout - 超时时间（毫秒），默认 600000（10 分钟）
 * @returns stdout + stderr 拼接的字符串
 */
function runCommand(command: string, timeout?: number): Promise<string>;

/**
 * Code 节点返回值。
 * - 返回对象：output_name 决定下一跳分支，content 传给下游，values 合并到 shareValues
 * - 返回字符串：等价于 { content: string }
 * - 返回 void / undefined：无输出
 */
type CodeResult = {
  output_name?: ${outputUnion};
  content?: string;
  values?: Record<string, string>;
} | string | void;
`
}

// 模块级 once flag —— Monaco language services 是全局单例,
// 同一 languageId 重复 register provider 会叠加调用、冒重复格式化结果;
// 组件多次 mount(strict mode 双调 / Form 重渲) 都不应再注册。
let formattersRegistered = false

/**
 * 把 TypeScript worker 返回的 TextChange[] 转成 Monaco 的 TextEdit[]。
 * Document / Range 两个 provider 共用同一份转换逻辑;
 * 用结构化类型避免依赖 monaco-editor 模块声明(运行时通过 window.monaco 注入)。
 */
function tsEditsToMonacoEdits(
  model: { getPositionAt(offset: number): { lineNumber: number; column: number } },
  edits: { span: { start: number; length: number }; newText: string }[],
) {
  return edits.map((edit) => {
    const start = model.getPositionAt(edit.span.start)
    const end = model.getPositionAt(edit.span.start + edit.span.length)
    return {
      range: {
        startLineNumber: start.lineNumber,
        startColumn: start.column,
        endLineNumber: end.lineNumber,
        endColumn: end.column,
      },
      text: edit.newText,
    }
  })
}

/**
 * 注册 javascript 的 Document / Range 两个 FormattingEditProvider，
 * 桥接到 Monaco 内置 TypeScript 语言服务 worker 做真正的格式化。
 *
 * - DocumentFormattingEditProvider 触发 Shift+Alt+F 手动格式化;
 * - DocumentRangeFormattingEditProvider 触发 formatOnPaste / formatOnType
 *   (Monaco 不会从 Document provider 自动派生 Range 行为,必须独立 register)。
 *
 * monaco-editor 的类型声明在本工程中不可用(declare const monaco 在 lib 不可解析时为 any),
 * 所以 callback 参数都显式标 any 避免 implicit-any 报错;helper tsEditsToMonacoEdits
 * 内部用结构化类型保留转换逻辑的最小契约。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function registerFormatters(monacoInstance: any): void {
  if (formattersRegistered) return
  formattersRegistered = true

  monacoInstance.languages.registerDocumentFormattingEditProvider('javascript', {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    provideDocumentFormattingEdits(model: any) {
      return monacoInstance.languages.typescript
        .getJavaScriptWorker()
        .then((getClient: (uri: unknown) => Promise<unknown>) => getClient(model.uri))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((worker: any) =>
          worker.getFormattingEditsForDocument(
            model.uri.toString(),
            model.getFormattingOptions(),
          ),
        )
        .then(
          (edits: { span: { start: number; length: number }; newText: string }[]) =>
            tsEditsToMonacoEdits(model, edits),
        )
    },
  })

  monacoInstance.languages.registerDocumentRangeFormattingEditProvider('javascript', {
    provideDocumentRangeFormattingEdits(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      model: any,
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      },
    ) {
      const startOffset = model.getOffsetAt({
        lineNumber: range.startLineNumber,
        column: range.startColumn,
      })
      const endOffset = model.getOffsetAt({
        lineNumber: range.endLineNumber,
        column: range.endColumn,
      })
      return monacoInstance.languages.typescript
        .getJavaScriptWorker()
        .then((getClient: (uri: unknown) => Promise<unknown>) => getClient(model.uri))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .then((worker: any) =>
          worker.getFormattingEditsForRange(
            model.uri.toString(),
            startOffset,
            endOffset,
            model.getFormattingOptions(),
          ),
        )
        .then(
          (edits: { span: { start: number; length: number }; newText: string }[]) =>
            tsEditsToMonacoEdits(model, edits),
        )
    },
  })
}

/**
 * Code 节点的 Monaco 编辑器 —— 替代 Input.TextArea，提供：
 * - JavaScript 语法高亮
 * - Shift+Alt+F 手动格式化 + 粘贴/输入时自动格式化
 * - 基于注入类型声明的 IntelliSense、类型检查与 JSDoc hover
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

      registerFormatters(monacoInstance)

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
        formatOnPaste: true,
        formatOnType: true,
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
    let disposed = false
    window._monacoReady.then((monacoInstance) => {
      if (disposed) return
      const tsLang = monacoInstance.languages.typescript as unknown as {
        javascriptDefaults: { addExtraLib(content: string, filePath: string): ExtraLib }
      }
      // 先释放旧声明
      extraLibRef.current?.dispose()
      extraLibRef.current = tsLang.javascriptDefaults.addExtraLib(
        buildTypeDeclarations(shareValueKeys, outputs),
        'inmemory://code-node-signature.d.ts',
      )
    })
    return () => {
      disposed = true
    }
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
