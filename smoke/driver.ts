// Stands in for the model and for the configured text LLM: draws a small
// synthetic test image into a raw RGBA buffer and encodes it with sharp (no
// Python involved), registers a mock adapter on ctx.llm, and drives two real
// vision-nv calls through the harness tool pipeline — verifying that the tool
// receives the representation, applies EXIF orientation for JPEGs, calls the
// mock model, and returns the model's understanding as its output.
import sharp from 'sharp'

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

export const name = 'smoke-driver'
export const inject = ['tools', 'llm']

const WIDTH = 144
const HEIGHT = 108

/** A 144x108 landscape: sky above, grass below, red circle, brown house. */
function drawTestImage(): Buffer {
  const buffer = Buffer.alloc(WIDTH * HEIGHT * 4)
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      let [r, g, b] = y < 55 ? [135, 206, 235] : [60, 140, 70] // sky / grass
      const dx = (x - 36) / 16.5 // red circle (same footprint as before)
      const dy = (y - 28) / 16.5
      if (dx * dx + dy * dy <= 1) [r, g, b] = [230, 60, 40]
      if (x >= 82 && x <= 112 && y >= 42 && y <= 82) [r, g, b] = [120, 75, 45] // house
      const offset = (y * WIDTH + x) * 4
      buffer[offset] = r
      buffer[offset + 1] = g
      buffer[offset + 2] = b
      buffer[offset + 3] = 255
    }
  }
  return buffer
}

/** Encode the drawing as a PNG and as a JPEG carrying EXIF orientation 6 (rotate 90 CW). */
async function makeTestImages(): Promise<void> {
  const raw = { raw: { width: WIDTH, height: HEIGHT, channels: 4 as const } }
  await sharp(drawTestImage(), raw).png().toFile('test-image.png')
  await sharp(drawTestImage(), raw)
    .jpeg({ quality: 90 })
    .withMetadata({ orientation: 6 })
    .toFile('test-image.jpg')
}

/** Mock text model: echoes the prompt structure and returns a canned analysis. */
class MockVisionAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const userText = options.messages
      .map(message => message.content
        .map(block => (block.type === 'text' ? block.text : ''))
        .join(''))
      .join('\n')
    const isJpeg = userText.includes('format=JPEG')
    console.log('[smoke] llm called with provider/model:', options.provider, options.model)
    console.log('[smoke] llm got system instructions:', options.system?.includes('STAGE 1: COMPLETE VISUAL ANALYSIS') === true)
    console.log('[smoke] llm got representation:', userText.includes('GRAYSCALE VIEW') && userText.includes('<image_representation>'))
    if (isJpeg) {
      console.log(
        '[smoke] jpeg exif orientation applied (144x108 -> 108x144):',
        userText.includes('size=108x144') && userText.includes('grid_size=72x96'),
      )
    } else {
      console.log('[smoke] png decoded (format/size/grid):', userText.includes('format=PNG')
        && userText.includes('size=144x108') && userText.includes('grid_size=72x54'))
    }
    const text = [
      '## Visual analysis',
      '### Composition',
      isJpeg
        ? 'The representation shows the same landscape rotated to portrait: the sky region is to the left, the grass to the right.'
        : 'The representation shows a bright landscape: a light upper region above a darker lower band, with a small dense rounded object in the upper-left and a rectangular mass in the lower middle.',
      '## Conclusion',
      '**The image shows: a red sun over a green field** — confidence 80%',
      '   - Supporting evidence: rounded high-contrast object top-left; horizontal horizon line; green lower region',
      '   - Ruled out: a red balloon over a lawn — the horizon is straight and the red object is small, high, and circular, matching a sun',
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
      await makeTestImages()
      for (const [path, label] of [['test-image.png', 'png'], ['test-image.jpg', 'jpeg']] as const) {
        const result = await ctx.tools.execute({
          callId: CallId(`smoke-${label}`),
          name: 'vision-nv',
          arguments: { path },
          signal: new AbortController().signal,
        })
        const text = result.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('')
        console.log(`[smoke] tool returned the final understanding (${label}):`)
        console.log(text)
      }
    } catch (error) {
      console.error('[smoke] FAILED:', error)
      process.exitCode = 1
    }
  })()
}
