import {
  CONTENT_TYPES_NS,
  OFFICE_DOCUMENT_REL,
  relationshipsPart,
  xmlEscape,
  xmlPart,
  zipOoxml,
} from './ooxml';

// ===========================================================================
// A PLAIN COLUMNAR .xlsx — a header row and data rows, and nothing else.
// ===========================================================================
//
// statementXlsx.ts builds ONE document with a letterhead, fact rows, sections
// and a balance; that shape is the statement's, not a general one. This builds
// the other shape the app needs twice over: a table.
//
//   * the opening-balance IMPORT TEMPLATE the storekeeper types into, and
//   * the stock-on-hand EXPORT of whatever the screen is currently filtered to.
//
// One builder for both, over the same hand-rolled OOXML machinery in ooxml.ts —
// see that file for why this app writes spreadsheets by hand over fflate rather
// than shipping a megabyte of exceljs to a customer on a Nigerian mobile
// connection.
//
// THE THING THAT MATTERS, same as the statement export: every numeric cell holds
// a REAL NUMBER, never the text "₦45,000.00". A column of text that looks like
// money and sums to zero is worse than no export at all — and in the template's
// case, a quantity column the user types into must be a number column or Excel
// will happily store "12" as text and the import will read whatever it likes.

export type SheetCell =
  | { kind: 'text'; value: string }
  | { kind: 'number'; value: number; format?: 'plain' | 'money' | 'quantity' }
  | null;

// A numeric cell, or an empty one when there is no figure. THREE IDENTICAL
// PRIVATE COPIES of this lived in stockXlsx, productsXlsx and negativeStockXlsx,
// each re-parsing a value the data layer had already parsed — the defensive
// habit rule 24 exists to end. One copy, and it takes the number it is given.
//
// null (no figure) leaves the cell EMPTY rather than writing 0: a blank reads as
// "nothing recorded", while a zero is a measurement somebody took.
export function numberCell(
  value: number | null,
  format: 'money' | 'quantity',
): SheetCell {
  if (value === null) return null;
  return { kind: 'number', value, format };
}

export interface SheetColumn {
  label: string;
  // Character width, as Excel counts them.
  width: number;
}

// ONE TAB of a workbook.
export interface SheetTab {
  // Sheet tab name. Excel refuses > 31 chars and the characters below, so it is
  // sanitised rather than trusted — a tenant's location name can reach this.
  name: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  // Freeze the header row (default true). A guidance tab is read top to bottom
  // and has nothing to scroll past, so it turns this off.
  freezeHeader?: boolean;
}

export interface SheetSpec {
  sheetName: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
  // The property's own currency code, for the money cell format (rule 17 — the
  // code always arrives from the database, never a literal).
  currency: string;
  // The document's date, so the same data exported twice produces byte-identical
  // files (see zipOoxml).
  issueDate: string;
}

export interface WorkbookSpec {
  // At least one tab. THE FIRST TAB IS THE DATA — lib/import/readSheet resolves
  // the first sheet in workbook order and imports that grid, so a guidance tab
  // must never be placed ahead of the grid a user fills in.
  sheets: SheetTab[];
  currency: string;
  issueDate: string;
}

const sheetPath = (index: number) => `xl/worksheets/sheet${index + 1}.xml`;

// Style indexes into cellXfs below, named so the builder reads as intent.
const STYLE = {
  plain: 0,
  header: 1,
  money: 2,
  quantity: 3,
} as const;

// The single-tab form, which is what every EXPORT wants: one grid, no guidance.
export function buildSheetXlsx(spec: SheetSpec): Uint8Array {
  return buildWorkbookXlsx({
    sheets: [
      { name: spec.sheetName, columns: spec.columns, rows: spec.rows },
    ],
    currency: spec.currency,
    issueDate: spec.issueDate,
  });
}

// The multi-tab form, which is what the IMPORT TEMPLATE wants: the grid to fill
// in, plus a tab explaining how to fill it in. Two tabs rather than guidance
// rows above the grid, because anything sitting above the header is something a
// storekeeper can delete, overtype or push the header past — and the importer
// then has to guess. A second tab cannot be typed into by accident and is never
// read by the importer at all.
export function buildWorkbookXlsx(spec: WorkbookSpec): Uint8Array {
  const tabs = spec.sheets.length > 0 ? spec.sheets : [emptyTab()];
  const names = uniqueSheetNames(tabs.map((t) => t.name));

  const parts: Record<string, string> = {
    '[Content_Types].xml': contentTypes(tabs.length),
    '_rels/.rels': relationshipsPart([
      { id: 'rId1', type: OFFICE_DOCUMENT_REL, target: 'xl/workbook.xml' },
    ]),
    'xl/workbook.xml': workbook(names),
    'xl/_rels/workbook.xml.rels': relationshipsPart([
      ...tabs.map((_, i) => ({
        id: `rId${i + 1}`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet',
        target: `worksheets/sheet${i + 1}.xml`,
      })),
      {
        // Styles takes the id AFTER the sheets, so adding a tab cannot collide
        // with it.
        id: `rId${tabs.length + 1}`,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
        target: 'styles.xml',
      },
    ]),
    'xl/styles.xml': styles(spec.currency),
  };

  tabs.forEach((tab, i) => {
    parts[sheetPath(i)] = sheet(tab);
  });

  return zipOoxml(parts, spec.issueDate);
}

function emptyTab(): SheetTab {
  return { name: 'Sheet', columns: [], rows: [] };
}

// Excel rejects these outright in a sheet name, and silently truncates past 31
// characters. A location called "Poolside Bar / Terrace" would otherwise produce
// a workbook that will not open at all.
function sanitiseSheetName(name: string): string {
  const cleaned = name.replace(/[\\/?*[\]:]/g, ' ').trim();
  return (cleaned || 'Sheet').slice(0, 31);
}

