import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	const openPanel = vscode.commands.registerCommand('agent-flow.openPanel', () => {
		const panel = vscode.window.createWebviewPanel(
			'agentFlow',
			'Agent Flow',
			vscode.ViewColumn.Active,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')]
			}
		);
		panel.webview.html = getWebviewContent(panel.webview, context.extensionUri);
	});

	context.subscriptions.push(openPanel);
}

export function deactivate() { }

function getWebviewContent(webview: vscode.Webview, extensionUri: vscode.Uri): string {

	return `
<!DOCTYPE html>
<html lang="zh">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Flow</title>
</head>
<body>
    <div id="root">aaa</div>
</body>
</html>
`;
}
