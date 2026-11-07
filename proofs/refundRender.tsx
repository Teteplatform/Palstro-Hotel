import { renderToString } from 'react-dom/server';
import { ToastProvider } from '../src/components/ui/Toast';
import { RefundForm, RefundEffect } from '../src/components/admin/folio/RefundForm';
import { TakePaymentForm } from '../src/components/admin/folio/TakePaymentForm';
import { PAYMENT_ABOUT, REFUND_ABOUT } from '../src/lib/folioLabels';

// THE REFUND FORM'S RENDER PROOF (1.1h4a, and rule 22 for how it is trusted).
//
// ---------------------------------------------------------------------------
// WHAT THIS EXISTS TO CATCH, AND NONE OF IT IS A CRASH
// ---------------------------------------------------------------------------
//   1. THE CEILING LEAKING INTO THE AMOUNT FIELD. The subject line names what
//      the folio has received, because that is the most a refund can be. Put
//      that figure in the box instead and you have rule 10's defect dressed as
//      helpfulness: a number already there gets accepted without being read.
//
//   2. THE EFFECT LINE ASSERTING A DEBT THAT DOES NOT EXIST. This is the one
//      that nearly shipped. The drafted copy read "the balance goes up by X —
//      the guest owes that again", which is true above zero and FALSE below it:
//      ₦50,000 received against no charges, refund ₦20,000, and the balance
//      moves -50,000 -> -30,000. Up, and the guest owes nothing before or after.
//      A sentence right on one side of zero and wrong on the other reads
//      fluently and gets believed, so this proof drives ALL THREE sides.
//
//   3. THE PIN PANEL ABSENT, OR CONDITIONAL. Every refund needs one whatever the
//      amount — unlike the discount screen, where it is threshold-gated.
//
//   4. THE CEILING READ FROM THE WRONG TOTAL. `balance` and `payments_total`
//      differ on any folio with charges, and the fixture gives them DIFFERENT
//      values deliberately: one where they coincide cannot say which total
//      produced the figure on screen (rule 27's fourth shape, which is the
//      mistake item 10's ordering fixture actually made).
//
//   5. A REFUSAL RE-WORDED INSTEAD OF RENDERED. rule 21: the message carries the
//      rule and the hint carries the way out, verbatim.
//
//   6. AND THE PAYMENT FORM'S ⓘ STILL TEACHING THE CLOSED PATH. 067 replaced the
//      help text under the amount field but left PAYMENT_ABOUT saying "a payment
//      or a deposit goes in, a refund goes out" — the panel above the field
//      teaching the exact thing the database now refuses. Fixed here, asserted
//      here.
//
// WHY renderToString: every floating layer on this form is already proven
// elsewhere (Typeahead by pickerRender, the ⓘ by screenHeaderRender). What is
// unproven is the WORDS and the arithmetic behind them, and both are in the
// server-rendered string — which is also the harsher test, because it catches a
// value computed correctly and then never displayed.

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const strip = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const effect = (amount: number | null, balance: number) =>
  strip(renderToString(<RefundEffect amount={amount} balance={balance} currency="NGN" />));

console.log('\nPART 1 — the effect line, on BOTH SIDES OF ZERO');

