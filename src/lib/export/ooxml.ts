import { strToU8, zipSync } from 'fflate';

// ===========================================================================
// THE SHARED MACHINERY BEHIND THE .xlsx AND .docx EXPORTS.
// ===========================================================================
//
// Both formats are the same thing underneath: a ZIP archive of XML parts with a
// content-type manifest and a relationship graph (OOXML, ECMA-376). So both are
// written here, by hand, over ONE small dependency — fflate, which is a few
// kilobytes and does nothing but deflate.
//
// WHY NOT A SPREADSHEET / WORD LIBRARY. exceljs and docx are each roughly a
// megabyte, and each drags Node stream and buffer shims into a browser bundle,
// to produce a file this app needs in exactly one shape. Palstro already builds
// its own icons, its own toasts and its own pagination for the same reason: the
// dependency costs more than the code it replaces, and it is the customer — on a
// Nigerian mobile connection — who pays for the download.
//
// WHAT WE GIVE UP by hand-writing: nothing this document needs. The parts below
// are the minimum a conforming reader requires, and the generated files were
// verified by reading them back with real parsers before this shipped.

// Escape text for XML content and attribute values alike.
//
// The apostrophe and quote are escaped too, so one function is safe in both
// positions and no caller has to remember which context they are in — a guest
// name containing an apostrophe (O'Brien) is otherwise a corrupt document.
export function xmlEscape(value: string): string {
  return stripIllegalXmlChars(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// CONTROL CHARACTERS ARE DROPPED, not escaped: XML 1.0 forbids them outright
// (there is no legal escape for U+0000–U+0008), so a stray one pasted into a
// charge description would make the whole package unreadable rather than merely
// ugly. Tab, newline and carriage return are legal and survive.
//
// Written as a scan rather than a regex so the source file itself contains no
// control characters — a literal one in a source range is invisible in review
// and survives a copy-paste as something else entirely.
function stripIllegalXmlChars(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x09 || code === 0x0a || code === 0x0d || code >= 0x20) {
      out += char;
    }
  }
  return out;
}

// Every part starts with this. `standalone="yes"` is what Excel and Word both
// write themselves, and some strict readers notice its absence.
export const XML_DECLARATION =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

export function xmlPart(body: string): string {
  return XML_DECLARATION + body;
}

// The relationship namespaces, named once so a typo cannot silently produce a
// package whose parts do not point at each other.
export const RELS_NS =
  'http://schemas.openxmlformats.org/package/2006/relationships';
export const CONTENT_TYPES_NS =
  'http://schemas.openxmlformats.org/package/2006/content-types';
export const OFFICE_DOCUMENT_REL =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

export interface Relationship {
  id: string;
  type: string;
  target: string;
}

export function relationshipsPart(relationships: Relationship[]): string {
  const entries = relationships
    .map(
      (r) =>
        `<Relationship Id="${xmlEscape(r.id)}" Type="${xmlEscape(
          r.type,
        )}" Target="${xmlEscape(r.target)}"/>`,
    )
    .join('');
  return xmlPart(`<Relationships xmlns="${RELS_NS}">${entries}</Relationships>`);
}

export type OoxmlParts = Record<string, string | Uint8Array>;

// Zip the parts into a package.
//
// `mtime` is the document's own issue date rather than "now": the archive then
// depends only on the statement it was built from, so the same statement
// exported twice produces byte-identical files, and a file listing shows the
// business date the document belongs to rather than the moment somebody clicked
// (rules 8 and 12 in spirit — created_at is audit metadata, never the date on
// the document).
export function zipOoxml(parts: OoxmlParts, issueDate: string): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(parts)) {
    entries[path] = typeof content === 'string' ? strToU8(content) : content;
  }
  return zipSync(entries, { level: 6, mtime: `${issueDate}T00:00:00Z` });
}
