// THE BREAKAGE RUNNER — one implementation, so a sabotage that did not sabotage
// cannot be reported as the code passing.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS, AND IT IS NOT A CONVENIENCE
// ---------------------------------------------------------------------------
// Rule 22 says a proof is not trusted until it has been made to fail, and rule
// 27 says an assertion that cannot distinguish working from absent is not an
// assertion. The breakage harness is where those two meet, and it had the same
// defect SIX times before anyone fixed the cause rather than the instance:
//
//   067 breakage M   the replay block moved to just ABOVE the PIN check, which
//                    is where it already was. No-op. Reported GREEN.
//   068 breakage G   `select 1 where false union all select 1 from ...` still
//                    returned the real row. No-op. Reported GREEN.
//   068 breakages I, J  appended AFTER the self-verify, so the assertions ran
//                    against the unmutated file. Reported GREEN.
//   069 breakage F   a line replaced with "the check, then that same line" — a
//                    move that moved nothing. Reported GREEN.
//   069 breakage H   searched a function body for ''closed'' where the text
//                    holds 'closed'. Matched nothing. Reported GREEN.
//
// Every one was caught by re-reading the mutation by hand. Rule 28's own counsel
// is that a third instance means hunting the fourth; this is past the sixth.
//
// SO THE HARNESS REFUSES THE MUTATION, NOT THE CODE. Two mechanical checks, both
// before the verify is allowed to run:
//
//   1. THE EDIT CHANGED THE FILE. Compare the bytes. Identical means the pattern
//      matched nothing, or the replacement equalled the original, or the quoting
//      was wrong — all of which are harness failures and none of which is
//      evidence about the code.
//   2. THE EDIT LANDS BEFORE THE VERIFY. A mutation whose first changed byte
//      falls after the self-verify block has not been tested: the assertions
//      already ran against the original. This is reported separately from (1)
//      because it looks exactly like a pass.
//
// A harness cannot be trusted by the thing it is testing, and neither can a
// sabotage. See CLAUDE.md, rule 27's seventh shape.

import fs from 'node:fs';

// Where the mutated and original strings first differ, or -1 if identical.
function firstDifference(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

/**
 * Run a set of breakages against one migration file.
 *
 * @param {object}   opts
 * @param {string}   opts.src            path to the migration
 * @param {string}   opts.verifyMarker   a string that begins the self-verify
 *                                       block. A mutation must land before it.
 * @param {Array}    opts.breaks         [label, (sql) => mutatedSql][]
 * @param {Function} opts.apply          async (sql) => void; throws on refusal.
 *                                       Must roll back whatever it did.
 * @param {string[]} [opts.expectGreen]  labels (or label prefixes) that are
 *                                       SUPPOSED to stay green, each with a
 *                                       reason the caller has written down.
 */
export async function runBreakages({ src, verifyMarker, breaks, apply, expectGreen = [] }) {
  const base = fs.readFileSync(src, 'utf8').replace(/\r\n/g, '\n');
  const verifyAt = base.indexOf(verifyMarker);
  if (verifyAt < 0) {
    throw new Error(
      `HARNESS: verifyMarker not found in ${src}. Without it, a mutation landing ` +
      `after the self-verify cannot be told from one that works.`,
    );
  }

  const tally = { red: 0, green: 0, harness: 0, expected: 0 };

  for (const [label, mutate] of breaks) {
    let sql;
    try {
      sql = mutate(base);
    } catch (e) {
      console.log(`HARNESS  ${label}\n      the mutation threw: ${e.message}`);
      tally.harness++;
      continue;
    }

    // ---- check 1: did it change anything at all? -------------------------
    const diffAt = firstDifference(sql, base);
    if (diffAt < 0) {
      console.log(
        `HARNESS  ${label}\n` +
        `      THE MUTATION CHANGED NOTHING. Its pattern matched nothing, or its\n` +
        `      replacement equals the original. This is NOT the code passing — it is\n` +
        `      a sabotage that did not happen, and it would have been reported as\n` +
        `      green six times before this check existed.`,
      );
      tally.harness++;
      continue;
    }

    // ---- check 2: does it land before the verify runs? -------------------
    if (diffAt > verifyAt) {
      console.log(
        `HARNESS  ${label}\n` +
        `      THE MUTATION LANDS AFTER THE SELF-VERIFY (first change at byte ${diffAt},\n` +
        `      verify begins at ${verifyAt}). The assertions ran against the ORIGINAL\n` +
        `      file, so a green here says nothing. Inject it before the verify block.`,
      );
      tally.harness++;
      continue;
    }

    // ---- and only now is the code under test -----------------------------
    try {
      await apply(sql);
      const allowed = expectGreen.some((p) => label.startsWith(p));
      if (allowed) {
        console.log(`GREEN*   ${label}\n      expected green — the caller has recorded why`);
        tally.expected++;
      } else {
        console.log(`*** GREEN  ${label}`);
        tally.green++;
      }
    } catch (e) {
      const m = String(e.message).replace(/\s+/g, ' ').slice(0, 260);
      const kind = e.code === 'P0001' ? 'RED' : `RED(${e.code ?? '?'})`;
      console.log(`${kind}  ${label}\n      ${m}`);
      tally.red++;
    }
  }

  console.log(
    `\n${tally.red} red, ${tally.green} unexpectedly green, ` +
    `${tally.expected} green-on-purpose, ${tally.harness} HARNESS FAILURE(S), ` +
    `of ${breaks.length}`,
  );

  // A harness failure is not a test result. Exit non-zero so a run with one
  // cannot be read as a clean sheet.
  if (tally.harness > 0 || tally.green > 0) process.exitCode = 1;
  return tally;
}
