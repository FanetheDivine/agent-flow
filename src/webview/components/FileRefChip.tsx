import { useMemo, useState, type FC } from 'react'
import { Image, Tag } from 'antd'
import { FileOutlined } from '@ant-design/icons'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'

/**
 * 单个文件引用在 UI 层的元信息。
 * 图片需要 `base64`（不含 `data:...;base64,` 前缀）才能渲染缩略图 / 预览；
 * 文本类需要 `text` 才能在 VSCode 中呼出预览 Panel。
 */
export type FileRefData = {
  id: string
  name: string
  mimeType: string
  size?: number
  /** 仅图片需要：base64 字符串（不含 data URL 前缀） */
  base64?: string
  /** 仅文本类需要：UTF-8 文本，用于预览 */
  text?: string
}

type Props = {
  data: FileRefData
  closable?: boolean
  onClose?: () => void
}

/**
 * 文件引用的通用展示组件：
 * - 图片：1em 方形缩略图（base64 → data URL），点击 Tag 打开 antd Image 预览
 * - 文本：文件图标 + 文件名；有 `text` 时点击呼出 VSCode 预览 Panel
 */
export const FileRefChip: FC<Props> = ({ data, closable, onClose }) => {
  const [previewOpen, setPreviewOpen] = useState(false)
  const isImage = data.mimeType.startsWith('image/')
  const dataUrl = useMemo(
    () => (isImage && data.base64 ? `data:${data.mimeType};base64,${data.base64}` : undefined),
    [data.base64, data.mimeType, isImage],
  )

  if (isImage && dataUrl) {
    return (
      <>
        <Tag
          closable={closable}
          onClose={onClose}
          style={{
            margin: 0,
            padding: 2,
            cursor: 'zoom-in',
            display: 'inline-flex',
            alignItems: 'center',
            lineHeight: 1,
          }}
          onClick={(e) => {
            e.stopPropagation()
            setPreviewOpen(true)
          }}
        >
          <img
            src={dataUrl}
            alt={data.name}
            style={{
              width: '1em',
              height: '1em',
              objectFit: 'cover',
              verticalAlign: 'middle',
              borderRadius: 2,
            }}
          />
        </Tag>
        <Image
          src={dataUrl}
          alt={data.name}
          style={{ display: 'none' }}
          preview={{
            visible: previewOpen,
            onVisibleChange: (v) => setPreviewOpen(v),
            src: dataUrl,
          }}
        />
      </>
    )
  }

  const canPreview = data.text !== undefined
  return (
    <Tag
      closable={closable}
      onClose={onClose}
      style={{ margin: 0, cursor: canPreview ? 'pointer' : 'default', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}
      onClick={
        canPreview
          ? (e) => {
              e.stopPropagation()
              postMessageToExtension({
                type: 'previewAttachment',
                data: { name: data.name, content: data.text! },
              })
            }
          : undefined
      }
    >
      <FileOutlined /> {data.name}
    </Tag>
  )
}
