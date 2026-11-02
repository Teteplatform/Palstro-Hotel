# Backups and recovery

This page is written for someone who has lost the database and is not having a
good day. Short sentences. Numbered steps.

**If the database is gone right now:** sections 2, 3 and 4, in that order. Get a
backup, decrypt it, then restore it. Sections 5, 6 and 7 are the three things
that go wrong quietly afterwards — read them before you tell anyone you are
finished.

Everything here was last verified on 2 November 2026.

---

## 1. What exists

Two scheduled jobs and one read-only database login.

| | |
| --- | --- |
| `.github/workflows/db-backup.yml` | Takes a backup twice a day. |
| `.github/workflows/db-restore-test.yml` | Opens the newest backup once a month and checks it. |
| `hotel_backup` | A database login that can read every row and change nothing. |

The backup runs at **05:17 and 21:43 Lagos time** (04:17 and 20:43 UTC).

The evening one matters more. A hotel runs a night audit. The 21:43 copy lands
after the day's trade and before the business date rolls over, so the database is
both complete and quiet.

### What a backup contains

Each run produces three files, all encrypted:

| File | What it is |
| --- | --- |
| `hotel-<stamp>.dump.age` | A `pg_dump` of the `public` and `auth` schemas. |
| `hotel-<stamp>.storage.tar.age` | Every file from the storage buckets. |
| `hotel-<stamp>.manifest.json.age` | A list of what the other two are supposed to contain. |

The manifest is the important one. It records a row count for every table, the
document counters as values, `gl_wired_at` for every property, the trial balance,
and a SHA-256 for every storage object. The monthly restore test checks the
restored copy against it. If you are recovering by hand, read the manifest first
and use it as your checklist.

---

## 2. How to get a backup

1. Open the repository on GitHub.
2. Go to **Actions** → **db-backup**.
3. Pick a run. Scroll to the bottom of the run page, to **Artifacts**.
4. Download the artifact. It is named `hotel-backup-<date>-am` or
   `hotel-backup-<date>-pm`.

`pm` is the night copy and is kept **30 days**. `am` is the morning copy and is
kept **7 days**. If you want the most recent good one, take the newest `pm`.

The date in the name is the **Lagos** date of the slot, not the UTC date of the
run. A run that GitHub starts late still carries the name of the slot it was
meant for, so it never overwrites the other copy.

### Which job holds the key

Only **`db-restore-test`** can decrypt a backup. It is the only job given
`BACKUP_AGE_KEY`, the age private key.

The nightly backup job is given only the **public** key. It can create a backup
and cannot read one. That is deliberate: if the nightly runner were ever
compromised, it would hold nothing that opens a single backup it has taken.

So if you want to see inside a backup, you decrypt it yourself, on your own
machine, with your own copy of the private key.

---

## 3. How to decrypt

You need `age` and your copy of the private key.

1. Unzip the downloaded artifact. You will get three `.age` files.

2. Put the private key in a file. It is the `BACKUP_AGE_KEY` line in
   `.env.local`, or your copy from the password manager.

   ```bash
   umask 077
   printf '%s\n' 'AGE-SECRET-KEY-1...' > age.key
   ```

3. Decrypt all three:

   ```bash
   for f in *.age; do age -d -i age.key -o "${f%.age}" "$f"; done
   ```

4. Delete the key file when you are done.

   ```bash
   rm -f age.key
   ```

You now have `hotel-<stamp>.dump`, `hotel-<stamp>.storage.tar` and
`hotel-<stamp>.manifest.json`.

### If the key is gone

There is no recovery. The private key cannot be regenerated, and without it every
encrypted backup is scrap. The backups keep arriving, keep being the right size,
and are useless.

Keep a copy somewhere that is not this laptop and not this repository.

---

## 4. The order of a real recovery

**Schema first, then data, then storage.** Do not swap these around.

### Step 1 — create the project and the schema

1. Create a new Supabase project, or reset the existing one.
2. Get its connection string. Use the **session pooler on port 5432**, not 6543.
3. Push every migration:

   ```bash
   node node_modules/supabase/dist/supabase.js db push --db-url '<new connection string>'
   ```

Check the manifest's `migrations` block and make sure the count and the highest
version match what you just applied. As of 2 November 2026 that is **47
migrations, highest `047`**.

#### Why the schema comes from migrations and not from the dump

Because `supabase_migrations` is **not in the dump**. The dump covers `public` and
`auth` only.

That is on purpose. `supabase_migrations.schema_migrations` is Supabase's own
record of which migration files have been applied. If you restored it from a dump
you would have a schema-history table that claims 47 migrations were applied to a
database that was actually built some other way, and the next `db push` would
believe it and skip everything. The migrations in `supabase/migrations/` are the
source of truth for the schema (CLAUDE.md §5). The dump is the source of truth for
the rows.

