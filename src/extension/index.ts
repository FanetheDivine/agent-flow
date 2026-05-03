import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import type {
  ExtensionFromWebviewMessage,
  ExtensionToWebviewMessage,
  PersistedFlows,
} from '@/common'
import { FlowRunnerManager } from './FlowRunnerManager'
import { PersistedFlowsController } from './PersistedFlowsController'

export function activate(context: vscode.ExtensionContext) {
  let currentPanel: vscode.WebviewPanel | undefined

  const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
    if (currentPanel) {
      currentPanel.reveal(undefined, true)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      'agentFlow',
      'Agent Flow',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    )
    currentPanel = panel
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri)

    const flowStore = new PersistedFlowsController()

    const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
      console.log('[Extension → Webview]', msg.type, msg.data)
      panel.webview.postMessage(msg)
    }

    const runnerManager = new FlowRunnerManager(postMessageToWebview)

    let currentFlows: PersistedFlows = { flows: [] }

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      console.log('[Webview → Extension]', e.type, e.data)
      match(e)
        .with({ type: 'requestFlows' }, async () => {
          currentFlows = await flowStore.loadFlows()
          postMessageToWebview({ type: 'loadFlows', data: currentFlows })
        })
        .with({ type: 'saveFlows' }, async ({ data }) => {
          const storeData: PersistedFlows = { flows: data }
          currentFlows = storeData
          await flowStore.saveFlows(storeData)
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
    () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) return
      const { selection, document } = editor
      const text = document.getText(selection)
      if (!text) return
      if (!currentPanel) {
        return
      }
      currentPanel.reveal(vscode.ViewColumn.Beside, true)
      currentPanel.webview.postMessage({
        type: 'insertSelection',
        data: {
          text,
          languageId: document.languageId,
          filename: vscode.workspace.asRelativePath(document.uri),
          startLine: selection.start.line + 1,
          endLine: selection.end.line + 1,
        },
      } satisfies ExtensionToWebviewMessage)
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
