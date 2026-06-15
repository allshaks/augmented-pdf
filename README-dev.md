# Augmented PDF — developer / Phase 0 guide

A thin harness to **de-risk** the three Phase 0 spikes from [PLAN.md](PLAN.md) §12. It is not
the real feature — it logs verbosely and proves the unknowns.

| Spike | What it proves | How it's verified |
|-------|----------------|-------------------|
| **S1** | We can capture the PDF text selection (literal text + PDF++'s 4-number `selId`) from the PDF++ `pdf-menu` event | In Obsidian (needs PDF++) |
| **S2** | We can drive the `claude` CLI in streaming mode, parse `stream-json`, and chain multi-turn sessions | ✅ **Already verified** via `npm run spike:claude` (and the runner is a TS port of that) |
| **S3** | A note containing a PDF++ `#page=&selection=` body link actually renders a highlight that double-click opens | In Obsidian (needs PDF++) |

## Prerequisites
- Node ≥ 18, npm (this repo built with node 24 / npm 11).
- The `claude` CLI installed **and logged in** (`claude auth status` → `"loggedIn": true`).
- For S1/S3: Obsidian desktop with the **PDF++** community plugin installed, and at least one PDF.

## Build
```bash
npm install
npm run build      # tsc -noEmit (type check) + esbuild bundle -> main.js
npm run dev        # watch mode (rebuilds main.js on save)
```

## S2 — verify the CLI engine without Obsidian
```bash
# single streamed answer
node scripts/spike-claude.mjs "In one sentence, what is self-attention?" --model haiku

# multi-turn: force an id on turn 1, resume it on turn 2
MYID=$(uuidgen)
node scripts/spike-claude.mjs "Remember A=42." --model haiku --session-id "$MYID"
node scripts/spike-claude.mjs "What is A?"     --model haiku --resume "$MYID"

# if `claude` isn't on PATH, point at it explicitly:
CLAUDE_BIN=/Users/you/.local/bin/claude node scripts/spike-claude.mjs "hi"
```
Expect: text streaming to stdout, then a summary line with `is_error`, `session_id`, `total_cost_usd`.

## Install into a vault (for S1/S3)
From this repo, link or copy the three runtime files into the vault's plugin folder:
```bash
VAULT="/path/to/your/vault"
DEST="$VAULT/.obsidian/plugins/augmented-pdf"
mkdir -p "$DEST"
ln -sf "$PWD/main.js" "$DEST/main.js"
ln -sf "$PWD/manifest.json" "$DEST/manifest.json"
ln -sf "$PWD/styles.css" "$DEST/styles.css"
```
(Symlinks mean `npm run build` updates the plugin in place — just reload Obsidian.)

Then in Obsidian: **Settings → Community plugins → enable "Augmented PDF (Claude)"**. Open the
plugin's settings and set the **Claude binary path** to an absolute path (GUI apps don't inherit
your shell PATH) — find it with `which claude`.

## Test procedures (open the developer console: Cmd-Opt-I)

**Preflight** — Command palette → "Spike: Preflight (PDF++ + claude auth)". Expect a notice like
`Preflight — PDF++: ✓ · claude: ✓ (max)`. If claude shows ✗, fix the binary path / log in.

**S1** — Open a PDF, select some text, right-click. You should see **"Ask Claude about selection
(spike)"** in the menu. The console logs `S1 pdf-menu { pageNumber, rawSelection, resolvedSelId,
textPreview }`. ✅ if `resolvedSelId` is a 4-number string and `textPreview` matches your selection.

**S2 (in-app)** — After selecting, click **"Ask Claude about selection (spike)"** (or run the
command). A live Notice shows Claude's streaming answer; the full text streams to the console; it
finishes with a cost. ✅ if the answer streams and completes without error.

**S3** — Select text in a PDF, then right-click → **"Write selection link (spike)"** (or the
command). It creates `AugmentedPDF-spike-<ts>.md` at the vault root. ✅ if the passage is now
**highlighted** in the PDF and **double-clicking the highlight opens that note**.

## Troubleshooting
- **`claude` ENOENT / not runnable** → set an absolute binary path in plugin settings.
- **Not logged in** → run `claude` in a terminal once and `/login`.
- **No "Ask Claude" in the PDF menu** → PDF++ not enabled, or its `pdf-menu` event changed; check
  the console for `pdf-plus not enabled` or `getSelectionInfo failed`.
- **S3 highlight doesn't render** → confirm the note's `**Source:**` link matches PDF++'s own
  "Copy link to selection" format for the same passage (compare the `selection=` numbers).
