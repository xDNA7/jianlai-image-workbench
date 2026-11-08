import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { URL } from 'node:url'

const expectedNode = readFileSync(new URL('../.node-version', import.meta.url), 'utf8').trim()
const expectedBun = readFileSync(new URL('../.bun-version', import.meta.url), 'utf8').trim()
const { packageManager } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const actualBun = execFileSync('bun', ['--version'], { encoding: 'utf8' }).trim()
if (process.versions.node !== expectedNode || actualBun !== expectedBun || packageManager !== `bun@${expectedBun}`) {
  throw new Error(`Toolchain mismatch: expected Node ${expectedNode}, Bun ${expectedBun}; received Node ${process.versions.node}, Bun ${actualBun}, packageManager ${packageManager}`)
}
console.log(`Verified Node ${expectedNode}, Bun ${expectedBun}`)
