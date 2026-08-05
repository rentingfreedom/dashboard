# cc-webreport

Compound Consulting branded webpage-report generator. Companion to the `cc-report` skill — same brand palette and component vocabulary (eyebrows, cards, spec tables, checkmark lists), rendered as a single self-contained HTML file instead of a Word document.

## Contents

| File | What it is |
|---|---|
| `SKILL.md` | Skill definition — tells Claude when and how to use this |
| `brand.js` | Brand config (colors, font, contact info). Kept in sync by hand with `cc-report`'s `brand.js`. |
| `report.js` | Reusable helper library (Eyebrow, H1, card, specTable, buildReport, etc.) — no npm dependencies |
| `example.js` | Working example that exercises every component |
| `assets/cc-logo.png` | Logo, embedded as a base64 data URI in generated reports |

## Installing this globally (all client projects)

Skills placed in your **user-level** Claude Code skills directory are available in every project, not just one repo:

```
C:\Users\merri\.claude\skills\cc-webreport\
```

Copy this whole folder there. Claude Code auto-discovers it and exposes it as `/cc-webreport`, plus auto-triggers it on phrases like "webpage report" or "on-brand web doc."

## Regenerating the example

```bash
cd cc-webreport
node example.js
```

Produces `sample.html` in this folder — open it directly in a browser.

## Tweaking the brand

Edit `brand.js`. All colors, the font, and the contact info are centralized there. Changes apply to every report produced by the skill on the next build. If you change CC's brand, update this file **and** `cc-report`'s `brand.js` to keep the Word and web versions in sync.

## For a client-branded version

Don't fork this skill. Copy the whole folder to a new skill (e.g. `rf-webreport`) and swap out `brand.js` + `assets/` for the client's identity. `report.js` stays the same.
