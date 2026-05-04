import type { UserMessageType } from '@/common'
import type { CodeRef } from './activeInputRegistry'

type MessageContent = UserMessageType['message']['content']

function isTextLikeFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true
  if (/\.(ts|tsx|js|jsx|mjs|cjs|md|json|txt|yaml|yml|html|htm|css|scss|less|py|go|rs|java|c|cpp|h|hpp|sh|bash|zsh|rb|php|sql|xml|toml|ini|env|lock)$/i.test(file.name)) return true
  return false
}

async function fileToBase64(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)))
  }
  return btoa(binary)
}

function refToText(ref: CodeRef): string {
  const range = ref.line
    ? ref.line[0] === ref.line[1]
      ? `L${ref.line[0]}`
      : `L${ref.line[0]}-${ref.line[1]}`
    : ''
  return `📎 ${ref.filename}${range ? ` ${range}` : ''}\n\`\`\`${ref.languageId}\n${ref.text}\n\`\`\``
}

/**
 * 将文本 / 文件 / 代码引用 组合为 SDKUserMessage 的 content：
 * - 代码引用 → text block，展开为带文件名+行号的代码块
 * - 图片文件 → image block (base64)
 * - 文本类文件 → text block，包含文件名和内容
 * - 其他二进制文件 → text block，标注"已附加"（避免 token 爆炸）
 */
export async function buildUserMessageContent(
  text: string,
  files: File[],
  references: CodeRef[] = [],
): Promise<MessageContent> {
  if (files.length === 0 && references.length === 0) return text

  const blocks: Exclude<MessageContent, string> = []

  for (const ref of references) {
    blocks.push({ type: 'text', text: refToText(ref) })
  }

  for (const file of files) {
    if (file.type.startsWith('image/')) {
      const data = await fileToBase64(file)
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: file.type as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
          data,
        },
      })
    } else if (isTextLikeFile(file)) {
      const content = await file.text()
      blocks.push({
        type: 'text',
        text: `📎 文件: ${file.name}\n\`\`\`\n${content}\n\`\`\``,
      })
    } else {
      blocks.push({
        type: 'text',
        text: `📎 附件（未内联）: ${file.name} (${file.size} bytes, ${file.type || 'unknown'})`,
      })
    }
  }
  if (text.trim()) {
    blocks.push({ type: 'text', text })
  }
  return blocks
}
