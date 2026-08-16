# Staff guide

How to run the front desk in this system: taking a booking, checking a guest in,
taking money, and giving them their bill.

This is the only copy of the guide. The Help page inside the admin renders this
same file, so what you read here and what you read on screen can never disagree.

**How to use it:** find your task in the list on the left (or under **Jump to a
task** on a phone), tap it, and follow the numbered steps. Every task says who
can do it and where the button is.

Where the guide says *your hotel*, it means whichever property you are signed in
to. The system runs several hotels, so it never uses one hotel's name.

---

## Who can do what

Three kinds of staff use the admin.

- **Front desk** — the day-to-day work: bookings, check-in, payments, charges,
  check-out, statements.
- **Manager** — everything the front desk does, plus approvals and reversals.
  A manager has a personal **approval PIN**.
- **Owner** — everything a manager does, plus the settings: rates, companies,
  taxes, branding.

| Task | Front desk | Manager | Owner |
| --- | --- | --- | --- |
| Create a booking | Yes | Yes | Yes |
| Check a guest in / out | Yes | Yes | Yes |
| Cancel a booking (reason required) | Yes | Yes | Yes |
| Take a payment or deposit | Yes | Yes | Yes |
| Add a charge (F&B, laundry, extras) | Yes | Yes | Yes |
| Discount **up to** the approval limit | Yes — recorded against you | Yes | Yes |
| Discount **above** the limit, or a full comp | Needs a manager's PIN | Yes — with your PIN | Yes — with your PIN |
| Void a charge or payment (reason required) | Yes | Yes | Yes |
| Reverse a payment, charge or discount | Needs a manager's PIN | Yes — with your PIN | Yes — with your PIN |
| Reverse a no-show, cancellation or check-out | Needs a manager's PIN | Yes — with your PIN | Yes — with your PIN |
| Print, email, WhatsApp or download a statement | Yes | Yes | Yes |
| Edit the guest record (name, phone, email, preference) | No | Yes | Yes |
| Set **your own** approval PIN | No | Yes | Yes |
| Room types, rates, companies, settings, site editor | No | Yes | Yes |
| Inventory items and stock locations | No | Yes | Yes |
| Record an opening balance, an adjustment or a stock take | Yes — recorded against you | Yes | Yes |
| Load opening stock from a spreadsheet | Quantities yes — recorded against you. Rows that **create new items** need an owner. | Yes | Yes |

**Two things to know about this table.**

1. **"Needs a manager's PIN" does not mean "ask a manager to log in".** The front
   desk starts the action, fills in the reason, and then hands the terminal to a
   manager to type their PIN. The approval is recorded against **the manager**,
   by name — not against the person who started it.
2. **Right now, every account that can open the admin is an owner or manager
   account.** Accounts created with the `front_desk` role can sign in but see a
   **No access** screen, because separate front-desk logins are not switched on
   yet. Until they are, ask your owner for a manager account. The "Front desk"
   column above describes the day-to-day tasks, which is what most people at the
   desk actually do.

---

## Front desk

### Signing in

**Who:** everyone. **Where:** the `/login` page of your hotel's admin.

1. Open the admin address your hotel gave you.
2. Type your **email** and **password**.
3. Press **Sign in**.

Notes:

- If the details are wrong you get one message — *That email or password is
  incorrect.* It never says which of the two was wrong, on purpose.
- If it says it could not reach the server, that is the internet, not your
  password. Check the connection and try again.
- To sign out: the button with your email on it, top right → **Sign out**.

![screenshot: the sign-in page](/help/sign-in.png)

### Finding your way around

**Where:** every screen.

- **Left sidebar** (desktop) — the menu. On a phone, tap the **☰** button at the
  top left to slide it open.
- **Sections** — *Daily*, *Revenue*, *Inventory*, *Back office*,
  *Configuration*. Tap a section heading to fold it away.
- Entries marked **SOON** are not built yet. They are shown so you can see what
  is coming; they do not open.
- **Top bar** — the property you are working in, a property switcher if you work
  at more than one, and your account menu.
- **Help** — at the bottom of the sidebar. It opens this guide.

What works today: **Bookings**, **Room types**, **Companies**, **Site editor**,
**Settings**, and the guest pages you reach from a booking.

### The bookings list

**Who:** everyone. **Where:** sidebar → **Bookings**.

This is the list of every reservation at this property, latest arrival date
first. It is also your way in to a guest: **tapping a row opens the guest, not
the booking**, because the person at the desk usually wants everything about
them, not one reservation.

**What the columns mean:**

| Column | What it tells you |
| --- | --- |
| **No.** | The booking number. It stays fixed on the left when the table scrolls sideways. |
| **Guest** | Who is staying, with the number of adults and children underneath. |
| **Room type** | The category booked — not a room number. |
| **Check-in / Check-out** | The **reserved** dates. |
| **Nights** | Nights between those two dates. |
| **Status** | Confirmed, Checked in, Checked out, Cancelled, No-show, Enquiry. |
| **Company / Walk-in** | The company being billed, or *Walk-in* if the guest pays. |
| **Total** | What the room comes to at the rates locked when the booking was made. |
| **Balance** | **What is still owed right now.** Red means the guest owes money. Green means nothing is owed. A green figure marked *refund due* means the hotel is holding their money. A dash means the balance could not be read — tell someone, do not treat it as zero. |

**To find a booking:**

1. Type into the box under **No.** or under **Guest**. The list refreshes when
   you stop typing.
2. Use the dropdown under **Status**, **Room type** or **Company** to narrow it.
3. For arrivals in a date range, press **Arrival date range** above the table,
   pick *Arriving from* and *Arriving to*, then **Done**.
4. **Clear all filters** removes everything at once.

Notes:

- The figures in the summary strip above the table cover **everything that
  matches your filters**, not just the page you are looking at. The ⓘ note beside
  them says exactly what is counted.
- Paging controls sit under the table: first, previous, next, last, a page
  number you can type into, and how many rows to show.

![screenshot: the bookings list with the header filters](/help/bookings-list.png)

### Taking a new booking

**Who:** everyone. **Where:** **Bookings** → **New booking** (top right).

The page is three numbered steps, top to bottom. The price updates as you go and
is always on screen — in the panel on the right on a computer, in the bar at the
bottom on a phone.

1. **Dates.** Pick **Check-in**, then **Check-out**. Check-out is pushed to the
   day after check-in if you set a later check-in. You cannot pick a check-in in
   the past.
2. **Expected arrival time** (optional). If the guest says "I land at 10pm", put
   `22:00` here. It is a note for the desk only — it changes nothing about the
   price, the room, or no-shows.
3. **Room type.** The table lists each type with how many are free for those
   dates and what a night costs. Tap one to choose it; the table folds up.
   A type with no availability cannot be chosen.
4. **Bill to.** Leave it on *Walk-in — bill the guest*, or pick a company. Picking
   a company switches to that company's negotiated rate **and** bills the folio
   to the company. The quote updates immediately.
