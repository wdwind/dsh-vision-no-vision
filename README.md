# dsh-vision-no-vision

A standalone, third-party [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) **backend plugin** that gives a text-only LLM vision capability.
The npm package name is `dsh-vision-no-vision`; the plugin and its tool are
called `vision-nv`.

How it works: the `vision-nv` tool takes an image path, converts the image to
a deterministic text representation (metadata, a grayscale view, an edge
view, and a coarse color grid) with a bundled Python script, then asks the
**user's configured text model** to interpret the representation and returns
the model's final understanding of the image as the tool result.

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
| `src/index.ts` | The Cordis plugin (`apply(ctx)`): registers the **`vision-nv`** tool on `ctx.tools`. The tool runs the Python converter, then makes an internal call through `ctx.llm` (the harness's configured model) and returns the analysis. |
| `src/prompt.ts` | `VISION_NV` — the instructions for the internal model call: a two-stage analysis (complete visual analysis, then top three educated guesses). |
| `python/ascii_vision.py` | The converter: image → metadata + GRAYSCALE VIEW + EDGE VIEW + COARSE COLOR GRID. Shipped as a runtime asset, resolved via `new URL('../python/ascii_vision.py', import.meta.url)` (works from `src/` in dev and from `lib/` when installed). |
| `smoke/cordis.yml` + `smoke/driver.ts` | Keyless smoke test: creates a synthetic test image with Pillow, registers a **mock LLM adapter**, and drives one real `vision-nv` call through the harness pipeline. |

One `vision-nv` call = two stages:

1. **Conversion (no model)**: `python ascii_vision.py <path>` → the
   representation, wrapped in `<image_representation>` tags.
2. **Interpretation (the configured text model)**: an internal
   `ctx.llm.stream()` call — system = `VISION_NV` instructions, user message =
   the wrapped representation, `tools: []` so the auxiliary call cannot make
   tool calls — whose text output becomes the tool result.

Configuration (via the plugin's `config` block in `cordis.yml`):

```yaml
- name: dsh-vision-no-vision
  config:
    pythonBin: python    # python executable (default 'python'; 'python3' is tried as fallback)
    timeoutMs: 120000    # end-to-end cap per call, conversion + model (default 120000, min 1000, max 600000)
    maxTokens: 2048      # output-token cap for the internal model call (default 2048, min 256, max 16384)
    provider: deepseek   # optional explicit route — must be paired with model
    model: deepseek-v4-flash
```

Which model the internal call uses: the explicit `provider`/`model` pair when
configured; otherwise the **session's active model** — the newest logged
`request/header` route of the calling agent's session (what the user picked
in the UI). Outside an agent session the explicit pair is required.

## Prerequisites

- Node.js + pnpm.
- **Python 3** with **Pillow** (`pip install -r requirements.txt`). The plugin
  surfaces a clear error message when Python or Pillow is missing.
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
[smoke] tool returned the final understanding:
## Visual analysis
### Composition
The representation shows a bright landscape: ...
```

The mock adapter in `smoke/driver.ts` stands in for the user's text model, so
the whole pipeline runs with no API key.

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
pnpm run build       # emits lib/index.js + lib/prompt.js + lib/types/*.d.ts
```

## Distribution — how other people install it

The harness has no plugin registry and needs no PR: third-party plugins enter
a user's setup purely through their **profile** composition.

1. **Ship built artifacts**: `pnpm run build`, then publish. `package.json`
   declares the bundle manifest (`dsh.bundle.patch -> ./bundle/cordis.patch.yml`),
   and the bundle patch references the package by name (`dsh-vision-no-vision`),
   which the loader resolves from the installing profile's `node_modules`. The
   `python/` directory ships inside the package (`files`), so the script is
   found next to `lib/` at runtime.

2. **Users install it** (any of these — `dsh plugin` forwards to pnpm inside
   the profile and auto-appends the bundle to `dsh.profile.bundles`):

   ```sh
   dsh plugin --profile web add dsh-vision-no-vision       # from npm (prebuilt)
   dsh plugin --profile web add ./dsh-vision-no-vision-0.1.0.tgz  # tarball
   dsh plugin --profile web add ./path/to/repo             # local checkout
   dsh plugin --profile web add github:you/dsh-vision-no-vision#<sha>  # git (needs `prepare` build + pnpm allowBuilds)
   ```

3. **Users also need Python + Pillow** on their machine (the plugin surfaces
   a clear error otherwise) — document this when you publish.

Full reference: `docs/user/develop/basic/publish.md` in the checkout (bundle
vs. profile manifests, layer order, the GitHub `prepare`/`allowBuilds` caveat).

## Notes

- **Backend-only**: no `dsh.client` declaration, no client bundle, no UI
  packages, no harness-side registration. Loads identically in the `web` and
  `headless` profiles.
- **Failure paths are model-visible**: a missing file, missing Pillow, an
  unreadable image, an undetermined model route, or a failed internal model
  call surfaces as the tool result, so the host model can explain the problem
  instead of guessing.
- The converter script is intentionally untouched (your spec). Pillow ≥10
  prints deprecation warnings to stderr on `getdata()`; they are ignored
  unless the run fails.
- `@deepseek-ai/schemastery` is a runtime dependency; `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-tools`, and `@deepseek-ai/dsh-llm` are peer dependencies
  (the harness provides them) mirrored in `devDependencies` for development.
