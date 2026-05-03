import { FC, PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, theme } from 'antd'
import zh_CN from 'antd/es/locale/zh_CN'
import { StyleProvider } from '@ant-design/cssinjs'
import { XProvider } from '@ant-design/x'
import zh_CN_X from '@ant-design/x/locale/zh_CN'
import '@ant-design/x-markdown/themes/dark.css'
import 'dayjs/locale/zh-cn'
import { App } from './App'
import './global.css'
import './utils/ExtensionMessage'

/** antd 首屏样式 样式兼容 本地化 主题等 */
const AntdProvider: FC<PropsWithChildren> = (props) => {
  return (
    <StyleProvider layer>
      <XProvider locale={{ ...zh_CN, ...zh_CN_X }} theme={{ algorithm: theme.darkAlgorithm }}>
        <AntdApp className='app'> {props.children}</AntdApp>
      </XProvider>
    </StyleProvider>
  )
}

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <AntdProvider>
      <App />
    </AntdProvider>,
  )
}
