# Augmented PDF

An [Obsidian](https://obsidian.md) **desktop** plugin that adds an "Ask Claude" mode to PDF
reading, on top of [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus). Highlight a passage,
ask questions in a sidebar chat, and your conversations are saved as markdown next to the PDF —
with an accumulating AI summary attached to each highlight.

It is driven by the local **`claude` CLI** (Claude Code), not the Anthropic HTTP API, so it uses
your existing Claude login.

> ⚠️ Early/alpha and built for personal use. Expect rough edges. Desktop only.

## What it does
- **Ask about a selection** — highlight text in a PDF → *Ask Claude* (or `Cmd/Ctrl+Esc`) → a
  streaming, multi-turn sidebar chat about that passage (per-chat model dropdown, live cost,
  "Thinking… / Thought for Ns" indicator, markdown rendering).
- **Accumulating annotations** — one *hub* note per highlight (keyed by page + selection) with an
  append-only list of `summary + link`, one entry per chat. The hub's selection link drives the
  PDF++ highlight, so clicking it opens the annotation.
- **Transcripts** — every chat is saved in a sibling `… (chats)/` folder; reopen one to **continue
  it** (resumes the original Claude session for true context recovery).
- **Deferred summaries** — a short summary is generated asynchronously (kept cheap) and patched in.
- **Cross-links** — if a same-stem literature note exists (e.g. a Zotero note), annotations link to
  it so they show up in that paper's backlinks.
- **Robustness** — nearby-overlap prompt, startup reconcile, PDF-rename hook, highlight
  click-through toggle.

## Requirements
- Obsidian desktop (the plugin is `isDesktopOnly`).
- The **PDF++** community plugin, installed and enabled.
- The **`claude` CLI** installed and logged in (`claude auth status` → `loggedIn: true`).

## Install (from source)
```bash
npm install
npm run build        # produces main.js
```
Then copy `main.js`, `manifest.json`, and `styles.css` into
`<vault>/.obsidian/plugins/augmented-pdf/`, reload Obsidian, and enable the plugin. In its
settings, set the **absolute path** to your `claude` binary (GUI apps don't inherit your shell
`PATH`; find it with `which claude`).

## Docs
- [`PLAN.md`](PLAN.md) — the design and architecture.
- [`README-dev.md`](README-dev.md) — build, dev workflow, and the Phase-0 spikes.

## License
[MIT](LICENSE).
