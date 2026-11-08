import { describe, expect, test } from 'bun:test'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'

const output = join(import.meta.dir, '../../dist/frontend-spa')

describe('static workbench build', () => {
  test('contains the SPA entry and fingerprinted resources', async () => {
    const html = await readFile(join(output, 'index.html'), 'utf8')
    expect(html).toContain('window.__reactRouterContext')
    // Absolute: a relative ./assets path breaks deep routes such as /jianlai/manage/<path>.
    expect(html).toContain('"/jianlai/assets/')
    expect(html).toContain('/jianlai/manifest.webmanifest')
    expect(html).not.toMatch(/(?:src|href)="\.\//)
    const scripts = [...html.matchAll(/(?:src|href)="([^\"]+\.(?:js|css))"/g)]
    expect(scripts.length).toBeGreaterThanOrEqual(2)
    for (const [, path] of scripts) await access(join(output, path!.replace('/jianlai/', '')))
  })

  test('includes local fonts, logo, and the client router bundle', async () => {
    await access(join(output, 'logo.svg'))
    await access(join(output, 'fonts/inter-latin-wght.woff2'))
    await access(join(output, 'fonts/source-han-sans-sc-vf.woff2'))
    const html = await readFile(join(output, 'index.html'), 'utf8')
    expect(html).toContain('type="module"')
  })
})
