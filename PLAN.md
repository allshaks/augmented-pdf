# Augmented PDF — Plan

An Obsidian community plugin that adds an **"Ask Claude"** mode to PDF reading: highlight
text in a PDF, ask a question, and have the whole conversation saved as markdown next to
the PDF — with a short AI summary that **accumulates** as a clickable annotation on the
highlight.

Built **on top of** [PDF++](https://github.com/RyotaUshio/obsidian-pdf-plus), driven by the
**`claude` CLI** (Claude Code), **not** the Anthropic HTTP API.

> Status: planning only. No code yet. This document is the contract for v1.
> The data model in §5–§8 was validated against PDF++'s actual source code (see §3.1).

---

## 1. Goal & scope

**v1 ships exactly one mode: `ask`.** Everything below is scoped to that.

A single end-to-end flow:

1. Select text in a PDF inside Obsidian.
2. Right-click → **"Ask Claude about selection"** (or a hotkey).
3. A chat panel opens, pre-loaded with the selected passage as context. You ask a question;
   Claude's answer streams in. You can ask follow-ups in the same thread.
4. When you finish the thread, the full transcript is written to a markdown file in a
   subfolder next to the PDF, and a **brief AI summary + a link to that transcript** is
   **appended** to the highlight's annotation note (it never overwrites earlier chats).
5. Double-clicking the highlight opens that annotation note — a running list of every chat
   about the passage, each with its summary and a link to the full transcript.

**Explicit non-goals for v1** (backlog in §13): any mode other than `ask`, mobile support,
and re-implementing anything PDF++ already does.

**Normal annotation keeps working for free.** We add a companion plugin rather than replace
PDF++, so all of PDF++'s normal highlighting/annotation features remain untouched.

---

## 2. The core decision: build on top of PDF++ (don't fork)

**Decision: ship a separate community plugin that depends on PDF++ at runtime.** Fork only
if a future mode needs to change PDF++'s rendering internals.

Why this works (verified against PDF++ source, its developer wiki, and Obsidian docs):

- **License is permissive** — PDF++ is MIT (© Ryota Ushio). Depend now, fork later if needed.
- **PDF++ gives us the hooks we need:**
  - A **`pdf-menu` workspace event** (`callback(menu, { pageNumber, selection, annot? })`) to add
    our own context-menu item and read the current selection.
  - A library handle `app.plugins.plugins['pdf-plus'].lib` (`pdfPlus.lib`) with
    `getPageAndTextRangeFromSelection()` (page + the 4-number selection range) and
    `copyLink.getTextToCopy(...)` (mint a selection link identical to PDF++'s, with color).
- **PDF++ is built on Obsidian's native pdf.js viewer**, so our highlights are normal PDF++
  backlinks.
- **It's actively maintained** (releases through late 2025 / 2026, tracking Obsidian 1.9.x).

Why **not** fork: we'd inherit PDF++'s full maintenance burden against unstable Obsidian
internals, and most users already have PDF++ installed; a companion composes with their setup.

**Trade-off we accept:** `pdfPlus.lib` + `pdf-menu` are a *best-effort* developer surface, not
a SemVer-stable public API, and PDF++ rides Obsidian's *internal* PDF APIs. Mitigation:
feature-detect everything, wrap internal calls in `try/catch`, pin/test against specific
PDF++ + Obsidian versions, degrade gracefully when a hook is missing.

---

## 3. Feasibility findings (the three pillars)

### 3.1 PDF++ (the substrate) — *source-verified*

- A highlight is **markdown-first**: a highlight is a wikilink with a fragment like
  `[[file.pdf#page=3&selection=12,4,18,96&color=yellow|alias]]`. Any note linking to a
  selection highlights that text and lists the note in PDF++'s backlinks pane.
- **Highlights are keyed by `page` + the 4-number selection string**
  (`beginIndex,beginOffset,endIndex,endOffset`), stored in a `MultiValuedMap` that PDF++'s
  author built *specifically* to support **multiple backlinks to one selection**
  (`src/lib/pdf-backlink-index.ts`). So **N notes/links on the same selection = one visual
  highlight**, and all N appear as separate rows in the backlinks pane. ← *This is exactly the
  substrate an accumulating annotation needs.*
- **A single "hub note" works**: PDF++ keys off each individual link *reference*, not the note
  body. One selection link in a note = one backlink; the rest of the note (other sections,
  other wikilinks) is ignored for that highlight. (Keep exactly **one** selection link per hub
  note, or you get duplicate pane rows.)
- **There is no native canonical "annotation note" / folder / template** — destination is
  wherever the user pastes. We must define and own this convention. Because backlinks are
  vault-wide and additive, appending accumulating summaries is naturally non-destructive.
- **⚠️ Interaction correction (important):** the "hover highlight → popover of the note" path
  is **gated behind the Page Preview core plugin and defaults to Ctrl/Cmd-hover**, not plain
  hover. The reliable primary interaction is **double-click highlight → opens the backlinking
  note** (`doubleClickHighlightToOpenBacklink`). Design the UX around double-click; treat the
  hover popover as an enhancement and detect/warn if Page Preview is disabled.
- **Display templates (`{{...}}`) are clipboard-only** — they control the text PDF++ *copies*,
  not how a backlink renders in the pane or viewer. We can't make the pane row "read like a
  summary" via templates; the consolidated-summary view must come from opening the hub note.
- **Avoid writing real annotations into the .pdf binary.** PDF++ can do this (experimental,
  via `pdf-lib`), but those objects are **not** backlinks and won't participate in our
  highlight/summary UX. Stay entirely on the markdown-backlink path.

### 3.2 Obsidian plugin runtime (what we're allowed to do)
- **Desktop is Electron with Node** → a plugin can `require('child_process').spawn('claude', …)`.
- **Mobile has no Node/Electron APIs** → desktop-only. Declare `"isDesktopOnly": true`. No
  mobile fallback for spawning a CLI.
- **PATH gotcha (top runtime risk):** GUI apps don't inherit the shell PATH, so
  `spawn('claude')` often fails with `ENOENT`. → Settings field for an **absolute binary path**
  + best-effort autodetect (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, npm global).
  e.g. `~/.local/bin/claude` (verified against CLI v2.1.119).
- **Side panel** = an `ItemView` registered with `registerView`; open via
  `workspace.getRightLeaf(false)`. Never cache view instances — re-acquire with
  `getLeavesOfType()`.
- **Depending on PDF++** is informal: check `app.plugins.plugins['pdf-plus']` inside
  `app.workspace.onLayoutReady(…)` (load order is otherwise unpredictable); warn + bail if absent.
- **Child processes aren't auto-cleaned** — track handles, `kill()` on cancel / view close /
  `onunload`.
- `vault.create('sub/dir/x.md')` **won't create missing parent folders** — `createFolder()` first.
- Generate links with `FileManager.generateMarkdownLink(...)` (respects user link prefs); use
  `vault.process(file, fn)` for atomic read-modify-write appends.

### 3.3 `claude` CLI (the engine)
- **Headless prompt:** `claude -p "<question>"` (arg or stdin).
- **Streaming:** `--output-format stream-json --verbose --include-partial-messages`. Each
  stdout line is one JSON event; render `content_block_delta` events with
  `delta.type == "text_delta"`. Final `type:"result"` line carries `session_id`,
  `total_cost_usd`, `is_error`.
- **Session continuity:** generate a UUID per chat thread, pass `--session-id <uuid>` on turn 1,
  `--resume <uuid>` on follow-ups. **Session lookup is scoped to the child cwd** — always spawn
  with a consistent cwd (vault root).
- **Context injection:** `--append-system-prompt "<passage + prior summaries>"`.
- **Lock it down:** `--allowedTools "Read,Grep,Glob" --permission-mode dontAsk` for read-only.
  In `-p` mode a non-pre-approved tool *aborts* the run — pre-authorize exactly what's needed.
- **Auth:** uses the user's existing Claude login (no API key). **Never use `--bare`** (it
  ignores OAuth → demands an API key; verified to fail on this logged-in machine). Preflight
  with `claude auth status` (JSON: `loggedIn`, `authMethod`, `subscriptionType`).
- **Billing (decided — proceed):** as of **2026-06-15**, `claude -p` on subscription plans draws
  from a **separate monthly "Agent SDK credit"**, distinct from interactive limits. We proceed
  with the CLI and **surface `total_cost_usd` per chat** in the UI so consumption is visible. An
  optional `--max-budget-usd` guard is a candidate setting (see §14).
- ⚠️ Installed version **2.1.119**; some flag behaviors changed in later versions (10 MB stdin
  cap @2.1.128; `--bare` possibly becoming the `-p` default). Test against the installed version.

---

## 4. Architecture overview

```
┌──────────────────────── Obsidian (desktop / Electron) ─────────────────────────┐
│  PDF++ (native pdf.js viewer)                                                    │
│    ▲ highlight rendered from our backlink                                        │
│    │ pdf-menu event + pdfPlus.lib                                                │
│  ┌─┴────────────────────────────────────────────────────────┐                   │
│  │  Augmented-PDF plugin                                      │                   │
│  │   • ContextMenu (adds "Ask Claude")                        │                   │
│  │   • Association (page+selection → existing hub or new)     │                   │
│  │   • ChatView (ItemView: stream, cancel, multi-turn)        │                   │
│  │   • ClaudeRunner (spawn / stream-json / sessions)          │                   │
│  │   • Store: hub notes (append-only) + immutable transcripts │                   │
│  │   • Summary + continuity injection                         │                   │
│  │   • Reconcile pass + rename hook + preflight + settings    │                   │
│  └─────────────────────────────────┬─────────────────────────┘                   │
│   writes/reads:                     │ child_process                              │
│   <pdf> (annotations)/  <pdf> (chats)/                                           │
└──────────────────────────────────────┼──────────────────────────────────────────┘
                                        ▼  claude -p --session-id/--resume (stream-json)
```

---

## 5. Data model & storage layout (validated hybrid)

**Spine = "hub annotation note per highlight"** (gives the single consolidated, accumulating
summary view your requirement asks for). **Disciplines borrowed for robustness:** transcripts
are **immutable** (only the hub is ever mutated), and each transcript **also** carries the
selection link so it independently renders the highlight and can rebuild a lost hub.

### 5.1 Folder layout — two sibling folders next to the PDF (lazily created)

```
MyVault/Papers/
├── Attention Is All You Need.pdf
├── Attention Is All You Need (annotations)/        ← HUB notes, one per highlight
│   ├── p3-s12.4.18.96 — attention-mechanism.md
│   └── p7-s8.10.9.4 — positional-encoding.md
└── Attention Is All You Need (chats)/              ← TRANSCRIPTS, one per chat (immutable)
    ├── 2026-06-15 1432 — attention-mechanism — a1b2c3d4.md
    ├── 2026-06-16 0901 — attention-mechanism — e5f6a7b8.md   ← 2nd chat, SAME highlight
    └── 2026-06-15 1505 — positional-encoding — c9d0e1f2.md
```

- **Hub filename:** `p{page}-s{b}.{bo}.{e}.{eo} — {slug}.md`. The `p{page}-s{4 numbers}` prefix
  is the **stable highlight key** (dots not commas, for filesystem safety). `{slug}` = first
  ~6 words of the selection, lowercased, ≤40 chars — **cosmetic, never parsed**.
- **Transcript filename:** `{YYYY-MM-DD HHmm} — {slug} — {chatId8}.md` (timestamp-first sorts
  chronologically; `chatId8` = first 8 hex of the chat UUID = the `--session-id`).
- Folder names are bound to the PDF stem and kept in sync by a `vault.on('rename')` hook (§8.4).

### 5.2 Hub note (append-only)

```markdown
---
augmented-pdf: hub
pdf: "[[Attention Is All You Need.pdf]]"
page: 3
selection: "12,4,18,96"
color: yellow
highlight-key: "Attention Is All You Need.pdf|3|12,4,18,96"
chat-count: 2
tags: [augmented-pdf/annotation]
---

> [!quote] Highlighted passage (p.3)
> An attention function can be described as mapping a query and a set of
> key-value pairs to an output…

**Source:** [[Attention Is All You Need.pdf#page=3&selection=12,4,18,96&color=yellow|Attention Is All You Need, page 3]]

## Chats

### 2026-06-15 14:32 — What does "mapping a query to an output" mean?
Claude explained attention as a weighted sum of value vectors, weights from query–key
dot products: a soft, content-addressable lookup rather than a hard index.
→ [[2026-06-15 1432 — attention-mechanism — a1b2c3d4|Full chat ↗]]

### 2026-06-16 09:01 — How is this different from Bahdanau attention?
Claude contrasted additive (Bahdanau) vs dot-product attention; this paper drops
recurrence entirely, the payoff being full parallelism across the sequence.
→ [[2026-06-16 0901 — attention-mechanism — e5f6a7b8|Full chat ↗]]
```

**Invariants (enforced only by our code):**
- The `**Source:**` line holds the selection wikilink **exactly once** — the canonical
  highlight render source (body link = the verified-solid path). Summary blocks never re-emit a
  `selection=` link (avoids duplicate pane rows).
- `## Chats` is **append-only**: we splice a new `### …` block at the end; prior blocks are
  never touched (so the user can hand-edit summaries safely).

### 5.3 Transcript note (immutable once written)

```markdown
---
augmented-pdf: transcript
chatId: a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d
pdf: "[[Attention Is All You Need.pdf]]"
page: 3
selection: "12,4,18,96"
color: yellow
hub: "[[p3-s12.4.18.96 — attention-mechanism]]"
session-id: a1b2c3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d
started: 2026-06-15T14:32:05
ended: 2026-06-15T14:36:48
model: claude-opus-4-8[1m]
status: complete            # complete | errored | interrupted
summary: >-
  Claude explained attention as a weighted sum of value vectors, with weights from
  query–key dot products — a soft content-addressable lookup.
tags: [augmented-pdf/chat]
---

# Chat — Attention Is All You Need, p.3

> [!quote] Selection — [[Attention Is All You Need.pdf#page=3&selection=12,4,18,96&color=yellow|p.3]]
> An attention function can be described as mapping a query and a set of key-value pairs…

[[p3-s12.4.18.96 — attention-mechanism|← Back to annotation]]

---

## You — 14:32
What does "mapping a query to an output" mean here?

## Claude — 14:32
… (full streamed answer, verbatim) …
```

Each transcript carries the selection link **in the body callout** (verified-solid location —
*not* frontmatter, whose render/jump behavior is unverified). Consequence: the backlinks pane
shows the hub row **plus** one row per transcript — we treat the pane as the per-chat index and
the **hub note as the consolidated-summary view**. A setting `transcript-backlinks: off` can
drop the transcript's fragment to a plain `#page=N` link for users who want one pane row per
highlight. *(Recommended default: ON — the redundancy is the robustness.)*

### 5.4 Why this layout
- **Reuses PDF++ end-to-end** — the `selection=` body link drives PDF++'s renderer; we write no
  highlight engine.
- **Faithful to the requirement** — one annotation note that *accumulates* `summary + [[link]]`.
- **Crash-safe & durable** — immutable transcripts + only-the-hub-mutates + a reconcile pass.

---

## 6. Summary semantics & accumulation

Your clarified intent: *every new chat appends a `summary + [[link]]` to the highlight's
annotation, accumulating, never overwriting; continuity across threads is a nice bonus.*

- **Accumulating annotation (core):** on conclude, **append** one `### <date> — <title>` block
  (summary + `→ [[transcript|Full chat ↗]]`) to the hub's `## Chats`. Append-only; bump
  `chat-count`.
- **Summary generation is deferred / async** (*decided*): "End chat" returns instantly and the
  appended block initially reads `*(summary pending…)*`. A background call then runs, **resuming
  the session** for full context:
  `claude --resume <chatId> -p "In 2–3 sentences summarize what this conversation established
  about the highlighted passage. Output only the summary."` On return, the block's placeholder and
  the transcript's `summary:` frontmatter are patched in place. Title = derived from the first
  question. If the deferred call fails, the block stays `*(summary pending)*` and the reconcile
  pass (§8.3) retries it.
- **Continuity across threads (bonus):** when a new chat starts on a highlight that already has
  chats, inject prior summaries (read cheaply from each transcript's `summary:` frontmatter,
  most-recent-last, capped to **K=8** + "(+N earlier elided)") via `--append-system-prompt`, each
  with its `[[transcript]]` link so Claude/you can open the source. Inject *summaries*, not full
  transcripts. Optional deepening: "Resume a specific prior chat" → `claude --resume <thatId>`
  (the one sanctioned exception to transcript immutability, appended under a `## Chat (resumed)`
  heading).

---

## 7. `claude` invocation design (concrete)

First turn:
```
claude -p "<user question>" \
  --session-id "<chatId-uuid>" \
  --append-system-prompt "<passage + pdf/page (+ prior summaries w/ [[links]])>" \
  --output-format stream-json --verbose --include-partial-messages \
  --allowedTools "Read,Grep,Glob" --permission-mode dontAsk \
  --model <chosen per chat>
```
Follow-up: same but `--resume "<chatId>"` and no re-injected passage (session already has it).

- **Model is chosen per chat** via a small dropdown in the ChatView — no fixed default
  (*decided*). Persist the last choice as a convenience.
- **Tools are read-only** (`Read,Grep,Glob`) so Claude can pull extra context from the vault/PDF
  when asked, but never writes (*decided*); `--permission-mode dontAsk` keeps it non-interactive.
- **cwd = vault root** (consistent, so `--resume` resolves; lets read-only tools reach vault
  files if asked). Optionally cwd = the PDF's folder so Claude can `Read` nearby pages.
- **Parse stdout as NDJSON**, line-buffered, tolerate partial lines; render `text_delta`s;
  surface tool-use as subtle status. Read the final `result` line for `session_id`/cost/`is_error`.
- **Cancellation & cleanup:** track every `ChildProcess`; `kill()` on cancel / `onClose` /
  `onunload`; show a stop button while streaming.
- **Preflight before first spawn:** (1) PDF++ present & enabled; (2) `claude` resolvable;
  (3) `claude auth status` → `loggedIn`. Actionable `Notice` on each failure.

---

## 8. Association, append, and recovery

### 8.1 Highlight ↔ chat association rule
**Exact, page-scoped match on the 4-number selection id**, byte-identical to PDF++'s
`selectionId` (`"${beginIndex},${beginOffset},${endIndex},${endOffset}"`). Matching looser than
PDF++ would desync from what's actually rendered as one highlight.
- Same `(page, selId)` exists → **same highlight** → append to that hub (inherit its color,
  inject prior summaries).
- No match → **new highlight** → create hub on conclude.
- Overlapping-but-not-identical → **different highlight by default** (faithful to PDF++). Surface
  a non-blocking "a nearby highlight has N chats — add here, or new?" notice; **never silently
  merge**. If accepted, reuse the existing hub (don't mint a new selection link).
- Same text on different pages → distinct (page in key). Same text twice on one page → distinct
  `beginIndex` → distinct (correct).

**Lookup = index-primary + glob-fallback:** PDF++ backlink index
(`page.selections.get(selId)` → source files filtered to `augmented-pdf` notes) first; if the
internal API drifts, glob `"<stem> (annotations)/p{page}-s*..."` + frontmatter match. Never
depend on a single deterministic path or a single internal API.

### 8.2 Conclude ordering (crash-safe)
`write transcript (immutable, full Q/A, body selection link, status, empty summary)` → `ensure hub
exists (single Source link, empty ## Chats)` → `append one block to hub (summary = "(pending)") +
bump chat-count` → **(background)** `generate summary, patch the hub block + transcript frontmatter`.
A crash never leaves an annotation link pointing at a missing transcript. Skip writing anything
below `min-turns-to-save` (default: 1 assistant turn).

### 8.3 Reconcile pass (startup)
Scan transcripts; re-handle anything left inconsistent by a crash or a failed background summary:
(a) a transcript whose `hub:` lacks a `## Chats` entry → re-append; (b) a `## Chats` block still
reading `*(summary pending)*` → re-run the deferred summary; (c) a chat that `errored` mid-stream.
Offer, never auto-delete.

### 8.4 Rename / move hook
Body wikilinks (`pdf:`, `**Source:**`, transcript callout) auto-repoint via Obsidian. Folder
names do **not** auto-rename → a `vault.on('rename')` handler renames both `(annotations)` and
`(chats)` folders to the new stem (matching old folders via the notes' `pdf:` frontmatter).
⚠️ Verify Obsidian preserves the `#page=&selection=&color=` fragment on rename (risk §11).

---

## 9. Key UX flows

**Ask (happy path):** select → context menu → ChatView opens with the passage quoted → ask →
answer streams → follow-ups → End chat → transcript saved, highlight appears/updates, summary
appended to the hub.

**Revisit:** **double-click** the highlight → opens the hub annotation note → read the running
list of summaries, click any `Full chat ↗`. (Hover popover also works *if* Page Preview is
enabled + Ctrl/Cmd-hover — treat as bonus.) A "Continue this thread" action on a transcript
reopens ChatView resuming that session.

**Failure modes (must be graceful):** PDF++ missing/disabled; `claude` not found; not logged in;
process crash mid-stream (partial transcript saved with `status: errored`, reconcile re-offers);
user cancels.

---

## 10. Plugin module structure (proposed)

```
augmented-pdf/
  manifest.json        # id: augmented-pdf, isDesktopOnly: true, minAppVersion pinned
  main.ts              # onload → onLayoutReady: detect pdf-plus, register view/menu/commands, reconcile
  src/
    pdfplus.ts         # typed, defensive wrapper over app.plugins.plugins['pdf-plus'] + pdf-menu
    selection.ts       # getPageAndTextRangeFromSelection → {page, selId, text, alias}
    associate.ts       # selId match: backlink-index primary + glob fallback; nearby-highlight notice
    claude/runner.ts   # spawn, stream-json parse, session mgmt, cancellation, preflight
    chat/view.ts       # ChatView (ItemView): message list, input, stop, status line
    store/hub.ts       # hub ensure/create + append-only splice; chat-count
    store/transcript.ts# immutable transcript write; summary patch
    summary.ts         # post-thread summary call + continuity injection
    reconcile.ts       # startup orphan-transcript reconcile
    rename.ts          # vault.on('rename') folder sync
    settings.ts        # binary path, model list + last-used, colors, folder templates, transcript-backlinks, (opt) budget cap
    preflight.ts       # pdf-plus check + claude auth status + binary resolution
  styles.css
```
Manifest `id` rules: lowercase-hyphen, can't contain "obsidian" or end in "plugin" →
`augmented-pdf` is fine. Display name e.g. "Augmented PDF (Claude)".

---

## 11. Risks & mitigations

| # | Risk | Severity | Mitigation |
|---|------|----------|------------|
| 1 | **Hover-popover "see summaries" is gated** (needs Page Preview + Ctrl/Cmd-hover) | High (UX) | Make **double-click → open hub** the primary path; detect/warn if Page Preview off |
| 2 | `pdfPlus.lib` / `pdf-menu` are best-effort, not stable; getting selection text may need internals | High | Spike first; feature-detect; fall back to DOM `getSelection()`; pin versions |
| 3 | Obsidian releases break PDF++ (transitively us) | High | Pin `minAppVersion`, test matrix, graceful degrade + Notice |
| 4 | `spawn('claude')` ENOENT (no shell PATH) | High | Settings absolute-path + autodetect + preflight |
| 5 | `vault.process()` atomicity assumed, not verified — two concludes on one hub could race | Med | Add an in-plugin per-hub write queue regardless |
| 6 | Wikilink `#page=&selection=&color=` fragment survival on PDF rename unverified | Med | Live-test before shipping rename hook; fall back to reconcile-by-frontmatter |
| 7 | Not authenticated / `--bare` auth pitfall | Med | Preflight `claude auth status`; never `--bare` |
| 8 | Agent-SDK-credit billing for `-p` (new today) | Med | Surface `total_cost_usd`; document; confirm with user |
| 9 | Bad summary compounds (feeds future chats' context) | Med | K-cap continuity; hub is plain markdown (user-editable); "regenerate summary" action |
| 10 | Orphaned child processes | Med | Track handles; `kill()` on cancel/close/unload |
| 11 | Extra summary round-trip adds latency/cost per chat | Low | **Resolved:** summary is deferred/async by default ("(pending)" block patched in) |
| 12 | Desktop-only excludes mobile | Low (accepted) | `isDesktopOnly: true`; documented |

---

## 12. Milestones (spikes first — de-risk the unknowns)

**Phase 0 — Spikes.**
- S1. Subscribe to `pdf-menu`, add a menu item, **log the literal selected text + selId** for a
  real selection. *(Biggest unknown — selection capture.)*
- S2. `spawn('claude', …)` with streaming flags; render `text_delta`s to console; handle
  PATH/auth. *(Proves the engine.)*
- S3. Write a note with a `selection=` body link and confirm PDF++ renders the highlight +
  double-click opens it. *(Proves the substrate end-to-end.)*

**Phase 1 — Ask MVP.** Context menu → ChatView → single question → streamed answer; spawn/stream/
cancel + preflight + settings (binary path, model).

**Phase 2 — Persistence & highlight.** Immutable transcript with body selection link; hub ensure/
create; **append** summary block; association by selId (index + glob); multi-turn via
`--session-id`/`--resume`.

**Phase 3 — Accumulation polish & recovery.** Summary generation; continuity injection; startup
reconcile; rename hook; "Continue this thread"; nearby-highlight notice.

**Phase 4 — Release.** Error states, colors/tags/folder-template config, Page-Preview detection,
docs, community-plugin submission.

Phase 1 is the first thing worth using daily; each phase is independently demoable.

---

## 13. Out of scope for v1 / future backlog
- Other modes: rewrite/improve, define term, critique/steelman, flashcards, translate, synthesis.
- Letting Claude `Read` the actual PDF pages around the selection for richer context.
- A custom on-highlight summary card (would require our own DOM injection, not PDF++-provided).
- Cost/usage dashboard; per-vault model defaults; storing `pageLabel` for display.
- Mobile (would need a fundamentally different transport than a local CLI).

---

## 14. Decisions & remaining questions

**Decided (2026-06-15):**
- **Engine** — proceed with the `claude` CLI; surface `total_cost_usd` per chat.
- **Model** — chosen **per chat** via a ChatView dropdown; no fixed default (persist last choice).
- **Tools** — **read-only** vault access (`Read,Grep,Glob`, `--permission-mode dontAsk`).
- **Summary timing** — **deferred / async**; annotation shows `*(summary pending)*` then patches in.

**Still open (lower-stakes; the plan already assumes the first option of each):**
1. **Hover vs double-click UX** — make double-click → hub note the headline interaction and treat
   the Page-Preview hover popover as a bonus? *(plan assumes yes)*
2. **Transcript backlinks** — default **ON** (per-chat rows in the pane) vs **OFF** (one clean row
   per highlight)? *(plan assumes ON)*
3. **Budget cap** — wire an optional `--max-budget-usd` per chat + a daily/total guard into
   settings now, or defer to a later phase? *(plan defers)*
```