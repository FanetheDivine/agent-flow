import { type FC, type ReactNode } from 'react'
import { Tag } from 'antd'
import { EditOutlined } from '@ant-design/icons'
import { match } from 'ts-pattern'
import { postMessageToExtension } from '@/webview/utils/ExtensionMessage'

type Props = {
  filePath: string
  oldString: string
  newString: string
  status: 'pending' | 'success' | 'error'
  fork?: ReactNode
}

export const EditDiffCard: FC<Props> = ({ filePath, oldString, newString, status, fork }) => {
  const statusTag = match(status)
    .with('success', () => (
      <Tag color='success' className='m-0 ml-auto text-[10px]'>
        已应用
      </Tag>
    ))
    .with('error', () => (
      <Tag color='error' className='m-0 ml-auto text-[10px]'>
        已中断
      </Tag>
    ))
    .with('pending', () => (
      <Tag color='processing' className='m-0 ml-auto text-[10px]'>
        执行中
      </Tag>
    ))
    .exhaustive()

  return (
    <div className='flex flex-col gap-2 overflow-x-hidden rounded-md border border-[#45475a] bg-[#181825] px-3 py-2'>
      <div className='flex items-center gap-2'>
        <EditOutlined className='text-[#89b4fa]' />
        <span className='font-semibold text-[#cdd6f4]'>文件变更</span>
        {fork}
        {statusTag}
      </div>
      <span className='text-[#cdd6f4]'>
        {filePath}，
        <a
          href='#'
          onClick={(e) => {
            e.preventDefault()
            postMessageToExtension({
              type: 'openDiff',
              data: { file_path: filePath, old_string: oldString, new_string: newString, status },
            })
          }}
          className='text-[#89b4fa] hover:underline'
        >
          点击查看差异
        </a>
      </span>
    </div>
  )
}