So the migrations build the structure, including the storage bucket, which
`005_storage.sql` creates. Then the dump fills it in.

### Step 2 — load the data

The restore test does this in three passes and you should too. This is the order
`pg_dump` intends.

```bash
pg_restore --no-owner --no-privileges --section=pre-data -d '<url>' hotel-<stamp>.dump
pg_restore --no-owner --no-privileges --section=data --disable-triggers -d '<url>' hotel-<stamp>.dump
pg_restore --no-owner --no-privileges --section=post-data -d '<url>' hotel-<stamp>.dump
```

Two things about the middle line.

- **`--disable-triggers` is required.** This schema is full of append-only and
  write guards — `forbid_stock_movement_change`, `forbid_purchase_receipt_change`,
  `set_row_audit`. They exist to stop anyone editing history. During a reload they
  would either refuse the rows outright or rewrite the audit columns of every row
  as it went in, so you would restore the data and lose the record of who did
  what. The customer's main worry is staff theft. The audit trail is the product.

- **If `--disable-triggers` is refused**, you are not connected as the table
  owner. Connect as `postgres`. If it is still refused, disable the guard triggers
  by name, load the data, and re-enable them. Write down that you did it.

`--section=post-data` last is also deliberate. It creates the indexes, foreign
keys and `NOT VALID` checks. Some of those checks are written to judge new rows
and not old ones. Create them before the data and they will refuse rows they were
never meant to see.

### Step 3 — put the storage files back

See section 7.

### Step 4 — check your work against the manifest

The monthly workflow does this for you against a throwaway PostgreSQL 17 in the
runner. To do it by hand you need a local PostgreSQL 17 you do not mind writing
to — the checker creates and drops its own `restore_check_*` database and refuses
to run against anything but `localhost`. If you have no local server, make a
throwaway one:

```bash
initdb -D ./pgtmp -U postgres --auth=trust -E UTF8
pg_ctl -D ./pgtmp -o "-p 54329 -c listen_addresses=127.0.0.1" -l pgtmp.log start
# ... run the checker ...
pg_ctl -D ./pgtmp -m fast stop && rm -rf ./pgtmp pgtmp.log
```

Then run the real checker:

```bash
RESTORE_ADMIN_URL=postgresql://postgres@localhost:54329/postgres \
PG_BIN=/usr/lib/postgresql/17/bin \
node scripts/ops/restore_check.mjs \
  --dump=hotel-<stamp>.dump \
  --manifest=hotel-<stamp>.manifest.json \
  --storage=hotel-<stamp>.storage.tar
```

It prints `PASS`, `FAIL` or `VACUOUS` for each check. **`VACUOUS` is not a pass.**
It means the check could not tell working from absent because its inputs were
empty, and it says why. Today the trial-balance checks are vacuous, because
nothing has posted to the ledger yet.

---

## 5. `gl_wired_at` — the value that cannot be rebuilt

`property_finance_settings.gl_wired_at` records the exact instant this property's
stock RPCs began posting to the ledger. Migration `047` stamped it once.

**A dump restores it correctly. Rebuilding from migrations does not.**

Migration `047` sets the column with `now()` where it is null. Run it on a fresh
database and every property gets stamped with **today**, not with the original
instant. The column then says the posting code started working today.

### The symptom you would see

Everything looks fine. Nothing errors.

Then, later, you notice that `stock_movements_unposted` is empty when it should
not be, or that the inventory reconciliation reads `0.00` when a posting has
genuinely been skipped.

Here is why. A movement whose `created_at` is before `gl_wired_at` is explained as
*"recorded before this property's stock movements began posting, so there was
nothing to post it"*. That is true, and it is the whole point of the column. But
if the stamp has been moved forward to today, then **every movement in the
database is before it**, so every movement gets excused — including ones that
genuinely failed to post. The alarm that is supposed to tell you stock moved
without reaching the ledger goes quiet and stays quiet.

That is the one thing the column must never do.

### What to do

1. Read the real value out of the manifest, under `finance_settings`.
2. After the restore, compare it to what is in the database.
3. If it does not match, set it back by hand.

As of 2 November 2026 there is one property and its stamp is
`2026-09-18T20:51:29.940Z`. Do not trust that number — read the manifest, which
is written fresh with every backup.

---

## 6. `document_counters` — restore them as they were

`document_counters` and `document_period_counters` hold the last number issued for
each document type. Today that is `booking` and `stock_take`. Others — goods
receipts, invoices, receipts — get a row the first time one is issued, so this
table grows as the hotel starts using more of the system.

**If these come back lower than they were, the next booking reuses a number that
has already been issued.** You then have two different bookings with the same
number, in the same tenant, and nothing in the system will tell you.

Numbers are generated by a `SECURITY DEFINER` function reading these counters, and
never by counting rows and adding one (CLAUDE.md §6). So the counter is the only
record of where the sequence had got to.

