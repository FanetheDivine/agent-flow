import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import type {
  ExtensionFromWebviewMessage,
  ExtensionToWebviewMessage,
  PersistedData,
} from '@/common'
import { FlowRunnerManager } from './FlowRunnerManager'
import { PersistedDataController } from './PersistedDataController'
import { initLogger, log, logError } from './logger'

/** 扩展名 → VSCode languageId（仅覆盖常见语言，未命中时保持 plaintext） */
const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescriptreact',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascriptreact',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'jsonc',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  xml: 'xml',
  html: 'html',
  htm: 'html',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  swift: 'swift',
  dart: 'dart',
  lua: 'lua',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  ps1: 'powershell',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  vue: 'vue',
  svelte: 'svelte',
  dockerfile: 'dockerfile',
  makefile: 'makefile',
}

export function activate(context: vscode.ExtensionContext) {
  initLogger(context)
  let currentPanel: vscode.WebviewPanel | undefined

  const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
    if (currentPanel) {
      currentPanel.reveal(undefined, true)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      'agentFlow',
      'Agent Flow',
      { viewColumn: vscode.ViewColumn.One, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    )
    currentPanel = panel
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'icon.svg')
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri)

    const flowStore = new PersistedDataController()

    const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
      log('[Extension → Webview]', msg.type, msg.data)
      panel.webview.postMessage(msg)
    }

    const runnerManager = new FlowRunnerManager(postMessageToWebview)

    let currentFlows: PersistedData = { flows: [] }

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      log('[Webview → Extension]', e.type, e.data)
      match(e)
        .with({ type: 'load' }, async () => {
          currentFlows = await flowStore.load()
          postMessageToWebview({ type: 'load', data: currentFlows })
        })
        .with({ type: 'save' }, async ({ data }) => {
          const storeData: PersistedData = { flows: data }
          currentFlows = storeData
          await flowStore.save(storeData)
        })
        .with({ type: 'previewAttachment' }, async ({ data }) => {
          const { name, content } = data
          try {
            const ext = name.toLowerCase().split('.').pop()
            const language = ext ? LANG_BY_EXT[ext] : undefined
            const doc = await vscode.workspace.openTextDocument({ language, content })
            await vscode.window.showTextDocument(doc, {
              viewColumn: vscode.ViewColumn.One,
              preview: true,
            })
          } catch (err) {
            logError('previewAttachment failed', err)
          }
        })
        .with({ type: 'openFile' }, async ({ data }) => {
          const { filename, line } = data
          const folders = vscode.workspace.workspaceFolders
          if (!folders?.length) return
          try {
            const uri = vscode.Uri.joinPath(folders[0].uri, filename)
            const doc = await vscode.workspace.openTextDocument(uri)
            const editor = await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside)
            if (line) {
              const [startLine, endLine] = line
              const startPos = new vscode.Position(Math.max(0, startLine - 1), 0)
              const endPos = new vscode.Position(Math.max(0, endLine - 1), Number.MAX_SAFE_INTEGER)
              editor.selection = new vscode.Selection(startPos, endPos)
              editor.revealRange(
                new vscode.Range(startPos, endPos),
                vscode.TextEditorRevealType.InCenter,
              )
            }
          } catch {
            // 文件不存在或无法打开时静默忽略
          }
        })
        .with({ type: 'insertSelectionFailed' }, () => {
          vscode.window.showInformationMessage(
            '请先打开一个 Agent 的对话面板，再使用此快捷键插入代码片段。',
          )
        })
        .with({ type: P.string.startsWith('flow.command.') }, ({ type, data }) => {
          // 对 flowStart 特殊处理：注入 flow 定义
          if (type === 'flow.command.flowStart') {
            const { flowId } = data as { flowId: string }
            const flow = currentFlows.flows.find((f) => f.id === flowId)
            if (!flow) return
            runnerManager.handleCommand(type, { ...data, flow })
          } else {
            runnerManager.handleCommand(type, data)
          }
        })
        .exhaustive()
    })

    panel.onDidDispose(() => {
      currentPanel = undefined
      runnerManager.disposeAll()
    })
  })

  const addSelectionToInput = vscode.commands.registerCommand(
    'agent-flow.addSelectionToInput',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      if (!currentPanel) return
      const { selection, document } = editor
      const selectedText = document.getText(selection)
      currentPanel.reveal(undefined, true)
      if (selectedText) {
        currentPanel.webview.postMessage({
          type: 'insertSelection',
          data: {
            text: selectedText,
            languageId: document.languageId,
            filename: vscode.workspace.asRelativePath(document.uri),
            line: [selection.start.line + 1, selection.end.line + 1],
          },
        } satisfies ExtensionToWebviewMessage)
      } else {
        currentPanel.webview.postMessage({
          type: 'insertSelection',
          data: {
            text: document.getText(),
            languageId: document.languageId,
            filename: vscode.workspace.asRelativePath(document.uri),
          },
        } satisfies ExtensionToWebviewMessage)
      }
    },
  )

  context.subscriptions.push(openPanel, addSelectionToInput)
}

export function deactivate() {}

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.css'),
  )
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'index.js'),
  )

  return `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Flow</title>
    <link rel="stylesheet" href="${styleUri}">
</head>
<body>
    <div id="root"></div>
    <script src="${scriptUri}"></script>
</body>
</html>
`
}