{
  // ---- 067's own example: money held, refund part of it, still held --------
  // 50,000 received against NO charges -> balance -50,000. Refund 20,000 and
  // the balance rises to -30,000: the guest owed nothing before and owes
  // nothing after. THIS is the fixture the drafted sentence would have failed.
  const held = effect(20000, -50000);
  ok('1.1 a refund that leaves the hotel still holding money says so', /still\s+holding/i.test(held), held);
  ok(
    '1.2 and does NOT claim the guest owes anything',
    !/owes?\b/i.test(held),
    held,
  );
  ok('1.3 and names the RESULTING balance, not the amount refunded', held.includes('30,000'), held);
  ok(
    '1.4 and not the amount refunded as though it were the balance',
    !/\b20,000\b/.test(held),
    held,
  );

  // ---- the other side: a refund that pushes the guest into debt ------------
  // 5,000 held against 30,000 of charges -> balance +25,000 already owing.
  const owing = effect(10000, 25000);
  ok('1.5 a refund that leaves the guest owing says THAT', /owes/i.test(owing), owing);
  ok('1.6 and does not say the hotel is holding anything', !/holding/i.test(owing), owing);
  ok('1.7 naming the resulting balance', owing.includes('35,000'), owing);

  // ---- and exactly zero, which is neither sentence -------------------------
  const settled = effect(20000, -20000);
  ok('1.8 a refund that settles the account says settled', /settled/i.test(settled), settled);
  ok('1.9 and claims no debt', !/owes?\b/i.test(settled), settled);
  ok('1.10 and claims no holding', !/holding/i.test(settled), settled);

  // ---- the crossing case, which is the one the two sentences share a border
  // on: 10,000 held, refund 15,000 -> the balance crosses to +5,000 owing.
  // Shown because a direction-only sentence cannot express it at all.
  const crossing = effect(15000, -10000);
  ok('1.11 a refund that crosses zero reports the side it LANDS on', /owes/i.test(crossing), crossing);
  ok('1.12 and names the crossed figure', crossing.includes('5,000'), crossing);

  // ---- nothing typed yet is not an effect of zero -------------------------
  const blank = effect(null, -50000);
  ok('1.13 with no amount typed it states no effect at all', /type an amount/i.test(blank), blank);
  ok('1.14 and invents no figure', !/50,000|0\.00/.test(blank), blank);
}

console.log('\nPART 2 — the form: the ceiling is shown, never prefilled');

{
  // THE TWO TOTALS ARE DELIBERATELY DIFFERENT. received 30,000 and balance
  // -12,000 cannot be confused for one another, so an assertion about the
  // ceiling cannot pass on the balance (rule 27's fourth shape).
  const html = renderToString(
    <ToastProvider>
      <RefundForm
        folioId="f1"
        currency="NGN"
        received={30000}
        balance={-12000}
        propertySlug="heledon"
        onDone={() => {}}
        onCancel={() => {}}
      />
    </ToastProvider>,
  );
  const text = strip(html);

  ok('2.1 the subject names what the folio has received', text.includes('30,000'), text.slice(0, 180));
  ok(
    '2.2 and says that is the most that can be refunded',
    /most that can be refunded/i.test(text),
    text.slice(0, 200),
  );
  // THE PREFILL CHECK, against the RENDERED MARKUP rather than the text, since
  // an input's value is an attribute and is invisible to strip().
  //
  // THE FIRST VERSION OF THIS WAS DECORATION and the breakage run caught it: it
  // looked for `name="amount"`, which this codebase never renders — the house
  // primitives key controls by a useId `id`, not a name. So the regex matched
  // nothing, `undefined` satisfied the check, and PREFILLING THE FIELD WITH THE
  // CEILING PRODUCED NO RED. Rule 27 exactly, in the assertion that was supposed
  // to catch the proof's own headline defect.
  //
  // It now reads EVERY input's value attribute and requires all of them to be
  // empty, which is true of this form by design: the amount, the reference and
  // the PIN all start blank, and the method is a <select> whose choice React
  // renders as `selected` on an option rather than as a value here.
  const inputValues = [...html.matchAll(/<input\b[^>]*?\bvalue="([^"]*)"/gi)].map((m) => m[1]);
  ok(
    '2.3 every input on the form starts EMPTY',
    inputValues.every((v) => v === ''),
    `${inputValues.length} input value(s): ${JSON.stringify(inputValues)}`,
  );
  ok(
    '2.4 and the ceiling figure is in no input at all',
    !inputValues.some((v) => v.includes('30,000') || v.includes('30000')),
    JSON.stringify(inputValues),
  );
  ok('2.5 the amount field says what to type', /amount you are handing back/i.test(text), text.slice(0, 260));

  console.log('\nPART 3 — the PIN panel, always');
  ok('3.1 the shared panel renders', /manager must authorise this refund/i.test(text), text.slice(0, 300));
  ok('3.2 with the PIN input', /Manager PIN/.test(text));
  ok('3.3 and the never-stored footnote', /never stored or displayed/i.test(text));
  ok(
    '3.4 and no threshold language — it is never conditional here',
    !/threshold|above\s+₦|over\s+₦/i.test(text),
    text.slice(0, 200),
  );
  ok('3.5 it is a password input, not a visible one', /type="password"/.test(html));

  console.log('\nPART 4 — the rest of the form');
  ok('4.1 a reason is required', /Reason for the refund/i.test(text));
  ok(
    '4.2 the method says it need not match how the money came in',
    /need not match how the money came in/i.test(text),
    text.slice(0, 400),
  );
  ok('4.3 and the effect line is on screen, not behind the ⓘ', /Type an amount to see/i.test(text));
  // THE ⓘ HOLDS THE GENERAL RULE AND THE SCREEN HOLDS THIS BILL'S FIGURES
  // (rule 25). The ceiling rule reads the same on a folio you have never seen,
  // so it belongs in the panel; "this folio has received 30,000" does not.
  ok(
    '4.4 the general rule about the ceiling is in the ⓘ copy, not on the screen',
    REFUND_ABOUT.some((p) => /petty cash/i.test(p)) && !/petty cash/i.test(text),
  );
  ok(
    '4.5 and the ⓘ distinguishes refund from reversing a payment',
    REFUND_ABOUT.some((p) => /REVERSE A PAYMENT/.test(p)),
  );
}

