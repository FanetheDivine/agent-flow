declare module '*.module.css' {
  const styles: Record<string, string>
  export default styles
}

declare module '*.css'

interface VsCodeApi {
  getState(): unknown
  setState(state: unknown): void
  postMessage(message: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi
