import * as vscode from 'vscode'

let channel: vscode.OutputChannel | undefined

export function initLogger(context: vscode.ExtensionContext): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Agent Flow')
    context.subscriptions.push(channel)
  }
  return channel
}

export function log(...args: unknown[]): void {
  console.log(args)
  channel?.appendLine(args.map(formatArg).join(' '))
}

export function logError(...args: unknown[]): void {
  channel?.appendLine('[ERROR] ' + args.map(formatArg).join(' '))
}

function formatArg(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.stack ?? v.message
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
