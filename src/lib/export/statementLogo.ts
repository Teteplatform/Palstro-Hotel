// THE DECODED LETTERHEAD LOGO — the type alone, deliberately in a file of its own.
//
// It used to live in lib/export/logo.ts, beside the browser decoder that
// produces it. That decoder touches `document`, `createImageBitmap` and a
// canvas, and the statement's PDF definition builder — which is now compiled
// into the SERVERLESS FUNCTION that emails a statement as well as into the
// browser bundle — only ever needed the SHAPE. A `import type` still puts the
// imported file into the TypeScript program, so a type living next to
// `document.createElement` would have dragged the DOM into a Node-only project.
//
// Hence this file: no imports, no runtime, no environment assumptions. The
// browser fills it from a canvas (lib/export/logo.ts); the email endpoint fills
// it from PNG bytes the caller decoded (api/_lib/statementLogoServer.ts). Both
// hand the same object to the same document builder.
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