// Excel also refuses a workbook with two tabs of the same name — and two tabs
// CAN collide after sanitising and truncating even when the inputs differed.
// Deduplicated here rather than left to the caller, since the caller is passing
// a tenant's location name and cannot know what it truncates to.
function uniqueSheetNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((raw) => {
    const base = sanitiseSheetName(raw);
    if (!used.has(base.toLowerCase())) {
      used.add(base.toLowerCase());
      return base;
    }
    for (let n = 2; ; n += 1) {
      const suffix = ` (${n})`;
      const candidate = base.slice(0, 31 - suffix.length) + suffix;
      if (!used.has(candidate.toLowerCase())) {
        used.add(candidate.toLowerCase());
        return candidate;
      }
    }
  });
}

function contentTypes(sheetCount: number): string {
  const sheets = Array.from({ length: sheetCount }, (_, i) =>
    `<Override PartName="/${sheetPath(
      i,
    )}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');

  return xmlPart(
    `<Types xmlns="${CONTENT_TYPES_NS}">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '</Types>',
  );
}

function workbook(sheetNames: string[]): string {
  const sheets = sheetNames
    .map(
      (name, i) =>
        `<sheet name="${xmlEscape(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
    )
    .join('');

  return xmlPart(
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<sheets>${sheets}</sheets>` +
      '</workbook>',
  );
}

// The currency cell format, derived from the SAME Intl formatting the screen
// uses so the cell shows what the page shows — symbol and position included.
// Identical reasoning (and identical fallback) to statementXlsx's version.
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
  const literal = `"${symbol.replace(/"/g, '""')}"`;
  return symbolLeads ? `${literal}#,##0.00` : `#,##0.00${literal}`;
}

function styles(currency: string): string {
  return xmlPart(
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="2">' +
      `<numFmt numFmtId="164" formatCode="${xmlEscape(
        currencyNumberFormat(currency),
      )}"/>` +
      // Quantities: two decimals always, up to four when the value has them, so
      // a 0.0250 kg recipe measure survives — the same four decimals the
      // numeric(14,4) columns carry (§6).
      //
      // The minimum of two is not cosmetic. The obvious format for "up to four
      // decimals, none if there are none" is `#,##0.####`, and Excel renders 200
      // under it as "200." — the decimal point in a format code is a LITERAL and
      // is printed whether or not a digit follows it. A column of "200." and
      // "48." reads as a rendering bug in a count sheet, which is precisely the
      // document somebody is checking figures against. Verified in Excel:
      // `#,##0.####` gives 200 -> "200."; `#,##0.00##` gives 200 -> "200.00",
      // 0.025 -> "0.025", 1234.5 -> "1,234.50".
      '<numFmt numFmtId="165" formatCode="#,##0.00##"/>' +
      '</numFmts>' +
      '<fonts count="2">' +
      '<font><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
      '<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/></font>' +
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
      '<cellXfs count="4">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
      '</cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
      '</styleSheet>',
  );
}

function sheet(tab: SheetTab): string {
  const header: SheetCell[] = tab.columns.map((c) => ({
    kind: 'text' as const,
    value: c.label,
  }));

  const body = [header, ...tab.rows]
    .map((cells, index) =>
      rowXml(cells, index + 1, index === 0 ? STYLE.header : undefined),
    )
    .join('');

  const cols = tab.columns
    .map(
      (c, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${c.width}" customWidth="1"/>`,
    )
    .join('');

  // Freeze the header row: a storekeeper scrolling 300 items needs to keep
  // seeing which column is which.
  const view =
    tab.freezeHeader === false
      ? '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
      : '<sheetViews><sheetView workbookViewId="0">' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
        '</sheetView></sheetViews>';

  return xmlPart(
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      view +
      (cols ? `<cols>${cols}</cols>` : '') +
      `<sheetData>${body}</sheetData>` +
      '</worksheet>',
  );
}

function rowXml(
  cells: SheetCell[],
  rowNumber: number,
  forcedStyle?: number,
): string {
  const body = cells
    .map((cell, index) =>
      cellXml(cell, columnLetter(index), rowNumber, forcedStyle),
    )
    .join('');
  return `<row r="${rowNumber}">${body}</row>`;
}

function cellXml(
  cell: SheetCell,
  column: string,
  rowNumber: number,
  forcedStyle?: number,
): string {
  if (!cell) return '';
  const reference = `${column}${rowNumber}`;

  if (cell.kind === 'number') {
    // Guard the impossible rather than writing "NaN" into a numeric cell, which
    // makes the whole workbook unreadable rather than merely wrong.
    if (!Number.isFinite(cell.value)) return '';
    const style =
      forcedStyle ??
      (cell.format === 'money'
        ? STYLE.money
        : cell.format === 'quantity'
          ? STYLE.quantity
          : STYLE.plain);
    const s = style ? ` s="${style}"` : '';
    return `<c r="${reference}"${s}><v>${cell.value}</v></c>`;
  }

  if (!cell.value) return '';
  const style = forcedStyle ?? STYLE.plain;
  const s = style ? ` s="${style}"` : '';
  // Inline strings rather than a shared-string table: one fewer part to keep
  // consistent, and neither of these documents has repetition worth pooling.
  return (
    `<c r="${reference}"${s} t="inlineStr"><is><t xml:space="preserve">` +
    `${xmlEscape(cell.value)}</t></is></c>`
  );
}

function columnLetter(index: number): string {
  let n = index;
  let letters = '';
  do {
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return letters;
}
