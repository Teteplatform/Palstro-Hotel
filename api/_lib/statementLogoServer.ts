import type { StatementLogo } from '../../src/lib/export/statementLogo';

// ============================================================================
// THE LETTERHEAD LOGO — THE ONE PART OF THE DOCUMENT THE CALLER SUPPLIES
// ============================================================================
//
// Everything else on the emailed statement is read from the database by
// api/_lib/statementSource.ts and cannot be influenced by the request. The logo
// is the exception, and this file is the argument for why that is acceptable —
// and the bound placed on it.
//
// ----------------------------------------------------------------------------
// WHY THE SERVER CANNOT DECODE THE STORED LOGO ITSELF
// ----------------------------------------------------------------------------
// Every image this system stores is WEBP: lib/imageProcessing re-encodes all
// three variants on upload, deliberately, because WebP is what keeps the media
// quota and the egress bill down. PDF cannot embed WebP — pdfmake (pdfkit) takes
// PNG or JPEG only. The browser gets around that with a canvas: it fetches the
// WebP, decodes it and re-encodes PNG (lib/export/logo.ts). Node has no canvas.
// Decoding WebP server-side would mean adding sharp (a ~30MB native dependency)
// or a WASM decoder to this deployment for one small image on one document.
//
// The alternative — no logo on emailed statements — was rejected: the PDF a
// guest receives would then differ from the one the desk downloads and prints,
// systematically, on every send. This build exists to make those two the same
// document.
//
// ----------------------------------------------------------------------------
// SO THE BROWSER SENDS THE DECODED PNG, AND THIS IS THE TRADE
// ----------------------------------------------------------------------------
// A caller who tampered with their own client could send a DIFFERENT PICTURE as
// the letterhead. They could not change one figure, one line, one date, the
// guest's name, the reference or the balance — all of that is re-read
// server-side. And the caller is already an authenticated staff member of that
// property who can attach any file to any email from their own mailbox, and who
// can change the property's real logo in settings. The worst case is a wrong
// picture at the top of a bill that is otherwise entirely the database's.
//
// The image is nonetheless bounded rather than trusted:
//   * it must be a real PNG (magic bytes + an IHDR chunk in the right place);
//   * its dimensions are READ FROM THE IHDR, never taken from the request, so a
//     lie about them cannot distort the page;
//   * both are capped, so an enormous image cannot blow the function's memory or
//     produce an attachment too large to deliver;
//   * anything that fails is dropped to null, and the document prints the
//     property NAME as its wordmark — exactly what the screen and the download
//     do when no logo resolves. A bad logo never fails a send.

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The browser decodes at most 420x200 (lib/export/logo.ts), which is 3x the
// widest the letterhead is ever drawn. These ceilings sit above that with room
// to spare, and well below anything that would trouble a PDF or a mailbox.
const MAX_BYTES = 1_000_000;
const MAX_DIMENSION = 2000;

export function decodeStatementLogo(base64: unknown): StatementLogo | null {
  if (typeof base64 !== 'string' || base64.length === 0) return null;
  // A base64 string is ~4/3 of the bytes it encodes; refuse the obviously
  // oversized one before spending memory decoding it.
  if (base64.length > MAX_BYTES * 1.4) return null;

  let png: Buffer;
  try {
    png = Buffer.from(base64, 'base64');
  } catch {
    return null;
  }
  if (png.length === 0 || png.length > MAX_BYTES) return null;

  const size = pngSize(png);
  if (!size) return null;

  return {
    // pdfmake takes an image only as a data URL. Rebuilt from the VALIDATED
    // bytes rather than passing the caller's string through, so whatever reaches
    // the renderer is something this function has parsed.
    dataUrl: `data:image/png;base64,${png.toString('base64')}`,
    png,
    width: size.width,
    height: size.height,
  };
}

// PNG dimensions, straight from the header. A PNG is the 8-byte signature, then
// a length-prefixed IHDR chunk whose first eight data bytes are width and height
// as big-endian uint32s — so the whole parse is fixed offsets, and a file that
// does not have them is not a PNG.
function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24) return null;
  if (!png.subarray(0, 8).equals(PNG_MAGIC)) return null;
  if (png.toString('latin1', 12, 16) !== 'IHDR') return null;

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1) return null;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) return null;
  return { width, height };
}
