// Handing a generated file to the user, and nothing else.
//
// Every exporter builds BYTES (a Uint8Array or a Blob) and stops there, so the
// builders stay pure and testable. This is the one place that touches the DOM to
// deliver them, and the one place that knows a filename ends in ".pdf".
//
// NO localStorage, NO sessionStorage, no service worker, no server round trip: a
// statement is assembled in the tab and saved from the tab.

// MIME types, named once. Excel and Word both refuse to open a file whose type
// does not match its extension on some platforms, and a wrong string here is the
// kind of bug that only shows up on the customer's machine.
export const PDF_MIME = 'application/pdf';
export const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Save a blob under a chosen name.
//
// The object URL is revoked on the next frame rather than immediately: Safari
// cancels an in-flight download when the URL it points at is revoked in the same
// tick, and a file that silently fails to save is the worst possible outcome for
// a document somebody is about to send a guest.
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  // Kept out of the layout and out of the tab order — this element exists for
  // one synthetic click and is gone before anything can focus it.
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadBytes(
  bytes: Uint8Array,
  filename: string,
  mime: string,
): void {
  // Copied into a fresh ArrayBuffer view so the Blob never holds a reference to
  // a buffer another writer could still be using.
  downloadBlob(new Blob([bytes.slice()], { type: mime }), filename);
}

// A File (not just a Blob) for the Web Share API, which requires real File
// objects with names — the name is what WhatsApp shows on the attachment.
export function toShareFile(blob: Blob, filename: string, mime: string): File {
  return new File([blob], filename, { type: mime });
}

// Base64 for a byte array, chunked so a large image never blows the argument
// limit of String.fromCharCode. Used for the PDF's data-URL image, which is the
// only form pdfmake accepts.
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
