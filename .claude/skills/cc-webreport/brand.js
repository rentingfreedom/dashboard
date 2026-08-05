// Compound Consulting brand system — web edition.
//
// Same palette as the cc-report (docx) skill's brand.js, kept in sync by hand.
// If you change CC's brand colors, update both files.

const path = require('path');

module.exports = {
  colors: {
    primary: '#5356C7', // Compound Consulting purple/indigo (logo color)
    accent: '#4F8EF7', // Blue accent (secondary)
    green: '#22B57F', // Success / checkmarks
    orange: '#D97A1A', // Warnings / highlights
    text: '#1A1F2E', // Body copy
    muted: '#6B7590', // Secondary text, footnotes, footer
    cardBg: '#F5F7FB', // Card background
    cardBg2: '#FAFBFD', // Alternate / lighter card background
    border: '#E4E8F0', // Card and table borders
    labelBg: '#EEF1F8', // Spec-table label cell background
    white: '#FFFFFF',
  },

  // Real brand font (the docx skill substitutes Calibri because Word can't
  // depend on a webfont — a webpage doesn't have that problem).
  font: {
    family: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    googleFontsUrl:
      'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
  },

  // Logo — bundled with the skill, embedded as a data URI so reports stay
  // single-file and portable (no broken relative links when emailed/moved).
  logoPath: path.join(__dirname, 'assets', 'cc-logo.png'),

  // Brand identity used on the cover/hero and top bar
  wordmark: 'COMPOUND CONSULTING',
  tagline: 'AI systems for real estate investors',
  headerLabel: 'Compound Consulting',

  // Contact — used on the cover and closing card
  contact: {
    name: 'Andrew Merritt',
    email: 'andrew@compoundconsulting.ai',
    phone: '843-202-4172',
    website: 'compoundconsulting.ai',
  },
};
