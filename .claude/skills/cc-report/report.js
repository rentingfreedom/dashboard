// cc-report: reusable docx helpers in Compound Consulting brand style.
//
// Usage:
//   const R = require('.../skills/cc-report/report');
//   const c = [
//     R.Eyebrow('Section 01  •  Overview'),
//     R.H1('Overview'),
//     R.P('The system does X, Y, Z.'),
//     R.card([R.Bullet('Point one'), R.Bullet('Point two')], { accent: 'primary' }),
//   ];
//   R.buildDoc({
//     title: 'Renting Freedom — Automation System Handoff',
//     cover: { eyebrow: 'AUTOMATION SYSTEM', title: 'Handoff Guide', preparedFor: 'Renting Freedom LLC' },
//     sections: [{ children: c }],
//   }).then(buf => fs.writeFileSync('out.docx', buf));

const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType,
  BorderStyle, ShadingType, LevelFormat, Header, Footer,
  PageNumber, ImageRun, PageBreak,
} = require('docx');
const fs = require('fs');
const BRAND = require('./brand');

const C = BRAND.colors;
const FONT = BRAND.font;
const TABLE_WIDTH = BRAND.page.contentWidth;

// Resolve accent name → hex. Accepts either a color name ('primary', 'accent',
// 'green', 'orange', ...) or a raw hex string. Falls back to primary.
function accentColor(name) {
  if (!name) return C.primary;
  if (C[name]) return C[name];
  if (/^[0-9A-Fa-f]{6}$/.test(name)) return name;
  return C.primary;
}

// ─── Text helpers ──────────────────────────────────────────────────────────

/** Body paragraph. `opts`: { bold, color, size (half-pt), alignment, spacing } */
function P(text, opts = {}) {
  return new Paragraph({
    spacing: { after: 140, line: 300, ...(opts.spacing || {}) },
    ...(opts.alignment ? { alignment: opts.alignment } : {}),
    children: [new TextRun({
      text,
      bold: opts.bold,
      color: opts.color || C.text,
      size: opts.size || 22,
      font: FONT,
    })],
  });
}

/** Small-caps section marker. Sits above H1. */
function Eyebrow(text, color = 'accent') {
  return new Paragraph({
    spacing: { before: 300, after: 60 },
    children: [new TextRun({
      text: text.toUpperCase(),
      bold: true, size: 16, color: accentColor(color), font: FONT,
      characterSpacing: 40,
    })],
  });
}

/** Top-level heading with primary-color underline accent. */
function H1(text, underlineColor = 'primary') {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 400, after: 200 },
    children: [new TextRun({ text, bold: true, size: 34, color: C.text, font: FONT })],
    border: {
      bottom: { color: accentColor(underlineColor), style: BorderStyle.SINGLE, size: 12, space: 8 },
    },
  });
}

/** Brand-color subheading. */
function H2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    children: [new TextRun({ text, bold: true, size: 26, color: C.primary, font: FONT })],
  });
}

/** Bold subheading in body color. No emoji — client emoji fonts vary. */
function H3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 240, after: 100 },
    children: [new TextRun({ text, bold: true, size: 22, color: C.text, font: FONT })],
  });
}

/** Bulleted list item. Requires the numbering config from buildDoc(). */
function Bullet(text) {
  return new Paragraph({
    numbering: { reference: 'bullet-list', level: 0 },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({ text, color: C.text, size: 22, font: FONT })],
  });
}

/** Green checkmark item. Use for accomplishments, deliverables, wins. */
function CheckMark(text) {
  return new Paragraph({
    spacing: { after: 90, line: 300 },
    indent: { left: 200 },
    children: [
      new TextRun({ text: '✓  ', bold: true, color: C.green, size: 24, font: FONT }),
      new TextRun({ text, color: C.text, size: 22, font: FONT }),
    ],
  });
}

/** Empty paragraph for vertical spacing. */
function spacer(before = 200) {
  return new Paragraph({ spacing: { before }, children: [new TextRun('')] });
}

/** Force a page break. */
function pageBreak() {
  return new Paragraph({ children: [new PageBreak()] });
}

// ─── Table helpers ─────────────────────────────────────────────────────────
const noBorder = { style: BorderStyle.NONE, size: 0, color: C.white };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };
const softBorder = { style: BorderStyle.SINGLE, size: 4, color: C.border };
const softBorders = { top: softBorder, bottom: softBorder, left: softBorder, right: softBorder };

/**
 * Card container with a colored left accent bar.
 * @param {Paragraph[]} children — content to render inside the card.
 * @param {object} opts — { accent: color name/hex, bg: color name/hex }
 */
