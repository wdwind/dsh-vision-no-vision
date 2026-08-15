# dsh-vision-no-vision

A standalone, third-party [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) **backend plugin** that gives a text-only LLM vision capability.
The npm package name is `dsh-vision-no-vision`; the plugin and its tool are
called `vision-nv`.

How it works: the `vision-nv` tool takes an image path, converts the image to
a deterministic text representation (metadata, a grayscale view, an edge
view, and a coarse color grid) with a built-in TypeScript converter — decoding
through small libraries (bmp-ts, omggif, pngjs, sharp), processing through
sharp — no Python or Pillow involved. It then asks the **user's configured
text model** to interpret the representation and returns the model's final
understanding of the image as the tool result.

No UI/client half, no changes to the harness checkout: everything lives in
this repository.

## Names

These are three independent names — do not conflate them:

| Name | Value | Where | Constraint |
|---|---|---|---|
| npm package | `dsh-vision-no-vision` | `package.json` → `name` | Install identifier (`dsh plugin add …`). The bundle row's `name` must equal it: the loader resolves exactly that string from the profile's `node_modules`. |
| plugin | `vision-nv` | `src/index.ts` → `export const name` | Cordis display metadata (labels the plugin in diagnostics). Free. |
| tool | `vision-nv` | `defineTool({ name: 'vision-nv' })` | What the model sees and calls. Free. |

## Architecture

