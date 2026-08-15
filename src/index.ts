import { resolve } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

import { describeImage } from './ascii-vision.ts'
import { VISION_NV } from './prompt.ts'

export const name = 'vision-nv'

// Wait until the tool registry and the LLM service exist.
export const inject = ['tools', 'llm']

export interface Config {
  /**
   * Hard cap on one complete analysis (conversion + model call), in ms.
   * Maximum is 2_147_483_647 ms (~24.8 days) — the platform's maximum timer
   * delay; the harness's tool-call timeout policy rejects anything above it.
   */
  timeoutMs: number
  /**
   * Optional output-token cap for the internal vision-model call. Unset
   * (the default) means "the maximum the selected provider/model route
   * allows": the plugin asks the LLM service for the route's advertised
   * output cap and uses that. An explicit value is honored, but is clamped
   * to the route cap so the provider never rejects the request.
   */
  maxTokens?: number
  /** Optional explicit provider route; must be paired with `model`. Defaults to the session's active model. */
  provider?: string
  /** Optional explicit model id; must be paired with `provider`. Defaults to the session's active model. */
  model?: string
}

export const Config: Schema<Config> = Schema.object({
  timeoutMs: Schema.number().min(1000).max(2_147_483_647).default(3_600_000),
  maxTokens: Schema.number().min(256),
  provider: Schema.string(),
  model: Schema.string(),
})

/** Ask the configured text model to interpret one image representation. */
export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'vision-nv',
    description: 'Give a text-only LLM vision capability: analyze the image at '
      + '`path` with the configured text model and return an understanding of '
      + 'what the image shows.',
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
      // directory; without an agent, the harness process cwd applies. The
      // converter runs in-process — no Python or Pillow involved.
      const cwd = exec.agent?.session.header.cwd
      const path = cwd === undefined ? resolve(args.path) : resolve(cwd, args.path)
      let stdout: string
      try {
        stdout = await describeImage(path, { displayPath: args.path })
      } catch (error) {
        throw new Error(
          `vision-nv: unable to process ${args.path}: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const representation = `<image_representation>\n${stdout.trimEnd()}\n</image_representation>`

      // Which model? Explicit config pair wins; otherwise the session's
      // active model (the newest logged request/header route).
      let provider: string | undefined = config.provider
      let model: string | undefined = config.model
      if ((provider === undefined) !== (model === undefined)) {
        throw new Error('vision-nv: provider and model must be configured together')
      }
      if (provider === undefined && exec.agent !== undefined) {
        const events = exec.agent.session.events
        for (let index = events.length - 1; index >= 0; index--) {
          const event = events[index]
          if (event?.type === 'request/header') {
            provider = event.data.header.config.provider
            model = event.data.header.config.model
            break
          }
        }
      }
      if (provider === undefined || model === undefined) {
        throw new Error(
          'vision-nv: cannot determine which model to call — configure provider and model together, or call the tool from an agent session',
        )
      }

      // Ask the LLM service for the highest output cap this exact route
      // accepts. Best-effort: adapters that cannot answer (or older service
      // versions without the query) must not block the call.
      let routeMaxTokens: number | undefined
      if (typeof ctx.llm.resolveModelInfo === 'function') {
        try {
          const info = await ctx.llm.resolveModelInfo(provider, model, exec.signal)
          routeMaxTokens = info.defaultMaxTokens
        } catch {
          // no known cap — fall through
        }
      }
      // Unset `maxTokens` means "unlimited": use the route's own maximum when
      // the adapter discloses one, otherwise omit the field entirely and let
      // the runtime/provider apply its normal cap. An explicit configured cap
      // wins, but is clamped to the route maximum so the provider never
      // rejects the call as over-limit.
      let maxTokens: number | undefined
      if (config.maxTokens !== undefined) {
        maxTokens = routeMaxTokens === undefined
          ? config.maxTokens
          : Math.min(config.maxTokens, routeMaxTokens)
      } else {
        maxTokens = routeMaxTokens
      }

      const options: GenerateOptions = {
        provider,
        model,
        messages: [createUserMessage({
          content: [{ type: 'text', text: representation }],
          source: { kind: 'plugin', plugin: 'dsh-vision-no-vision' },
        })],
        system: VISION_NV,
        tools: [],
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(exec.agent !== undefined ? { sessionId: exec.agent.session.id } : {}),
        signal: AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)]),
      }

      const assembler = new BlockAssembler()
      try {
        for await (const chunk of ctx.llm.stream(options)) {
          assembler.push(chunk)
        }
      } catch (error) {
        if (exec.signal.aborted) {
          throw new Error('vision-nv: the analysis was cancelled')
        }
        throw new Error(
          `vision-nv: the vision model call failed: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const finish = assembler.finish
      if (finish.kind === 'error' || finish.kind === 'aborted') {
        throw new Error(`vision-nv: the vision model call failed: ${finish.failure.message}`)
      }
      if (finish.kind === 'max-tokens') {
        const cap = maxTokens === undefined ? 'the route maximum' : `${maxTokens} tokens`
        throw new Error(
          `vision-nv: the analysis output reached the token limit (${cap}) — the model stopped before finishing; use a model with a larger output limit`,
        )
      }
      const blocks = assembler.blocks()
      const text = blocks
        .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      if (text.length === 0) {
        throw new Error('vision-nv: the vision model produced no text')
      }
      return text
    },
  }))
}