function card(children, opts = {}) {
  const accent = accentColor(opts.accent || 'accent');
  const bg = opts.bg && C[opts.bg] ? C[opts.bg] : (opts.bg || C.cardBg);

  const accentBar = new TableCell({
    width: { size: 80, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: accent, color: 'auto' },
    borders: noBorders,
    children: [new Paragraph({ children: [new TextRun('')] })],
  });
  const contentCell = new TableCell({
    width: { size: TABLE_WIDTH - 80, type: WidthType.DXA },
    shading: { type: ShadingType.CLEAR, fill: bg, color: 'auto' },
    borders: {
      top: { style: BorderStyle.SINGLE, size: 4, color: C.border },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: C.border },
      left: noBorder,
      right: { style: BorderStyle.SINGLE, size: 4, color: C.border },
    },
    margins: { top: 200, bottom: 200, left: 260, right: 200 },
    children,
  });
  return new Table({
    columnWidths: [80, TABLE_WIDTH - 80],
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    rows: [new TableRow({ children: [accentBar, contentCell] })],
    borders: {
      top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
      insideHorizontal: noBorder, insideVertical: noBorder,
    },
  });
}

/**
 * 2-column label/value table. Labels are shaded in the brand's labelBg color
 * and typed in brand primary. Values are body-color plain text.
 * @param {Array<[string, string]>} rows
 */
function specTable(rows) {
  const col1 = 2400, col2 = TABLE_WIDTH - col1;
  return new Table({
    columnWidths: [col1, col2],
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    rows: rows.map(([label, value]) => new TableRow({
      children: [
        new TableCell({
          width: { size: col1, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill: C.labelBg, color: 'auto' },
          borders: {
            top: softBorder, bottom: softBorder, left: softBorder,
            right: { style: BorderStyle.SINGLE, size: 4, color: C.border },
          },
          margins: { top: 120, bottom: 120, left: 180, right: 120 },
          children: [new Paragraph({
            children: [new TextRun({ text: label, bold: true, color: C.primary, size: 20, font: FONT })],
          })],
        }),
        new TableCell({
          width: { size: col2, type: WidthType.DXA },
          borders: softBorders,
          margins: { top: 120, bottom: 120, left: 180, right: 180 },
          children: [new Paragraph({
            children: [new TextRun({ text: value, color: C.text, size: 20, font: FONT })],
          })],
        }),
      ],
    })),
  });
}

/**
 * Documentation-style 2-column table with a brand-color header row and zebra data rows.
 * @param {string} header1
 * @param {string} header2
 * @param {Array<[string, string]>} rows
 */
function twoColTable(header1, header2, rows) {
  const col1 = 2600, col2 = TABLE_WIDTH - col1;
  const headerRow = new TableRow({
    tableHeader: true,
    children: [header1, header2].map((h, i) => new TableCell({
      width: { size: i === 0 ? col1 : col2, type: WidthType.DXA },
      shading: { type: ShadingType.CLEAR, fill: C.primary, color: 'auto' },
      borders: softBorders,
      margins: { top: 120, bottom: 120, left: 180, right: 180 },
      children: [new Paragraph({
        children: [new TextRun({ text: h, bold: true, color: C.white, size: 20, font: FONT })],
      })],
    })),
  });
  const dataRows = rows.map(([a, b], i) => new TableRow({
    children: [
      new TableCell({
        width: { size: col1, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: i % 2 ? C.cardBg2 : C.white, color: 'auto' },
        borders: softBorders,
        margins: { top: 100, bottom: 100, left: 180, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: a, bold: true, color: C.text, size: 20, font: FONT })],
        })],
      }),
      new TableCell({
        width: { size: col2, type: WidthType.DXA },
        shading: { type: ShadingType.CLEAR, fill: i % 2 ? C.cardBg2 : C.white, color: 'auto' },
        borders: softBorders,
        margins: { top: 100, bottom: 100, left: 180, right: 180 },
        children: [new Paragraph({
          children: [new TextRun({ text: b, color: C.text, size: 20, font: FONT })],
        })],
      }),
    ],
  }));
  return new Table({
    columnWidths: [col1, col2],
    width: { size: TABLE_WIDTH, type: WidthType.DXA },
    rows: [headerRow, ...dataRows],
  });
}

/**
 * Contact card. Use as the last element of the document.
 * @param {string} question — headline, e.g. "Questions or issues?"
 */
function contactCard(question = 'Questions or issues?') {
  return card([
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({ text: question, bold: true, size: 24, color: C.primary, font: FONT })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({
        text: `${BRAND.contact.name}  •  Compound Consulting`,
        size: 22, color: C.text, font: FONT,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: `${BRAND.contact.email}  •  ${BRAND.contact.phone}  •  ${BRAND.contact.website}`,
        size: 20, color: C.muted, font: FONT,
      })],
    }),
  ], { accent: 'primary', bg: 'cardBg' });
}