console.log('\nPART 5 — the payment form no longer teaches the closed path');

{
  const form = strip(
    renderToString(
      <ToastProvider>
        <TakePaymentForm
          folioId="f1"
          currency="NGN"
          timezone="Africa/Lagos"
          onDone={() => {}}
          onCancel={() => {}}
        />
      </ToastProvider>,
    ),
  );
  ok('5.1 the help text does not invite a negative amount', !/negative/i.test(form), form.slice(0, 200));
  ok(
    '5.2 and PAYMENT_ABOUT no longer says a refund goes out through this box',
    !PAYMENT_ABOUT.some((p) => /a refund goes out/i.test(p)),
    PAYMENT_ABOUT.find((p) => /refund/i.test(p)) ?? '(no refund paragraph)',
  );
  ok(
    '5.3 it points at the refund action instead',
    PAYMENT_ABOUT.some((p) => /its own button/i.test(p)),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);

// ---------------------------------------------------------------------------
// WHAT WENT RED WHEN THE CODE WAS BROKEN (rule 22; rule 27's test: name the
// defect that turns each assertion red)
// ---------------------------------------------------------------------------
// Ten mutations, ten caught — and one of them caught the PROOF rather than the
// code, which is the entry worth reading first.
//
//   1. The effect line restored to the drafted "the balance goes up by X — the
//      guest owes that again". SEVEN assertions red, and the useful part is
//      WHICH: 1.1, 1.2, 1.8 and 1.9 are the side-of-zero ones. A proof with only
//      the owing fixture would have passed this sentence and shipped it.
//   2. `after = amount` instead of `balance + amount`. Seven red. The sentence
//      then names the amount refunded as though it were the resulting balance —
//      fluent, and a different number from the one the bill will show.
//   3. `after = balance - amount`, the direction inverted. FIVE red, including
//      1.11 on the crossing case: a refund that should land the guest owing
//      ₦5,000 reported the hotel holding ₦40,000.
//   4. The amount field prefilled with the ceiling. 2.3 and 2.4 red — BUT ONLY
//      AFTER THE ASSERTION WAS FIXED. Its first version looked for
//      `name="amount"`, which this codebase never renders, so it matched
//      nothing, `undefined` satisfied it, and the prefill produced NO RED. The
//      assertion meant to catch this proof's headline defect was decoration
//      (rule 27), and the breakage run is the only reason that is known.
//   5. The subject naming `balance` rather than `received`. 2.1 red — and the
//      fixture is why: 30,000 received against a -12,000 balance are different
//      numbers, so the assertion can tell which total produced the figure.
//   6. The PIN panel made conditional on an amount over ₦50,000. The build
//      failed outright, which is a red of a blunter kind and still correct:
//      there is no threshold for a refund, and the type system refused the
//      shape before the assertions could.
//   7. The ceiling rule restated on the screen as well as in the ⓘ. 4.4 red.
//      Rule 25's split: the general rule reads the same on a folio you have
//      never seen, so it belongs behind the icon.
//   8. PAYMENT_ABOUT restored to "a refund goes out". 5.2 and 5.3 red — the
//      panel above the payment field teaching the path 067 closed.
//   9. The payment help text restored to inviting a negative. 5.1 red.
//  10. The method hint changed to "Must match how the money came in." 4.2 red.
//      It cannot: record_refund takes a folio and has no original to match.
