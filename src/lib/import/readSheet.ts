import { strFromU8, unzipSync } from 'fflate';

// ===========================================================================
// READING A SPREADSHEET THE USER UPLOADED — .xlsx or .csv, in the browser.
// ===========================================================================
//
// The repo already WRITES OOXML by hand over fflate (lib/export/ooxml.ts). This
// is the other direction, and it is the same trade for the same reason: an .xlsx
// is a ZIP of XML parts, fflate already unzips, the browser already parses XML,
// and SheetJS is ~1MB of bundle that the customer downloads over a Nigerian
// mobile connection to read a five-column sheet. So: fflate + DOMParser, and no
// new dependency in package.json.
//
// WHAT WE GIVE UP by hand-reading, stated honestly:
//   * DATE CELLS come back as Excel serial numbers, not dates. Deliberate and
//     harmless here — the opening-balance sheet has no date column (the business
//     date is chosen once, on the screen, for the whole import), and inventing a
//     serial-to-date conversion nobody needs is how a subtle off-by-one gets in.
//   * FORMULAS are read as their CACHED RESULT (the <v> Excel last wrote), which
//     is exactly what the user saw on screen when they saved. A file that has
//     never been opened in a spreadsheet program has no cached results, so its
//     formula cells read blank — and blank is then reported as a per-row error
//     by the validator, never silently treated as zero.
//   * STYLES are ignored entirely. A number formatted as currency is still just
//     a number, which is all this needs.
//
// EVERYTHING IS RETURNED AS TEXT. Parsing "12.5" into a number is the
// validator's job, not the reader's — one place decides what a valid quantity
// is, and it is the place that can report a per-row error about it.

// A parsed sheet: rows of cells, already positioned by column so a missing cell
// in the middle of a row does not shift everything after it left.
export interface SheetData {
  rows: string[][];
  format: 'xlsx' | 'csv';
  // The sheet's own name, for the preview header ('Sheet1', or whatever the
  // storekeeper renamed it to).
  sheetName: string;
}

export class SheetReadError extends Error {}

const XLSX_EXTENSIONS = ['.xlsx', '.xlsm'];
const CSV_EXTENSIONS = ['.csv', '.txt'];

export function isSupportedSheetFile(name: string): boolean {
  const lower = name.toLowerCase();
  return [...XLSX_EXTENSIONS, ...CSV_EXTENSIONS].some((ext) =>
    lower.endsWith(ext),
  );
}

// Read a File the user picked. Returns the cells AND the file's own bytes, so
// the caller can hash the content for the import's idempotency namespace (the
// bytes are read once, here, rather than twice).
export async function readSheetFile(
  file: File,
): Promise<{ sheet: SheetData; bytes: Uint8Array }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const lower = file.name.toLowerCase();

  if (XLSX_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { sheet: readXlsx(bytes), bytes };
  }
  if (CSV_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { sheet: readCsv(strFromU8(bytes)), bytes };
  }
  // .xls (the old binary format) is a completely different container and is not
  // supported. Say so plainly rather than failing inside the unzip with
  // something the user cannot act on.
  throw new SheetReadError(
    `“${file.name}” is not a spreadsheet this can read. Save it as .xlsx or .csv and try again.`,
  );
}

// ---------------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------------

