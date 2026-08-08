// THE SAMPLE-ROW MARKER, and nothing else.
//
// A template that ships with worked example rows IN THE GRID (see
// productTemplate.ts) creates one hazard: a user who types their items in below
// the examples and uploads the lot would create products nobody asked for. The
// marker below is how a row says "I am an example", and isSampleName is how the
// validator recognises one and skips it.
//
// WHY THIS IS ITS OWN FILE, AND WHY IT MUST STAY DEPENDENCY-FREE. Both halves
// of the job need this constant — the WRITER stamps it onto every sample row,
// and the VALIDATOR looks for it — but the two halves have very different
// bundling costs. The validator runs on every upload and belongs in the import
// screen's chunk; the writer pulls in the whole OOXML machinery and fflate and
// is only needed by somebody who actually clicks Download, which is why it is
// loaded with a dynamic import.
//
// Keeping the marker inside productTemplate.ts defeated exactly that: the
// validator's `import { isSampleName } from './productTemplate'` is a STATIC
// edge, so the bundler pulled the writer into the main chunk and the dynamic
// import became decoration (rolldown says so out loud —
// INEFFECTIVE_DYNAMIC_IMPORT). Ten lines in their own module keep the writer
// where it belongs: out of the bundle the customer downloads over a Nigerian
// mobile connection. Add nothing here that imports anything.

export const SAMPLE_PREFIX = 'SAMPLE — ';

// Matches the prefix as WRITTEN, and also the em dash typed as a hyphen or an
// en dash by a user who retyped the row. Anchored and requiring the dash, so a
// genuine product called "Sample Bottle" or "Sampler Kit" is never swallowed.
const SAMPLE_PATTERN = /^\s*sample\s*[—–-]/i;

export function isSampleName(name: string): boolean {
  return SAMPLE_PATTERN.test(name);
}
