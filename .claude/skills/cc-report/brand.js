// Compound Consulting brand system
//
// This file is the single source of truth for CC's visual identity in generated
// documents. Edit here to change the look of every doc produced by the cc-report skill.
//
// Colors are hex without the '#' — docx expects that format.

const path = require('path');

module.exports = {
  colors: {
    primary:  '5356C7',   // Compound Consulting purple/indigo (logo color)
    accent:   '4F8EF7',   // Blue accent (secondary)
    green:    '22B57F',   // Success / checkmarks
    orange:   'D97A1A',   // Warnings / highlights
    text:     '1A1F2E',   // Body copy
    muted:    '6B7590',   // Secondary text, footnotes, footer
    cardBg:   'F5F7FB',   // Card background
    cardBg2:  'FAFBFD',   // Alternate / lighter card background
    border:   'E4E8F0',   // Card and table borders
    labelBg:  'EEF1F8',   // Spec-table label cell background
    white:    'FFFFFF',
  },

  font: 'Calibri',   // Widely available on Word installs; renders close to Inter

  // Page layout (all values in DXA — 1440 = 1 inch)
  page: {
    width:  12240,   // 8.5"
    height: 15840,   // 11"
    margins: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
    coverMargins: { top: 1080, right: 1080, bottom: 1080, left: 1080 },
    // Usable content width = pageWidth - left - right = 12240 - 1440*2 = 9360
    contentWidth: 9360,
  },

  // Logo — bundled with the skill so this doesn't depend on any external resource
  logoPath: path.join(__dirname, 'assets', 'cc-logo.png'),

  // Brand identity used on cover pages and headers
  wordmark:     'COMPOUND CONSULTING',
  tagline:      'AI systems for real estate investors',
  headerLabel:  'Compound Consulting',   // Short version in per-page header

  // Contact — used on the cover page and closing card
  contact: {
    name:    'Andrew Merritt',
    email:   'andrew@compoundconsulting.ai',
    phone:   '843-202-4172',
    website: 'compoundconsulting.ai',
  },
};
