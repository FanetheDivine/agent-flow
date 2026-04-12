import { FC, useState } from 'react'
import { Button } from 'antd'
import { Test } from '@/webview/components/Test'

export const App: FC = () => {
  const [count, setCount] = useState(0)

  return (
    <div
      className='p-4'
      style={{
        fontFamily: 'var(--vscode-font-family)',
        color: 'var(--vscode-foreground)',
      }}
    >
      <h2 className='m-0'>Agent Flow</h2>
      <p>
        Count: <strong>{count}</strong>
      </p>
      <Button
        onClick={() => setCount((c) => c + 1)}
        type='primary'
        className='bg-white text-red-500'
      >
        +1
      </Button>
      <Test />
    </div>
  )
}