### What to do

1. The manifest records both tables as **values**, not counts. Read them.
2. After the restore, compare `last_number` for every row.
3. If any is lower, set it to the manifest value.

Setting one **higher** than it was is safe. It leaves a gap in the numbering,
which is ugly and harmless. Setting one lower is not safe. If you are unsure,
go higher.

As of 2 November 2026:

- `document_counters` — `booking` at 3, `stock_take` at 1.
- `document_period_counters` — `booking` `202607` at 1, `booking` `202608` at 2.
  This table is per month, because booking numbers restart monthly
  (`019_booking_number_monthly.sql`).

Read the manifest rather than trusting those figures. It is written fresh with
every backup.

---

## 7. The storage files

### What the archive holds

`hotel-<stamp>.storage.tar` holds every object from every bucket, at its exact
path, under a folder named after its bucket:

```
property-media/<tenant_id>/<property_id>/hero/full/<uuid>.webp
property-media/<tenant_id>/<property_id>/hero/card/<uuid>.webp
property-media/<tenant_id>/tenant/items/thumb/<uuid>.webp
```

As of 2 November 2026 that is 9 objects and 645 KB: a hero image, a logo and one
item photo, in three size variants each.

Every object was checked against the size the database recorded **before** being
archived, and has a SHA-256 in the manifest. The monthly restore test verifies the
archived bytes against those checksums.

### Why this matters more than it looks

`media_assets` is the index over those bytes. It records the path, the size, the
dimensions and the original filename.

**It does not record a checksum or any source URL. It cannot re-fetch a file.**

So the bytes in the bucket are the only copy. If you restore the database and not
the storage, you get live `media_assets` rows pointing at files that do not
exist. The guest site renders broken images, and **nothing in the system can tell
you what the pictures were** — not even their names, beyond whatever the original
filename happened to be on somebody's laptop months ago.

That is the inverse of the orphan problem the media rules were written to avoid.
A file with no row bills you forever; a row with no file is a hole on the website.

### How to put the bytes back

1. Extract the archive.

   ```bash
   mkdir -p restore-storage && tar -xf hotel-<stamp>.storage.tar -C restore-storage
   ```

2. Make sure the bucket exists. `005_storage.sql` creates it, so if you pushed the
   migrations in step 1 it is already there.

3. Upload each file to its exact path. The path must match
   `media_assets.bucket_path` character for character, or the row still points at
   nothing.

   You need a **service-role key** for this. Get it from the Supabase dashboard:
   **Project Settings → API**. Then:

   ```bash
   cd restore-storage/property-media
   find . -type f | sed 's|^\./||' | while read -r p; do
     curl -sS --fail-with-body -X POST \
       -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
       -H "Content-Type: $(file --mime-type -b "$p")" \
       --data-binary "@$p" \
       "https://<project-ref>.supabase.co/storage/v1/object/property-media/$p" \
       && echo "ok   $p" || echo "FAIL $p"
   done
   ```

4. Check the count. The manifest's `storage.object_count` says how many there
   should be.

If `file` is not available, the manifest records each object's `mime` alongside
its path and checksum, so you can read the content type from there instead.

#### Two honest notes about step 3

**The service-role key is deliberately not stored anywhere.** It is not a GitHub
secret and it is not in `.env.local`. It can read and write every row of every
table and delete every storage object, which is far too much for a nightly job
that only needs to read nine image files. Fetching it from the dashboard for a
one-time recovery, with a person watching, is a different thing from a runner
holding it forever. Do not add it to a secret afterwards.

**This upload loop has not been exercised against a live project**, because doing
so would have meant holding that key. It is the documented Storage API and the
shape is right, but the first real recovery drill should be the thing that proves
it. The pinned Supabase CLI (2.109.1) has only `storage ls`, no upload, so the CLI
is not a shortcut here. A newer CLI has `storage cp` and would be worth checking
first.

### When to revisit the size of this

Today: 9 objects, 645 KB. It disappears inside the dump.

Projected: around 30 rooms photographed, say 8 photos each, 3 variants each at
roughly 250 KB, plus menu and item images — that is about **180 MB**. That still
fits a GitHub artifact at 30-day retention, but it stops being free.

**Revisit when the archive passes about 250 MB, or when the artifact upload starts
taking longer than the dump.**

The first lever is to **keep only the `full` variant** and document that `card` and
`thumb` must be regenerated. Together they are about a quarter of the bytes.

Right now all three variants are kept on purpose. They are derivable from `full`
in theory. In a real recovery nobody is going to re-run a resize pipeline and
write files back at exact paths while the hotel is down.

---

## 8. When the private-bucket guard stops a backup

You will see this, and the backup will have failed:

```
backup: REFUSING TO BACK UP: 1 storage bucket(s) are NOT public
        (<name>: N object(s), N bytes).
```

