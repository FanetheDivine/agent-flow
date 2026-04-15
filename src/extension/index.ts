import { match, P } from 'ts-pattern'
import * as vscode from 'vscode'
import type { ExtensionFromWebviewMessage, ExtensionToWebviewMessage } from '@/common'
import type { FlowStore as FlowStoreData } from '@/common'
import { FlowRunnerManager } from './FlowRunnerManager'
import { FlowStoreController } from './FlowStoreController'

export function activate(context: vscode.ExtensionContext) {
  let currentPanel: vscode.WebviewPanel | undefined

  const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
    if (currentPanel) {
      currentPanel.reveal(vscode.ViewColumn.Active)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      'agentFlow',
      'Agent Flow',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      },
    )
    currentPanel = panel
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri)

    const flowStore = new FlowStoreController()

    const postMessageToWebview = (msg: ExtensionToWebviewMessage) => {
      panel.webview.postMessage(msg)
    }

    const runnerManager = new FlowRunnerManager(postMessageToWebview)

    let currentFlows: FlowStoreData = { flows: [] }

    panel.webview.onDidReceiveMessage(async (e: ExtensionFromWebviewMessage) => {
      match(e)
        .with({ type: 'requestFlows' }, async () => {
          currentFlows = await flowStore.loadFlows()
          postMessageToWebview({ type: 'loadFlows', data: currentFlows })
        })
        .with({ type: 'saveFlows' }, async ({ data }) => {
          const storeData: FlowStoreData = { flows: data }
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
        .otherwise(() => {})
    })

    panel.onDidDispose(() => {
      currentPanel = undefined
      runnerManager.disposeAll()
    })
  })

  context.subscriptions.push(openPanel)
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
