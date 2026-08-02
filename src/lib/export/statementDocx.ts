import type { StatementData } from '../statement';
import type { StatementLogo } from './logo';
import {
  CONTENT_TYPES_NS,
  OFFICE_DOCUMENT_REL,
  relationshipsPart,
  xmlEscape,
  xmlPart,
  zipOoxml,
} from './ooxml';
import {
  STATEMENT_COLUMNS,
  statementBalanceLabel,
  statementEmptyMessage,
  statementFacts,
  statementRows,
  formatStatementAmount,
} from './statementSections';

// ===========================================================================
// THE STATEMENT AS AN EDITABLE WORD DOCUMENT (.docx).
// ===========================================================================
//
// WHY THIS FORMAT EXISTS BESIDE THE PDF: the PDF is the document as issued — it
// is what a guest is sent. This one is the document as a STARTING POINT. A desk
// that has to add a line of explanation for a company's accounts department, or
// put the statement on letterhead paper of its own, needs something they can
// type in. That means real paragraphs and a real table, not a picture of one.
//
// So the charges are a genuine Word table with five columns the recipient can
// widen, sort by eye, or paste into an email; the letterhead is text with the
// property's logo above it; the totals are rows of that same table.
//
// Written by hand over fflate (see ooxml.ts). Every figure comes from
// statementSections and therefore from assembleStatement — nothing is recomputed
// here, and the words beside the figures are the same words the screen uses.

// A4 in twentieths of a point, and the usable width between 2cm margins. Every
// column width below sums to CONTENT_TWIPS exactly: Word lays a fixed table out
// by its grid, and a grid that does not add up produces a table that spills off
// the page on one machine and not another.
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1134;
const CONTENT_TWIPS = PAGE_WIDTH - MARGIN * 2; // 9638

const COLUMN_TWIPS = [600, 1300, 1600, 4438, 1700];

// EMUs per point, for the logo's drawing extent.
const EMU_PER_POINT = 12700;
const LOGO_MAX_WIDTH_PT = 150;
const LOGO_MAX_HEIGHT_PT = 46;

const INK = '1F1F1F';
const MUTED = '5C5C5C';
const RULE = 'B0B0B0';
const HEADER_FILL = 'F2EDE4';

const LOGO_PATH = 'word/media/logo.png';
const LOGO_REL_ID = 'rId2';

export function buildStatementDocx(
  statement: StatementData,
  logo: StatementLogo | null,
): Uint8Array {
  const relationships = [
    {
      id: 'rId1',
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      target: 'styles.xml',
    },
  ];
  if (logo) {
    relationships.push({
      id: LOGO_REL_ID,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      target: 'media/logo.png',
    });
  }

  const parts: Record<string, string | Uint8Array> = {
    '[Content_Types].xml': contentTypes(logo !== null),
    '_rels/.rels': relationshipsPart([
      { id: 'rId1', type: OFFICE_DOCUMENT_REL, target: 'word/document.xml' },
    ]),
    'word/_rels/document.xml.rels': relationshipsPart(relationships),
    'word/styles.xml': styles(),
    'word/document.xml': documentPart(statement, logo),
  };
  if (logo) parts[LOGO_PATH] = logo.png;

  return zipOoxml(parts, statement.issueDate);
}

