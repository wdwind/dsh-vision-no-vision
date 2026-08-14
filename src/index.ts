import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

import { VISION_ANALYSIS_PROMPT } from './prompt.ts'

const execFileAsync = promisify(execFile)

export const name = 'dsh-vision-no-vision'

// Wait until the tool registry and system-prompt services exist.
export const inject = ['tools', 'systemPrompt']

export interface Config {
  /** Python executable used to run the ASCII-art script. */
  pythonBin: string
  /** Hard cap on one image-conversion run. */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  pythonBin: Schema.string().default('python'),
  timeoutMs: Schema.number().min(1000).max(120000).default(30000),
})

/** Where the shipped python script lives, relative to this module. */
function scriptPath(): string {
  return fileURLToPath(new URL('../python/ascii_vision.py', import.meta.url))
}

/**
 * Run the conversion script. Tries `config.pythonBin` first, then the
 * conventional `python3` fallback, so a missing configured binary degrades
 * instead of failing. Any other failure (missing Pillow, bad image, non-zero
 * exit) throws with the script's stderr so the model sees the reason.
 */
async function runPython(
  config: Config,
  args: readonly string[],
  options: { signal: AbortSignal; cwd?: string },
): Promise<string> {
  const candidates = [...new Set([config.pythonBin, 'python', 'python3'])]
  for (const bin of candidates) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: config.timeoutMs,
        signal: options.signal,
        cwd: options.cwd,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      })
      return stdout
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code
      if (code === 'ENOENT') {
        continue // executable missing — try the next candidate
      }
      // Non-zero exit or spawn failure: surface the script's diagnostics.
      const detail = (
        (error as { stderr?: string; stdout?: string } | null)?.stderr
        ?? (error as { stdout?: string } | null)?.stdout
        ?? (error instanceof Error ? error.message : String(error))
      ).trim()
      throw new Error(`ascii_vision failed (${bin}): ${detail}`)
    }
  }
  throw new Error(
    `no python executable found (tried ${candidates.join(', ')}); install Python and Pillow (see requirements.txt)`,
  )
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'analyze_image',
    description:
      'Produce a deterministic ASCII-art representation of the image at `path` '
      + '(metadata, grayscale view, edge view, coarse color grid) so a text-only '
      + 'model can understand the image. The result arrives wrapped in '
      + '<image_representation> tags; interpret it according to the '
      + 'vision-analysis instructions.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Path to the image file (relative to the working directory)',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    timeoutMs: config.timeoutMs,
    async execute(args, exec) {
      // Resolve relative image paths against the calling agent's working
      // directory; without an agent, the harness process cwd applies.
      const cwd = exec.agent?.session.header.cwd
      const stdout = await runPython(config, [scriptPath(), args.path], {
        signal: exec.signal,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      return `<image_representation>\n${stdout.trimEnd()}\n</image_representation>`
    },
  }))

  // The instructions that teach the model how to read the representation.
  // Tool guidance sections conventionally live at order 100-199.
  ctx.systemPrompt.section({
    name: 'vision-no-vision:analysis',
    order: 150,
    text: VISION_ANALYSIS_PROMPT,
  })
}
