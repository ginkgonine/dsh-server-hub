import { copyFile, cp, mkdir } from 'node:fs/promises'

await mkdir(new URL('../lib/', import.meta.url), { recursive: true })
await Promise.all([
  copyFile(new URL('../src/index.js', import.meta.url), new URL('../lib/index.js', import.meta.url)),
  copyFile(new URL('../src/client.js', import.meta.url), new URL('../lib/client.js', import.meta.url)),
  cp(new URL('../src/remote/', import.meta.url), new URL('../lib/remote/', import.meta.url), { recursive: true }),
])
