/**
 * Image -> text converter for vision-nv: decodes an image (bmp-ts, omggif,
 * pngjs, sharp) and renders fixed-width text views (metadata, grayscale,
 * edge, coarse color grid) for a text-only LLM. All image processing is
 * delegated to sharp; only the final mappings (byte -> character, RGB ->
 * palette code) are plain JS.
 *
 * CLI: `node lib/cli.js IMAGE`.
 */
import { readFile } from 'node:fs/promises'
import { statSync } from 'node:fs'

import sharp from 'sharp'
import { decodeBmp, decodeGif, decodePng } from './decode.ts'

export const ASCII_WIDTH = 72
export const CHARACTERS = ' .:-=+*#%@'

/** Insertion order matters: ties resolve to the first palette entry. */
export const COLOR_PALETTE: ReadonlyArray<readonly [code: string, rgb: readonly [number, number, number]]> = [
  ['K', [20, 20, 20]], ['A', [128, 128, 128]], ['W', [235, 235, 235]], ['R', [210, 45, 45]],
  ['O', [230, 125, 35]], ['Y', [225, 205, 55]], ['G', [55, 155, 70]], ['C', [50, 180, 180]],
  ['B', [55, 100, 200]], ['P', [125, 70, 170]], ['M', [220, 130, 170]], ['N', [120, 75, 45]],
]

export const COLOR_LEGEND = (
  'K=black A=gray W=white R=red O=orange Y=yellow '
  + 'G=green C=cyan B=blue P=purple M=pink N=brown'
)

export interface DescribeOptions {
  /** Path shown in error messages when it differs from `path` (the plugin
   * resolves relative paths against the agent's cwd but reports the original
   * argument). */
  displayPath?: string
}

/** Pillow-style format labels for sharp's lowercase format names. */
const FORMAT_NAMES: Readonly<Record<string, string>> = {
  jpeg: 'JPEG', png: 'PNG', gif: 'GIF', bmp: 'BMP', tiff: 'TIFF', webp: 'WEBP',
  avif: 'AVIF', heif: 'HEIF', jp2: 'JPEG2000',
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Aspect-ratio-corrected height for a fixed-width text grid. */
function gridHeight(width: number, height: number, targetWidth: number): number {
  return Math.max(1, Math.round(targetWidth * height / width * 0.45))
}

/** Nearest coarse palette code; the first entry wins ties. */
function paletteCode(r: number, g: number, b: number): string {
  let best = COLOR_PALETTE[0]![0]
  let bestDistance = Infinity
  for (const [code, reference] of COLOR_PALETTE) {
    const distance = (r - reference[0]) ** 2 + (g - reference[1]) ** 2 + (b - reference[2]) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      best = code
    }
  }
  return best
}

/** Decode an image file into 8-bit RGB, format sniffed from the magic bytes. */
async function decode(path: string): Promise<{ rgb: Uint8Array; width: number; height: number; format: string }> {
  const bytes = await readFile(path)
  if (bytes[0] === 0x42 && bytes[1] === 0x4D) return { ...decodeBmp(bytes), format: 'BMP' }
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
    return { ...decodeGif(bytes), format: 'GIF' }
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    return { ...decodePng(bytes), format: 'PNG' }
  }
  const image = sharp(path)
  const metadata = await image.metadata()
  const format = metadata.format === undefined
    ? 'UNKNOWN'
    : FORMAT_NAMES[metadata.format] ?? metadata.format.toUpperCase()
  const { data, info } = await image
    .rotate() // auto-orient from EXIF; no-op when absent
    .removeAlpha() // drop alpha without compositing
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true })
  return {
    rgb: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
    format,
  }
}

/** Mean of a byte plane. */
function mean(values: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < values.length; i++) sum += values[i]!
  return sum / values.length
}

/** ITU-R 601-2 luma, the same formula Pillow's convert('L') uses (L24). */
function luma(rgb: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgb.length / 3)
  for (let i = 0, j = 0; i < rgb.length; i += 3, j++) {
    out[j] = (rgb[i]! * 19595 + rgb[i + 1]! * 38470 + rgb[i + 2]! * 7471 + 0x8000) >> 16
  }
  return out
}

/**
 * The coarse color grid is a plain block average: each output cell is the
 * mean of the source pixels it covers, so hard edges yield a dominant color
 * instead of resampler ringing (sharp exposes no box/average kernel). The
 * grayscale and edge views use sharp's Lanczos resize.
 */
function blockColorGrid(
  rgb: Uint8Array,
  width: number,
  height: number,
  targetWidth: number,
  targetHeight: number,
): string {
  const rows: string[] = []
  for (let y = 0; y < targetHeight; y++) {
    const yStart = Math.floor(y * height / targetHeight)
    const yEnd = Math.floor((y + 1) * height / targetHeight)
    let row = ''
    for (let x = 0; x < targetWidth; x++) {
      const xStart = Math.floor(x * width / targetWidth)
      const xEnd = Math.floor((x + 1) * width / targetWidth)
      let r = 0
      let g = 0
      let b = 0
      let count = 0
      for (let sy = yStart; sy < yEnd; sy++) {
        for (let sx = xStart; sx < xEnd; sx++) {
          const offset = (sy * width + sx) * 3
          r += rgb[offset]!
          g += rgb[offset + 1]!
          b += rgb[offset + 2]!
          count++
        }
      }
      row += paletteCode(Math.round(r / count), Math.round(g / count), Math.round(b / count))
    }
    rows.push(row)
  }
  return rows.join('\n')
}

/** Render the fixed-width text representation of an image file. */
export async function describeImage(path: string, options: DescribeOptions = {}): Promise<string> {
  const { displayPath } = options
  if (!isFile(path)) {
    throw new Error(`file not found: ${displayPath ?? path}`)
  }
  const { rgb, width, height, format } = await decode(path)

  const targetWidth = ASCII_WIDTH
  const targetHeight = gridHeight(width, height, targetWidth)
  const rawGray = { raw: { width, height, channels: 1 as const } }
  // sharp converts to sRGB on output by default, which would make raw()
  // 3-channel and misalign row indexing; force b-w so every view stays
  // exactly 1 byte per pixel.
  const toBw = (pipeline: ReturnType<typeof sharp>) => pipeline
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })

  // Grayscale (brightness source) computed with Pillow's luma formula, then
  // the two resized views via sharp.
  const gray = luma(rgb)
  const [grayView, edgeView] = await Promise.all([
    toBw(sharp(gray, rawGray).resize(targetWidth, targetHeight, { kernel: 'lanczos3' })),
    toBw(sharp(gray, rawGray)
      .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
      .resize(targetWidth, targetHeight, { kernel: 'lanczos3' })),
  ])

  const grid = (data: Uint8Array): string => {
    const rows: string[] = []
    for (let y = 0; y < targetHeight; y++) {
      let row = ''
      for (let x = 0; x < targetWidth; x++) {
        row += CHARACTERS.charAt(Math.floor(data[y * targetWidth + x]! * (CHARACTERS.length - 1) / 255))
      }
      rows.push(row)
    }
    return rows.join('\n')
  }
  const orientation = width > height ? 'landscape' : height > width ? 'portrait' : 'square'

  return `METADATA
format=${format}
size=${width}x${height}
orientation=${orientation}
mean_brightness=${mean(gray).toFixed(1)}
grid_size=${targetWidth}x${targetHeight}
GRAYSCALE VIEW
${grid(grayView.data)}
EDGE VIEW
${grid(edgeView.data)}
COARSE COLOR GRID
legend: ${COLOR_LEGEND}
${blockColorGrid(rgb, width, height, targetWidth, targetHeight)}
`
}
