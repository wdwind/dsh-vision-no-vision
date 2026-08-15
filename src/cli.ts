/** Standalone CLI for the converter: `node lib/cli.js IMAGE`. */
import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describeImage } from './ascii-vision.ts'

async function main(): Promise<void> {
  const script = basename(process.argv[1] ?? 'cli.js')
  if (process.argv.length !== 3) {
    console.error(`Usage: ${script} IMAGE`)
    process.exitCode = 2
    return
  }
  const path = process.argv[2]!
  try {
    if (!statSync(path).isFile()) {
      console.error(`Error: file not found: ${path}`)
      process.exitCode = 1
      return
    }
    console.log(await describeImage(path))
  } catch (error) {
    console.error(`Error: unable to process ${path}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  void main()
}
