import { query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { appendFileSync } from 'fs'
import { resolve } from 'path'
import * as readline from 'readline/promises'

type UserMessageParam = { role: 'user'; content: string }

/** 简单的异步消息队列 — SDK 通过 async iterator 消费 */
class MessageQueue {
  private messages: SDKUserMessage[] = []
  private waiting: ((msg: SDKUserMessage) => void) | null = null
  private closed = false

  push(text: string) {
    const msg: SDKUserMessage = {
      type: 'user',
      message: { role: 'user', content: text } as UserMessageParam,
      parent_tool_use_id: null,
    }
    if (this.waiting) {
      this.waiting(msg)
      this.waiting = null
    } else {
      this.messages.push(msg)
    }
  }

  async *[Symbol.asyncIterator]() {
    while (!this.closed) {
      if (this.messages.length > 0) {
        yield this.messages.shift()!
      } else {
        const msg = await new Promise<SDKUserMessage>((r) => (this.waiting = r))
        if (this.closed) break
        yield msg
      }
    }
  }

  close() {
    this.closed = true
    this.waiting?.({
      type: 'user',
      message: { role: 'user', content: '' } as UserMessageParam,
      parent_tool_use_id: null,
    })
  }
}

// ── 日志 ─────────────────────────────────────────────────────────────────────

const logFile = resolve(import.meta.dirname ?? '.', 'sdk-log.jsonl')

function logMessage(msg: unknown) {
  appendFileSync(logFile, JSON.stringify({ ts: Date.now(), msg }) + '\n', 'utf-8')
}

// ── 终端工具 ──────────────────────────────────────────────────────────────────

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question).finally(() => rl.close())
}

function parseChoice(response: string, options: { label: string }[]): string {
  const labels = response
    .split(',')
    .map((s) => parseInt(s.trim(), 10) - 1)
    .filter((i) => !isNaN(i) && i >= 0 && i < options.length)
    .map((i) => options[i].label)
  return labels.length > 0 ? labels.join(', ') : response
}

// ── canUseTool 回调 ───────────────────────────────────────────────────────────

async function canUseTool(
  toolName: string,
  input: Record<string, unknown>,
  _options: {
    signal: AbortSignal
    title?: string
    displayName?: string
    description?: string
    toolUseID: string
  },
): Promise<
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  // AskUserQuestion
  if (toolName === 'AskUserQuestion') {
    const questions = (input as any).questions as Array<{
      question: string
      header: string
      options: Array<{ label: string; description: string }>
      multiSelect: boolean
    }>
    const answers: Record<string, string> = {}
    for (const q of questions) {
      console.log(`\n\x1b[36m[${q.header}]\x1b[0m ${q.question}`)
      q.options.forEach((opt, i) =>
        console.log(`  ${i + 1}. \x1b[1m${opt.label}\x1b[0m — ${opt.description}`),
      )
      answers[q.question] = parseChoice(
        (await ask(`  选择 (${q.multiSelect ? '多选' : '序号或自定义'}): `)).trim(),
        q.options,
      )
    }
    return { behavior: 'allow', updatedInput: { questions: input.questions, answers } }
  }

  // 工具审批
  console.log(
    `\n\x1b[33m[审批]\x1b[0m ${toolName}: ${toolName === 'Bash' ? input.command : (input.file_path ?? JSON.stringify(input).slice(0, 100))}`,
  )
  return (await ask('  (y/n): ')).trim().toLowerCase() === 'y'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: '用户拒绝' }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const queue = new MessageQueue()

  console.log('\n\x1b[32m━━━ Claude Agent SDK Demo ━━━\x1b[0m')
  console.log('\x1b[2m输入消息开始对话，输入 exit 退出\x1b[0m\n')

  // 首次输入 — 启动对话
  const first = (await ask('\x1b[32mYou>\x1b[0m ')).trim()
  if (!first || first.toLowerCase() === 'exit') return
  queue.push(first)

  try {
    for await (const msg of query({
      prompt: queue,
      options: {
        maxTurns: 100,
        model: 'qwen3.6-plus',
        permissionMode: 'default',
        allowedTools: ['Read', 'Glob', 'Grep', 'AskUserQuestion'],
        canUseTool,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: '' },
      },
    })) {
      logMessage(msg)
      if (msg.type === 'assistant') {
        // AI 输出中 — 只显示，不接收输入
        const content = msg.message?.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text') process.stdout.write(block.text)
          }
        }
      } else if (msg.type === 'result') {
        // AI 回合结束 — 现在允许用户输入
        console.log(
          msg.subtype === 'success'
            ? '\n\n\x1b[32m✓\x1b[0m'
            : `\n\n\x1b[31m✗ ${msg.errors?.join('; ')}\x1b[0m`,
        )
        const input = (await ask('\x1b[32mYou>\x1b[0m ')).trim()
        if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') queue.close()
        else if (input) queue.push(input)
      }
    }
  } catch (err) {
    console.error(`\n\x1b[31mFatal: ${(err as Error).message}\x1b[0m`)
  }
}

main()
