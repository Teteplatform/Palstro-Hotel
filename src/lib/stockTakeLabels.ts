// Generic UI copy for the stock take (039) — no tenant content (rule 17), and
// NOTHING HERE RESTATES A RULE THE DATABASE ENFORCES (rule 21).
//
// The distinction these strings live on: a refusal is the server's, verbatim
// (stockErrorMessage, which appends the RAISE hint). What is written here
// explains what a control DOES before it is used, and why the screen is shaped
// the way it is — which is the client's job, and stops exactly where the
// server's begins. "A count above the approval limit needs a manager PIN" is
// never written here as a threshold value; the server names its own number.

import type { StockTakeStatus } from '../types/stockTake';

// ---------------------------------------------------------------------------
// The one thing everybody asks about this screen
// ---------------------------------------------------------------------------

// Why the number they are counting against is missing. Asked on first use by
// everyone, so it is answered on the sheet rather than in training.
export const COUNT_BLIND_EXPLANATION =
  'You will not see what the system expects until the count is finished — not ' +
  'hidden on this screen, but never sent to it. A count taken with the answer ' +
  'in front of you proves nothing, because the quickest way to finish is to ' +
  'type what the system already believes, and finding out where that belief is ' +
  'wrong is the whole reason to count.';

// Rule 16 on the progress pair, and rule 20's principle: a figure must state
// the set it describes. This one covers the WHOLE COUNT — deliberately wider
// than the filter, because "how much of the store is left" is not a question
// about the category you happen to be looking at.
export const COUNT_PROGRESS_EXPLANATION =
  'Covers the whole count, not this page and not the current filter: every ' +
  'shelf on the sheet, counted or not. A shelf counts as counted the moment a ' +
  'number is saved against it — including a zero, which is a real answer.';

export const COUNT_UNCOUNTED_EXPLANATION =
  'A shelf you have not been to yet is “not counted”, and it is left completely ' +
  'alone when the count is finished — no movement, no variance. That is ' +
  'different from counting a shelf and finding it empty, which is a zero and ' +
  'writes the whole expected quantity off.';

// What starting a count commits to, said before the button rather than
// discovered afterwards.
export const COUNT_START_EXPLANATION =
  'Starting a count takes a snapshot of what this location holds right now. ' +
  'Everything you count is compared against that snapshot — so a delivery that ' +
  'arrives while you are still counting shows up as stock the count did not ' +
  'see, rather than as a difference you caused.';

export const COUNT_ONE_AT_A_TIME_EXPLANATION =
  'One count at a time per location. Two people counting the same shelves are ' +
  'measuring two different moments, and whichever finished second would post ' +
  'differences against a snapshot the first had already moved.';

export const COUNT_RESUMABLE_EXPLANATION =
  'A count is saved as you go, one shelf at a time. Close the page, hand the ' +
  'phone to the next shift, come back tomorrow — the sheet is where you left it.';

// Rule 16 on the variance total of a finished count.
export const COUNT_VARIANCE_EXPLANATION =
  'Covers every line of this count. Each difference is valued at the cost the ' +
  'stock actually moved at when the count was finished — recorded at that ' +
  'moment and never recalculated, so this figure reads the same today as it did ' +
  'the day it was approved.';

export const COUNT_VARIANCE_SIGN_EXPLANATION =
  'A negative means the shelf held less than the system thought and the ' +
  'difference has been written off; a positive means there was more than ' +
  'expected and it has been added. Both are recorded as movements in your name, ' +
  'permanently, and neither can be edited afterwards.';

// What a count does NOT do — the boundary between an adjustment and a count,
// which CLAUDE.md §9 says must never be blurred.
export const COUNT_VERSUS_ADJUSTMENT_NOTE =
  'A count says the count was wrong. A write-off says we lost it, and why. They ' +
  'are recorded as different things on purpose: blur them and the variance ' +
  'report stops meaning anything.';

// ---------------------------------------------------------------------------
// The manager PIN, on the two acts that can need one
// ---------------------------------------------------------------------------
// THESE EXIST BECAUSE THE SHARED PIN PANEL ONCE NAMED THE WRONG ACT. It was
// written for the four reversal forms and hardcoded "A manager must authorise
// this reversal", so the first time a storekeeper met it on a count sheet they
// were asked to approve a reversal of nothing. The panel takes the act as a prop
// now, and these are the count's words.
//
// NOTE WHAT THE FINISHING ONE DOES NOT SAY: it does not say a PIN is required,
// and it does not name a threshold. Whether one is needed depends on the value
// of the variance — the figure the screen is forbidden to know while the count
// is open — so the honest sentence is "may", and the server says the rest in its
// own words if it refuses (rule 21).

export const COUNT_PIN_TITLE = 'A manager may need to approve this count';

export const COUNT_PIN_LEAD =
  'A count is approved by whoever finishes it, and needs a manager’s PIN as well ' +
  'once the differences it found are worth more than this hotel’s approval limit';

export const COUNT_PIN_REASON =
  'and this screen cannot tell you whether yours is, because saying so would ' +
  'mean showing you the figure you are counting against. Leave it empty if you ' +
  'have the authority; you will be told plainly if a manager is needed.';

// Undoing a finished count is the other act, and it is not conditional: it
// always needs a manager, at any size, because it erases movements a manager
// already approved.
export const REVERSE_COUNT_PIN_TITLE = 'A manager must authorise undoing this count';

export const REVERSE_COUNT_PIN_LEAD =
  'Undoing a count always needs a PIN, whatever it is worth';

export const REVERSE_COUNT_PIN_REASON =
  'because it takes back stock movements a manager already approved, and puts ' +
  'every shelf on this count back to what the system believed before it.';

export const REVERSE_COUNT_EXPLANATION =
  'Nothing is deleted. Every movement this count posted is undone by an ' +
  'opposite movement, and both the count and its undoing stay on file with the ' +
  'names against them. Then count again — a count that was wrong is answered by ' +
  'another count, never by editing this one.';

// ---------------------------------------------------------------------------
// Status labels
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<StockTakeStatus, string> = {
  open: 'In progress',
  finished: 'Finished',
  cancelled: 'Abandoned',
  reversed: 'Reversed',
};

export function takeStatusLabel(status: StockTakeStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// Design tokens only, never a literal hex (rule 17 / §8). An abandoned count
// reads MUTED rather than alarming: it posted nothing, so it is a fact about
// the paperwork, not about the stock.
export function takeStatusTone(status: StockTakeStatus): string {
  switch (status) {
    case 'open':
      return 'bg-accent/15 text-accent';
    case 'finished':
      return 'bg-primary/10 text-primary';
    // A REVERSED count gets its own tone, distinct from an abandoned one, for
    // the same reason 038 gave a reversal its own movement type: someone
    // scanning a year of counts has to be able to tell "this one was thrown out
    // after it posted" from "this one was never finished". They are different
    // events with different consequences, and if they looked alike here the
    // status would be doing its job in the database and not on the screen.
    case 'reversed':
      return 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/30';
    default:
      return 'bg-sand text-charcoal-muted';
  }
}
