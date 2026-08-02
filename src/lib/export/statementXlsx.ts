import type { StatementData } from '../statement';
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
} from './statementSections';

// ===========================================================================
// THE STATEMENT AS A SPREADSHEET (.xlsx).
// ===========================================================================
//
// WHAT A SPREADSHEET IS FOR, AND WHY IT IS NOT JUST A PDF IN A GRID: somebody
// asked for this format in order to CHECK it — a company settling a corporate
// booking, an auditor, a guest who wants to add the extras up themselves. So the
// one thing that matters here is that every amount cell holds a REAL NUMBER, not
// the text "₦45,000.00". A column of text that looks like money and sums to zero
// is worse than no export at all.
//
// The number carries the property's currency as a CELL FORMAT instead
// (numFmt 164, built from the currency the statement carries — never a literal,
// rule 17), so the cell displays exactly what the screen displays while still
// being a number the recipient can total.
//
// SIGNS FOLLOW THE DOCUMENT. The discount and the payments total are negative in
// this sheet because they are printed as subtractions on the bill, which means a
// reader can select the figure column and land on the balance. That sign
// convention is statementSections', not this file's.
//
// Written by hand over fflate — see ooxml.ts for why.

// The parts a minimal, conforming workbook needs. Anything Excel can infer
// (sharedStrings, calcChain, docProps, theme) is deliberately absent: every part
// present is a part that has to stay correct.
const SHEET_PATH = 'xl/worksheets/sheet1.xml';

export function buildStatementXlsx(statement: StatementData): Uint8Array {
  return zipOoxml(
    {
      '[Content_Types].xml': contentTypes(),
      '_rels/.rels': relationshipsPart([
        { id: 'rId1', type: OFFICE_DOCUMENT_REL, target: 'xl/workbook.xml' },
      ]),
      'xl/workbook.xml': workbook(),
      'xl/_rels/workbook.xml.rels': relationshipsPart([
        {
          id: 'rId1',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
          target: 'worksheets/sheet1.xml',
        },
        {
          id: 'rId2',
          type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
          target: 'styles.xml',
        },
      ]),
      'xl/styles.xml': styles(statement.property.currency),
      [SHEET_PATH]: sheet(statement),
    },
    statement.issueDate,
  );
}

// ---------------------------------------------------------------------------
// Cell styles, by index into cellXfs below. Named so the sheet builder reads as
// intent rather than as magic numbers.
// ---------------------------------------------------------------------------
const STYLE = {
  plain: 0,
  bold: 1,
  title: 2,
  muted: 3,
  money: 4,
  moneyBold: 5,
  columnHeader: 6,
} as const;

function contentTypes(): string {
  return xmlPart(
    `<Types xmlns="${CONTENT_TYPES_NS}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      `<Override PartName="/${SHEET_PATH}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  );
}

function workbook(): string {
  return xmlPart(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets><sheet name="Statement" sheetId="1" r:id="rId1"/></sheets>' +
      '</workbook>',
  );
}

// ---------------------------------------------------------------------------
// The currency cell format
// ---------------------------------------------------------------------------
// Derived from the SAME Intl formatting the screen uses, so the cell shows what
// the page shows: the symbol Intl produces for the property's currency, in the
// position Intl puts it (leading for ₦ and $, trailing for kr and zł). Two
// decimal places, always — a folio's printed lines must add up to its printed
// total, which is why lib/format has formatMoney at all.
//
// The currency code is the fallback when a runtime has no symbol for it, which
// is exactly what formatCurrency falls back to as well.
function currencyNumberFormat(currency: string): string {
  let symbol = currency;
  let symbolLeads = true;
  try {
    const parts = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).formatToParts(1234.5);
    const symbolIndex = parts.findIndex((p) => p.type === 'currency');
    const digitsIndex = parts.findIndex((p) => p.type === 'integer');
    if (symbolIndex >= 0) {
      symbol = parts[symbolIndex].value;
      symbolLeads = symbolIndex < digitsIndex;
    }
  } catch {
    // An unknown currency code: the code itself is a perfectly good prefix.
  }
  // Excel format codes quote literal text. The symbol is a tenant-configured
  // value, so any quote inside it is doubled rather than allowed to terminate
  // the literal early.
  const literal = `"${symbol.replace(/"/g, '""')}"`;
  return symbolLeads ? `${literal}#,##0.00` : `#,##0.00${literal}`;
}

