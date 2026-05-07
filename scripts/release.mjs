import { execSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const run = (cmd) => {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd: root, stdio: 'inherit' })
}

const tag = execSync('npm version patch --no-git-tag-version', { cwd: root }).toString().trim()
console.log(`> npm version patch -> ${tag}`)

run(`npm run format`)
run(`git add .`)
run(`git commit -m "${tag}"`)
run(`git tag ${tag}`)
run(`git push`)
run(`git push origin --tags`)

console.log(`\n已发布 ${tag}`)
