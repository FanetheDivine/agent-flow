import * as esbuild from 'esbuild'
import tailwindPlugin from 'esbuild-plugin-tailwindcss'
import { createRequire } from 'module'
import fs from 'node:fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const nodeRequire = createRequire(import.meta.url)

const production = process.argv.includes('--production')
const watch = process.argv.includes('--watch')

const externalPackages = ['@anthropic-ai/claude-agent-sdk']

const vsceTargetToSdkBinary = {
  'win32-x64': '@anthropic-ai/claude-agent-sdk-win32-x64',
  'win32-arm64': '@anthropic-ai/claude-agent-sdk-win32-arm64',
  'darwin-x64': '@anthropic-ai/claude-agent-sdk-darwin-x64',
  'darwin-arm64': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  'linux-x64': '@anthropic-ai/claude-agent-sdk-linux-x64',
  'linux-arm64': '@anthropic-ai/claude-agent-sdk-linux-arm64',
  'alpine-x64': '@anthropic-ai/claude-agent-sdk-linux-x64-musl',
  'alpine-arm64': '@anthropic-ai/claude-agent-sdk-linux-arm64-musl',
}

function resolvePackageDir(req, pkg) {
  try {
    return path.dirname(req.resolve(`${pkg}/package.json`))
  } catch {
    // package has 'exports' without './package.json' — walk up from main entry
  }
  try {
    let dir = path.dirname(req.resolve(pkg))
    while (dir !== path.dirname(dir)) {
      const pj = path.join(dir, 'package.json')
      if (fs.existsSync(pj)) {
        const name = JSON.parse(fs.readFileSync(pj, 'utf8')).name
        if (name === pkg) return dir
      }
      dir = path.dirname(dir)
    }
  } catch {
    // ignore
  }
  return null
}

const sdkDir = resolvePackageDir(nodeRequire, '@anthropic-ai/claude-agent-sdk')
if (!sdkDir) {
  throw new Error('@anthropic-ai/claude-agent-sdk is not installed')
}
const sdkScopedRequire = createRequire(path.join(sdkDir, 'package.json'))

function pickDevBinaryPkg() {
  const { platform, arch } = process
  if (platform === 'linux') {
    const isMusl = fs.existsSync('/etc/alpine-release')
    return `@anthropic-ai/claude-agent-sdk-linux-${arch}${isMusl ? '-musl' : ''}`
  }
  return `@anthropic-ai/claude-agent-sdk-${platform}-${arch}`
}

const vsceTarget = process.env.VSCE_TARGET
let binaryPkg
if (vsceTarget) {
  binaryPkg = vsceTargetToSdkBinary[vsceTarget]
  if (!binaryPkg) {
    throw new Error(
      `Unsupported VSCE_TARGET "${vsceTarget}". Supported: ${Object.keys(vsceTargetToSdkBinary).join(', ')}`,
    )
  }
} else {
  binaryPkg = pickDevBinaryPkg()
}

const vendorPackages = [{ name: '@anthropic-ai/claude-agent-sdk', dir: sdkDir }]
const binaryDir = resolvePackageDir(sdkScopedRequire, binaryPkg)
if (!binaryDir) {
  if (vsceTarget) {
    throw new Error(`Native binary package not installed: ${binaryPkg}`)
  }
  console.warn(`[esbuild] dev binary package not installed (skipping): ${binaryPkg}`)
} else {
  vendorPackages.push({ name: binaryPkg, dir: binaryDir })
}

const vendorRoot = path.resolve(__dirname, 'dist/node_modules')
fs.rmSync(vendorRoot, { recursive: true, force: true })
for (const { name, dir } of vendorPackages) {
  const dst = path.join(vendorRoot, name)
  fs.cpSync(dir, dst, { recursive: true, dereference: true })
}

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
  external: ['vscode', ...externalPackages],
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
