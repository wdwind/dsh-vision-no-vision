# dsh-vision-no-vision

A standalone, third-party [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) **backend plugin** that gives a text-only LLM vision capability.

How it works: for an image, the plugin runs a bundled Python script
(`python/ascii_vision.py`) that produces a deterministic text representation —
metadata, a grayscale view, an edge view, and a coarse color grid — and hands
that text to the model together with a system-prompt section
(`vision-nv:analysis`) that teaches the model how to reconstruct the image's
meaning from the representation.

No UI/client half, no changes to the harness checkout: everything lives in
this repository.

## Architecture

| Piece | What it does |
|---|---|
| `src/index.ts` | The Cordis plugin (`apply(ctx)`): registers the **`vision-nv`** tool on `ctx.tools` and the `vision-nv:analysis` section on `ctx.systemPrompt`. |
| `src/prompt.ts` | The vision instructions (`VISION_NV`): a two-stage analysis — complete visual analysis, then top three educated guesses. |
| `python/ascii_vision.py` | The converter: image → metadata + GRAYSCALE VIEW + EDGE VIEW + COARSE COLOR GRID. Shipped as a runtime asset, resolved via `new URL('../python/ascii_vision.py', import.meta.url)` (works from `src/` in dev and from `lib/` when installed). |
| `smoke/cordis.yml` + `smoke/driver.ts` | Keyless smoke test: creates a synthetic test image with Pillow, drives one real `vision-nv` call through the harness pipeline, prints the representation. |

The tool returns the representation wrapped in `<image_representation>` tags
(the vision instructions say where it arrives):

```
<image_representation>
METADATA
format=PNG
...
COARSE COLOR GRID
legend: K=black A=gray W=white R=red O=orange Y=yellow G=green C=cyan B=blue P=purple M=pink N=brown
...
</image_representation>
```

Configuration (via the plugin's `config` block in `cordis.yml`):

```yaml
- name: dsh-vision-no-vision
  config:
    pythonBin: python    # python executable (default 'python'; 'python3' is tried as fallback)
    timeoutMs: 30000     # per-conversion hard cap (default 30000, min 1000, max 120000)
```

## Prerequisites

- Node.js + pnpm.
- **Python 3** with **Pillow** (`pip install -r requirements.txt`). The plugin
  surfaces a clear error message when Python or Pillow is missing.
- A deepseek-harness checkout is only needed to *run* against a harness during
  development (the vendored Cordis bin for the smoke test and `pnpm dsh` for
  the Web GUI). The plugin itself has no compile-time or runtime dependency on
  the checkout's location.

## Setup

```sh
pnpm install
```

All `@deepseek-ai/*` development dependencies come from the npm registry
(`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, …) into this project's own
`node_modules` — there are no machine-specific path mappings.

## Development loop

### 1. Smoke test (fastest, keyless)

```powershell
Set-Location C:\D\Code\dsh-vision-without-vision-model\smoke
node --import tsx C:/D/Code/deepseek-harness/vendor/cordis/bin.js
```

Expected output (head):

```
[smoke] representation lines: 84
[smoke] head:
<image_representation>
METADATA
format=PNG
size=144x108
orientation=landscape
...
[smoke] wrapped in <image_representation>: true
```

The checkout path only supplies the vendored Cordis bin (a dev convenience);
the plugin, the driver, and every `@deepseek-ai/*` package load from this
project's `node_modules`.

### 2. Load it into the Web GUI

From the checkout root:

```sh
pnpm dsh web --patch C:/D/Code/dsh-vision-without-vision-model/cordis.patch.yml
```

Open `http://127.0.0.1:3080` and ask the model to analyze an image file in
the workspace (e.g. "Use vision-nv on screenshot.png and describe what it
shows"). (Don't run while another dsh instance owns port 3080; use `--port`.)

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
   which the loader resolves from the installing profile's `node_modules`.
   The `python/` directory ships inside the package (`files`), so the script
   is found next to `lib/` at runtime.

2. **Users install it** (any of these — `dsh plugin` forwards to pnpm inside
   the profile and auto-appends the bundle to `dsh.profile.bundles`):

   ```sh
   dsh plugin --profile web add dsh-vision-no-vision          # from npm (prebuilt)
   dsh plugin --profile web add ./dsh-vision-no-vision-0.1.0.tgz   # tarball
   dsh plugin --profile web add ./path/to/dsh-vision-no-vision     # local checkout
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
- **Failure paths are model-visible**: a missing file, missing Pillow, or an
  unreadable image surfaces the script's stderr as the tool result, so the
  model can explain the problem instead of guessing.
- The converter script is intentionally untouched (your spec). Pillow ≥10
  prints deprecation warnings to stderr on `getdata()`; they are ignored
  unless the run fails.
- `@deepseek-ai/schemastery` is a runtime dependency; `@deepseek-ai/cordis`
  and `@deepseek-ai/dsh-tools` are peer dependencies (the harness provides
  them) mirrored in `devDependencies` for development.
