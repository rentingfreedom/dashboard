---
name: cc-webreport
description: Create a standalone HTML "webpage report" in Compound Consulting's brand style — hero cover, sticky brand top bar, colored section eyebrows, cards with accent bars, styled spec tables, and checkmark lists. Use when the user asks for a client handoff, proposal, status report, assessment, briefing, playbook, or any Compound Consulting deliverable that should be opened in a browser rather than Word — a "webpage report," "web report," "html report," "on-brand web doc," or "browser-based report." For the same content as a Word document instead, use the cc-report skill.
---

# Compound Consulting branded webpage reports

This skill produces a single self-contained HTML file in Compound Consulting's visual style — the same design system as the `cc-report` (docx) skill, translated to a browser page: light theme, brand purple/blue/green accents, a hero cover section, sticky top bar, card containers with colored left bars, section eyebrows in small caps, spec tables with subtle shading, and checkmark lists.

## When to use

Reach for this skill whenever the deliverable is a **client-facing document from Compound Consulting** that should be opened as a webpage instead of a Word doc. Typical examples:

- Client handoffs and system documentation
- Proposals and scoping docs
- Monthly / quarterly status reports
- Assessments and audits
- Playbooks and internal SOPs
- Executive briefings

If the user wants the same content as a `.docx` instead, use the **cc-report** skill — it shares the same brand palette but renders to Word. Do not use this for casual notes, quick memos, or the client's own branded material.

## How to use

The skill is a small Node.js library with **no external dependencies** (uses only Node's built-in `fs`/`path`) — no `npm install` step needed. You write a small build script that imports the helpers, defines the content, and writes the HTML file.

Order of operations:

1. `Read` `report.js` to see the exact helper API surface. Do this every time before writing content — the API is small but easy to misremember (e.g. `card()` takes an HTML string, not an array; `H3` takes only text).
2. Write a build script (typically at `<outputs>/build-<slug>.js`) that:
   - `require`s `report.js` from this skill's folder
   - Composes cover metadata + section content using the helpers (join the pieces into an HTML string per section)
   - Calls `R.buildReport({...})` and writes the returned string to a `.html` file (or use `R.buildReportFile({...}, outPath)` to do both in one call)
3. Run it with `node build-<slug>.js`
4. Verify visually before delivering. If a headless browser is available, render the file and take a screenshot (see `example.js` + a Puppeteer/Playwright snippet) rather than eyeballing raw HTML. If no headless browser is available in the sandbox, at minimum open the file's structure and check that sections/cards/tables closed correctly, and tell the user to preview it in their own browser.
5. Copy the final `.html` to the workspace and present it with `mcp__cowork__present_files`.

## API reference (concise)

Full details live in `report.js`. Quick summary of what's exported:

**Text elements:**
- `P(text, opts?)` — body paragraph. `opts`: `{ bold, color, align, size }`
- `Eyebrow(text, color?)` — small caps section marker (goes above H1)
- `H1(text)` — top-level section heading with colored underline
- `H2(text)` — brand-color subheading
- `H3(text)` — bold subheading in body color (no emoji — keep it cross-platform)
- `Bullet(text)` / `CheckMark(text)` — single `<li>` items; usually you want the list helpers below instead
- `bulletList(items)` — `<ul>` from an array of plain-text strings
- `checkList(items)` — green-checkmark `<ul>` from an array of plain-text strings (use for accomplishments, deliverables)
- `divider()` — horizontal rule

**Layout:**
- `card(html, {accent?, bg?})` — content block with a colored left accent bar. `html` is an already-composed HTML string (e.g. `P(...) + bulletList(...)`).
- `specTable([[label, value], ...])` — 2-column label/value table with brand-color labels
- `twoColTable(header1, header2, rows)` — 2-column table with brand-color header row and zebra rows
- `contactCard(question?)` — closing "Questions or issues?" card, pre-filled from `brand.js` contact info
- `section(id, eyebrowText, h1Text, bodyHtml)` — convenience wrapper combining Eyebrow + H1 + body into one `{ id, html }` object

**Document:**
- `buildReport({title, cover, sections, topbar?})` → returns a full HTML string (doctype, head, sticky top bar, hero cover, content, footer)
- `buildReportFile({...}, outPath)` → same, but also writes the file and returns the path

See `example.js` for the exact shape of `cover` and `sections`.

## Brand config

`brand.js` holds the palette, font, logo path, and contact info — kept in sync by hand with the `cc-report` (docx) skill's `brand.js`. It's the one file to edit if you need to tweak colors globally. **Don't hardcode brand values in your build scripts** — always read from `brand.js`.

The web version uses the real brand font (Inter, via Google Fonts) instead of the Calibri substitute the docx skill needs — a webpage can depend on a webfont; a `.docx` sent to a client's machine can't.

## Conventions

- **Single self-contained file.** CSS is inlined in a `<style>` tag and the logo is embedded as a base64 data URI — no external assets to lose track of when the file is moved or emailed. The only external dependency is the Google Fonts stylesheet link for Inter; it degrades gracefully to system fonts if unreachable.
- **No emoji icons.** Same reasoning as the docx skill — consistent look regardless of the viewer's OS/fonts.
- **Sections start with an eyebrow.** Every H1 is preceded by an `Eyebrow(...)` call. This is what gives the report its structured feel.
- **Cards are for callouts, not everything.** Use cards for: important warnings, grouped bullet/check lists you want visually anchored, and the closing contact block. Not for regular body text.
- **Spec tables for facts, twoColTable for reference material.** Spec tables (URL/Login/Notes style) look like info panels. twoColTable (Item/Status style) reads like documentation.
- **Contact card at the end.** Use `contactCard()` as the last element of the last section.
- **Print-friendly.** The stylesheet includes `@media print` rules (cover forces a page break, sticky bar becomes static) so a client can still print/PDF the page from their browser if they want a static copy.

## Output paths

- Build scripts go in `<outputs>/build-<slug>.html`
- Final HTML goes in the workspace at the location that matches the deliverable (usually a client project folder)
- **Present the final HTML** with `mcp__cowork__present_files` so the user can open it directly

## Example

See `example.js` in this folder for a minimal working example that exercises every primary component (Eyebrow, H1, H2, H3, P, bulletList, checkList, card, specTable, twoColTable, contactCard). Copy it as a starting point for new reports. Run `node example.js` to produce `sample.html`.
