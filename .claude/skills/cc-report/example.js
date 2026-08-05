// Minimal working example of the cc-report skill.
// Exercises every primary component so you can see what each one does.
// Run: node example.js  (produces example-output.docx)

const fs = require('fs');
const path = require('path');
const R = require('./report');

const {
  P, Eyebrow, H1, H2, H3, Bullet, CheckMark,
  card, specTable, twoColTable, contactCard,
  buildDoc, spacer,
} = R;

// ─── Compose the content ───────────────────────────────────────────────────
const content = [];

// Section 1 — eyebrow → H1 → body → spec table
content.push(Eyebrow('Section 01  •  Overview'));
content.push(H1('Overview'));
content.push(P('Every section starts with a small-caps eyebrow above an H1. The H1 gets a subtle colored underline that acts as a visual divider.'));

content.push(H2('Where things live'));
content.push(specTable([
  ['Docs',     'Google Drive'],
  ['Code',     'GitHub — CompoundConsultingAI'],
  ['Analytics', 'Vercel + n8n'],
]));

// Section 2 — cards, twoColTable, checkmarks
content.push(Eyebrow('Section 02  •  Structure'));
content.push(H1('Layout Components'));

content.push(H2('Cards'));
content.push(P('Use card() for callouts, grouped bullets, and roadmap sections. Pass an accent color name — primary, accent, green, orange — or a raw hex.'));
content.push(card([
  Bullet('Card with default (accent) color'),
  Bullet('Left bar sets the visual tone'),
  Bullet('Great for emphasizing important lists'),
]));

content.push(card([
  P('Cards can also contain body paragraphs, not just bullets.'),
  P('Useful for warnings, notes, or grouped guidance where a bullet list feels wrong.'),
], { accent: 'orange' }));

content.push(H2('Reference tables'));
content.push(P('twoColTable() reads like documentation — brand-color header, zebra rows.'));
content.push(twoColTable('Field', 'Description', [
  ['title',        'The document title, shown in the page header'],
  ['cover',        'Optional cover metadata. Omit for internal docs.'],
  ['sections',     'Array of content sections'],
]));

content.push(H2('Checkmark lists'));
content.push(P('CheckMark() is for accomplishments and deliverables. Reserve it for wins.'));
content.push(CheckMark('First accomplishment'));
content.push(CheckMark('Second accomplishment'));
content.push(CheckMark('Third accomplishment'));

// Section 3 — nested structure with H3 and multiple cards
content.push(Eyebrow('Section 03  •  Nested Content', 'green'));
content.push(H1('Deep Sections'));
content.push(P('H3 headings introduce subsections within a card-heavy section. Keep the hierarchy shallow — H1, H2, H3 is usually enough.'));

content.push(H3('First subsection'));
content.push(card([
  P('Content specific to this subsection.'),
], { accent: 'accent' }));

content.push(H3('Second subsection'));
content.push(card([
  P('Content specific to this subsection.'),
], { accent: 'primary' }));

// Closing contact card
content.push(spacer(600));
content.push(contactCard());

// ─── Build and write ───────────────────────────────────────────────────────
buildDoc({
  title: 'CC-Report Example',
  cover: {
    eyebrow: 'Reference',
    title: 'Example Document',
    preparedFor: 'Internal',
  },
  sections: [{ children: content }],
}).then((buf) => {
  const out = path.join(__dirname, 'example-output.docx');
  fs.writeFileSync(out, buf);
  console.log(`Wrote ${out}`);
});
