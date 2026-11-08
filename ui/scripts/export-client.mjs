import { cp, rm, readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'

const source = resolve(import.meta.dirname, '../build/client')
const target = resolve(import.meta.dirname, process.env.VITE_OUT_DIR || '../../dist/frontend-spa')

// Hash the client entry and every emitted asset; this identifies contents, not build time.
const hash = createHash('sha256')
async function hashFiles(directory) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'version.json') continue
    const path = resolve(directory, entry.name)
    hash.update(entry.name)
    if (entry.isDirectory()) await hashFiles(path)
    else hash.update(await readFile(path))
  }
}
await hashFiles(source)
await writeFile(resolve(source, 'version.json'), JSON.stringify({ version: hash.digest('hex') }) + '\n')

await rm(target, { recursive: true, force: true })
await cp(source, target, { recursive: true })
console.log(`Exported ${source} -> ${target}`)
