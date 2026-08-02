import type {
  Column,
  Content,
  ContentTable,
  TableCell,
  TDocumentDefinitions,
} from 'pdfmake/interfaces';
import type { StatementData } from '../statement';
import type { StatementLogo } from './logo';
import {
  STATEMENT_COLUMNS,
  statementBalanceLabel,
  statementEmptyMessage,
  statementFacts,
  statementRows,
  formatStatementAmount,
} from './statementSections';
import { PDF_MIME } from './download';

// ===========================================================================
// THE STATEMENT AS A PDF.
// ===========================================================================
//
// WHY pdfmake, AND NOT THE ALTERNATIVES
//
//   * NOT a screenshot (html2canvas and friends). A rasterised bill has no
//     selectable text, cannot be searched, prints soft, and weighs several
//     hundred kilobytes for a one-page document a guest will read on a phone.
//
//   * NOT jsPDF's built-in fonts. jsPDF's standard fourteen are WinAnsi-encoded,
//     and WinAnsi HAS NO NAIRA SIGN (U+20A6). Every figure on the first tenant's
//     statement would come out mangled — the one failure this whole build exists
//     to prevent, since the PDF would then disagree with the screen on every
//     line. pdfmake embeds Roboto, which carries ₦ (and €, £, the true minus
//     sign U+2212 and the em dash the app uses for a missing value), so the
//     figures print exactly as the screen formats them.
//
//   * NOT the browser's print-to-PDF path. It is kept — "Print statement" still
//     sits beside these exports — but it cannot produce a FILE: there is nothing
//     to hand to the share sheet, nothing to attach to a WhatsApp message, and
//     the filename is whatever the browser decides. A real generated file is the
//     thing a desk actually sends.
//
// THE LIBRARY IS LAZY-LOADED. pdfmake plus its embedded fonts is by far the
// largest dependency in the app, and it is imported inside createStatementPdfBlob
// — never at module scope — so it lands in its own chunk that a user who never
// exports anything never downloads.
//
// EVERY FIGURE COMES FROM statementSections, WHICH COMES FROM assembleStatement.
// Nothing below re-queries, re-computes or re-derives a number; the builder is
// pure and takes the assembled document plus an already-decoded logo.
//
// IT IS MONOCHROME BY DESIGN. The screen's balance box turns red when money is
// owed; this one does not, and does not need to — the WORD carries the state
// (rule: the document must survive a black-and-white photocopy), and greys are
// the only colour used so a mono laser printer produces the same document a
// colour one does.

// A4 at pdfmake's default 72dpi points, less the page margins below: the width
// available to a full-bleed rule or table.
const CONTENT_WIDTH = 515;

const INK = '#1f1f1f';
const MUTED = '#5c5c5c';
const RULE = '#b0b0b0';

export function buildStatementPdfDefinition(
  statement: StatementData,
  logo: StatementLogo | null,
): TDocumentDefinitions {
  const facts = statementFacts(statement);
  const documentFacts = facts.filter((f) => f.group === 'document');
  const partyFacts = facts.filter((f) => f.group === 'party');

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 50],
    // The PDF's own metadata, so a file sitting in a mail client or a document
    // manager identifies itself the same way its filename does.
    info: {
      title: `${statement.title} ${statement.reference}`,
      author: statement.property.name,
      subject: `${statement.title} for ${statement.guest.name}`,
    },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: INK, lineHeight: 1.15 },
    styles: {
      propertyName: { fontSize: 13, bold: true },
      title: { fontSize: 15, bold: true, characterSpacing: 2 },
      meta: { fontSize: 8, color: MUTED },
      factLabel: { fontSize: 7.5, color: MUTED, characterSpacing: 0.6 },
      factValue: { fontSize: 9 },
      tableHeader: { fontSize: 7.5, bold: true, color: MUTED, characterSpacing: 0.6 },
      section: { fontSize: 7.5, bold: true, color: MUTED, characterSpacing: 0.6 },
      figureMuted: { color: MUTED },
      figureStrong: { bold: true },
      balanceLabel: { fontSize: 10, bold: true, characterSpacing: 0.6 },
      balanceAmount: { fontSize: 14, bold: true },
      footerNote: { fontSize: 8, color: MUTED },
    },
    content: [
      letterhead(statement, logo, documentFacts),
      partyBlock(partyFacts),
      bodyTable(statement),
      balanceBlock(statement),
      footerBlock(statement),
    ],
    // A bill that runs to two pages must say so on both, and each page must
    // carry the document's number — pages get separated, and a loose second page
    // with no reference on it is unidentifiable.
    footer: (currentPage: number, pageCount: number) => ({
      margin: [40, 12, 40, 0],
      columns: [
        {
          text: `${statement.title} ${statement.reference} · ${statement.property.name}`,
          style: 'meta',
        },
        {
          text: `Page ${currentPage} of ${pageCount}`,
          style: 'meta',
          alignment: 'right',
        },
      ],
    }),
  };
}