| Piece | What it does |
|---|---|
| `src/index.ts` | The Cordis plugin (`apply(ctx)`): registers the **`vision-nv`** tool on `ctx.tools`. The tool runs the converter in-process, then makes an internal call through `ctx.llm` (the harness's configured model) and returns the analysis. |
| `src/prompt.ts` | `VISION_NV` — the instructions for the internal model call: a two-stage analysis (complete visual analysis, then top three educated guesses). |
| `src/ascii-vision.ts` | The converter: image → metadata + GRAYSCALE VIEW + EDGE VIEW + COARSE COLOR GRID. Decoding is delegated to small libraries; luma, edge detection, and resize are done with a few deterministic operations. Also runnable directly: `node lib/cli.js IMAGE`. |
| `src/decode.ts` | The decoding layer: bmp-ts (BMP), omggif (GIF), pngjs (PNG) — one small, well-tested library per format where sharp can't match; everything else goes through sharp. |
| `smoke/cordis.yml` + `smoke/driver.ts` | Keyless smoke test: draws a synthetic test image and encodes it with sharp (PNG and an EXIF-rotated JPEG), registers a **mock LLM adapter**, and drives two real `vision-nv` calls through the harness pipeline. |

One `vision-nv` call = two stages:

1. **Conversion (no model)**: the built-in TypeScript converter reads the
   image and produces the representation, wrapped in `<image_representation>`
   tags.
2. **Interpretation (the configured text model)**: an internal
   `ctx.llm.stream()` call — system = `VISION_NV` instructions, user message =
   the wrapped representation, `tools: []` so the auxiliary call cannot make
   tool calls — whose text output becomes the tool result.

Configuration (via the plugin's `config` block in `cordis.yml`):

```yaml
- name: dsh-vision-no-vision
  config:
    timeoutMs: 3600000  # end-to-end cap per call, conversion + model
                          # (default 3600000 = 1 hour; min 1000, max 2147483647 ≈ 24.8 days)
    # maxTokens: 4096    # optional output-token cap for the internal model call
                          # (unset by default = the maximum the selected provider/model route allows;
                          # min 256 when set, no upper bound)
    provider: deepseek   # optional explicit route — must be paired with model
    model: deepseek-v4-flash
```

Which model the internal call uses: the explicit `provider`/`model` pair when
configured; otherwise the **session's active model** — the newest logged
`request/header` route of the calling agent's session (what the user picked
in the UI). Outside an agent session the explicit pair is required.

## Prerequisites

- Node.js + pnpm.
- Nothing else at development or runtime: `pnpm install` fetches `sharp`
  together with its platform-specific prebuilt binary, so users need no
  Python, no Pillow, and no compiler (on the rare platforms without a sharp
  prebuild, building libvips from source requires a C toolchain).
- A deepseek-harness checkout is only needed to *run* against a harness during
  development (the vendored Cordis bin for the smoke test and the `dsh` CLI
  for the Web GUI). The plugin itself has no compile-time or runtime
  dependency on the checkout's location, and this repository contains no
  machine-specific paths.

## Setup

```sh
pnpm install
```

All `@deepseek-ai/*` development dependencies come from the npm registry
(`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, …)
into this project's own `node_modules` — there are no machine-specific path
mappings.

## Development loop

In the commands below, `<deepseek-harness-checkout>` is the path to your
local checkout of deepseek-harness and `<vision-nv-repo>` is the path to this
repository.

### 1. Smoke test (fastest, keyless, mock model)

```powershell
Set-Location <vision-nv-repo>/smoke
node --import tsx <deepseek-harness-checkout>/vendor/cordis/bin.js
```

Expected output (head):

```
[smoke] llm called with provider/model: smoke smoke-model
[smoke] llm got system instructions: true
[smoke] llm got representation: true
[smoke] png decoded (format/size/grid): true
[smoke] tool returned the final understanding (png):
## Visual analysis
### Composition
The representation shows a bright landscape: ...
[smoke] jpeg exif orientation applied (144x108 -> 108x144): true
[smoke] tool returned the final understanding (jpeg):
...
```

The mock adapter in `smoke/driver.ts` stands in for the user's text model, so
the whole pipeline runs with no API key. The test images are drawn into a raw
buffer and encoded with sharp — no Python anywhere.

### 2. Load it into the Web GUI

Build the package, install this repository into a profile, and launch:

```sh
# from this repository
pnpm run build

# from the checkout (absolute path to this repository)
pnpm dsh plugin --profile web add <vision-nv-repo>
pnpm dsh web
```

`dsh plugin add` links this repository into the profile and activates the
bundle layer (`bundle/cordis.patch.yml`, declared by `dsh.bundle` in
`package.json`). Open `http://127.0.0.1:3080` and ask the model to analyze an
image file in the workspace (e.g. "Use vision-nv on screenshot.png and
describe what it shows"). (Don't run while another dsh instance owns port
3080; use `--port`.)

### 3. Typecheck and build

```sh
pnpm run typecheck   # tsc -p tsconfig.json
pnpm run build       # emits lib/index.js + lib/prompt.js + lib/ascii-vision.js + lib/types/*.d.ts
```

`lib/cli.js` is also a standalone CLI: `node lib/cli.js IMAGE` prints the
same representation the tool feeds to the model.

## Distribution — how other people install it

The harness has no plugin registry and needs no PR: third-party plugins enter
a user's setup purely through their **profile** composition.

1. **Ship built artifacts**: `pnpm run build`, then publish. `package.json`
   declares the bundle manifest (`dsh.bundle.patch -> ./bundle/cordis.patch.yml`),
   and the bundle patch references the package by name (`dsh-vision-no-vision`),
   which the loader resolves from the installing profile's `node_modules`.
   `sharp` is a regular runtime dependency, so its prebuilt binary installs
   automatically from the same registry.

2. **Users install it** (any of these — `dsh plugin` forwards to pnpm inside
   the profile and auto-appends the bundle to `dsh.profile.bundles`):

   ```sh
   dsh plugin --profile web add dsh-vision-no-vision       # from npm (prebuilt)
   dsh plugin --profile web add ./dsh-vision-no-vision-0.3.0.tgz  # tarball
   dsh plugin --profile web add ./path/to/repo             # local checkout
   dsh plugin --profile web add github:you/dsh-vision-no-vision#<sha>  # git
   ```

   Local-checkout and git installs build automatically: the `prepare` script
   runs `pnpm run build`, so `lib/` is produced on the spot (no checked-in
   artifacts needed).

3. **No extra runtime setup**: all decoders are pure-JS packages (bmp-ts,
   omggif, pngjs) plus `sharp`, whose platform-specific prebuilt binary comes
   from the registry as an optional dependency — no lifecycle scripts, no pnpm
   `allowBuilds` entries, no compiler. Formats: BMP, GIF, PNG (including
   16-bit and interlaced), JPEG, WebP, TIFF, AVIF, HEIF, SVG, PDF (first page
   for animated/multi-page files); EXIF orientation is auto-applied on the
   sharp path.

Full reference: `docs/user/develop/basic/publish.md` in the checkout (bundle
vs. profile manifests, layer order, the GitHub `prepare`/`allowBuilds` caveat).

## Notes

- **Backend-only**: no `dsh.client` declaration, no client bundle, no UI
  packages, no harness-side registration. Loads identically in the `web` and
  `headless` profiles.
- **Failure paths are model-visible**: a missing file, an unreadable or
  unsupported image, an undetermined model route, or a failed internal model
  call surfaces as the tool result, so the host model can explain the problem
  instead of guessing.
- The converter delegates everything to libraries — no hand-rolled image
  processing, no Python. Decoding: bmp-ts (BMP), omggif (GIF, first frame,
  transparency mapped through the palette), pngjs (PNG, including 16-bit
  samples and interlacing), sharp (JPEG, WebP, TIFF, AVIF, HEIF, SVG, PDF,
  …). Processing: grayscale is computed with Pillow's luma formula (ITU-R
  601-2, so the character views match the original Python converter); sharp
  (libvips) does edge detection (3x3 `[-1,-1,-1,-1,8,-1,-1,-1,-1]`
  convolution) and Lanczos downscale for the grayscale and edge views. Only
  the final mappings are JS: byte value → character density ramp, and RGB →
  nearest coarse palette code. The coarse color grid uses a plain block
  average per cell (sharp exposes no box/average kernel, and Lanczos ringing
  would smear colors across hard edges).
- `python/ascii_vision.py` and `requirements.txt` remain in the repository as
  a historical reference only; they are not shipped in the package (`files`)
  and nothing calls them.
- `@deepseek-ai/schemastery` and `sharp` are runtime dependencies;
  `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, and `@deepseek-ai/dsh-llm`
  are peer dependencies (the harness provides them) mirrored in
  `devDependencies` for development.