### What happened

The backup fetches object bytes from the **public CDN endpoint**, which needs no
credential. That only works for a public bucket. Somebody has added a private
one, so the backup cannot reach its contents.

It stops rather than skipping, because a backup that silently omitted a private
bucket would still go green, still be the right size, and still be trusted. If
that bucket held guest identity documents, that would be the worst possible
failure in this system.

### What to do

**Do not make the bucket public.** The error says this and it means it. A public
bucket's CDN endpoint does not consult row-level security at all, so making it
public to fix a backup would publish every file in it to anyone who knew a path.

Instead:

1. Decide what credential the backup should use to read that bucket. The options
   are a signed-URL mint, or a Supabase S3 access key scoped as tightly as
   Supabase allows.
2. Write down what that credential can do if the runner is compromised. An S3 key
   is project-scoped and has full write and delete on **every** bucket; there is no
   read-only variant.
3. Record the decision in this file.
4. Then change `scripts/ops/backup.mjs`.

See the standing rule in
[`ARCHITECTURE.md`](ARCHITECTURE.md) about guest identity documents and public
buckets before you do any of this.

---

## 9. What the backup does not cover

Be clear about this before you rely on it.

### Vercel environment variables

Not backed up. The guest site and admin app read `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY` and the rest from Vercel's own project settings. If the
Vercel project is lost you re-enter them by hand. `.env.example` records the
**names**. The values come from the Supabase dashboard.

### The Supabase project's own settings

Not backed up. None of this is in a `pg_dump`:

- Auth providers, email templates and SMTP settings
- Storage bucket configuration beyond what `005_storage.sql` recreates
- API keys, JWT secret, custom domains
- Network restrictions and connection pooler settings
- Any policy or extension created outside a migration

Anything created through the dashboard rather than through a migration exists only
in the dashboard. That is a reason to put things in migrations.

### Point-in-time recovery

We take **two snapshots a day**. We do not have point-in-time recovery.

The worst case is that you lose up to about sixteen hours of work — everything
between the last snapshot and the loss. Before go-live that is fine. Once the
hotel is trading and taking bookings, sixteen hours is a real number of real
bookings, folio charges and payments, and somebody has to reconstruct them from
paper.

Supabase sells point-in-time recovery on paid plans. **Revisit this at go-live.**
Our own backup is still worth having either way: theirs lives in their account and
is reachable only through their dashboard, and the only backup you can trust is
one you have opened yourself.

### The `storage` schema's own rows

The dump covers `public` and `auth`. It does not cover the `storage` schema, so
`storage.objects` metadata and the 4 storage RLS policies are not in it.

This is fine and deliberate. Re-uploading a file recreates its `storage.objects`
row, and `005_storage.sql` recreates the bucket and its policies. But it means you
cannot restore the storage metadata without re-uploading the bytes.

---

## 10. Checking the set-up without waiting for a backup

Run the **db-backup** workflow by hand with mode **`check-setup`**.

1. **Actions** → **db-backup** → **Run workflow**.
2. Set **mode** to `check-setup`.
3. Run it.

It audits every secret and the backup login, and takes no backup. It prints only
`ok`, `MISSING` or `FAIL` for each check — never a value, never a host, never a
server message, because this repository's Actions logs are world-readable.

Use it after changing a secret, and after changing either workflow. Waiting until
04:17 tomorrow to find out whether an edit was valid is how a backup sits broken
for a week.

---

## 11. The secrets, and which job reads which

| Secret | Read by | Where the value comes from |
| --- | --- | --- |
| `BACKUP_DB_URL` | db-backup | `.env.local` — the `hotel_backup` login |
| `BACKUP_AGE_RECIPIENT` | db-backup | `.env.local` — the age **public** key |
| `BACKUP_AGE_KEY` | db-restore-test only | `.env.local` — the age **private** key |
| `SUPABASE_URL` | db-backup, supabase-keepalive | `VITE_SUPABASE_URL` |
| `SUPABASE_ANON_KEY` | db-backup, supabase-keepalive | `VITE_SUPABASE_ANON_KEY` |

The backup login is created and rotated by:

```bash
node scripts/ops/apply_backup_role.mjs
```

It generates a password, applies `scripts/ops/backup_role.sql` over psql's stdin
so the password never lands in a file, and writes the new `BACKUP_DB_URL` into
`.env.local`. Nothing prints the password. After rotating, update the GitHub
secret and run `check-setup`.

To prove the login is still read-only and still sees everything:

```bash
node scripts/ops/prove_backup_role.mjs
```

It briefly removes `BYPASSRLS`, confirms the read falls to zero, and puts it back
— so a green result means something. If it ever reports that `BYPASSRLS` was not
restored, fix that immediately: every backup after that point would silently
contain no rows at all.
