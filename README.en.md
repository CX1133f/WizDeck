# WizDeck

A single-file, fully offline presentation editor: parse any HTML deck → split it into 1920×1080 slides → edit at both slide and element level in the workbench → export a real, re-editable `.pptx` straight from the browser.

Zero dependencies, zero network, nothing uploaded. Double-click `WizDeck.html` and it runs.

[中文](README.md)

## Capabilities

| | |
|---|---|
| **Input** | Any HTML document; images / fonts / stylesheets are inlined as data URIs |
| **Splitting** | `section` / `.slide` / `data-wd-slide` / reveal.js structures detected automatically; an unmarked document falls back to a single slide |
| **Editing** | Slide level and element level: position, size, rotation, z-order, alignment and distribution, fill, border, radius, opacity, custom CSS |
| **Elements** | Text box, four heading levels, shapes, tables, formulas (LaTeX), charts, images, video, bezier curves, polygons |
| **Canvas** | Drag / resize / rotate / arrow-key nudge / marquee multi-select / Alt-drag duplicate / format painter / find |
| **Export** | `.pptx` (real OOXML), self-contained presentation HTML, `.wd.html` project file |
| **Present** | Fullscreen playback, speaker notes, page HUD, light/dark theme |

## Quick start

1. Open `WizDeck.html` in a browser (Chrome / Edge).
2. Click "Open" in the top bar (`Ctrl+O`), or drag an HTML deck straight into the window.
3. Switch and reorder slides in the left rail; double-click text on the canvas to edit, drag corner handles to resize, drag `⟳` to rotate.
4. Edit color, font size, radius and the rest in the right panel — changes apply live.
5. Open "Save & Export" → "Export to Power Point" and the browser downloads a `.pptx`.

The top bar's "Help" button carries the full three-step walkthrough, the shortcut table, and the pagination conventions.

## Input conventions

Pagination markers are optional — the engine detects common patterns on its own. For a guaranteed split, use any of these:

```html
<section class="slide"> … </section>

<div data-wd-slide> … </div>

<div class="slides"><section>…</section></div>   <!-- reveal.js -->
```

For the highest fidelity:

- Use a `1920 × 1080` canvas (`samples/patterns/odd-size-1280x720.html` shows other sizes also work).
- Prefer system fonts (PingFang SC / Microsoft YaHei, etc.) and absolute positioning.
- External images, fonts and stylesheets are fetched and inlined, so the parsed document is fully self-contained.

## Export

### PowerPoint (`.pptx`)

The exporter hand-writes the ZIP packer (CRC32 + deflate-raw, degrading to store when `CompressionStream` is unavailable) and the PresentationML, producing a real OOXML package inside the browser — no libraries, no network. Content is written in three layers; the strategy is **correctness first, editability second**:

| Content | Export result |
|---|---|
| Text | Real text boxes, one per visual line, auto-wrap off so line breaks match the browser exactly |
| Solid fills, borders, rounded rectangles | Real shapes with editable fill and outline |
| Images | Real picture objects |
| Gradients, drop shadows, filters, rotation, SVG, transparency | Isolated and rasterized to PNG — visually 100% identical, but text in that layer is no longer editable |

Occlusion handling: when a rasterized element covers a vector element, the covered part is baked into the image too, guaranteeing "what you see is what you get"; otherwise vector editability is preserved. Speaker notes at the bottom of a slide are written to the PPTX notes page.

### Other formats

