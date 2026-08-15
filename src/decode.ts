/**
 * Decoding layer: one small, well-tested library per format instead of
 * hand-rolled parsers. Everything normalizes to 8-bit packed RGB.
 *
 * - BMP  -> bmp-ts (pure TS, zero deps; sharp's libvips has no BMP loader)
 * - GIF  -> omggif (pure JS, zero deps, battle-tested). First frame only
 *           (like `Image.open`), transparency index mapped through the
 *           palette (the GIF's own colors, no compositing).
 * - PNG  -> pngjs (pure JS, zero deps). Handles 8-bit and 16-bit samples,
 *           palette, and interlacing; 16-bit is scaled to 8-bit.
 * - everything else (JPEG, WebP, TIFF, AVIF, HEIF, SVG, PDF, …) goes
 *   through sharp in ascii-vision.ts.
 */
import { decode as decodeBmpTs } from 'bmp-ts'
import { GifReader } from 'omggif'
import { PNG } from 'pngjs'

export interface DecodedPixels {
  /** 8-bit packed RGB, 3 bytes per pixel. */
  rgb: Uint8Array
  width: number
  height: number
}

/** Drop the alpha channel without compositing (Pillow's convert('RGB') behavior). */
function dropAlpha(rgba: Uint8Array, pixelCount: number): Uint8Array {
  const rgb = new Uint8Array(pixelCount * 3)
  for (let i = 0, j = 0; i < pixelCount * 4; i += 4, j += 3) {
    rgb[j] = rgba[i]!
    rgb[j + 1] = rgba[i + 1]!
    rgb[j + 2] = rgba[i + 2]!
  }
  return rgb
}

export function decodeBmp(bytes: Uint8Array): DecodedPixels {
  const decoder = decodeBmpTs(bytes as Buffer, { toRGBA: true })
  const count = decoder.width * decoder.height
  return {
    rgb: dropAlpha(new Uint8Array(decoder.data.buffer, decoder.data.byteOffset, decoder.data.byteLength), count),
    width: decoder.width,
    height: decoder.height,
  }
}

export function decodeGif(bytes: Uint8Array): DecodedPixels {
  const reader = new GifReader(bytes)
  if (reader.numFrames() < 1) {
    throw new Error('GIF contains no frames')
  }
  const width = reader.width
  const height = reader.height
  const rgba = new Uint8Array(width * height * 4)
  // Pre-fill with the palette color of the transparency index so transparent
  // pixels keep the GIF's own colors (no background compositing).
  const info = reader.frameInfo(0)
  if (info.transparent_index !== null && info.palette_offset !== null) {
    const p = info.palette_offset + info.transparent_index * 3
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = bytes[p]!
      rgba[i + 1] = bytes[p + 1]!
      rgba[i + 2] = bytes[p + 2]!
      rgba[i + 3] = 255
    }
  }
  reader.decodeAndBlitFrameRGBA(0, rgba)
  return { rgb: dropAlpha(rgba, width * height), width, height }
}

export function decodePng(bytes: Uint8Array): DecodedPixels {
  const png = PNG.sync.read(bytes as Buffer) // RGBA; 16-bit samples auto-scaled to 8-bit
  return {
    rgb: dropAlpha(new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength), png.width * png.height),
    width: png.width,
    height: png.height,
  }
}
