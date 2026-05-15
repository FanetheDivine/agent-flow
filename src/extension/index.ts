import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import type {
  ExtensionFlowCommandEvents,
  ExtensionFlowCommandMessage,
  ExtensionFlowSignalMessage,
  ExtensionFromWebviewMessage,
  ExtensionToWebviewMessage,
  PersistedData,
} from '@/common'
import { FlowRunStateManager } from './FlowRunStateManager'
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
  /** webview 是否已就绪：以收到 load command 为准。dispose 时重置为 false */
  let webviewReady = false
  /** webview 未就绪时排队的指令型消息（load / insertSelection / focusFlow 等需要 UI 响应的） */
  const pendingMessages: ExtensionToWebviewMessage[] = []

  // 把 runner / 持久化 / 状态镜像 提到 activate 作用域：webview 关闭后这些对象继续存活，
  // 等下次开 panel 重连。
  const flowStore = new PersistedDataController()
  const flowRunStateManager = new FlowRunStateManager()
  let currentFlows: PersistedData = { flows: [] }

  const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
    // signal 进入前先喂给状态镜像，确保 webview 不在时 extension 这边状态依然完整
    if (msg.type.startsWith('flow.signal.')) {
      flowRunStateManager.applySignal(msg as ExtensionFlowSignalMessage)
    }
    log('[Extension → Webview]', msg.type, msg.data)
    currentPanel?.webview.postMessage(msg)
  }

  /**
   * 把"指令型"消息可靠地送达 webview：
   * - panel 已存在且 webview 已就绪 → 立即发送
   * - 否则推入 pending 队列。若 panel 不存在还会触发 openPanel，
   *   webview 启动并发出 load 后由 flushPending 一次性发送。
   * 用于 insertSelection、focusFlow 等 UI 引导信号 ——
   * 普通 flow.signal.* 走 postMessageToWebview 即可（webview 重开后会通过 load 拿到状态快照）。
   */
  const postMessageWhenReady = (msg: ExtensionToWebviewMessage) => {
    if (currentPanel && webviewReady) {
      // signal 也要让镜像消费一次，保持与 postMessageToWebview 行为一致
      if (msg.type.startsWith('flow.signal.')) {
        flowRunStateManager.applySignal(msg as ExtensionFlowSignalMessage)
      }
      log('[Extension → Webview]', msg.type, msg.data)
      currentPanel.webview.postMessage(msg)
      return
    }
    pendingMessages.push(msg)
    if (!currentPanel) {
      void vscode.commands.executeCommand('agent-flow.openPanel')
    }
  }

  const flushPendingMessages = () => {
    while (pendingMessages.length > 0) {
      const m = pendingMessages.shift()!
      if (m.type.startsWith('flow.signal.')) {
        flowRunStateManager.applySignal(m as ExtensionFlowSignalMessage)
      }
      log('[Extension → Webview]', m.type, m.data)
      currentPanel?.webview.postMessage(m)
    }
  }

  // notifyUser webPanel不存在或不可见 弹 VSCode 通知。
  // notifyUser: 当 panel 不存在或不可见时弹 VSCode 通知。
  flowRunStateManager.setNotifyHandler((data) => {
    const { agentName, flowId, flowName, reason } = data

    if (currentPanel && currentPanel.visible) return

    const msg = match(reason)
      .with('result', () => `Agent「${agentName}」生成完毕`)
      .with('awaiting-question', () => `Agent「${agentName}」需要回答`)
      .with('awaiting-tool-permission', () => `Agent「${agentName}」请求授权`)
      .with('flow-completed', () => `工作流「${flowName}」已完成`)
      .with('agent-error', () => `Agent「${agentName}」运行出错`)
      .exhaustive()
    vscode.window.showInformationMessage(msg, '查看').then((choice) => {
      if (choice !== '查看') return
      postMessageWhenReady({
        type: 'focusFlow',
        data: { flowId },
      })
      currentPanel?.reveal(undefined, true)
    })
  })

  const runnerManager = new FlowRunnerManager(
    postMessageToWebview,
    (flowId) => flowRunStateManager.getFlowRunStates()[flowId]?.shareValues ?? {},
  )

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

    // 初始化 panel 可见性

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      log('[Webview → Extension]', e.type, e.data)
      match(e)
        .with({ type: 'load' }, async () => {
          currentFlows = await flowStore.load()
          flowRunStateManager.applyFlows(currentFlows.flows, (flowId) =>
            runnerManager.disposeRunner(flowId),
          )
          postMessageToWebview({
            type: 'load',
            data: {
              flows: currentFlows.flows,
              flowRunStates: flowRunStateManager.getFlowRunStates(),
            },
          })
          // load 抵达即视为 webview 已就绪：把之前排队的消息一次性发出
          webviewReady = true
          flushPendingMessages()
        })
        .with({ type: 'save' }, async ({ data }) => {
          const storeData: PersistedData = { flows: data }
          currentFlows = storeData
          flowRunStateManager.applyFlows(currentFlows.flows, (flowId) =>
            runnerManager.disposeRunner(flowId),
          )
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
        .with({ type: P.string.startsWith('flow.command.') }, (e) => {
          // 先镜像到 state（flowStart 路径的覆盖式初始化也由 reducer 完成；killFlow 会置 stopped）
          flowRunStateManager.applyCommand(e as ExtensionFlowCommandMessage)
          const { type, data } = e
          if (type === 'flow.command.flowStart') {
            const { flowId } = data as ExtensionFlowCommandEvents['flow.command.flowStart']
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
      webviewReady = false
      // 故意不 disposeAll：runner 与 flowStateManager 在 webview 关闭后继续工作，
      // 下次重新打开 panel 时通过 load 把当前状态发回 webview。
    })
  })

  const addSelectionToInput = vscode.commands.registerCommand(
    'agent-flow.addSelectionToInput',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const { selection, document } = editor
      const selectedText = document.getText(selection)
      const insertMsg: ExtensionToWebviewMessage = selectedText
        ? {
            type: 'insertSelection',
            data: {
              text: selectedText,
              languageId: document.languageId,
              filename: vscode.workspace.asRelativePath(document.uri),
              line: [selection.start.line + 1, selection.end.line + 1],
            },
          }
        : {
            type: 'insertSelection',
            data: {
              text: document.getText(),
              languageId: document.languageId,
              filename: vscode.workspace.asRelativePath(document.uri),
            },
          }
      // panel 不存在时 postMessageWhenReady 会触发 openPanel 并把消息排队等 webview 就绪
      postMessageWhenReady(insertMsg)
      currentPanel?.reveal(undefined, true)
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
