# dsh-vision-no-vision

A standalone, third-party [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(dsh) **backend plugin** that gives a text-only LLM vision capability.

How it works: for an image, the plugin runs a bundled Python script
(`python/ascii_vision.py`) that produces a **deterministic ASCII-art
representation** — metadata, a grayscale view, an edge view, and a coarse
color grid — and hands that text to the model together with a system-prompt
section (`vision-no-vision:analysis`) that teaches the model how to
reconstruct the image's meaning from the representation.

No UI/client half, no changes to the harness checkout: everything lives in
this repository.

## Architecture

| Piece | What it does |
|---|---|
| `src/index.ts` | The Cordis plugin (`apply(ctx)`): registers the `analyze_image` tool on `ctx.tools` and the `vision-no-vision:analysis` section on `ctx.systemPrompt`. |
| `src/prompt.ts` | The analysis instructions (your two-stage prompt: complete visual analysis + top three educated guesses). |
| `python/ascii_vision.py` | The converter: image → metadata + GRAYSCALE VIEW + EDGE VIEW + COARSE COLOR GRID. Shipped as a runtime asset, resolved via `new URL('../python/ascii_vision.py', import.meta.url)` (works from `src/` in dev and from `lib/` when installed). |
| `smoke/cordis.yml` + `smoke/driver.ts` | Keyless smoke test: creates a synthetic test image with Pillow, drives one real `analyze_image` call through the harness pipeline, prints the representation. |

The tool returns the representation wrapped in `<image_representation>` tags
(so it lands in the conversation exactly where the instructions expect it):

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

- A deepseek-harness checkout that has completed **run-from-source**
  (`pnpm install` + `pnpm run build` — see `README.md#run-from-source`).
- **Python 3** with **Pillow** installed (`pip install -r requirements.txt`).
  The plugin surfaces a clear error message when Python or Pillow is missing.

This project needs **no `pnpm install` of its own** for development:
`@deepseek-ai/*` imports resolve through the tsconfig `paths` maps against the
checkout's built artifacts.

## What is here

| Path | Purpose |
|---|---|
| `src/index.ts` | The plugin (tool + prompt section + config). |
| `src/prompt.ts` | The vision-analysis instructions. |
| `python/ascii_vision.py` | The image → ASCII-art converter (shipped with the package). |
| `requirements.txt` | Python runtime dependency (Pillow). |
| `cordis.patch.yml` | Development overlay: inserts the plugin into the `web` profile via `--patch` (absolute source path). |
| `bundle/cordis.patch.yml` | Distribution layer: the same plugin row, referencing the package **by name** for `dsh plugin` installs. |
| `smoke/cordis.yml` + `smoke/driver.ts` | Keyless smoke test (no API key, no model). |
| `tsconfig.json` | Typecheck config: resolves `@deepseek-ai/*` to the checkout's built declarations. |
| `tsconfig.runtime.json` | Runtime twin for tsx (same map against built JS). |
| `tsconfig.build.json` | Emits the distributable `lib/` from `src/`. |

## Development loop

The harness checkout is never modified. Bare `@deepseek-ai/*` names resolve
through tsx's tsconfig `paths` mapping (the checkout's root `node_modules` has
no `@deepseek-ai` links), so:

- **smoke test** — tsx must be pointed at `tsconfig.runtime.json`;
- **Web GUI** — running `pnpm dsh web` from the checkout root makes tsx find
  the checkout's own tsconfig, so no env var is needed.

### 1. Smoke test (fastest, keyless)

One-time setup: `node --import tsx` resolves the `tsx` package from the
working directory, which has no `node_modules`. Create a gitignored junction
to the checkout's tsx (already done in this repo; `node_modules/` is
ignored):

```powershell
New-Item -ItemType Junction -Path node_modules\tsx -Target 'C:\D\Code\deepseek-harness\node_modules\.pnpm\tsx@4.22.4\node_modules\tsx'
```

Then:

```powershell
$env:TSX_TSCONFIG_PATH = 'C:\D\Code\dsh-vision-without-vision-model\tsconfig.runtime.json'
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

### 2. Load it into the Web GUI

From the checkout root:

```sh
pnpm dsh web --patch C:/D/Code/dsh-vision-without-vision-model/cordis.patch.yml
```

Open `http://127.0.0.1:3080` and ask the model to analyze an image file in
the workspace (e.g. "Use analyze_image on screenshot.png and describe what it
shows"). (Don't run while another dsh instance owns port 3080; use `--port`.)

### 3. Typecheck and build

```sh
pnpm run typecheck   # tsc against the checkout's declarations
pnpm run build       # emits lib/index.js + lib/prompt.js + lib/types/*.d.ts
```

Both scripts invoke the checkout's `tsc` via `pnpm --dir ../deepseek-harness`;
adjust the relative paths in `package.json` if your checkout lives elsewhere.

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
   a clear error otherwise) — document this in your plugin's README when you
   publish.

Full reference: `docs/user/develop/basic/publish.md` in the checkout (bundle
vs. profile manifests, layer order, the GitHub `prepare`/`allowBuilds` caveat).

## Notes

- **Backend-only**: no `dsh.client` declaration, no client bundle, no UI
  packages, no harness-side registration. Loads identically in the `web` and
  `headless` profiles.
- **The harness checkout stays pristine**: `git status` in the checkout shows
  no changes from this project. The only non-committed artifact in THIS repo
  is the gitignored `node_modules/tsx` junction used by the smoke test.
- **Failure paths are model-visible**: a missing file, missing Pillow, or an
  unreadable image surfaces the script's stderr as the tool result, so the
  model can explain the problem instead of guessing.
- The converter script is intentionally untouched (your spec). Pillow ≥10
  prints deprecation warnings to stderr on `getdata()`; they are ignored
  unless the run fails.
