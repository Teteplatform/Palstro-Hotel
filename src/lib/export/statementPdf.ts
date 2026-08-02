import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import type { StatementData } from '../statement';
import type { StatementLogo } from './statementLogo';
import {
  buildStatementPdfDefinition,
  ROBOTO_FACES,
} from './statementPdfDefinition';
import { PDF_MIME } from './download';

// ===========================================================================
// THE STATEMENT AS A PDF — IN THE BROWSER.
// ===========================================================================
//
// The DOCUMENT itself (every page, every figure, every rule) is built by
// ./statementPdfDefinition, which is pure and shared. This file is only the
// browser's half: loading pdfmake's browser bundle and turning that definition
// into a Blob the tab can download or hand to a share sheet.
//
// The split exists because the email endpoint renders the SAME statement in
// Node (api/_lib/statementPdfServer.ts). Two PDF builders would be two bills;
// one definition with two thin runtime shells is one bill, printed twice.
//
// THE LIBRARY IS LAZY-LOADED. pdfmake plus its embedded fonts is by far the
// largest dependency in the app, and it is imported inside createStatementPdfBlob
// — never at module scope — so it lands in its own chunk that a user who never
// exports anything never downloads.

// Build the PDF as a Blob. The ONLY place pdfmake's browser bundle is loaded.
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
      pdfMake.addFonts({ Roboto: ROBOTO_FACES });
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