function styles(currency: string): string {
  return xmlPart(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      `<numFmts count="1"><numFmt numFmtId="164" formatCode="${xmlEscape(
        currencyNumberFormat(currency),
      )}"/></numFmts>` +
      '<fonts count="4">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="14"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><sz val="9"/><color rgb="FF5C5C5C"/><name val="Calibri"/></font>' +
      '</fonts>' +
      // Excel requires these first two fills to exist, in this order, whether or
      // not anything uses them.
      '<fills count="3">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF2EDE4"/><bgColor indexed="64"/></patternFill></fill>' +
      '</fills>' +
      '<borders count="2">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left/><right/><top/><bottom style="thin"><color rgb="FFB0B0B0"/></bottom><diagonal/></border>' +
      '</borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="7">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  );
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

type Cell =
  | { kind: 'text'; value: string; style?: number }
  | { kind: 'number'; value: number; style?: number }
  | null;

function sheet(statement: StatementData): string {
  const rows: Cell[][] = [];
  const push = (cells: Cell[]) => rows.push(cells);
  const blank = () => rows.push([]);

  // --- The letterhead, as plain rows -------------------------------------
  push([{ kind: 'text', value: statement.property.name, style: STYLE.title }]);
  if (statement.property.address) {
    push([{ kind: 'text', value: statement.property.address, style: STYLE.muted }]);
  }
  const contact = [statement.property.phone, statement.property.email]
    .filter(Boolean)
    .join(' · ');
  if (contact) push([{ kind: 'text', value: contact, style: STYLE.muted }]);
  blank();
  push([{ kind: 'text', value: statement.title, style: STYLE.bold }]);

  // --- The facts, label and value, exactly as the document states them ----
  for (const fact of statementFacts(statement)) {
    push([
      { kind: 'text', value: fact.label, style: STYLE.bold },
      { kind: 'text', value: fact.value },
    ]);
  }
  blank();

  // --- The body ----------------------------------------------------------
  push(
    STATEMENT_COLUMNS.map((label) => ({
      kind: 'text' as const,
      value: label,
      style: STYLE.columnHeader,
    })),
  );

  const bodyRows = statementRows(statement);
  if (bodyRows.length === 0) {
    push([{ kind: 'text', value: statementEmptyMessage(statement), style: STYLE.muted }]);
  }

  for (const row of bodyRows) {
    if (row.kind === 'section') {
      push([{ kind: 'text', value: row.label, style: STYLE.bold }]);
      continue;
    }
    if (row.kind === 'line') {
      push([
        { kind: 'number', value: row.sn },
        { kind: 'text', value: row.date },
        { kind: 'text', value: row.type },
        { kind: 'text', value: row.description },
        { kind: 'number', value: row.amount, style: STYLE.money },
      ]);
      continue;
    }
    const strong = row.weight === 'strong';
    push([
      null,
      null,
      null,
      { kind: 'text', value: row.label, style: strong ? STYLE.bold : STYLE.plain },
      {
        kind: 'number',
        value: row.amount,
        style: strong ? STYLE.moneyBold : STYLE.money,
      },
    ]);
  }

  // --- The balance -------------------------------------------------------
  // The MAGNITUDE beside the state's own word, as the document prints it: the
  // word says the direction, and a stray minus sign on a bill reads as an error.
  blank();
  push([
    null,
    null,
    null,
    {
      kind: 'text',
      value: statementBalanceLabel(statement.balance.state),
      style: STYLE.bold,
    },
    {
      kind: 'number',
      value: Math.abs(statement.balance.amount),
      style: STYLE.moneyBold,
    },
  ]);

  // --- The footer --------------------------------------------------------
  blank();
  push([{ kind: 'text', value: statement.footer.thankYou }]);
  if (statement.footer.note) {
    // Split on newlines: a multi-line note (bank details, payment terms) reads
    // as several rows in a spreadsheet, where one cell with embedded newlines
    // would show as a single truncated line unless the reader turns wrapping on.
    for (const line of statement.footer.note.split('\n')) {
      push([{ kind: 'text', value: line, style: STYLE.muted }]);
    }
  }

  const sheetData = rows
    .map((cells, index) => rowXml(cells, index + 1))
    .join('');

  return xmlPart(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      // Widths chosen for the five body columns; the fact rows reuse the first
      // two, which is why the label column is comfortably wide.
      '<cols>' +
      '<col min="1" max="1" width="16" customWidth="1"/>' +
      '<col min="2" max="2" width="18" customWidth="1"/>' +
      '<col min="3" max="3" width="18" customWidth="1"/>' +
      '<col min="4" max="4" width="46" customWidth="1"/>' +
      '<col min="5" max="5" width="16" customWidth="1"/>' +
      '</cols>' +
      `<sheetData>${sheetData}</sheetData>` +
      '</worksheet>',
  );
}

function rowXml(cells: Cell[], rowNumber: number): string {
  const body = cells
    .map((cell, index) => cellXml(cell, columnLetter(index), rowNumber))
    .join('');
  return `<row r="${rowNumber}">${body}</row>`;
}

function cellXml(cell: Cell, column: string, rowNumber: number): string {
  if (!cell) return '';
  const reference = `${column}${rowNumber}`;
  const style = cell.style ? ` s="${cell.style}"` : '';

  if (cell.kind === 'number') {
    // Guard the impossible rather than writing "NaN" into a numeric cell, which
    // makes the whole workbook unreadable rather than merely wrong.
    if (!Number.isFinite(cell.value)) return '';
    return `<c r="${reference}"${style}><v>${cell.value}</v></c>`;
  }
  if (!cell.value) return '';
  // Inline strings rather than a shared-string table: one fewer part to keep
  // consistent, and a statement has no repetition worth pooling.
  return (
    `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">` +
    `${xmlEscape(cell.value)}</t></is></c>`
  );
}

// A..E is all this sheet needs, but the general form costs three lines and
// removes a landmine for whoever adds a sixth column.
function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}
