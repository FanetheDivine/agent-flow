import { FC, useEffect, useState } from 'react'
import { Button } from 'antd'
import { postMessageToExtension, subscribeExtensionMessage } from './utils/ExtensionMessage'

export const App: FC = () => {
  const [str, setStr] = useState('')
  useEffect(() => {
    const cleanup = subscribeExtensionMessage((v) => setStr((s) => s + '\n' + JSON.stringify(v)))
    return cleanup
  }, [])
  return (
    <>
      {str}
      <Button
        onClick={() => {
          postMessageToExtension({
            type: 'loadFlow',
            data: {
              name: 'a',
            },
          })
        }}
      >
        aaa
      </Button>
    </>
  )
}
