# cc-report

Compound Consulting branded Word document generator. This is a Cowork skill — Claude uses it to produce reports, handoffs, proposals, and other client deliverables that match CC's visual style.

## Contents

| File | What it is |
|---|---|
| `SKILL.md` | Skill definition — tells Claude when and how to use this |
| `brand.js` | Brand config (colors, font, contact info). One-stop shop for style tweaks. |
| `report.js` | Reusable helper library (Eyebrow, H1, card, specTable, etc.) |
| `example.js` | Working example that exercises every component |
| `assets/cc-logo.png` | Logo, bundled so the skill has no external dependencies |
| `example-output.docx` | Reference output — what the example produces |

## Installing this as a Cowork skill

1. Open Cowork's **Settings → Capabilities**
2. Point it at this folder (`RE Tech Consulting/skills/cc-report/`)
3. Once installed, Claude will invoke it automatically when you ask for on-brand documents

## Regenerating the example

```bash
cd RE Tech Consulting/skills/cc-report
node example.js
```

Produces `example-output.docx` in this folder.

## Tweaking the brand

Edit `brand.js`. All colors, the font, and the contact info are centralized there. Changes apply to every document produced by the skill on the next build.

## For a client-branded version

Don't fork this skill. Copy the whole folder to a new skill (e.g. `rf-report`) and swap out `brand.js` + `assets/` for the client's identity. `report.js` stays the same.
