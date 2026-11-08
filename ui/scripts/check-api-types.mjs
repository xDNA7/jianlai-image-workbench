import { readFile } from 'node:fs/promises'
import { URL } from 'node:url'
import openapiTS, { astToString, COMMENT_HEADER } from 'openapi-typescript'

// Generate in memory: CI must report drift without rewriting the checked-in file.
const schema = new URL('../../docs/openapi.yaml', import.meta.url)
const target = new URL('../src/api/generated.ts', import.meta.url)
const expected = COMMENT_HEADER + astToString(await openapiTS(schema))
if (await readFile(target, 'utf8') !== expected) {
  console.error('API types differ from docs/openapi.yaml. Run bun run api:types and commit the generated file.')
  process.exitCode = 1
} else {
  console.log('API generated types match docs/openapi.yaml')
}