function contentTypes(hasLogo: boolean): string {
  return xmlPart(
    `<Types xmlns="${CONTENT_TYPES_NS}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      (hasLogo ? '<Default Extension="png" ContentType="image/png"/>' : '') +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
      '</Types>',
  );
}

// The document's default face and size, set once. Word substitutes a font that
// has the glyph when Calibri lacks one, so an unusual currency symbol still
// prints rather than turning into boxes.
function styles(): string {
  return xmlPart(
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:docDefaults><w:rPrDefault><w:rPr>' +
      '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>' +
      `<w:color w:val="${INK}"/><w:sz w:val="19"/><w:szCs w:val="19"/>` +
      '</w:rPr></w:rPrDefault>' +
      '<w:pPrDefault><w:pPr><w:spacing w:after="60" w:line="252" w:lineRule="auto"/></w:pPr></w:pPrDefault>' +
      '</w:docDefaults>' +
      '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
      '</w:styles>',
  );
}

// ---------------------------------------------------------------------------
// The document body
// ---------------------------------------------------------------------------

function documentPart(
  statement: StatementData,
  logo: StatementLogo | null,
): string {
  const facts = statementFacts(statement);
  const body: string[] = [];

  // --- Letterhead ---------------------------------------------------------
  if (logo) body.push(logoParagraph(logo));
  body.push(
    paragraph([run(statement.property.name, { bold: true, size: 28 })], {
      spacingAfter: 20,
    }),
  );
  if (statement.property.address) {
    body.push(
      paragraph([run(statement.property.address, { size: 16, color: MUTED })], {
        spacingAfter: 0,
      }),
    );
  }
  const contact = [statement.property.phone, statement.property.email]
    .filter(Boolean)
    .join(' · ');
  if (contact) {
    body.push(paragraph([run(contact, { size: 16, color: MUTED })]));
  }

  // --- The document's own handle -----------------------------------------
  body.push(
    paragraph(
      [run(statement.title.toUpperCase(), { bold: true, size: 30, spacing: 40 })],
      { spacingBefore: 200, spacingAfter: 60 },
    ),
  );
  for (const fact of facts.filter((f) => f.group === 'document')) {
    body.push(factParagraph(fact.label, fact.value));
  }

  // --- Who and what it is for --------------------------------------------
  body.push(paragraph([run('', {})], { spacingBefore: 120, spacingAfter: 0 }));
  for (const fact of facts.filter((f) => f.group === 'party')) {
    body.push(factParagraph(fact.label, fact.value));
  }

  // --- The itemised body --------------------------------------------------
  body.push(bodyTable(statement));
  // A table must be followed by a paragraph; Word treats a body that ends on a
  // table as damaged, and two adjacent tables merge into one.
  body.push(paragraph([], { spacingAfter: 0 }));

  // --- The balance --------------------------------------------------------
  body.push(balanceTable(statement));
  body.push(paragraph([], { spacingAfter: 0 }));

  // --- The footer ---------------------------------------------------------
  body.push(
    paragraph([run(statement.footer.thankYou, {})], { spacingBefore: 200 }),
  );
  if (statement.footer.note) {
    // The note is free text a property wrote, and its line breaks are meaningful
    // (bank details, payment terms). Each line becomes its own paragraph so Word
    // shows it the way the screen's `whitespace-pre-line` does.
    for (const line of statement.footer.note.split('\n')) {
      body.push(paragraph([run(line, { size: 16, color: MUTED })], { spacingAfter: 0 }));
    }
  }

  return xmlPart(
    '<w:document ' +
      'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
      `<w:body>${body.join('')}` +
      `<w:sectPr><w:pgSz w:w="${PAGE_WIDTH}" w:h="${PAGE_HEIGHT}"/>` +
      `<w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" ` +
      'w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>' +
      '</w:body></w:document>',
  );
}

// ---------------------------------------------------------------------------
// Paragraphs and runs
// ---------------------------------------------------------------------------

interface RunOptions {
  bold?: boolean;
  // Half-points, as WordprocessingML measures type: 19 is 9.5pt.
  size?: number;
  color?: string;
  // Letter spacing in twentieths of a point.
  spacing?: number;
}

function run(text: string, options: RunOptions): string {
  const properties =
    (options.bold ? '<w:b/>' : '') +
    (options.color ? `<w:color w:val="${options.color}"/>` : '') +
    (options.spacing ? `<w:spacing w:val="${options.spacing}"/>` : '') +
    (options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '');
  const runProperties = properties ? `<w:rPr>${properties}</w:rPr>` : '';
  return (
    `<w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`
  );
}

interface ParagraphOptions {
  align?: 'left' | 'right' | 'center';
  spacingBefore?: number;
  spacingAfter?: number;
}

