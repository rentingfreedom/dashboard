// cc-webreport: reusable HTML/CSS helpers in Compound Consulting brand style.
// Same visual language as the cc-report (docx) skill — eyebrows, cards with
// accent bars, spec tables, checkmark lists — rendered as a single
// self-contained HTML file instead of a Word document.
//
// Usage:
//   const R = require('.../skills/cc-webreport/report');
//   const body = [
//     R.Eyebrow('Section 01 · Overview'),
//     R.H1('Overview'),
//     R.P('The system does X, Y, Z.'),
//     R.card(R.bulletList(['Point one', 'Point two']), { accent: 'primary' }),
//   ].join('\n');
//   const html = R.buildReport({
//     title: 'Renting Freedom — Q3 Status Report',
//     cover: { eyebrow: 'STATUS REPORT', title: 'Q3 Review', preparedFor: 'Renting Freedom LLC' },
//     sections: [{ id: 'overview', html: body }],
//   });
//   fs.writeFileSync('out.html', html);

const fs = require('fs');
const path = require('path');
const BRAND = require('./brand');

const C = BRAND.colors;
const FONT = BRAND.font.family;

// ─── Utilities ─────────────────────────────────────────────────────────────

function esc(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Resolve an accent name ('primary', 'accent', 'green', ...) or raw hex to a CSS color. */
function accentColor(name) {
  if (!name) return C.primary;
  if (C[name]) return C[name];
  if (/^#?[0-9A-Fa-f]{6}$/.test(name)) return name.startsWith('#') ? name : `#${name}`;
  return C.primary;
}

function logoDataUri() {
  const buf = fs.readFileSync(BRAND.logoPath);
  const ext = path.extname(BRAND.logoPath).slice(1) || 'png';
  return `data:image/${ext};base64,${buf.toString('base64')}`;
}

// ─── Text helpers ──────────────────────────────────────────────────────────

/** Body paragraph. `opts`: { bold, color, align, size (px) } */
function P(text, opts = {}) {
  const style = [];
  if (opts.bold) style.push('font-weight:600');
  if (opts.color) style.push(`color:${accentColor(opts.color)}`);
  if (opts.align) style.push(`text-align:${opts.align}`);
  if (opts.size) style.push(`font-size:${opts.size}px`);
  return `<p class="cc-p"${style.length ? ` style="${style.join(';')}"` : ''}>${esc(text)}</p>`;
}

/** Small-caps section marker. Sits above H1. */
function Eyebrow(text, color = 'accent') {
  return `<div class="cc-eyebrow" style="color:${accentColor(color)}">${esc(text.toUpperCase())}</div>`;
}

/** Top-level heading with a colored underline accent. */
function H1(text, underline = 'primary') {
  return `<h1 class="cc-h1" style="border-bottom-color:${accentColor(underline)}">${esc(text)}</h1>`;
}

/** Brand-color subheading. */
function H2(text) {
  return `<h2 class="cc-h2">${esc(text)}</h2>`;
}

/** Bold subheading in body color. No emoji — keep it cross-platform. */
function H3(text) {
  return `<h3 class="cc-h3">${esc(text)}</h3>`;
}

/** Single bullet item — pair with bulletList() or drop into a manual <ul>. */
function Bullet(text) {
  return `<li>${esc(text)}</li>`;
}

/** Single green-checkmark item — pair with checkList(). */
function CheckMark(text) {
  return `<li><span class="cc-check-mark">&#10003;</span>${esc(text)}</li>`;
}

/** Bulleted list from an array of plain-text items. */
function bulletList(items) {
  return `<ul class="cc-bullets">${items.map(Bullet).join('')}</ul>`;
}

/** Checkmark list from an array of plain-text items. Use for wins/deliverables. */
function checkList(items) {
  return `<ul class="cc-checks">${items.map(CheckMark).join('')}</ul>`;
}

/** Horizontal divider. */
function divider() {
  return `<hr class="cc-divider">`;
}

// ─── Layout helpers ────────────────────────────────────────────────────────

/**
 * Card container with a colored left accent bar.
 * @param {string} html — inner HTML (already-composed markup, e.g. joined P()/bulletList() calls)
 * @param {object} opts — { accent: color name/hex, bg: color name/hex }
 */
function card(html, opts = {}) {
  const accent = accentColor(opts.accent || 'accent');
  const bg = opts.bg ? (C[opts.bg] || accentColor(opts.bg)) : C.cardBg;
  return `<div class="cc-card" style="border-left-color:${accent};background:${bg}">${html}</div>`;
}

/**
 * 2-column label/value table. Labels are shaded and typed in brand primary.
 * @param {Array<[string, string]>} rows
 */
function specTable(rows) {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td class="cc-spec-label">${esc(label)}</td><td class="cc-spec-value">${esc(value)}</td></tr>`
    )
    .join('');
  return `<table class="cc-spec-table">${body}</table>`;
}

/**
 * Documentation-style 2-column table with a brand-color header row and zebra data rows.
 * @param {string} header1
 * @param {string} header2
 * @param {Array<[string, string]>} rows
 */
function twoColTable(header1, header2, rows) {
  const head = `<tr><th>${esc(header1)}</th><th>${esc(header2)}</th></tr>`;
  const body = rows
    .map(([a, b]) => `<tr><td class="cc-col1">${esc(a)}</td><td>${esc(b)}</td></tr>`)
    .join('');
  return `<table class="cc-two-col-table"><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

/**
 * Contact card. Use as the last element of the report.
 * @param {string} question — headline, e.g. "Questions or issues?"
 */
function contactCard(question = 'Questions or issues?') {
  const inner = `
    <p class="cc-contact-q">${esc(question)}</p>
    <p class="cc-contact-line">${esc(BRAND.contact.name)} &nbsp;•&nbsp; Compound Consulting</p>
    <p class="cc-contact-line cc-contact-muted">${esc(BRAND.contact.email)} &nbsp;•&nbsp; ${esc(
    BRAND.contact.phone
  )} &nbsp;•&nbsp; ${esc(BRAND.contact.website)}</p>
  `;
  return card(inner, { accent: 'primary', bg: 'cardBg' });
}

/**
 * Wraps eyebrow + H1 + body into a <section> with an anchor id, for optional
 * nav-link targets. Purely a convenience — you can also just concatenate
 * Eyebrow()/H1()/... yourself and pass { html } to buildReport sections.
 */
function section(id, eyebrowText, h1Text, bodyHtml) {
  return {
    id,
    navLabel: h1Text,
    html: `${Eyebrow(eyebrowText)}${H1(h1Text)}${bodyHtml}`,
  };
}

// ─── CSS ───────────────────────────────────────────────────────────────────

function buildCss() {
  return `
:root {
  --cc-primary: ${C.primary};
  --cc-accent: ${C.accent};
  --cc-green: ${C.green};
  --cc-orange: ${C.orange};
  --cc-text: ${C.text};
  --cc-muted: ${C.muted};
  --cc-card-bg: ${C.cardBg};
  --cc-card-bg-2: ${C.cardBg2};
  --cc-border: ${C.border};
  --cc-label-bg: ${C.labelBg};
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  font-family: ${FONT};
  color: var(--cc-text);
  background: #fff;
  line-height: 1.6;
  font-size: 16px;
}
img { max-width: 100%; }

/* Top bar */
.cc-topbar {
  position: sticky; top: 0; z-index: 10;
  display: flex; align-items: center; gap: 10px;
  padding: 14px 32px;
  background: rgba(255,255,255,0.92);
  backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--cc-border);
}
.cc-topbar img { height: 22px; width: auto; }
.cc-topbar-word { font-weight: 800; font-size: 13px; letter-spacing: 1.5px; color: var(--cc-primary); }
.cc-topbar-title { margin-left: auto; font-size: 13px; color: var(--cc-muted); }

/* Cover / hero */
.cc-cover {
  min-height: 92vh;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  text-align: center;
  padding: 64px 24px;
  background: linear-gradient(160deg, ${C.cardBg} 0%, #ffffff 55%, ${C.cardBg2} 100%);
}
.cc-cover img.cc-logo { width: 96px; height: auto; margin-bottom: 20px; }
.cc-cover-wordmark { font-weight: 800; font-size: 15px; letter-spacing: 3px; color: var(--cc-primary); margin-bottom: 6px; }
.cc-cover-tagline { font-style: italic; color: var(--cc-muted); font-size: 14px; margin-bottom: 44px; }
.cc-cover-eyebrow { font-weight: 700; font-size: 13px; letter-spacing: 2px; color: var(--cc-accent); margin-bottom: 14px; }
.cc-cover-title { font-weight: 800; font-size: 44px; max-width: 780px; margin: 0 0 16px; color: var(--cc-text); }
.cc-cover-prepared { color: var(--cc-muted); font-size: 17px; margin-bottom: 48px; }
.cc-cover-contact-name { font-weight: 700; font-size: 14px; margin-bottom: 2px; }
.cc-cover-contact-line { color: var(--cc-muted); font-size: 13px; }

/* Content */
.cc-content { max-width: 860px; margin: 0 auto; padding: 24px 32px 80px; }
.cc-eyebrow { font-weight: 700; font-size: 12px; letter-spacing: 2px; margin: 48px 0 6px; }
.cc-content > .cc-eyebrow:first-child { margin-top: 8px; }
.cc-h1 {
  font-weight: 800; font-size: 28px; margin: 0 0 22px; padding-bottom: 14px;
  border-bottom: 3px solid var(--cc-primary);
}
.cc-h2 { font-weight: 700; font-size: 21px; color: var(--cc-primary); margin: 30px 0 10px; }
.cc-h3 { font-weight: 700; font-size: 17px; color: var(--cc-text); margin: 22px 0 8px; }
.cc-p { margin: 0 0 14px; color: var(--cc-text); }

.cc-bullets, .cc-checks { margin: 0 0 16px; padding-left: 0; list-style: none; }
.cc-bullets li { position: relative; padding-left: 20px; margin-bottom: 8px; }
.cc-bullets li::before {
  content: ''; position: absolute; left: 4px; top: 10px;
  width: 6px; height: 6px; border-radius: 50%; background: var(--cc-accent);
}
.cc-checks li { position: relative; padding-left: 26px; margin-bottom: 9px; }
.cc-check-mark { position: absolute; left: 0; color: var(--cc-green); font-weight: 700; }

.cc-divider { border: none; border-top: 1px solid var(--cc-border); margin: 32px 0; }

.cc-card {
  border-left: 4px solid var(--cc-accent);
  border-top: 1px solid var(--cc-border); border-right: 1px solid var(--cc-border); border-bottom: 1px solid var(--cc-border);
  border-radius: 6px;
  padding: 18px 22px;
  margin: 18px 0;
}
.cc-card .cc-p:last-child, .cc-card ul:last-child { margin-bottom: 0; }

.cc-spec-table, .cc-two-col-table {
  width: 100%; border-collapse: collapse; margin: 16px 0 24px;
  font-size: 14px;
}
.cc-spec-table td, .cc-two-col-table th, .cc-two-col-table td {
  border: 1px solid var(--cc-border); padding: 10px 14px; text-align: left; vertical-align: top;
}
.cc-spec-label { background: var(--cc-label-bg); color: var(--cc-primary); font-weight: 700; width: 32%; }
.cc-spec-value { color: var(--cc-text); }
.cc-two-col-table th { background: var(--cc-primary); color: #fff; font-weight: 700; }
.cc-two-col-table td.cc-col1 { font-weight: 700; }
.cc-two-col-table tbody tr:nth-child(even) td { background: var(--cc-card-bg-2); }

.cc-contact-q { font-weight: 700; color: var(--cc-primary); text-align: center; font-size: 16px; margin: 0 0 8px; }
.cc-contact-line { text-align: center; margin: 0 0 4px; font-size: 14px; }
.cc-contact-muted { color: var(--cc-muted); }

.cc-footer {
  text-align: center; padding: 28px 24px 40px; color: var(--cc-muted); font-size: 12px;
  border-top: 1px solid var(--cc-border); margin-top: 24px;
}

@media (max-width: 640px) {
  .cc-cover-title { font-size: 32px; }
  .cc-content { padding: 20px 20px 60px; }
  .cc-topbar-title { display: none; }
}

@media print {
  .cc-topbar { position: static; backdrop-filter: none; }
  .cc-cover { min-height: 100vh; page-break-after: always; }
  .cc-content { max-width: none; }
  a[href]::after { content: none !important; }
}
`;
}

// ─── Cover ─────────────────────────────────────────────────────────────────

function buildCover({ eyebrow, title, preparedFor }, logoUri) {
  return `
<section class="cc-cover">
  <img class="cc-logo" src="${logoUri}" alt="${esc(BRAND.wordmark)}">
  <div class="cc-cover-wordmark">${esc(BRAND.wordmark)}</div>
  <div class="cc-cover-tagline">${esc(BRAND.tagline)}</div>
  ${eyebrow ? `<div class="cc-cover-eyebrow">${esc(eyebrow.toUpperCase())}</div>` : ''}
  <h1 class="cc-cover-title">${esc(title)}</h1>
  ${preparedFor ? `<div class="cc-cover-prepared">Prepared for ${esc(preparedFor)}</div>` : ''}
  <div class="cc-cover-contact-name">${esc(BRAND.contact.name)}</div>
  <div class="cc-cover-contact-line">${esc(BRAND.contact.email)} &nbsp;•&nbsp; ${esc(BRAND.contact.phone)}</div>
</section>`;
}

function buildTopbar(title, logoUri) {
  return `
<div class="cc-topbar">
  <img src="${logoUri}" alt="">
  <span class="cc-topbar-word">${esc(BRAND.headerLabel)}</span>
  <span class="cc-topbar-title">${esc(title)}</span>
</div>`;
}

function buildFooter() {
  return `<div class="cc-footer">${esc(BRAND.contact.website)} &nbsp;•&nbsp; ${esc(BRAND.wordmark)}</div>`;
}

// ─── Document assembly ─────────────────────────────────────────────────────

/**
 * Build a complete branded report as a single self-contained HTML string.
 *
 * @param {object} opts
 * @param {string} opts.title              — <title> tag and topbar label
 * @param {object} [opts.cover]            — hero/cover metadata; omit to skip it
 * @param {string} [opts.cover.eyebrow]    — e.g. "STATUS REPORT"
 * @param {string} opts.cover.title        — e.g. "Q3 Review"
 * @param {string} [opts.cover.preparedFor]— e.g. "Renting Freedom LLC"
 * @param {Array}  opts.sections           — [{ id?, html }] — html is pre-composed markup
 *                                            (join Eyebrow()/H1()/P()/card()/... calls)
 * @param {boolean} [opts.topbar=true]     — show the sticky top bar
 * @returns {string} full HTML document
 */
function buildReport({ title, cover, sections, topbar = true }) {
  const logoUri = logoDataUri();
  const body = sections
    .map((s) => `<section${s.id ? ` id="${esc(s.id)}"` : ''}>${s.html}</section>`)
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="${BRAND.font.googleFontsUrl}">
<style>${buildCss()}</style>
</head>
<body>
${topbar ? buildTopbar(title, logoUri) : ''}
${cover ? buildCover(cover, logoUri) : ''}
<div class="cc-content">
${body}
</div>
${buildFooter()}
</body>
</html>`;
}

/** Convenience: build and write to disk in one call. */
function buildReportFile(opts, outPath) {
  const html = buildReport(opts);
  fs.writeFileSync(outPath, html, 'utf8');
  return outPath;
}

module.exports = {
  // Text
  P, Eyebrow, H1, H2, H3, Bullet, CheckMark, bulletList, checkList, divider,
  // Layout
  card, specTable, twoColTable, contactCard, section,
  // Document
  buildReport, buildReportFile,
  // Constants
  BRAND, COLORS: C, FONT,
};
