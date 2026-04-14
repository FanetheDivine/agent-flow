import { FC, PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { App as AntdApp, ConfigProvider } from 'antd'
import zh_CN from 'antd/es/locale/zh_CN'
import { StyleProvider } from '@ant-design/cssinjs'
import 'dayjs/locale/zh-cn'
import { App } from './App'
import './global.css'
import './utils/ExtensionMessage'

/** antd 首屏样式 样式兼容 本地化 主题等 */
const AntdProvider: FC<PropsWithChildren> = (props) => {
  return (
    <StyleProvider layer>
      <ConfigProvider locale={zh_CN}>
        <AntdApp className='app'> {props.children}</AntdApp>
      </ConfigProvider>
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