5. **Guest.** Search **by name or phone**. If they have stayed before, pick them
   from the results — do not create a second record for the same person, or
   their history and what they owe end up split in two. If they are new, add
   them: **first and last name are required**; middle name, phone, email and
   their ID (type, number, expiry) are taken if you have them.
6. **Adults** and **Children.** The maximum for the chosen room type is shown
   under each box.
7. **Special requests** (optional) — cot, late arrival, dietary notes.
8. Check the **Quote**, then press **Create booking**.

Notes:

- If the button is grey, the line under it says what is still missing.
- If somebody books that last room while you are typing, you get *That room type
  is no longer available…* and availability is re-counted. Nothing is created
  twice — pressing the button twice cannot make two bookings.
- If you leave the page part-way through, your draft is kept until you sign out
  or refresh. **Discard draft** throws it away deliberately.
- After creating, you land on the booking itself, ready to take a deposit.

![screenshot: the new booking page](/help/new-booking.png)

### The guest home

**Who:** everyone. **Where:** tap any row in the **Bookings** list.

Everything about one person, in one place.

**The profile band** (top): their name, phone, email and ID, and a **★
preference** pill. Tap **+ Add preference** to record something the hotel should
remember — *top floor*, *quiet room*, *early breakfast*. Nothing reads it
automatically; it is there so the next receptionist knows. Editing the guest's
name, phone, email or preference is a manager/owner action.

**The Summary strip** — six figures covering this guest's **whole account at this
property**, not just the stays on screen:

| Figure | Meaning |
| --- | --- |
| **With us since** | The date of their first stay. |
| **Stays** | How many stays they have. |
| **Nights** | Nights actually billed. A stay that has not arrived yet counts its reserved nights. |
| **Charged** | Everything billed to them, including tax. |
| **Paid** | Everything they have paid, less any refunds. |
| **Outstanding** | What they still owe (red). If the hotel is holding their money it says **Credit held** instead, in green. |

The ⓘ **How this is calculated** note beside the heading spells out what is in
each figure.

**The Stays table** — one row per stay: dates, room, nights, status, charged,
paid and balance. On a phone the middle columns fold underneath the dates.
Tapping the dates opens that stay's full bill.

**The kebab (⋮) on the left of each row** — everything you can do to that stay:

| Menu item | What it does |
| --- | --- |
| **Make payment** | Take money against this stay. |
| **Add charge** | Post an extra (food, laundry, internet…). |
| **Open full bill** | The internal working bill, with the void trail and the per-line tools. |
| **Statement** | The clean printable bill you hand or send to the guest. |
| **Statement PDF** | Downloads that document straight away. |
| **Send on WhatsApp** | Shares a summary of it. |
| **Email statement** | Opens the send dialog (see *The statement*). |
| **Check in** | Only on a confirmed stay. |
| **Check out** | Only on a checked-in stay. |
| **Cancel** | Only on a confirmed stay. |
| **Reverse no-show / cancellation / checkout** | Manager actions — see the Manager section. |

**The Ledger tab** — one running statement across every stay and every loose
charge or payment, like a bank statement: it goes up with a charge and down with
a payment. The last line is what they owe overall. Tapping a line opens that
stay's own bill.

![screenshot: the guest home, Summary tab](/help/guest-home.png)

### Checking a guest in

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Check in**.

1. Open the guest (tap their booking in the list).
2. On the stay's row, tap **⋮** → **Check in**.
3. Check the **Arrival date** and **Arrival time**. They default to *now*, in the
   hotel's own clock.
4. If the guest actually arrived earlier — a 2 a.m. walk-in you are keying at
   8 a.m. — **change them to when they really arrived**.
5. Press **Confirm check-in**.

**Why the time can be edited.** This is not paperwork. The arrival date decides
**which nights the bill charges for**. A guest who arrived at 02:00 and is keyed
in at 08:00 the next morning would otherwise be billed for the wrong night. You
cannot record an arrival in the future.

If the arrival differs from the reserved check-in, the panel tells you before you
confirm: *Nights will be charged from …*. The reserved date is never changed — it
stays on the record for any dispute.

![screenshot: the check-in panel with date and time](/help/check-in.png)

### Reserved nights and nights billed

**Who:** everyone — this is the question guests argue about most.

- **Reserved nights** — what was booked.
- **Billed nights** — from the night the guest actually arrived, up to (but not
  including) the day they leave.

A guest books three nights, their flight is cancelled, and they arrive on the
last day. The stays table shows **1** with a muted **(3 reserved)** beside it,
and the bill carries exactly one room night.

**The guest pays for nights slept, not nights booked.** If they arrive *earlier*
than booked, billing still starts on the reserved date, because that is the night
whose price was agreed.