// Build the PDF as a Blob. The ONLY place pdfmake is loaded.
export async function createStatementPdfBlob(
  statement: StatementData,
  logo: StatementLogo | null,
): Promise<Blob> {
  const pdfMake = await loadPdfMake();
  const blob = await pdfMake
    .createPdf(buildStatementPdfDefinition(statement, logo))
    .getBlob();
  // pdfmake already types its blob as application/pdf; the constant is asserted
  // here so a change on their side cannot quietly hand the share sheet a file
  // WhatsApp will not accept.
  return blob.type === PDF_MIME ? blob : new Blob([blob], { type: PDF_MIME });
}

// ---------------------------------------------------------------------------
// The blocks
// ---------------------------------------------------------------------------

function letterhead(
  statement: StatementData,
  logo: StatementLogo | null,
  documentFacts: { label: string; value: string }[],
): Content {
  const { property } = statement;

  const identity: Content[] = [];
  // The logo when one decoded, the NAME as the wordmark otherwise — exactly the
  // screen's fallback, so an unconfigured property still prints a document that
  // identifies itself and a dangling asset id never becomes a hole in the page.
  if (logo) {
    identity.push({
      image: logo.dataUrl,
      fit: [150, 46],
      margin: [0, 0, 0, 6],
    });
  }
  identity.push({ text: property.name, style: 'propertyName' });
  if (property.address) {
    identity.push({ text: property.address, style: 'meta', margin: [0, 2, 0, 0] });
  }
  const contact = [property.phone, property.email].filter(Boolean).join(' · ');
  if (contact) identity.push({ text: contact, style: 'meta' });

  const handle: Content[] = [
    { text: statement.title.toUpperCase(), style: 'title', alignment: 'right' },
  ];
  for (const fact of documentFacts) {
    handle.push({
      text: [
        { text: `${fact.label} `, style: 'meta' },
        { text: fact.value, fontSize: 8.5, bold: true },
      ],
      alignment: 'right',
      margin: [0, 2, 0, 0],
    });
  }

  return {
    // The rule under the letterhead is drawn rather than bordered so it spans
    // the full content width regardless of how tall either column ran.
    stack: [
      {
        columns: [
          { width: '*', stack: identity },
          { width: 'auto', stack: handle },
        ],
        columnGap: 16,
      },
      {
        margin: [0, 10, 0, 0],
        canvas: [
          {
            type: 'line',
            x1: 0,
            y1: 0,
            x2: CONTENT_WIDTH,
            y2: 0,
            lineWidth: 0.8,
            lineColor: RULE,
          },
        ],
      },
    ],
  };
}

// Who the document is for and what it is for, as label/value pairs laid out in
// two balanced columns so a stay's block never runs down half a page.
function partyBlock(partyFacts: { label: string; value: string }[]): Content {
  const half = Math.ceil(partyFacts.length / 2);
  const column = (facts: { label: string; value: string }[]): Column => ({
    width: '*',
    stack: facts.map((fact) => ({
      margin: [0, 0, 0, 6] as [number, number, number, number],
      stack: [
        { text: fact.label.toUpperCase(), style: 'factLabel' },
        { text: fact.value, style: 'factValue' },
      ],
    })),
  });

  return {
    margin: [0, 12, 0, 0],
    columns: [column(partyFacts.slice(0, half)), column(partyFacts.slice(half))],
    columnGap: 24,
  };
}

// The itemised body: the same five columns, the same order, the same strings as
// the screen — section headings, lines, then the figure rows.
function bodyTable(statement: StatementData): Content {
  const rows = statementRows(statement);
  const body: TableCell[][] = [
    STATEMENT_COLUMNS.map((label, index) => ({
      text: label,
      style: 'tableHeader',
      alignment: index === STATEMENT_COLUMNS.length - 1 ? 'right' : 'left',
    })),
  ];

  if (rows.length === 0) {
    body.push([
      {
        text: statementEmptyMessage(statement),
        colSpan: 5,
        alignment: 'center',
        color: MUTED,
        margin: [0, 16, 0, 16],
      },
      {},
      {},
      {},
      {},
    ]);
  }

  // Which rows get a hairline above them: the header, and every 'strong' figure
  // (the totals that a reader adds up to). Collected while the body is built so
  // the table layout can ask by index instead of re-deriving the structure.
  const ruledAbove = new Set<number>([1]);

  for (const row of rows) {
    if (row.kind === 'section') {
      body.push([
        { text: row.label.toUpperCase(), style: 'section', margin: [0, 8, 0, 2], colSpan: 5 },
        {},
        {},
        {},
        {},
      ]);
      continue;
    }

    if (row.kind === 'line') {
      body.push([
        { text: String(row.sn), color: MUTED, fontSize: 8 },
        { text: row.date, color: MUTED, noWrap: true },
        { text: row.type },
        { text: row.description },
        { text: row.amountText, alignment: 'right', noWrap: true },
      ]);
      continue;
    }

    const style =
      row.weight === 'muted'
        ? 'figureMuted'
        : row.weight === 'strong'
          ? 'figureStrong'
          : undefined;
    if (row.weight === 'strong') ruledAbove.add(body.length);
    body.push([
      { text: row.label, colSpan: 4, alignment: 'right', style, margin: [0, 2, 0, 2] },
      {},
      {},
      {},
      { text: row.amountText, alignment: 'right', style, noWrap: true, margin: [0, 2, 0, 2] },
    ]);
  }

  const table: ContentTable = {
    margin: [0, 14, 0, 0],
    table: {
      // The header repeats on every page: a second page of charges with no
      // column headings is a page a reader has to scroll back from.
      headerRows: 1,
      widths: ['auto', 'auto', 'auto', '*', 'auto'],
      body,
    },
    layout: {
      hLineWidth: (i) => (i === 1 || ruledAbove.has(i) ? 0.7 : 0),
      vLineWidth: () => 0,
      hLineColor: () => RULE,
      paddingLeft: (i) => (i === 0 ? 0 : 6),
      paddingRight: (i) => (i === 4 ? 0 : 6),
      paddingTop: () => 4,
      paddingBottom: () => 4,
    },
  };
  return table;
}

