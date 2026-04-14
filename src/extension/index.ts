import * as vscode from 'vscode'
import type { ExtensionFromWebviewMessage, ExtensionToWebviewMessage } from '@/common'

export function activate(context: vscode.ExtensionContext) {
  const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
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
    panel.webview.html = getWebviewContent(panel.webview, context.extensionUri)
    panel.webview.onDidReceiveMessage((e: ExtensionFromWebviewMessage) => {
      const message = e
      console.log(message)
      panel.webview.postMessage({ a: 'aa' })
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
