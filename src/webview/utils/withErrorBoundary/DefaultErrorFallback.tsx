import { FC } from 'react'
import { FallbackProps } from 'react-error-boundary'
import { Result, Button } from 'antd'
import { ReloadOutlined } from '@ant-design/icons'

export const DefaultErrorFallback: FC<FallbackProps> = (props) => {
  const { error, resetErrorBoundary } = props
  return (
    <div className='flex h-full w-full flex-1 items-center justify-center'>
      <Result
        status={'error'}
        title={'发生错误'}
        subTitle={(error as any)?.message}
        extra={[
          <Button key='retry' type='primary' icon={<ReloadOutlined />} onClick={resetErrorBoundary}>
            重试
          </Button>,
          <Button
            key='refresh'
            // eslint-disable-next-line no-self-assign
            onClick={() => (window.location.href = window.location.href)}
          >
            {'刷新'}
          </Button>,
        ]}
      />
    </div>
  )
}
