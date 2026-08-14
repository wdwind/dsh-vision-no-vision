// Stands in for the model: creates a small synthetic test image with Pillow,
// drives one real call through the harness tool pipeline (registry →
// validation → execute → result materialization), and prints the
// representation the LLM would receive.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { CallId } from '@deepseek-ai/dsh-llm'

const execFileAsync = promisify(execFile)

export const name = 'smoke-driver'
export const inject = ['tools']

/** A 144x108 landscape: sky above, grass below, red circle, brown house. */
async function makeTestImage(): Promise<void> {
  const code = [
    "from PIL import Image, ImageDraw",
    "im = Image.new('RGB', (144, 108), 'white')",
    "d = ImageDraw.Draw(im)",
    "d.rectangle([0, 0, 143, 54], fill=(135, 206, 235))",
    "d.rectangle([0, 55, 143, 107], fill=(60, 140, 70))",
    "d.ellipse([20, 12, 52, 44], fill=(230, 60, 40))",
    "d.rectangle([82, 42, 112, 82], fill=(120, 75, 45))",
    "im.save('test-image.png')",
  ].join('; ')
  await execFileAsync('python', ['-c', code], { windowsHide: true })
}

export function apply(ctx: Context) {
  void (async () => {
    try {
      await makeTestImage()
      const result = await ctx.tools.execute({
        callId: CallId('smoke-1'),
        name: 'analyze_image',
        arguments: { path: 'test-image.png' },
        signal: new AbortController().signal,
      })
      const text = result.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
      const lines = text.split('\n')
      console.log('[smoke] representation lines:', lines.length)
      console.log('[smoke] head:')
      console.log(lines.slice(0, 12).join('\n'))
      console.log('[smoke] tail:')
      console.log(lines.slice(-6).join('\n'))
      console.log(
        '[smoke] wrapped in <image_representation>:',
        text.startsWith('<image_representation>')
        && text.trimEnd().endsWith('</image_representation>'),
      )
    } catch (error) {
      console.error('[smoke] FAILED:', error)
      process.exitCode = 1
    }
  })()
}