Room nights are never typed in by hand. They post by themselves — see
[The night audit](#the-night-audit) — and again at check-out for anything the
audit has not reached yet.

### Taking a payment or a deposit

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Make payment**.

**A deposit and a payment are the same thing here.** There is no separate deposit
screen: money taken three weeks early is a payment on a folio that is already
open, and it nets off as room nights post.

1. Tap **⋮** → **Make payment** on the right stay.
2. Type the **Amount**. It starts empty on purpose — **never assume the balance
   due**; type what the guest actually handed over.
3. Pick the **Method**: Cash, Bank transfer, POS / card, Company account, Other.
4. Put the **Reference** in — teller number, POS slip, transfer reference. It is
   optional against a stay, and required for a payment that belongs to no stay.
5. Check the **Payment date**. It defaults to the hotel's operating day today.
   This is the day the cash-up will look for the money on.
6. Press **Record payment**.

Notes:

- **A refund is a negative amount.** Type `-20000` to give ₦20,000 back. There is
  no separate refund button.
- Pressing the button twice cannot record the payment twice.
- If the payment fails, you are told why in the system's own words. Nothing is
  half-recorded.

![screenshot: the take payment panel](/help/take-payment.png)

### Adding a charge

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Add charge**.

For the extras a guest signs to their room: a restaurant or bar bill, a laundry
ticket, internet, transport, a damaged item.

**Never add a room night here.** Room charges post automatically (see
[The night audit](#the-night-audit)) at the rate locked when the booking was
made. Keying one by hand posts it at whatever you typed, and the audit will post
its own copy as well.

1. Tap **⋮** → **Add charge**.
2. Pick a **Charge type**. The list is your hotel's own — the owner adds or
   retires types, so if something is missing, ask.
3. Write a **Description**: *Dinner — table 4*, *laundry ticket 218*.
4. Set the **Quantity** and the **Unit amount**.
5. Check the **Charge date**. A bar sale at 02:00 belongs to the **previous**
   operating day — change the date if you are keying it the next morning.
6. Look at the box underneath: it shows **Gross**, each tax or service charge
   that applies, and **Guest pays (estimated)**. Quote the guest that bottom
   figure, not the bare price.
7. Press **Post charge**.

The preview is an estimate only because the charge does not exist yet. Once it is
posted, every figure on the bill is computed by the system.

![screenshot: the add charge panel with the tax preview](/help/add-charge.png)

### Giving a discount

**Who:** everyone can start one; some need a manager's PIN. **Where:** the stay's
full bill (**⋮** → **Open full bill**) → the **⋯** on the charge line →
**Discount**.

**A discount attaches to one charge, not to the whole bill.** That is why you
open it from a line: the record has to say which sale was reduced, by how much,
why, and on whose authority.

1. Open the guest → the stay's **⋮** → **Open full bill**.
2. Find the charge line, press **⋯** on it, choose **Discount**.
3. Type the **Discount amount**.
4. Watch **the approval meter** under the box. It tells you, as you type, exactly
   where you stand:
   - *"Within your own approval limit — no PIN needed"* — with how much of your
     limit is left. The discount is recorded **against you** as the approver.
   - *"Manager PIN required"* — with how far over the limit you are.
   - *"Full comp — manager PIN always required"* — see below.
   - *"More than the charge"* — you have typed more than the line is worth.
5. Write the **Reason**. It is required. It is printed on the bill and kept in
   the change log.
6. If a PIN is required, a bordered box appears. **Hand the terminal to a
   manager** — they type their own PIN there.
7. Press **Apply discount** (or **Approve discount**).

**The two rules, plainly:**

- **Up to your hotel's approval limit:** no PIN. You are recorded as the
  approver.
- **Above the limit, or a full comp (100% off), however small:** a manager's PIN,
  every time. A comp is the easiest way to make a real sale disappear, so it
  always carries a manager's name.

Your hotel's limit is set by the owner. If it is set to **0**, every discount
needs a manager.

A discount **replaces** any discount already on that line; it is not added to it.

![screenshot: the discount panel and approval meter](/help/discount.png)

### Checking a guest out

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Check out**.

1. Tap **⋮** → **Check out** on the stay.
2. Read the **pulsing red reminder**: *Before checking out — confirm all charges
   are posted.*
3. **Actually ask the guest** — anything from the bar this morning? laundry?
   minibar? Then post whatever is missing **before** you continue.
4. Tick **I have checked with the guest and all charges are on the folio.** The
   confirm button stays disabled until you do.
5. Press **Confirm check-out**.

**Why the reminder moves.** You have pressed this button a hundred times and
ninety-nine of them had nothing to check. A red box that does not move becomes
furniture within a week. (If your device is set to reduce motion, it does not
pulse — the words and the colour are the same.)

**After you confirm,** the system posts every room night that is not on the bill
yet and tells you what it did: *"3 nights posted now, 1 already on the bill.
₦45,000 still outstanding — settle before they leave."* Settle it before they
walk out.

**Check-out works at any hour.** A 02:00 departure — hours before the night audit
runs — still leaves with a complete, settleable bill.

**Once a guest is checked out, no new charge can go on that stay.** That is why
step 3 matters.

![screenshot: the check-out panel with the reminder](/help/check-out.png)

### No-shows

**Who:** happens automatically; the desk follows up. **Where:** the bookings list
and the guest home.

A booking becomes a **no-show** when its whole reserved arrival day has passed in
the hotel's own time and nobody arrived. A guest has until midnight to walk in,
so today's arrivals are never touched.

What happens then depends on who was paying:

- **Company booking** — the room was held on the company's account, so the
  company is charged **one night** and the booking is marked **No-show**.
- **Walk-in / individual** — they committed nothing, so nothing is charged and the
  booking is simply **Cancelled**.

**Either way the room is released** and can be sold again.

For a company no-show you will see a **Call before releasing this room** notice
on the bookings list and on that guest's page. It names the room, the dates and
the company.

1. Read the notice.
2. **Phone the company** — a delayed flight is not the same as a cancellation,
   and they have just been billed and lost the room.
3. Press **Acknowledge**. Who cleared it and when is recorded.

Acknowledging does not hold the room — the room is already free. It records that
somebody dealt with it.

### Cancelling a booking

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Cancel** (only
shown on a confirmed stay).

1. Tap **⋮** → **Cancel**.
2. Type the **reason**. It is required and permanent.
3. Press **Confirm cancellation**.

**A deposit already taken is left exactly where it is.** The system does not
decide whether it is refunded or forfeited — that is your hotel's policy and a
person's decision. To refund it, record a negative payment on the folio.

### The statement

**Who:** everyone. **Where:** guest home → the stay's **⋮** → **Statement**.

The statement is the **guest-facing** bill: clean, printable, with no buttons a
guest could press. It is not the same as **Open full bill**, which is your
working copy with the void trail and the per-line tools on it.

Voided lines are **hidden** from the statement and excluded from its totals — a
guest should not be handed a page of crossed-out lines. The trail stays on the
internal bill.

**To print it:**

1. Open **⋮** → **Statement**.
2. Press **Print statement**.
3. Only the document prints. The sidebar, the buttons and the ⓘ note are not on
   the paper.

**To send or save it** — press **Export / Share**:

| Choice | What it does |
| --- | --- |
| **Email** | Sends the guest the PDF. Opens a dialog first — see below. |
| **PDF** | Downloads the document as issued, ready to attach. |
| **Excel** | The figures as numbers, for checking. |
| **Word** | An editable copy. |
| **WhatsApp** | Shares a summary with the guest. |

**Emailing it — the dialog is the point.**

1. Choose **Email**.
2. **Look at the address.** It is filled in from the guest's record, and that is
   exactly the thing that is often wrong, out of date, or their company's.
3. Correct it if it is wrong. This send goes to whatever is in the box.
4. Managers and owners also get **Also save this address to the guest record** —
   tick it so nobody retypes it next time.
5. If the document has been emailed before, a line tells you where and when.
   Sending again is fine; the guest simply gets another copy.
6. Press **Send statement**.

You always get a plain answer: sent, already sent, or the reason it failed.
Pressing **Send** twice does not send two copies of the same statement to the
same address.

**PDF, Excel, Word and WhatsApp are also on the stay's ⋮ menu** on the guest home
(PDF, WhatsApp and Email), so you do not have to open the page first.

![screenshot: the statement with the Export / Share menu open](/help/statement.png)

### Charges and payments outside a stay

**Who:** everyone. **Where:** guest home → **Standalone charge / payment**
(beside the **Stays** heading).

For money that belongs to a person but to no stay: a non-resident using the
restaurant, a deposit taken before any booking exists, a company visitor's bar
tab.

1. Press **Standalone charge / payment**.
2. Fill it in as you would a normal charge or payment.
3. The **description** (on a charge) and the **reference** (on a payment) are
   **required** here. An entry tied to no stay is impossible to explain a month
   later without one.

Once the guest has one of these, a **Non-resident statement** button appears
beside the Stays heading — the same document, adapted: no room, no dates, no
nights.

---

## Manager

Everything above, plus the approvals. All of it turns on your PIN.

### Setting your approval PIN

**Who:** managers and owners only. **Where:** your account menu (top right) →
**Manager PIN**, or **Settings → Manager PIN**.

1. Open either place.
2. Type a **PIN** of 4 to 8 digits, then type it again to confirm.
3. Press **Set PIN**.

**What to know:**

- **It is yours alone.** Nobody can set or read anybody else's PIN — not the
  owner, not support, not this system. It is stored scrambled, one way.
- **Forgotten it?** Nobody can recover it. Set a new one here; that replaces it.
- **A manager with no PIN cannot approve anything**, so a shift with no
  PIN-holding manager is a shift that cannot reverse a payment. Set it on day
  one.
- Avoid `1111` or `1234` — obvious PINs are rejected.
- If you work for two hotel groups, you have a separate PIN for each.
- Every approval you give is recorded **against you by name**, permanently, and
  can never be edited or deleted. Treat the PIN as your signature.

### Void or Reverse?

Two ways to undo something, and picking the right one matters.

| | **Void** | **Reverse** |
| --- | --- | --- |
| **Use it when** | It should never have been recorded — mistyped, wrong folio, the transfer never cleared. Caught in the same moment. | It **was** recorded and **was** relied upon: a receipt was issued, a statement was sent, a balance was quoted. |
| **PIN?** | No | **Always** — whatever the amount |
| **What happens** | The line stays on the bill, struck through and marked, and stops counting. | The original line stays and keeps counting. A **second line** — the counter-entry — undoes it. |
| **On the guest's statement** | Hidden | Both lines appear |

Neither ever deletes anything. A mistaken ₦150,000 charge that simply vanished
would be indistinguishable from a charge that was never posted — which is exactly
the cover a dishonest posting needs.

**Every reversal needs a reason and a PIN, is permanent, and carries the
approving manager's name.** There is no threshold: reversing ₦5,000 needs the
same approval as ₦500,000, because the record of money received is worth just as
much to somebody stealing either amount.

**To void something** (no PIN): open the stay's full bill → **⋯** on the line →
**Void** → type the reason → confirm.

### Reversing a payment

**Where:** guest home → the stay's **⋮** → **Open full bill** → **⋯** on the
payment line → **Reverse**.

1. Check the line named at the top of the panel — method, amount, date,
   reference.
2. Type the **reason**: *transfer recalled by the guest's bank*, *deposit
   refunded in cash at the desk*. It is printed on the counter-entry, so the
   guest's bill says why.
3. Type your **PIN**.
4. Press **Reverse payment**.

The original payment stays exactly as it is. A matching counter-entry is posted
against it, so the balance goes back **up** by that amount, and both lines stay
on the bill for good.

A payment that has already been **voided** cannot be reversed — it counts for
nothing already.

### Reversing a charge

**Where:** the stay's full bill → **⋯** on the charge line → **Reverse charge**.

Use it when the item should not have been billed at all: never delivered, posted
to the wrong folio.

1. Read the panel: it names the line and the exact amount that will move — *the
   guest will owe ₦X **less**, plus the tax that follows it*.
2. Type the **reason** (printed on the counter-entry).
3. Type your **PIN**.
4. Press **Reverse charge**.

The whole line comes off by counter-entry, including its tax and net of any
discount on it. Nothing is deleted.

### Reversing a discount — and changing one

**Where:** the stay's full bill → **⋯** on the charge line → **Reverse
discount**.

This is the opposite direction from everything else, so read it twice: **the
charge stays on the bill and goes back to its full price.** Only the reduction is
undone, so **the guest owes more**.

Use it when a discount was given in error, to the wrong guest, or beyond what was
agreed.

1. Read the panel — it says how much **more** the guest will owe.
2. Type the **reason**.
3. Type your **PIN**.
4. Press **Reverse discount**.

**To change a discount to a different amount, reverse it and re-issue:**

1. **Reverse discount** on the line (reason + PIN). The charge is back at full
   price.
2. **Discount** on the same line again, with the new amount and its own reason
   (and a PIN, if the new amount needs one).

The original discount, its reason and the manager who approved it all stay on the
record. Nothing is edited in place.

### Reversing a no-show

**Where:** guest home → the stay's **⋮** → **Reverse no-show** (only shown on a
no-show).

Use it when the guest did turn up, or the no-show was recorded by mistake.

1. Open the panel and read the two boxes:
   - **This re-takes the room for every night of the stay.** The no-show released
     the room, so somebody else may have it now.
   - **Any no-show charge will be credited back** by counter-entry, with its tax.
     Both lines stay visible.
2. Type the **reason**.
3. Type your **PIN**.
4. Press **Reverse no-show**.

**It can be refused, and that is the system working.** Availability is re-checked
night by night before anything changes. If a night is full, the booking is **not**
restored and the refusal names the nights that are gone — read it out to the
guest. Nothing changes when it is refused.

The booking comes back as **confirmed**, not checked in. If the guest is standing
there, check them in afterwards in the usual way so the right nights are billed.

If the arrival day has already passed, the panel warns you: tonight's night audit
will resolve the booking again unless somebody checks the guest in today.

### Reversing a cancellation

**Where:** guest home → the stay's **⋮** → **Reverse cancellation**.

Same shape as reversing a no-show, with one difference: **no money moves.** A
cancelled booking had no room charges, and any deposit stays exactly where it is.

1. Type the **reason**.
2. Type your **PIN**.
3. Press **Reverse cancellation**.

It re-takes the room, so it can be refused night by night in exactly the same way,
naming the nights that are gone. The booking returns to **confirmed**.

### Reversing a check-out

**Where:** guest home → the stay's **⋮** → **Reverse checkout**.

Use it when the guest **has not actually left**: checked out at 09:00 while they
were still at breakfast and staying another night, or checked out on the wrong
booking of a group.

**This reopens the stay. It does not un-charge it.**

- The booking goes back to **checked in** and the folio opens again, so you can
  post tonight's dinner and take payment.
- **The room nights already on the bill stay.** They were slept. If one
  particular charge genuinely has to come off, reverse *that charge*, with its own
  reason and PIN.
- The recorded arrival does not move, so the nights being billed do not move.

1. Type the **reason**.
2. Type your **PIN**.
3. Press **Reverse checkout**.

**It can only be done once.** When the guest really leaves, check them out again
in the normal way — nights already on the bill are not posted twice, and only
nights the stay has since gained are added. That second check-out cannot be
reversed.

Nothing is re-taken and nothing can be refused for availability: a checked-out
stay never released its room.

---

## Owner

Everything above, plus the setup. **Where:** sidebar → *Configuration*.

### Settings

**Where:** sidebar → **Settings**. Six tabs, plus **Manager PIN** for your own
PIN. The tab you are on is in the address, so you can bookmark or share it.
Switching tabs with unsaved changes warns you first.

| Tab | What is in it |
| --- | --- |
| **Brand & theme** | Logo, the five brand colours, font pairing, site template. Contrast is checked as you pick a colour, so text stays readable. |
| **Content** | Tagline, about text and image, hero images (up to 5), gallery, amenities, which sections show on the guest site and in what order. |
| **Contact** | Hotel name, phone, email, address, map coordinates with a live pin preview, directions. **Invoices and confirmations read these too.** |
| **Operations** | Timezone, currency, night-audit time, online booking on/off. |
| **Finance** | The discount approval threshold. Private to your staff — never shown on the guest site. |
| **Tax** | Default VAT rate for the company, entered as a percentage (e.g. `7.5`). |

**Two settings that are not cosmetic:**

- **Timezone** decides which business day every charge, payment and room night
  belongs to. The night audit bills "yesterday" in *this* timezone, and every
  report groups by that day.
- **Currency** is the code every amount in the system is shown in — rates, bills,
  balances, statements.

**The discount approval threshold** (Finance tab) is the amount below which staff
can discount without a manager. Above it, a manager's PIN is required and that
manager is recorded as the approver. A **full comp always needs a PIN**, whatever
this is set to. Set it to **0** to require a manager for every discount.

**Edit visually** (top right of Settings) opens the **Site editor**: your real
guest site with editing switched on, so you click the thing you want to change
and see it change. It edits the same values as the tabs above — one set of
settings, two ways in.

### Room types and rates

**Where:** sidebar → **Room types**.

A room type is a bookable category — *Deluxe Double* — not a physical room.

For each type you set: name, description, bed configuration, size, maximum adults
and children, amenities, images and display order.

**Three levels of price, in order of precedence:**

1. **Rack rate** — the standard nightly price.
2. **Weekend rate** — used on the days you mark as weekend days.
3. **Seasonal rates** — named, dated overrides (*Christmas*, *Detty December*).
   Overlapping periods are allowed; the system resolves which one wins.

Use the **rate preview** on the card: pick a date and it shows what a night would
cost on that date and which rule decided it.

**A rate change never touches an existing booking.** Every booking locks its
per-night price when it is created, so tonight's price change affects tomorrow's
bookings, not the ones already made.

### Companies and negotiated rates

**Where:** sidebar → **Companies**.

Corporate accounts that book rooms on their own account.

1. Press to add a company, fill in its details, save.
2. Open the company and set a **negotiated rate per room type**: either a **fixed
   amount** per night, or a **percentage off** the rack rate.
3. The preview shows rack versus the company's price side by side.
4. Clear a rate to put that room type back on rack — that is not an error.

When a booking is billed to a company, its price comes from these rates and the
folio is billed to the company. Company pricing is never shown on the guest site.

### Inventory

**Where:** sidebar → *Inventory*.

One page for the whole of stock control. It used to be three — *Items*,
*Locations* and *Store* — and every real job crossed at least two of them, so
they are now one screen with a **location picker** at the top and a **row of
tabs** underneath. The old menu entries are gone; anything pointing at them lands
here.

**View stock at** decides what every figure on the page describes:

- **All locations** — the whole hotel rolled up. Each item's row shows where its
  stock actually is (*Main Store: 62 · Kitchen: 1*).
- **A single location** — that store, kitchen or bar on its own, with its own
  quantities and its own average cost.

> Everyone who can open this page sees every location. Restricting a barman to
> the Bar needs staff logins and roles, which are not built yet.

**Manage locations** and **Load opening stock** sit beside the picker rather than
in the tabs — both are setup you do once, not daily work. *Load opening stock*
takes one sheet that does both jobs at once: what you stock, and how much of it
is on the shelf. **Add product**, on the Products tab, is the same job one item
at a time.

The tabs:

| Tab | What it does |
| --- | --- |
| **Products** | The main list: every item, with what you hold of it and what it is worth. |
| **Categories** | The groups your stock reports are broken down by. |
| **Adjustments** | Every correction ever posted, and the form that posts one. |
| **Stock Take** | Count a location and record the differences. |
| **Import History** | Every opening balance loaded, with who loaded it and when. |
| **Price Update** | Marked **SOON** — selling prices arrive with the menu. The tab says what it needs first and what to use meanwhile. |

Every other tab works. **Requisitions** and **stock transfers** used to sit in
this row and have moved out to their own menu entry, **Requisitions**, directly
below Inventory — see below.

### Products — the item list

Everything you hold, use or sell, defined **once for the whole company** — the
same *Rice* in every hotel you run — with this hotel's stock beside it.

The card above the table gives **total items**, **items with stock**, **total
units** and the **stock value**, each across everything matching your filters and
every page, never just what you can see. The small **i** beside each one says
exactly what it counts. (Total units adds kilograms to bottles, so it is a rough
sense of scale; the value is the figure that really adds up.)

Search by name or code, and filter by category, type or stock. Narrowing by
**stock** — *at or below reorder level*, *less than nothing* — lists one line per
location, because that is a question about a shelf rather than about an item.

**Export** writes every row matching your filters, across all pages. **Add
product** creates items — one at a time, or many from a template. Opening a row
shows the movements behind its figures when you are looking at one location, or
where the stock is when you are looking at all of them.

Each item has:

- **A name**, and optionally a **code** for bin cards and stock sheets. Neither
  can repeat — *Rice* and *rice* are the same item.
- **A type**, and this is the one worth reading twice:

  | Type | What it means |
  | --- | --- |
  | **Ingredient** | Used up by recipes only. Never sold on its own. Rice, cooking oil, soap. |
  | **Sold as-is** | Sold exactly as it is. One sale takes one off the shelf. Bottled water, biscuits. |
  | **Both** | Sold on its own *and* used in recipes — a 50cl Coke sold at the bar and poured into a cocktail. |

  Pick **Both** whenever a thing is sold over the counter *and* goes into
  something else. Marked as *Sold as-is* only, its cocktail use would never come
  off your stock and the bar would run dry with stock showing on hand.

- **A base unit** — the smallest unit you actually measure: kg, litre, piece,
  bottle. **Everything is entered in this unit.** There is no "cartons of 12" to
  set up and get wrong; a delivery of 5 cartons is entered as the number of
  pieces it really is.
- **A category** — how your stock reports are grouped. Manage the list on the
  **Categories** tab. Removing a category keeps its items; they simply become
  uncategorised.
- **A reorder level** — the amount below which you want warning. Optional. Items
  at or below it are flagged on the row and counted on the card above.
- **Perishable** and **In use** switches. *In use* off keeps an item on file but
  out of new entries, and out of this list unless you ask for it in the filters.

Base unit and Category each carry a **+ New** beside them, so a unit or a group
you have not set up yet is a field and a button rather than a trip to another
tab and a half-filled form abandoned on the way. **Type has no + New**, and that
is deliberate: *Ingredient / Sold as-is / Both* are not a list you add to, they
are the three behaviours the system knows how to act on — a fourth would have
nothing to do.

The rest of the fields are optional and are there for the reports and the
purchasing screens that come next:

| Field | What it is for |
| --- | --- |
| **Barcode** | The code on the packaging. Separate from **Code**, which is your own short reference — you may use either, both or neither. |
| **Pack size** | How it is packed, in words: *carton of 24*, *25 kg bag*. A description only. **Stock is still counted in the base unit.** |
| **Purchase cost** | What one base unit normally costs to buy. Informational: your stock is still valued at what you actually paid, delivery by delivery. |
| **Min stock** / **Max stock** | The ordering range — the floor you want to keep, and the ceiling worth holding. Read by purchasing when it arrives. **The low-stock warning uses Reorder level**, not these. |

Two fields you may expect and will not find. **Supplier** arrives with
purchasing, where it is a proper record — a hotel buys rice from three people at
three prices, and one box on the item could only ever hold one of them.
**Selling price** arrives with the menu, because the same bottle sells at one
price at the bar and another in the restaurant.

**Removing an item** takes it out of the catalogue but keeps its history, so it
can come back later. An item still holding stock anywhere cannot be removed at
all — write it down to zero first.

![screenshot: the Products tab at All locations, with the summary card and the Locations column](/help/inventory-products.png)

#### Adding a product

> **Two different jobs, and it is worth being clear which one you are doing.**
> **Adding a product** says *what a thing is* — "Rice exists, it is an
> ingredient, it is measured in kilograms". **Loading opening stock** says *how
> much of it you have* — "there are 200 kg of rice in the Main Store". Products
> first; stock afterwards, once the items exist.

**Add product** asks one question first: **one, or many?**

- **Add a single product** — the usual path. Fill in one item, and if you know
  it, **what is already on the shelf**: a location, a quantity, what one unit
  cost, and the day it was counted. Fill that in and the opening balance is
  recorded in the same pass; leave it blank and only the item is created.

  It is worth filling in. Recording it later is the step people forget, and a
  catalogue the system believes is empty is worse than no catalogue.

  The two are saved one after the other, not together, so if the item is created
  and the balance is refused — usually because that item already has one in that
  location — the screen says exactly that. The item is real; only the stock is
  missing, and you can record it from the item's row.

- **Add many from a template** — for setting up, when you have a hundred items
  to enter. Download the sheet (**CSV** or **Excel**), type your catalogue into
  it, upload it back, and check the preview before anything is created.

##### The product template

It arrives with a few **worked example rows**, one per type, showing exactly how
a product is written — plus your own unit codes and category names. Those rows
begin with **SAMPLE —** and are **always skipped by the import**, so you can
type over them or leave them; either is fine.

The columns are **Name, Code, Type, Base unit, Category, Barcode, Pack size,
Purchase cost, Min stock, Max stock, Reorder level**. Name, Type and Base unit
are required; everything else is optional. A category has to match one of yours
exactly — the import will not invent a new one from a typo, it tells you
instead.

> Take the **CSV** if Excel opens the file read-only and will not let you type
> in it. That is your office computer's document policy rather than the file.

##### Duplicate protection

This is the part that matters, because two rows for one sack of rice **cannot be
merged later** — their movements are permanent, so the only fix is to write one
down to zero and abandon it.

| What is found | What happens |
| --- | --- |
| **The same name** (or the same code) already exists | **Blocked.** Not created, not attempted. An item switched off still owns its name. |
| **A similar name** — *Rice* beside your existing *White Rice* | **Warned.** You are shown the near-matches and asked to confirm before it is created. |
| Anything else wrong — an unknown unit, an unknown category, a type that is not one of the three | **Blocked**, with the reason on the row. |

The same three answers apply whether you are adding one product or a hundred. In
the template preview each row is marked, the counts are shown, and **nothing is
created until you press the button** — and if any row needed review, you tick a
box confirming those names are genuinely different items before the button will
work.

Uploading the same file twice is safe: names that already exist are recognised
and left alone, never created a second time.

### Stock locations

**Where:** *Inventory* → **Manage locations**.

The places that hold stock **in this hotel** — unlike items, these are per
property, because stock is physical.

Every property starts with **Main Store, Kitchen, Bar** and **Housekeeping**.
Rename them to whatever you call them, add as many as you have, remove the ones
you do not use. A restaurant with no rooms simply removes Housekeeping.

**You can have two of the same kind.** A Poolside Bar and an Executive Lounge Bar
are two separate bars, each keeping its own stock and its own figures.

The **kind** decides what a location will do once stock movements exist:

| Kind | What it does |
| --- | --- |
| **Store** | Holds bulk stock and issues it out. Deliveries are received in here. |
| **Kitchen** | Uses up stock through recipes — a plated dish takes its ingredients out of this kitchen. |
| **Bar** | Sells drinks straight off the shelf and pours recipes for cocktails. |
| **Housekeeping** | Stocks the rooms. Issuing an amenity kit while cleaning takes it off this location. |
| **Other** | Anything else that holds stock — a maintenance cupboard, laundry chemicals. |

One of your stores is the **default receiving store** — where stock arrives
unless you say otherwise, on the opening-stock sheet now and on deliveries when
purchasing arrives. Open a store and turn on **Default receiving store** to move
it; the previous one gives the badge up in the same action, so there is always
exactly one. The switch only appears on a **Store**, because receiving is what a
store is.

Use the arrows to order the list. Removing a location takes it off the list —
**but a location still holding stock cannot be removed at all**. Move the stock
out, or write it off with an adjustment, first. (The same applies to an item:
one with stock on hand anywhere cannot be removed from the catalogue.)

![screenshot: the Manage locations panel over the inventory page](/help/stock-locations.png)

### What the stock figures mean

> This section sits under Owner because it belongs with the rest of Inventory,
> but **recording stock is store work**: anyone with an account can post an
> opening balance, an adjustment or a count, and it is recorded against their
> name. Defining the *items* and the *locations* stays with the owner.

Each row shows the quantity **in the item's own unit**, its **average cost** per
unit, and the **value** of what is there.

**Nothing here is stored.** Every quantity is added up from the movements
recorded against that item in that location, every time you open the screen. That
is why the numbers can never quietly drift away from the movements behind them —
and why you can always open a row and see exactly where a figure came from.

**Opening a row** shows every movement, oldest first, with what the stock stood
at after each one. This is the place to check a cost you do not recognise. Viewing
all locations at once, it shows *where* the stock is instead — pick a location to
see the movements, because two locations keep two separate averages and blending
them would give a figure that is true of neither.

#### What "average cost" means

Every time stock comes in at a new price, the cost of what you already had and
the cost of what just arrived are **blended in proportion to their quantities**.

> 100 kg of rice at ₦1,500 and then 50 kg at ₦1,700 gives you 150 kg at
> ₦1,566.67 each — not ₦1,600, because there is twice as much of the cheaper
> rice.

**Taking stock out never changes it.** Stock leaves at whatever the average
already is, so cooking with the rice cannot change what the rice still in the
store is worth. Only buying more at a different price moves it.

**What each issue actually cost is written down at the moment it happens**, and
never worked out again afterwards. That is what lets a food-cost figure from last
March still be the figure that was true last March, rather than something
recalculated from today's prices.

#### When stock says less than nothing

A location can show a **negative** quantity — say **−15 kg** — and the system
will never round that up to zero or refuse to display it.

**It means stock left without a movement behind it.** In practice that is one of
three things: a delivery that was never entered, an issue posted against the
wrong location, or stock that walked. It is a question worth asking, not a
display fault, and hiding it would hide exactly the thing this module exists to
show you.

The system will **warn you before** an entry takes a location below zero, and
tell you what it would come to, so a slipped decimal point gets caught. If you
confirm, it records it. Serving guests always wins: a system that refuses to let
the kitchen work is a system whose staff start writing fake receipts to get
through the night, and then nothing in it can be trusted.

### Adding or correcting stock

**Where:** the **Adjustments** tab, or **Add or correct stock** on any item's row.

The form offers two things:

- **Opening balance** — what was already on the shelf when you started using the
  system. **Once per item per location.** You will not be offered an item that
  already has one.
- **Adjustment** — a correction afterwards. Choose **Add stock** or **Remove
  stock** (never type a minus sign), and give a **reason**.

**A reason is required on every adjustment, and it cannot be edited or deleted
afterwards.** An adjustment moves stock with no purchase and no sale behind it,
so the reason and your name stay against it permanently. A mistake is fixed by
posting *another* adjustment, so the whole story stays visible — the same rule as
the folio.

When you add stock, leaving the cost blank keeps the current average, which is
right for "I found two more bags of the same thing". Typing a different cost is
allowed and will move the average, because that is what it means.

If a correction would leave **less than nothing** on hand, the system stops and
tells you what it would come to. You can still record it — and sometimes you
should, because a negative figure is real information: it means stock left
without a movement behind it. It is never quietly rounded up to zero.

The **Adjustments** tab lists every correction ever posted — what changed, where,
why, and in whose name — filtered by location, item, date range, or direction.
Nothing on that list can be edited, by anyone.

![screenshot: the Adjustments tab, with a correction being recorded above the list of past ones](/help/stock-adjustments.png)

### Reversing a stock movement

Sometimes a movement should not have been posted at all — a delivery keyed
against the wrong item, or a receipt for stock that was rejected at the gate. A
**reversal** undoes it.

**It works exactly like reversing a charge on a folio**, and the rules are the
same three:

- **A manager's PIN is always required.** There is no size of movement small
  enough to skip it. Reversal is the power to erase, and the reversal is recorded
  against the approving manager by name.
- **A reason is required**, and it is kept permanently.
- **The original movement is never touched.** The system posts an equal and
  opposite movement beside it, so both stay visible — what was recorded, and what
  undid it.

**A reversal is dated today, not the day of the original.** If a receipt from
last Tuesday is reversed this Friday, Tuesday's stock report stays exactly as it
was printed and the correction appears on Friday. Two people running the same
report a week apart should never get different numbers.

**The cost unwinds exactly.** Reversing a delivery removes precisely the value it
added, so the average cost goes back to what it was before — not to something
approximately right.

**A movement can be reversed once, ever.** Asking a second time tells you when it
was already reversed. A reversal cannot itself be reversed; if the stock needs to
move again, post it again.

**An opening balance cannot be reversed.** It is the starting line of that item's
history in that location. Correct it with an adjustment instead — before anything
else has moved, an adjustment unwinds it exactly.

### Closing a period

**Where:** Settings → Finance.

Set **Postings locked through** to a date and nothing can be recorded on or
before it. Anyone who tries is told which date is locked and which date they were
trying to post to.

This is how you make "we have reported this month" a fact rather than something
everybody is trusted to remember. Without it, somebody corrects a February figure
in April and every report printed since February is quietly wrong.

You cannot set the lock to a date in the future — a period is closed once it has
happened, not before. Moving the lock is recorded, like every other settings
change.

> **Write-offs, requisitions and purchase receipts are not built yet.** Today,
> stock that spoils or breaks is recorded as an **adjustment** with the reason
> written out. When write-offs arrive they will be their own kind of movement so
> that wastage can be reported on separately from clerical corrections.

### Counting a location

**Where:** the **Stock Take** tab.

Pick the location and the day you counted, then walk the store keying what is
actually on each shelf beside what the system believes. Nothing is pre-filled —
a counted quantity copied from the system is the system agreeing with itself,
which is the exact check a count exists to break.

The sheet **keeps what you have keyed as you page through**, and **Record the
differences** posts all of it, not the page you are on. Only items whose count
differs produce anything; counting a shelf and finding it right records nothing,
which is correct.

Each difference is recorded as a normal **adjustment**, with the count and its
date as the reason — permanent, and in your name. A line that fails stays on your
sheet with the reason beside it, so you can fix it and post again without any
risk of recording it twice.

Only items that have moved in that location can be counted: an item with no
history there has no cost to value a count against. Give it an opening balance
first.

![screenshot: a stock take part-counted, with three differences ready to record](/help/stock-take.png)

### Loading your opening stock from a spreadsheet

**Where:** *Inventory* → **Load opening stock**, beside the location picker.

**One sheet does both jobs.** A row for something you already have records its
quantity; a row for something new **creates the item and** records its quantity.
So a hotel starting from nothing fills in one file, once, rather than building a
catalogue on one screen and then remembering to come back and say what is on the
shelves.

1. **Check the location and the count date**, then press **Download sheet
   (CSV)** — or **Excel**. It downloads straight away; there is nothing to read
   first, because the instructions are on the sheet.

   The **Location** starts on your **receiving store** — where deliveries
   arrive. Pick a kitchen or a bar instead and you get one short question:
   *"Stock is best received into the store and issued out. Put it in the Bar
   anyway?"* The answer starts at **No**; putting stock straight into a bar has
   to be a deliberate yes. (Which store is the default is yours to set — see
   **Stock locations** below.)

   The **date** is the day you counted, not the day you upload.

2. **Fill it in.** The sheet already lists every item you have, with **the unit
   it is tracked in**, so you never have to remember whether rice is counted in
   kilograms or in bags. Type an **Opening quantity** and a **Unit cost** beside
   the things you actually hold. Blank rows are skipped; **0 records that you
   counted and there is none**. Use a full stop for decimals.

   Add rows at the bottom for anything not listed yet, filling in its Type, Base
   unit and Category. A second tab, **Reference**, lists the exact units,
   categories and types that will be accepted — the column headings point at it.
   (The CSV has no tabs, so the same three lists sit above the header; delete
   them or leave them, the import steps over them either way.)

   On a row you already have, only **Opening quantity**, **Unit cost** and
   **Note** are read. Change an existing item's details on the item itself, not
   here.

   > **If Excel opens the file read-only and will not let you type in it, take
   > the CSV instead.** That is your office computer's document policy rather
   > than the file: many company laptops are set to open any spreadsheet that
   > has not been given a company label read-only, whoever created it. The CSV
   > is not affected, opens and edits normally in Excel, and imports back
   > exactly the same way.

3. **Upload it back** (.xlsx or .csv) and **check the preview.** Every row is
   checked *before anything is saved*: what will be created, what stock will be
   recorded, what is already loaded, and exactly what is wrong with anything
   that cannot import. **Nothing is written until you press Import.**

Rows with a problem do not hold up the rest: import the good ones now and fix
the others in the file.

#### When the sheet says something you have not set up

A unit, a category or a name the sheet uses and your catalogue does not is
**never created quietly**. It becomes a question, asked once however many rows
use it, and it holds only those rows:

| What the file said | What you are asked |
| --- | --- |
| A unit you do not have — *kilo* | **Create it** (give it a name and say what it measures), or **use one of mine**. |
| A category you do not have — *Beverges* | **Create it**, or **use one of mine**. |
| A name that looks like one you already have — *Rice* beside *White Rice* | **Create as new**, or **use the existing one**. |

This is the difference between a catalogue you can report on and one you cannot.
A typed *kgs* auto-created as a unit splits one item's stock into two scales that
can never be added together, and nothing would ever have told you. So the import
waits for you.

The **Import** button stays off until every question has an answer.

**Uploading the same file twice is safe.** Rows that already loaded are
recognised and left alone — the stock is not doubled, and items you already have
are not created a second time. Because an item can only ever have one opening
balance in a location, even a re-saved copy of the file cannot double-load it.

**This is for opening stock only.** Ongoing deliveries are recorded as purchases
when that screen arrives — not by uploading this sheet again with bigger numbers.

The **Import History** tab lists every opening balance on file, newest first,
with its location, quantity, cost and who loaded it. It does not list *files* —
a record of "this spreadsheet, these rows, these failures" needs a log of its own
and arrives with purchasing.

![screenshot: the import preview with good and bad rows](/help/stock-import.png)

### Requisitions

**Where:** sidebar → **Requisitions**, directly under *Inventory*.

**Not built yet** — the page opens and explains itself rather than doing
anything. It is listed here because it is where two things you may be looking
for will live: **requisitions** (the kitchen asking the store for what it needs)
and **transfers** (moving stock from one location to another). Both used to be
tabs inside Inventory.

The flow it will provide, in three steps:

1. **Raise** — the kitchen, bar or housekeeping asks the store for items and
   quantities, in each item's own base unit.
2. **The store sends** — the storekeeper issues what they are actually sending,
   which is not always what was asked for. Both figures are kept.
3. **The requester confirms** — whoever asked confirms what turned up. Only then
   is the movement complete.

**Why both sides confirm.** With one signature, the store records ten kilograms
out, the kitchen receives eight, and the two are never compared — the shortfall
surfaces months later as an unexplained variance. Two-sided confirmation puts
the gap on the record the day it happens, with both names against it.

It waits on **staff logins and roles**: a requisition has to know who may
request, who may approve, and for which location, and there is no way to say
"this person runs the Kitchen" yet.

**Until then, move stock between locations as two adjustments** — remove it from
where it left, add it to where it went, with the same reason on both. Be aware
of what that does not give you: the two entries are not linked, so nothing
checks that what left equals what arrived, and nothing records that anybody
asked.

### The night audit

**What it is:** a job that runs once a night, on its own, for every property.

**What it does, each run:**

1. **Posts room charges** for every guest who was in-house — one night, at the
   price locked when the booking was made. This is why room charges appear on a
   bill without anybody typing them.
2. **Reports bookings that never checked in**, so the desk can see them.
3. **Frees rooms from bookings nobody collected.** A confirmed booking whose
   arrival day has entirely passed is resolved: a company booking becomes a
   **no-show** and is charged one night; a walk-in is **cancelled** and charged
   nothing. Either way the room is released, and a company no-show leaves a
   follow-up notice for the desk.

**What staff need to know:**

- Room charges arriving by themselves are normal. Never add them by hand.
- Re-running the audit is safe. It cannot post a night twice — a repeat run
  changes nothing.
- The cutoff time is the **Night audit time** on the Operations tab, in the
  property's own timezone.
- Check-out also posts any unbilled nights, so a guest leaving before the audit
  runs still gets a complete bill.

---

## Words we use

| Word | What it means here |
| --- | --- |
| **Folio** | One stay's bill inside the system — every charge and payment for it. Opened automatically when the booking is created. |
| **Statement** | The clean, printable version of a folio that a guest is given. |
| **Business date** | The hotel's operating day. A bar sale at 02:00 belongs to the previous business date, not to the calendar day. |
| **Rack rate** | The standard published nightly price for a room type. |
| **Comp** | A 100% discount — the charge written off entirely. Always needs a manager's PIN. |
| **Void** | Mark a line as never-should-have-been-recorded. No PIN. Hidden from the guest's statement. |
| **Reverse** | Undo a line that was relied upon, by posting an opposite line beside it. Always needs a manager's PIN. |
| **Counter-entry** | The opposite line a reversal posts. |
| **Walk-in** | A booking the guest pays for themselves, as opposed to one billed to a company. |
| **Non-resident** | A charge or payment that belongs to a person but to no stay. |
| **Movement** | One recorded change of stock in one location — an opening balance, an adjustment, later a delivery or an issue. Permanent: corrected by another movement, never edited. |
| **On hand** | What a location is holding, added up from its movements. Never a stored number. |
| **Average cost** | What one unit of an item is worth in that location, blended across everything that has come in. Taking stock out does not change it. |
| **Opening balance** | What was already on the shelf when you started using the system. Once per item per location. |

---

## Not built yet

These appear in the menu marked **SOON** and do not open. Nothing in this guide
depends on them.

- Front desk board and the physical room / housekeeping board
- Rates and availability calendar
- Food & Beverage and Laundry as their own modules (post them as charges for now)
- **Requisitions** — its own menu entry, below Inventory. The page opens and
  explains the flow it will provide (raise → the store sends → the requester
  confirms) and what it waits on. Transfers between locations come with it.
- Purchases and suppliers.
- Selling prices — the **Price Update** tab inside Inventory, marked *soon*, with
  what it needs first. Everything else in **Inventory** — the product list,
  categories, adjustments, stock takes, opening balances and the spreadsheet
  load — *is* built; see the Owner section.
- Maintenance, staff, reports, accounting
- A guests list screen (reach a guest through their booking)
- Guest profile photos
- Separate front-desk logins

---

## About this guide

This file is `docs/USER-GUIDE.md` in the repository, and it is the only copy. The
in-app **Help** page renders this same file, so editing it here updates both.

**Adding screenshots.** The guide already marks where each one goes, like this:

```
![screenshot: the check-in panel with date and time](/help/check-in.png)
```

Drop a PNG at `public/help/check-in.png` and it appears — no change to the guide
needed. Until a file is there, the Help page shows a labelled placeholder box
instead of a broken image, so a missing screenshot never breaks the page. Use the
same `/help/<name>.png` path for any new one, and write the alt text as a plain
description of what the picture shows.
