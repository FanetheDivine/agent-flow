import * as esbuild from 'esbuild'
import tailwindPlugin from 'esbuild-plugin-tailwindcss'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started')
    })
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`)
        console.error(`    ${location.file}:${location.line}:${location.column}:`)
      })
      console.log('[watch] build finished')
    })
  },
}

const extensionCtx = await esbuild.context({
  entryPoints: ['src/extension/index.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'node',
  outfile: 'dist/extension.js',
  external: ['vscode'],
  logLevel: 'silent',
  alias: {
    '@': path.resolve(__dirname, 'src'),
  },
  plugins: [esbuildProblemMatcherPlugin],
})
const webviewCtx = await esbuild.context({
  entryPoints: ['src/webview/index.tsx'],
  bundle: true,
  format: 'iife',
  jsx: 'automatic',
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  platform: 'browser',
  outdir: 'dist/webview',
  entryNames: 'index',
  logLevel: 'silent',
  alias: {
    '@': path.resolve(__dirname, 'src'),
  },
  plugins: [tailwindPlugin({ cssModules: { enabled: true } }), esbuildProblemMatcherPlugin],
})
if (watch) {
  await Promise.all([extensionCtx.watch(), webviewCtx.watch()])
} else {
  await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()])
  await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()])
}