- **Self-contained presentation HTML** — every page is still a complete HTML document; share it as-is.
- **Project file `.wd.html`** — carries a `wizdeck-doc` block and can be reopened in this tool to continue editing (`Ctrl+S`).

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `Ctrl+O` | Open HTML (or drag a file into the window) |
| `Ctrl+S` | Save project · `Ctrl+E` export PPTX |
| `Ctrl+F` | Find text (`Enter` next / `Shift+Enter` previous) |
| `Ctrl+C` / `V` / `D` | Copy / paste / duplicate element in place |
| `Ctrl+B` / `I` / `U` | Bold / italic / underline |
| `Ctrl+]` / `Ctrl+[` | Bring forward / send backward |
| Arrow keys | Nudge 1px, `Shift` + arrow for 10px |
| `Alt` + drag | Duplicate element |
| `Shift` + click | Multi-select |
| `Delete` | Delete element |
| `F5` | Present (`←` `→` to page, `N` notes, `F` fullscreen, `Esc` exit) |
| `Ctrl+0` | Fit to window |
| `Ctrl+` / `Ctrl+-` | Zoom |
| `Ctrl+\` | Show / hide both side panels |

## Interface layout

- **Top bar** — undo/redo, new slide, insert (text box / heading / shape / table / formula / chart / image / video), format painter, find, open, save & export, theme, help.
- **Left rail** — slide list, switch and drag to reorder.
- **Canvas** — the slide canvas plus selection box and control handles (corner resize, `⟳` rotate, bezier start/end/bend points and both end tangents).
- **Right panel** — contextual inspector: slide properties, or the selected element's size, position, fill, border, radius, opacity, layer, alignment and distribution, custom CSS declarations, and LaTeX source.
- **Status bar** — selection summary, zoom controls, present entry point.

## Project structure

```
WizDeck.html          ← build output: single-file, self-contained, the thing you distribute
build.mjs             ← build script
build/
  shell.html          ← page skeleton + SVG icon sprite
  styles.css
  js/01-core.js       ← utilities and constants (1920×1080 canvas, EMU conversion)
  js/02-parse.js      ← HTML parsing, asset inlining, slide splitting
  js/03-store.js      ← document model, undo / redo
  js/04-render.js     ← rendering
  js/05-pptx.js       ← PPTX exporter (ZIP + OOXML)
  js/06-ui.js         ← top bar, panels, inspector, shortcuts, help
  js/07-elements.js   ← element types
  js/08-draw.js       ← freehand: cubic bezier curves, polygon vertex editing and fill
samples/              ← sample deck and splitting-pattern examples
tools/                ← regression suites, probe scripts, validators
```

## Build

```bash
node build.mjs
```

Concatenates `shell.html` + `styles.css` + `js/*.js` from `build/` (ordered by numeric prefix) into the single-file `WizDeck.html`, then runs a self-containment check that flags any external script, stylesheet or font reference.

## Tests

The regression suites drive a local headless Chrome over CDP, each with a fresh browser instance — chaining several suites over one Chrome kills it and makes every later suite fail with CDP timeouts (false failures). There are no npm dependencies; the suites run under plain node.

```powershell
# Windows
powershell -File tools\run-regressions.ps1

# run selected suites only
powershell -File tools\run-regressions.ps1 -Only edit-test.mjs,pattern-test.mjs
```

`tools/run-suites.sh` is the bash equivalent. Logs land in `tmp/regressions/`.

The 12 regression suites cover:

| Suite | Coverage |
|---|---|
| `edit-test.mjs` / `edit-test2.mjs` | Editing core / alignment, layers, marquee |
| `cursor-test.mjs` | Cursors, rotation, drag hit points |
| `textpos-test.mjs` | Text positioning accuracy |
| `panel-test.mjs` | Panel collapse / expand |
| `topbar-test.mjs` | Top bar buttons and icons |
| `overlay-test.mjs` | Selection overlay zero-occlusion and shortcut parity |
| `elements-test.mjs` | Shapes / headings / text / tables / formulas / charts |
| `latex-test.mjs` | LaTeX → MathML parsing (pure node, no browser) |
| `video-test.mjs` | Video insertion and poster fallback |
| `ui-smoke.mjs` | Workbench shell smoke test |
| `pattern-test.mjs` | Slide-split detection |

`tools/` also holds one-off probe scripts (hit testing, drag, polylines, styling, …) and Python validators (`validate_pptx.py`, `audit_bounds.py`, `fidelity.py`).

## Known limitations

- Cross-origin images and fonts cannot be read and are skipped (local files and data URIs are unaffected).
- Text depends on fonts installed on the presenting machine; the exporter declares a separate `eastAsia` font for CJK to reduce fallback risk.
- Custom `@font-face` rules are not embedded into the PPTX — use system fonts instead, or rasterize that element as an image.

## Data storage

All state lives in `localStorage`; nothing is uploaded:

| Key | Purpose |
|---|---|
| `wizdeck.model` | `Ctrl+S` saves the current document to the browser |
| `wizdeck.theme` | Light / dark theme |
| `wizdeck.debug` | Enable debug logging |
| `wizdeck.autosample` | Load the sample deck on first open |
