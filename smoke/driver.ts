// Stands in for the model and for the configured text LLM: creates a small
// synthetic test image with Pillow, registers a mock adapter on ctx.llm, and
// drives one real call through the harness tool pipeline — verifying that the
// tool receives the representation, calls the mock model, and returns the
// model's understanding as its output.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

const execFileAsync = promisify(execFile)

export const name = 'smoke-driver'
export const inject = ['tools', 'llm']

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

/** Mock text model: echoes the prompt structure and returns a canned analysis. */
class MockVisionAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const userText = options.messages
      .map(message => message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join(''))
      .join('\n')
    console.log('[smoke] llm called with provider/model:', options.provider, options.model)
    console.log('[smoke] llm got system instructions:', options.system?.includes('STAGE 1: COMPLETE VISUAL ANALYSIS') === true)
    console.log('[smoke] llm got representation:', userText.includes('GRAYSCALE VIEW') && userText.includes('<image_representation>'))
    const text = [
      '## Visual analysis',
      '### Composition',
      'The representation shows a bright landscape: a light upper region above a darker lower band, with a small dense rounded object in the upper-left and a rectangular mass in the lower middle.',
      '## Top three educated guesses',
      '1. a red sun over a green field — 60%',
      '   - Supporting evidence: rounded high-contrast object top-left; horizontal horizon line; green lower region',
      '   - Uncertainty: the lower rectangle could be a building rather than vegetation',
    ].join('\n')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx: Context) {
  ctx.llm.registerAdapter(['smoke'], new MockVisionAdapter())
  void (async () => {
    try {
      await makeTestImage()
      const result = await ctx.tools.execute({
        callId: CallId('smoke-1'),
        name: 'vision-nv',
        arguments: { path: 'test-image.png' },
        signal: new AbortController().signal,
      })
      const text = result.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join('')
      console.log('[smoke] tool returned the final understanding:')
      console.log(text)
    } catch (error) {
      console.error('[smoke] FAILED:', error)
      process.exitCode = 1
    }
  })()
}