function readXlsx(bytes: Uint8Array): SheetData {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new SheetReadError(
      'That file could not be opened as a spreadsheet. If it came from another program, open it in Excel and save it as .xlsx.',
    );
  }

  const workbookXml = textPart(files, 'xl/workbook.xml');
  if (!workbookXml) {
    throw new SheetReadError(
      'That .xlsx file has no workbook inside it. Open it in Excel and save it again.',
    );
  }

  // Resolve THE FIRST SHEET properly rather than assuming sheet1.xml: the file
  // named sheet1.xml is not necessarily the first tab (Excel keeps the order in
  // workbook.xml and the path behind a relationship id). A user who added a
  // "Notes" tab first would otherwise have the wrong grid imported, silently.
  const workbook = parseXml(workbookXml);
  const firstSheet = workbook.getElementsByTagName('sheet')[0];
  const sheetName = firstSheet?.getAttribute('name') ?? 'Sheet1';
  const relId =
    firstSheet?.getAttribute('r:id') ??
    firstSheet?.getAttributeNS(
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'id',
    ) ??
    null;

  let sheetPath = 'xl/worksheets/sheet1.xml';
  const relsXml = textPart(files, 'xl/_rels/workbook.xml.rels');
  if (relId && relsXml) {
    const rels = parseXml(relsXml);
    for (const rel of Array.from(rels.getElementsByTagName('Relationship'))) {
      if (rel.getAttribute('Id') === relId) {
        const target = rel.getAttribute('Target') ?? '';
        sheetPath = target.startsWith('/')
          ? target.slice(1)
          : `xl/${target.replace(/^\.\//, '')}`;
        break;
      }
    }
  }

  const sheetXml =
    textPart(files, sheetPath) ??
    // Fall back to the conventional path rather than failing outright: a file
    // written by a tool with an unusual relationship graph is still readable.
    textPart(files, 'xl/worksheets/sheet1.xml');

  if (!sheetXml) {
    throw new SheetReadError(
      'That .xlsx file has no readable sheet inside it. Open it in Excel and save it again.',
    );
  }

  const shared = readSharedStrings(textPart(files, 'xl/sharedStrings.xml'));
  return { rows: readWorksheet(sheetXml, shared), format: 'xlsx', sheetName };
}

function textPart(
  files: Record<string, Uint8Array>,
  path: string,
): string | null {
  const part = files[path];
  return part ? strFromU8(part) : null;
}

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    throw new SheetReadError(
      'That spreadsheet is damaged and could not be read. Open it in Excel and save it again.',
    );
  }
  return doc;
}

// The shared-string table: xlsx pools repeated text and cells reference it by
// index. A <si> may be one <t>, or several <r> runs each with their own <t>
// (that is what a partly-bold cell looks like), so every descendant <t> is
// concatenated — reading only the first would truncate "Coca-Cola 50cl" to
// "Coca-" the moment somebody bolded part of it.
function readSharedStrings(xml: string | null): string[] {
  if (!xml) return [];
  const doc = parseXml(xml);
  return Array.from(doc.getElementsByTagName('si')).map(elementText);
}

function elementText(el: Element): string {
  return Array.from(el.getElementsByTagName('t'))
    .map((t) => t.textContent ?? '')
    .join('');
}

function readWorksheet(xml: string, shared: string[]): string[][] {
  const doc = parseXml(xml);
  const rows: string[][] = [];

  for (const row of Array.from(doc.getElementsByTagName('row'))) {
    // The row's own index, so a gap in the middle of the sheet stays a gap. A
    // sheet with a blank row 5 must not shift row 6's data up into it — the
    // preview reports errors BY ROW NUMBER, and those numbers have to match what
    // the user sees in Excel.
    const rowIndex = Number(row.getAttribute('r') ?? '0');
    const cells: string[] = [];

    for (const c of Array.from(row.getElementsByTagName('c'))) {
      const ref = c.getAttribute('r') ?? '';
      const col = columnIndex(ref);
      if (col < 0) continue;
      cells[col] = cellText(c, shared);
    }

    const target = rowIndex > 0 ? rowIndex - 1 : rows.length;
    // Fill any skipped rows with empties so indexes stay honest.
    while (rows.length < target) rows.push([]);
    rows[target] = normaliseRow(cells);
  }

  return rows;
}

