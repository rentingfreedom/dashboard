---
name: cc-report
description: Create a Word document (.docx) in Compound Consulting's brand style — cover page, branded header/footer, colored section eyebrows, cards with accent bars, styled spec tables, and checkmark lists. Use when the user asks for a client handoff, proposal, status report, assessment, briefing, playbook, or any Compound Consulting deliverable that should look on-brand rather than plain. Trigger on phrases like "compound consulting handoff/proposal/report", "cc-branded doc", "on-brand doc", "styled report", or when the output is a formal client deliverable from Compound Consulting.
---

# Compound Consulting branded reports

This skill produces a Word document in Compound Consulting's visual style. It's the same design system used for the Renting Freedom handoff and the phase-one-proposal — light theme, brand purple/blue/green accents, card containers with colored left bars, section eyebrows in small caps, spec tables with subtle shading.

## When to use

Reach for this skill whenever the deliverable is a **client-facing document from Compound Consulting** that should look on-brand. Typical examples:

- Client handoffs and system documentation
- Proposals and scoping docs
- Monthly / quarterly status reports
- Assessments and audits
- Playbooks and internal SOPs
- Executive briefings

Do **not** use this for casual notes, quick memos, or the client's own branded material (that would be a different skill).

## How to use

The skill is a Node.js library. You write a small build script in the outputs folder that imports the helpers, defines the content, and writes the docx. Then you copy the result to the workspace.

Order of operations:

1. `Read` `report.js` to see the exact helper API surface. Do this every time before writing content — the API is small but easy to misremember (e.g. `H3` takes only text, `card` takes an options object with `accent` and `bg`).
2. Write a build script (typically at `<outputs>/build-<slug>.js`) that:
   - `require`s `report.js` and `brand.js` from this skill's folder
   - Composes cover metadata + section content using the helpers
   - Calls `buildDoc({...}).then(buf => fs.writeFileSync(...))`
3. Run it with `node build-<slug>.js`
4. Verify by converting to PDF and reading a page or two:
   ```bash
   python3 <path>/skills/docx/scripts/office/soffice.py --headless --convert-to pdf --outdir <preview_dir> <output>.docx
   pdftoppm -jpeg -r 80 <preview_dir>/<output>.pdf <preview_dir>/pg
   ```
5. Copy the final docx to the workspace and present it with `mcp__cowork__present_files`.

## API reference (concise)

Full details live in `report.js`. Quick summary of what's exported:

**Text elements:**
- `P(text, opts?)` — body paragraph
- `Eyebrow(text, color?)` — small caps section marker (goes above H1)
- `H1(text)` — top-level section heading with colored underline
- `H2(text)` — brand-color subheading
- `H3(text)` — bold subheading in body color (no emoji — Word emoji rendering is unreliable)
- `Bullet(text)` — bulleted list item
- `CheckMark(text)` — green checkmark item (use for accomplishments, deliverables)

**Layout:**
- `card(children, {accent?, bg?})` — content block with a colored left accent bar. `children` is an array of Paragraphs.
- `specTable([[label, value], ...])` — 2-column label/value table with brand-color labels
- `twoColTable(header1, header2, rows)` — 2-column table with brand-color header row and zebra rows
- `pageBreak()` — force a page break

**Document:**
- `buildDoc({title, cover, sections}) → Promise<Buffer>` — assembles the full docx with cover page, branded header/footer, and content sections. See `example.js` for the exact shape of `cover` and `sections`.

## Brand config

`brand.js` holds the palette, font, logo path, and contact info. It's the one file to edit if you need to tweak colors globally. **Don't hardcode brand values in your build scripts** — always read from `brand.js`.

## Conventions

- **No emoji icons.** Client machines may not have Segoe UI Emoji. The colored eyebrows and card accents carry the visual language.
- **Sections start with an eyebrow.** Every H1 is preceded by an `Eyebrow(...)` line. This is what gives the doc its structured feel.
- **Cards are for callouts, not everything.** Use cards for: important warnings, grouped bullet lists you want visually anchored, and the roadmap-style groupings. Not for regular body text.
- **Spec tables for facts, twoColTable for reference material.** Spec tables (URL/Login/Notes style) look like info panels. twoColTable (Column/Description style) reads like documentation.
- **Contact card at the end.** Use `card()` with the brand primary accent for the closing "Questions or issues?" block. See `example.js`.

## Output paths

- Build scripts go in `<outputs>/build-<slug>.js`
- Intermediate docx goes in `<outputs>/<slug>.docx`
- Final docx goes in the workspace at the location that matches the deliverable (usually `RE Tech Consulting/` for CC-internal docs, or a client project folder for client deliverables)
- **Present the final docx** with `mcp__cowork__present_files` so the user can open it directly

## Example

See `example.js` in this folder for a minimal working example that exercises every primary component (Eyebrow, H1, H2, H3, P, Bullet, CheckMark, card, specTable, twoColTable, contact card). Copy it as a starting point for new documents.
