import type { FC, MouseEventHandler } from 'react'
import { Tag } from 'antd'
import { LinkOutlined } from '@ant-design/icons'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'
import type { CodeRef } from '@/webview/utils/activeInputRegistry'

/** 展示层只需要 filename + line，`text` 由调用方在序列化时自行补齐 */
export type CodeRefChipData = Pick<CodeRef, 'filename' | 'line'>

type Props = {
  codeRef: CodeRefChipData
  closable?: boolean
  onClose?: () => void
  /** 覆盖默认点击行为（默认打开对应文件 + 行范围） */
  onClick?: MouseEventHandler<HTMLSpanElement>
}

/** 代码片段引用的通用展示组件：`📎 文件名 [L1-5]`，点击打开文件并选中行 */
export const CodeRefChip: FC<Props> = ({ codeRef, closable, onClose, onClick }) => {
  const range = codeRef.line
    ? codeRef.line[0] === codeRef.line[1]
      ? `L${codeRef.line[0]}`
      : `L${codeRef.line[0]}-${codeRef.line[1]}`
    : undefined
  return (
    <Tag
      closable={closable}
      onClose={onClose}
      className='m-0 cursor-pointer break-all whitespace-pre-wrap'
      onClick={
        onClick ??
        (() =>
          postMessageToExtension({
            type: 'openFile',
            data: { filename: codeRef.filename, line: codeRef.line },
          }))
      }
    >
      <LinkOutlined /> {codeRef.filename}
      {range ? ` ${range}` : ''}
    </Tag>
  )
}