// The one thing on the page that must be unmissable. A box, the state in words,
// and the MAGNITUDE beside it — never a signed figure, because a stray minus on
// a bill reads as an error and the word already says the direction.
function balanceBlock(statement: StatementData): Content {
  const { amount, state } = statement.balance;
  return {
    margin: [0, 14, 0, 0],
    table: {
      widths: ['*', 'auto'],
      body: [
        [
          {
            text: statementBalanceLabel(state).toUpperCase(),
            style: 'balanceLabel',
            margin: [8, 8, 0, 8],
          },
          {
            text: formatStatementAmount(
              Math.abs(amount),
              statement.property.currency,
            ),
            style: 'balanceAmount',
            alignment: 'right',
            margin: [0, 6, 8, 6],
          },
        ],
      ],
    },
    layout: {
      hLineWidth: () => 1.4,
      vLineWidth: () => 1.4,
      hLineColor: () => INK,
      vLineColor: () => INK,
      paddingLeft: () => 0,
      paddingRight: () => 0,
      paddingTop: () => 0,
      paddingBottom: () => 0,
    },
  };
}

// The property's own closing line and its configured note (payment terms, bank
// details) — both from property settings, never a literal here (rule 17), and
// the note simply absent when a property has not written one.
function footerBlock(statement: StatementData): Content {
  const stack: Content[] = [
    {
      margin: [0, 12, 0, 0],
      canvas: [
        {
          type: 'line',
          x1: 0,
          y1: 0,
          x2: CONTENT_WIDTH,
          y2: 0,
          lineWidth: 0.5,
          lineColor: RULE,
        },
      ],
    },
    { text: statement.footer.thankYou, margin: [0, 8, 0, 0] },
  ];
  if (statement.footer.note) {
    stack.push({
      text: statement.footer.note,
      style: 'footerNote',
      margin: [0, 6, 0, 0],
    });
  }
  return { stack };
}

// ---------------------------------------------------------------------------
// Loading pdfmake
// ---------------------------------------------------------------------------

// The slice of pdfmake 0.3's browser API this file uses. Declared locally rather
// than leaning on the published types for the MODULE SHAPE, because pdfmake ships
// a CommonJS bundle: whether the namespace or its `.default` carries the API
// depends on the bundler's interop, and unwrapping it explicitly is the only
// form that is correct either way.
interface PdfMakeBrowser {
  addVirtualFileSystem(vfs: Record<string, string>): void;
  addFonts(fonts: Record<string, Record<string, string>>): void;
  createPdf(definition: TDocumentDefinitions): { getBlob(): Promise<Blob> };
}

// Roboto is the family pdfmake's own virtual file system ships, and the reason
// this library was chosen: it carries the currency symbols an Intl-formatted
// amount can contain. The four faces are named here because 0.3 no longer
// registers a default family for you.
const ROBOTO = {
  normal: 'Roboto-Regular.ttf',
  bold: 'Roboto-Medium.ttf',
  italics: 'Roboto-Italic.ttf',
  bolditalics: 'Roboto-MediumItalic.ttf',
};

let pdfMakePromise: Promise<PdfMakeBrowser> | null = null;

// Loaded once per session and memoised: registering the fonts means pushing
// ~800KB of base64 through the virtual file system, and doing that again on a
// second export would be pure waste.
function loadPdfMake(): Promise<PdfMakeBrowser> {
  if (!pdfMakePromise) {
    pdfMakePromise = (async () => {
      const [pdfMakeModule, vfsModule] = await Promise.all([
        import('pdfmake/build/pdfmake'),
        import('pdfmake/build/vfs_fonts'),
      ]);
      const pdfMake = unwrap<PdfMakeBrowser>(pdfMakeModule);
      const vfs = unwrap<Record<string, string>>(vfsModule);
      pdfMake.addVirtualFileSystem(vfs);
      pdfMake.addFonts({ Roboto: ROBOTO });
      return pdfMake;
    })().catch((e) => {
      // A failed load must not poison every later attempt with a rejected
      // promise the user can never retry past.
      pdfMakePromise = null;
      throw e;
    });
  }
  return pdfMakePromise;
}

function unwrap<T>(module: unknown): T {
  const candidate = module as { default?: T };
  return (candidate.default ?? module) as T;
}