function paragraph(runs: string[], options: ParagraphOptions = {}): string {
  const spacing =
    options.spacingBefore !== undefined || options.spacingAfter !== undefined
      ? `<w:spacing${
          options.spacingBefore !== undefined
            ? ` w:before="${options.spacingBefore}"`
            : ''
        }${
          options.spacingAfter !== undefined ? ` w:after="${options.spacingAfter}"` : ''
        }/>`
      : '';
  const alignment = options.align ? `<w:jc w:val="${options.align}"/>` : '';
  // Element order inside w:pPr is fixed by the schema: spacing before jc.
  const properties = spacing || alignment ? `<w:pPr>${spacing}${alignment}</w:pPr>` : '';
  return `<w:p>${properties}${runs.join('')}</w:p>`;
}

// "Booking  HH-2608-0001" — the label small and grey, the value beside it, which
// is how the screen's fact blocks read.
function factParagraph(label: string, value: string): string {
  return paragraph(
    [
      run(`${label.toUpperCase()}  `, { size: 15, color: MUTED, spacing: 12 }),
      run(value, {}),
    ],
    { spacingAfter: 20 },
  );
}

function logoParagraph(logo: StatementLogo): string {
  // Fit the decoded image inside the same box the PDF uses, preserving aspect —
  // a stretched logo is worse than none.
  const scale = Math.min(
    LOGO_MAX_WIDTH_PT / logo.width,
    LOGO_MAX_HEIGHT_PT / logo.height,
    1,
  );
  const cx = Math.max(1, Math.round(logo.width * scale * EMU_PER_POINT));
  const cy = Math.max(1, Math.round(logo.height * scale * EMU_PER_POINT));

  return (
    '<w:p><w:pPr><w:spacing w:after="80"/></w:pPr><w:r><w:drawing>' +
    '<wp:inline distT="0" distB="0" distL="0" distR="0">' +
    `<wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:effectExtent l="0" t="0" r="0" b="0"/>' +
    '<wp:docPr id="1" name="Logo"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    '<pic:pic>' +
    '<pic:nvPicPr><pic:cNvPr id="1" name="logo.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    `<pic:blipFill><a:blip r:embed="${LOGO_REL_ID}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/>' +
    `<a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic>' +
    '</wp:inline></w:drawing></w:r></w:p>'
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

interface CellOptions {
  width: number;
  span?: number;
  align?: 'left' | 'right' | 'center';
  fill?: string;
  borders?: string;
}

function cell(runs: string[], options: CellOptions): string {
  // w:tcPr element order is fixed by the schema: tcW, gridSpan, tcBorders, shd.
  const properties =
    `<w:tcW w:w="${options.width}" w:type="dxa"/>` +
    (options.span ? `<w:gridSpan w:val="${options.span}"/>` : '') +
    (options.borders ?? '') +
    (options.fill
      ? `<w:shd w:val="clear" w:color="auto" w:fill="${options.fill}"/>`
      : '');
  return (
    `<w:tc><w:tcPr>${properties}</w:tcPr>` +
    paragraph(runs, { align: options.align, spacingAfter: 0 }) +
    '</w:tc>'
  );
}

function tableRow(cells: string[], header = false): string {
  // A header row repeats when the table breaks across pages — a second page of
  // charges with no column headings is a page the reader has to scroll back
  // from.
  const properties = header ? '<w:trPr><w:tblHeader/></w:trPr>' : '';
  return `<w:tr>${properties}${cells.join('')}</w:tr>`;
}

// Horizontal hairlines only: a bill reads as rows of figures, and vertical rules
// turn it into a grid that fights the eye.
const BODY_BORDERS =
  '<w:tblBorders>' +
  `<w:top w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/>` +
  `<w:bottom w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/>` +
  `<w:insideH w:val="single" w:sz="4" w:space="0" w:color="${RULE}"/>` +
  '<w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '<w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>' +
  '</w:tblBorders>';

const BOX_BORDERS =
  '<w:tblBorders>' +
  `<w:top w:val="single" w:sz="12" w:space="0" w:color="${INK}"/>` +
  `<w:bottom w:val="single" w:sz="12" w:space="0" w:color="${INK}"/>` +
  `<w:left w:val="single" w:sz="12" w:space="0" w:color="${INK}"/>` +
  `<w:right w:val="single" w:sz="12" w:space="0" w:color="${INK}"/>` +
  '</w:tblBorders>';

function table(grid: number[], rows: string[], borders: string): string {
  const gridXml = grid.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  return (
    '<w:tbl><w:tblPr>' +
    `<w:tblW w:w="${CONTENT_TWIPS}" w:type="dxa"/>` +
    borders +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar>' +
    '<w:top w:w="60" w:type="dxa"/><w:left w:w="80" w:type="dxa"/>' +
    '<w:bottom w:w="60" w:type="dxa"/><w:right w:w="80" w:type="dxa"/>' +
    '</w:tblCellMar>' +
    `</w:tblPr><w:tblGrid>${gridXml}</w:tblGrid>${rows.join('')}</w:tbl>`
  );
}

function bodyTable(statement: StatementData): string {
  const [snW, dateW, typeW, descW, amountW] = COLUMN_TWIPS;
  const labelSpanWidth = snW + dateW + typeW + descW;

  const rows: string[] = [
    tableRow(
      STATEMENT_COLUMNS.map((label, index) =>
        cell([run(label.toUpperCase(), { bold: true, size: 15, color: MUTED, spacing: 12 })], {
          width: COLUMN_TWIPS[index],
          align: index === STATEMENT_COLUMNS.length - 1 ? 'right' : 'left',
          fill: HEADER_FILL,
        }),
      ),
      true,
    ),
  ];

  const bodyRows = statementRows(statement);
  if (bodyRows.length === 0) {
    rows.push(
      tableRow([
        cell([run(statementEmptyMessage(statement), { color: MUTED })], {
          width: CONTENT_TWIPS,
          span: 5,
          align: 'center',
        }),
      ]),
    );
  }

  for (const row of bodyRows) {
    if (row.kind === 'section') {
      rows.push(
        tableRow([
          cell([run(row.label.toUpperCase(), { bold: true, size: 15, color: MUTED, spacing: 12 })], {
            width: CONTENT_TWIPS,
            span: 5,
          }),
        ]),
      );
      continue;
    }

    if (row.kind === 'line') {
      rows.push(
        tableRow([
          cell([run(String(row.sn), { size: 16, color: MUTED })], { width: snW }),
          cell([run(row.date, { color: MUTED })], { width: dateW }),
          cell([run(row.type, {})], { width: typeW }),
          cell([run(row.description, {})], { width: descW }),
          cell([run(row.amountText, {})], { width: amountW, align: 'right' }),
        ]),
      );
      continue;
    }

    const strong = row.weight === 'strong';
    const color = row.weight === 'muted' ? MUTED : undefined;
    rows.push(
      tableRow([
        cell([run(row.label, { bold: strong, color })], {
          width: labelSpanWidth,
          span: 4,
          align: 'right',
        }),
        cell([run(row.amountText, { bold: strong, color })], {
          width: amountW,
          align: 'right',
        }),
      ]),
    );
  }

  return table(COLUMN_TWIPS, rows, BODY_BORDERS);
}

// The balance, boxed: the state in words and the MAGNITUDE beside it, exactly as
// the screen and the PDF print it.
function balanceTable(statement: StatementData): string {
  const amountWidth = 2400;
  const labelWidth = CONTENT_TWIPS - amountWidth;
  return table(
    [labelWidth, amountWidth],
    [
      tableRow([
        cell(
          [
            run(statementBalanceLabel(statement.balance.state).toUpperCase(), {
              bold: true,
              size: 22,
              spacing: 12,
            }),
          ],
          { width: labelWidth },
        ),
        cell(
          [
            run(
              formatStatementAmount(
                Math.abs(statement.balance.amount),
                statement.property.currency,
              ),
              { bold: true, size: 28 },
            ),
          ],
          { width: amountWidth, align: 'right' },
        ),
      ]),
    ],
    BOX_BORDERS,
  );
}
