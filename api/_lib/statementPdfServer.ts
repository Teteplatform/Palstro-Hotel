import { createRequire } from 'node:module';
// SIDE-EFFECT IMPORTS, AND THEY ARE LOAD-BEARING. Vercel does not bundle a Node
// function: it traces the import graph and uploads the files it finds. A package
// reached ONLY through createRequire below risks being left out of the
// deployment — and pdfmake pulls in pdfkit, linebreak and xmldoc behind it, so
// the whole chain would go missing. These two lines put both modules in the
// static graph, which the tracer cannot miss. Node's CJS cache makes the later
// require() return the very same instance, so nothing is loaded twice.
import 'pdfmake';
import 'pdfmake/build/vfs_fonts.js';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { StatementData } from '../../src/lib/statement';
import type { StatementLogo } from '../../src/lib/export/statementLogo';
import {
  buildStatementPdfDefinition,
  ROBOTO_FACES,
} from '../../src/lib/export/statementPdfDefinition';

// ============================================================================
// THE STATEMENT AS A PDF — IN NODE
// ============================================================================
//
// The counterpart of lib/export/statementPdf.ts (the browser's shell). Both are
// thin: the DOCUMENT is buildStatementPdfDefinition, imported from src/ and
// shared, so the PDF a guest receives by email is the same file the desk
// downloads — same layout, same fonts, same figures, page for page. There is no
// second document builder in this codebase and there must never be one.
//
// ----------------------------------------------------------------------------
// WHY require(), IN AN ESM FILE
// ----------------------------------------------------------------------------
// pdfmake 0.3 ships its server build as CommonJS (`main: js/index.js`) and its
// font vfs as a CommonJS script. createRequire is the supported way to load
// those from an ES module, and it keeps the interop explicit rather than leaving
// it to whatever the bundler decides `default` means this month.
//
// ----------------------------------------------------------------------------
// FONTS COME FROM THE VIRTUAL FILE SYSTEM, NOT THE DISK
// ----------------------------------------------------------------------------
// pdfmake can load .ttf files by path, and on Vercel that is a trap: the bundler
// traces `require()` calls, not font paths built at runtime, so the four Roboto
// files would very likely not be uploaded with the function and every send would
// fail with ENOENT — in production only, never locally. Requiring
// `pdfmake/build/vfs_fonts` instead makes the fonts a MODULE (base64 inside the
// bundle), which the tracer cannot miss, and it is the same vfs the browser
// registers. Both shells therefore embed byte-identical Roboto.
//
// ----------------------------------------------------------------------------
// ONE KNOWN DIFFERENCE, STATED RATHER THAN HIDDEN: THE CURRENCY SYMBOL
// ----------------------------------------------------------------------------
// lib/format's formatMoney calls Intl.NumberFormat(undefined, …) — the RUNTIME's
// default locale — so the currency's presentation follows whoever is rendering:
//
//     en-NG  -> ₦143,108.00
//     en-US / en-GB / this function -> NGN 143,108.00
//
// The VALUE is identical in every case; only the symbol differs, and the same
// split already exists between two staff members on differently-configured
// laptops. It is left alone here because the fix is a locale argument through
// every shared formatter — a change to every screen in the app, not to this
// endpoint — and because the server's default (en-US) matches the browser
// default on the machines this system actually runs on. If a desk running en-NG
// ever needs the emailed PDF to carry ₦ too, the smallest correct fix is to give
// formatMoney an explicit locale and thread the property's own through it.
//
// ----------------------------------------------------------------------------
// THE RENDERER IS SEALED
// ----------------------------------------------------------------------------
// setUrlAccessPolicy(false) and setLocalAccessPolicy(false): this renderer may
// not fetch a URL and may not read a file, ever. Everything it needs is inline —
// the fonts from the vfs, the logo as a data URL. Without these, a document
// definition that named a remote image would make the SERVER fetch it, which is
// a request-forgery primitive reachable from a signed-in staff account, and a
// local path would read the function's own filesystem.

interface PdfMakeServer {
  addFonts(fonts: Record<string, Record<string, string>>): void;
  setUrlAccessPolicy(callback: (url: string) => boolean): void;
  setLocalAccessPolicy(callback: (path: string) => boolean): void;
  virtualfs: {
    writeFileSync(filename: string, content: string, encoding: string): void;
    existsSync(filename: string): boolean;
  };
  createPdf(definition: TDocumentDefinitions): { getBuffer(): Promise<Buffer> };
}

const require = createRequire(import.meta.url);

let printer: PdfMakeServer | null = null;

// Prepared once per warm invocation: registering the fonts means decoding ~800KB
// of base64 into the virtual file system, and a warm Lambda would otherwise redo
// it on every send.
function pdfMake(): PdfMakeServer {
  if (printer) return printer;

  const instance = require('pdfmake') as PdfMakeServer;
  const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;

  // The node build has no addVirtualFileSystem (that is a browser extension), so
  // the files go in one at a time. Only the four faces the document asks for —
  // the vfs object also carries the standard-font metrics, which nothing here
  // uses.
  for (const file of Object.values(ROBOTO_FACES)) {
    const base64 = vfs[file];
    if (!base64) {
      throw new Error(`pdfmake's font bundle is missing ${file}`);
    }
    instance.virtualfs.writeFileSync(file, base64, 'base64');
  }

  instance.addFonts({ Roboto: ROBOTO_FACES });
  instance.setUrlAccessPolicy(() => false);
  instance.setLocalAccessPolicy(() => false);

  printer = instance;
  return instance;
}

export async function renderStatementPdf(
  statement: StatementData,
  logo: StatementLogo | null,
): Promise<Buffer> {
  return pdfMake().createPdf(buildStatementPdfDefinition(statement, logo)).getBuffer();
}
