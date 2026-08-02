import { bytesToBase64 } from './download';

// THE LETTERHEAD LOGO, TURNED INTO SOMETHING A DOCUMENT FORMAT WILL ACCEPT.
//
// The screen renders the logo straight from its public URL, in whatever format
// storage holds. That format is WebP (lib/imageProcessing encodes every uploaded
// variant to WebP), and NEITHER PDF NOR WORD CAN EMBED WEBP: pdfmake takes PNG
// or JPEG data URLs, and an OOXML package needs real PNG/JPEG bytes with a
// matching content type. So the browser decodes the image once and re-encodes it
// as PNG, which both formats take, and both exporters share the result.
//
// A FAILURE HERE IS NEVER AN EXPORT FAILURE. A missing logo, a dangling asset
// id, a storage object that has gone away, a CORS refusal on a proxied domain —
// each of those yields null, and the document falls back to the property NAME as
// its wordmark, exactly as the screen does when no logo resolves. A guest is far
// better served by a statement with a name at the top than by an export that
// refused to run because a picture would not load.

export interface StatementLogo {
  // For pdfmake, which accepts only a data URL for an image node.
  dataUrl: string;
  // For the Word package, which stores the raw bytes as a part.
  png: Uint8Array;
  // Pixel dimensions of the re-encoded image, needed to size the Word drawing
  // (which is specified in EMUs) without distorting the logo.
  width: number;
  height: number;
}

// The widest the letterhead logo is ever drawn is about 140pt. Decoding at 3x
// that keeps it crisp on a 300dpi print without carrying a 2000px hero into a
// document that will be emailed.
const MAX_WIDTH = 420;
const MAX_HEIGHT = 200;

// Decoded logos, keyed by URL. A desk that saves the PDF and then the Word copy
// would otherwise fetch and re-encode the same image twice; the URL is a
// content-addressed storage path, so an entry can never go stale under a
// changed logo — a different logo is a different URL.
const decoded = new Map<string, Promise<StatementLogo | null>>();

export function loadStatementLogo(
  logoUrl: string | null,
): Promise<StatementLogo | null> {
  if (!logoUrl) return Promise.resolve(null);
  const cached = decoded.get(logoUrl);
  if (cached) return cached;
  const pending = decodeLogo(logoUrl);
  decoded.set(logoUrl, pending);
  return pending;
}

async function decodeLogo(logoUrl: string): Promise<StatementLogo | null> {
  try {
    // fetch + createImageBitmap rather than an <img>: an <img> drawn to a canvas
    // taints it unless crossOrigin was set before the load, and a tainted canvas
    // throws on toBlob. Fetching the bytes ourselves makes the CORS outcome
    // explicit — it either resolves or it does not, and either way we handle it.
    const response = await fetch(logoUrl, { mode: 'cors', credentials: 'omit' });
    if (!response.ok) return null;
    const blob = await response.blob();

    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(
      1,
      MAX_WIDTH / bitmap.width,
      MAX_HEIGHT / bitmap.height,
    );
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      bitmap.close();
      return null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const png = await canvasToPng(canvas);
    if (!png) return null;

    return {
      dataUrl: `data:image/png;base64,${bytesToBase64(png)}`,
      png,
      width,
      height,
    };
  } catch {
    // Deliberately swallowed — see the header. The document prints its wordmark.
    return null;
  }
}

async function canvasToPng(canvas: HTMLCanvasElement): Promise<Uint8Array | null> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((result) => resolve(result), 'image/png');
  });
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
