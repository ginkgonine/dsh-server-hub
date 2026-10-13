import { readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = new URL(item.name + (item.isDirectory() ? '/' : ''), directory)
    if (item.isDirectory()) await check(target)
    else if (item.name.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', fileURLToPath(target)], { stdio: 'inherit' })
      if (result.error) throw result.error
      if (result.status !== 0) process.exit(result.status || 1)
    }
  }
}
await check(new URL('../lib/', import.meta.url))