// ─── Cover page ────────────────────────────────────────────────────────────
function buildCoverChildren({ eyebrow, title, preparedFor }, logoBuf) {
  return [
    new Paragraph({ spacing: { before: 3200 }, children: [new TextRun('')] }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 400 },
      children: [new ImageRun({
        data: logoBuf,
        transformation: { width: 140, height: 118 },
        type: 'png',
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 60 },
      children: [new TextRun({
        text: BRAND.wordmark,
        bold: true, size: 22, color: C.primary,
        characterSpacing: 100, font: FONT,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 },
      children: [new TextRun({
        text: BRAND.tagline,
        italics: true, size: 18, color: C.muted, font: FONT,
      })],
    }),
    ...(eyebrow ? [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({
        text: eyebrow.toUpperCase(),
        bold: true, size: 20, color: C.accent,
        characterSpacing: 60, font: FONT,
      })],
    })] : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 220 },
      children: [new TextRun({
        text: title,
        bold: true, size: 60, color: C.text, font: FONT,
      })],
    }),
    ...(preparedFor ? [new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 800 },
      children: [new TextRun({
        text: `Prepared for ${preparedFor}`,
        size: 24, color: C.muted, font: FONT,
      })],
    })] : []),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 100 },
      children: [new TextRun({
        text: BRAND.contact.name,
        bold: true, size: 20, color: C.text, font: FONT,
      })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({
        text: `${BRAND.contact.email}   •   ${BRAND.contact.phone}`,
        size: 18, color: C.muted, font: FONT,
      })],
    }),
    new Paragraph({ children: [new PageBreak()] }),
  ];
}

// ─── Header / Footer ───────────────────────────────────────────────────────
function makePageHeader(title, logoBuf) {
  return new Header({
    children: [new Paragraph({
      tabStops: [{ type: 'right', position: TABLE_WIDTH }],
      children: [
        new ImageRun({
          data: logoBuf,
          transformation: { width: 24, height: 20 },
          type: 'png',
        }),
        new TextRun({ text: `   ${BRAND.headerLabel}`, bold: true, size: 18, color: C.primary, font: FONT }),
        new TextRun({ text: '\t', font: FONT }),
        new TextRun({ text: title, size: 16, color: C.muted, font: FONT }),
      ],
    })],
  });
}

function makePageFooter() {
  return new Footer({
    children: [new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [
        new TextRun({ text: BRAND.contact.website, size: 16, color: C.muted, font: FONT }),
        new TextRun({ text: '   •   ', size: 16, color: C.muted, font: FONT }),
        new TextRun({ text: 'Page ', size: 16, color: C.muted, font: FONT }),
        new TextRun({ children: [PageNumber.CURRENT], size: 16, color: C.muted, font: FONT }),
        new TextRun({ text: ' of ', size: 16, color: C.muted, font: FONT }),
        new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 16, color: C.muted, font: FONT }),
      ],
    })],
  });
}

const emptyHeader = new Header({ children: [new Paragraph({ children: [new TextRun('')] })] });
const emptyFooter = new Footer({ children: [new Paragraph({ children: [new TextRun('')] })] });

// ─── Document assembly ─────────────────────────────────────────────────────
/**
 * Build a complete branded document.
 *
 * @param {object} opts
 * @param {string} opts.title            — window/PDF title. Also shown in page header.
 * @param {object} [opts.cover]          — cover page metadata; omit to skip cover
 * @param {string} [opts.cover.eyebrow]  — e.g. "AUTOMATION SYSTEM"
 * @param {string} opts.cover.title      — e.g. "Handoff Guide"
 * @param {string} [opts.cover.preparedFor] — e.g. "Renting Freedom LLC"
 * @param {Array}  opts.sections         — [{ children: Paragraph[] }]
 * @returns {Promise<Buffer>}
 */
function buildDoc({ title, cover, sections }) {
  const logoBuf = fs.readFileSync(BRAND.logoPath);

  const docSections = [];

  if (cover) {
    docSections.push({
      properties: {
        page: {
          size: { width: BRAND.page.width, height: BRAND.page.height },
          margin: BRAND.page.coverMargins,
        },
      },
      headers: { default: emptyHeader },
      footers: { default: emptyFooter },
      children: buildCoverChildren(cover, logoBuf),
    });
  }

  // Content sections
  for (const s of sections) {
    docSections.push({
      properties: {
        page: {
          size: { width: BRAND.page.width, height: BRAND.page.height },
          margin: BRAND.page.margins,
        },
      },
      headers: { default: makePageHeader(title, logoBuf) },
      footers: { default: makePageFooter() },
      children: s.children,
    });
  }

  const doc = new Document({
    creator: 'Compound Consulting',
    title,
    numbering: {
      config: [{
        reference: 'bullet-list',
        levels: [{
          level: 0,
          format: LevelFormat.BULLET,
          text: '•',
          alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 520, hanging: 260 } } },
        }],
      }],
    },
    styles: {
      default: {
        document: { run: { font: FONT, size: 22, color: C.text } },
      },
    },
    sections: docSections,
  });

  return Packer.toBuffer(doc);
}

module.exports = {
  // Text
  P, Eyebrow, H1, H2, H3, Bullet, CheckMark, spacer, pageBreak,
  // Layout
  card, specTable, twoColTable, contactCard,
  // Document
  buildDoc,
  // Constants
  BRAND, COLORS: C, FONT, TABLE_WIDTH,
};