function cellText(c: Element, shared: string[]): string {
  const type = c.getAttribute('t');

  if (type === 'inlineStr') {
    const is = c.getElementsByTagName('is')[0];
    return is ? elementText(is).trim() : '';
  }

  const v = c.getElementsByTagName('v')[0];
  const raw = v?.textContent ?? '';
  if (!raw) return '';

  if (type === 's') {
    const index = Number(raw);
    return (Number.isInteger(index) ? shared[index] : undefined)?.trim() ?? '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  // 'e' is an error cell (#REF!, #N/A). Returned as its text so the validator
  // reports "not a valid number" against that row rather than reading it as 0.
  return raw.trim();
}

// "BC12" -> 54. Returns -1 for a reference it cannot read, so a malformed cell
// is dropped rather than landing in column 0 on top of real data.
function columnIndex(ref: string): number {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) {
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

// A sparse array (holes where a row had no cell) becomes a dense array of
// strings, because `for (const cell of row)` over a sparse array yields
// undefined and every downstream .trim() would throw.
function normaliseRow(cells: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < cells.length; i += 1) out.push(cells[i] ?? '');
  return out;
}

// ---------------------------------------------------------------------------
// .csv
// ---------------------------------------------------------------------------

// A full RFC-4180 reader, not a `split(',')`: quoted fields hold commas
// ("Coca-Cola, 50cl"), doubled quotes are literal quotes, and a quoted field may
// contain newlines. A naive split gets all three wrong, and gets them wrong
// silently — the row count still looks right.
export function readCsv(text: string): SheetData {
  // Strip the UTF-8 BOM Excel writes: left in place it becomes part of the first
  // header cell, and a header that looks exactly like "Item" then matches
  // nothing. Written as a \uFEFF escape rather than as a literal character —
  // an invisible character in a source file is invisible in review too.
  const body = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(body);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];

    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i += 1; // a doubled quote is one literal quote
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === delimiter) {
      row.push(field.trim());
      field = '';
      continue;
    }
    if (ch === '\r') continue; // CRLF: the \n does the work
    if (ch === '\n') {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += ch;
  }

  // Whatever is left when the text ends is the last field of the last row —
  // unless the file ended with a newline, in which case there is nothing left
  // and pushing would add a phantom blank row.
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  return { rows, format: 'csv', sheetName: 'CSV' };
}

// Excel on a locale where the decimal separator is a comma writes CSV with
// SEMICOLONS. A file like that read as comma-separated collapses into one column
// and every row fails validation with a message about a missing item — which
// tells the user nothing about the real problem. Detected from the first
// non-empty line by counting candidates OUTSIDE quotes.
function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? '';
  const counts = [',', ';', '\t'].map((d) => ({
    d,
    n: countOutsideQuotes(firstLine, d),
  }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

function countOutsideQuotes(line: string, delimiter: string): number {
  let inQuotes = false;
  let n = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && ch === delimiter) n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Content fingerprint — what makes a re-upload idempotent
// ---------------------------------------------------------------------------

// A stable hash of the FILE'S OWN BYTES. This is the idempotency namespace for
// the whole import: every row's key is derived from it, so re-uploading the same
// file replays each row (the RPC returns the movement it already posted) instead
// of loading the stock twice.
//
// Keyed on CONTENT, never on a fresh batch id, and that distinction is the
// entire point — a random per-upload id would make every re-upload a new intent,
// which is precisely the double-load this protects against. (A file re-saved by
// Excel hashes differently, and that case is caught by the second guard: 036's
// unique index allows only one opening balance per item per location.)
export async function fileFingerprint(bytes: Uint8Array): Promise<string> {
  // Copied into a fresh ArrayBuffer so the digest never sees a view over a
  // buffer something else could still be writing to.
  const buffer = bytes.slice().buffer;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(digest)]
      .slice(0, 16) // 128 bits is plenty for a namespace, and keeps keys short
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  // crypto.subtle needs a secure context. Every real deployment is HTTPS (and
  // localhost counts), so this is a belt-and-braces path rather than an expected
  // one — but failing the whole import because a hash function was missing would
  // be a worse outcome than a non-cryptographic content hash, which is all this
  // needs: it is a namespace, not a signature.
  return fnvFingerprint(bytes);
}

function fnvFingerprint(bytes: Uint8Array): string {
  // Four independent FNV-1a passes with different offset bases, concatenated —
  // 128 bits of content-derived namespace.
  const offsets = [0x811c9dc5, 0x01000193, 0x7fffffff, 0x9e3779b9];
  return offsets
    .map((offset) => {
      let h = offset >>> 0;
      for (let i = 0; i < bytes.length; i += 1) {
        h ^= bytes[i];
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return h.toString(16).padStart(8, '0');
    })
    .join('');
}
