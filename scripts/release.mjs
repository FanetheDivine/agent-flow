import { execSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(root, 'package.json')

const raw = readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(raw)

const parts = pkg.version.split('.')
if (parts.length !== 3 || parts.some((p) => !/^\d+$/.test(p))) {
  throw new Error(`无效的 version: ${pkg.version}`)
}
parts[2] = String(Number(parts[2]) + 1)
const nextVersion = parts.join('.')
const tag = `v${nextVersion}`

const indentMatch = raw.match(/^(\s+)"name"/m)
const indent = indentMatch ? indentMatch[1] : '  '
pkg.version = nextVersion
const newlineAtEnd = raw.endsWith('\n') ? '\n' : ''
writeFileSync(pkgPath, JSON.stringify(pkg, null, indent) + newlineAtEnd)

const run = (cmd) => {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

run(`git add .`)
run(`git commit -m "version"`)
run(`git tag ${tag}`)
run(`git push`)
run(`git push origin --tags`)

console.log(`\n已发布 ${tag}`)
