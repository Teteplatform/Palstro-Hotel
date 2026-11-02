-- =============================================================================
--  The read-only backup login `hotel_backup`  (docs/backups.md)
-- =============================================================================
--  WHAT THIS IS FOR. The nightly backup (.github/workflows/db-backup.yml) needs a
--  login that can read every row of this database and change nothing. It must NOT
--  be the `postgres` superuser: that credential lives in a GitHub secret, and a
--  secret that can drop the database is a different category of risk from one that
--  can only read it. Ported from palstro-fuel's scripts/ops/backup_role.sql, with
--  the numbers re-checked against THIS database (see the BYPASSRLS note).
--
--  HOW IT IS APPLIED. Normally by `node scripts/ops/apply_backup_role.mjs`, which
--  substitutes the password in memory and pipes this file to psql — the password
--  never lands on disk outside .env.local. It can also be pasted into the Supabase
--  dashboard (project rsqwknhzxzknesjbdyog > SQL Editor > New query) if the CLI
--  route is unavailable; in that case replace CHANGE_ME_IN_EDITOR below first, and
--  do not save the query as a snippet.
--
--  SAFE TO RUN AGAIN. It creates the login if missing; otherwise it only sets the
--  password again and re-applies the rights. Re-running is how you rotate.
--
--  What the login can do, and why each part is here:
--   - LOGIN, a password, at most 3 connections; nothing else. Not a superuser,
--     cannot create databases or roles, no replication.
--   - pg_read_all_data: SELECT on every table, view and sequence in every schema
--     (public and auth, which backup.mjs dumps). It grants no INSERT / UPDATE /
--     DELETE / TRUNCATE anywhere, and there are no write grants to PUBLIC on any
--     table in `public` (checked on live: 0 such grants).
--   - BYPASSRLS: REQUIRED, and this is the part people try to remove. All 43
--     tables in `public` and 16 of the 27 in `auth` have row-level security, with
--     96 policies between them. pg_dump reads with row security OFF and STOPS with
--     "query would be affected by row-level security policy" on any table whose
--     policies would filter what this login sees — so without BYPASSRLS the dump
--     does not merely come out thin, it FAILS. The apparent alternative,
--     --enable-row-security, is worse than failing: it would dump only the rows the
--     policies show this login, and every policy here scopes through
--     get_tenant_ids() / get_property_ids(), which for a login that is in no
--     tenant_users row returns an empty array. That dump would contain ZERO rows of
--     hotel data and would still exit 0 — a backup that looks like a backup, is the
--     right shape, is encrypted, lands in the artifact, and restores to nothing.
--     BYPASSRLS lets it read every row. It confers no right to change any.
--   - pg_monitor (which includes pg_read_all_stats): read-only statistics, so the
--     health check can size pg_stat_statements. The dashboard's `postgres` role can
--     grant pg_monitor but not pg_read_all_stats on its own.
--   - default_transaction_read_only = on: every transaction this login opens is
--     read-only unless it deliberately says otherwise.
--
--  THE ONE HONEST CAVEAT, which differs from palstro-fuel and is stated because the
--  next person will otherwise copy fuel's stronger claim. Fuel's file says nothing
--  in its schemas is writable through PUBLIC. That is NOT true here: this database
--  has 15 SECURITY DEFINER functions in `public` that PUBLIC may EXECUTE, and a
--  SECURITY DEFINER function runs as its owner, so it is not bounded by this
--  login's SELECT-only grants. Most are trigger functions that do nothing useful
--  when called directly (log_field_changes, create_*_settings_row,
--  enforce_media_quota) and three are the read-only helpers RLS itself calls
--  (get_tenant_ids, get_property_ids, is_tenant_staff) — but claim_statement_email,
--  create_folio_for_booking and the seed_* functions do write.
--  They are NOT revoked, deliberately: get_tenant_ids() is called by every RLS
--  policy in the database, and revoking EXECUTE from PUBLIC would break every
--  signed-in read in the application. What actually protects us is that the backup
--  never calls them — pg_dump issues SELECTs — plus the read-only transaction
--  default above, inside which even a SECURITY DEFINER function cannot write.
--  Treat this as "the blast radius is small and understood", not "it is impossible".
-- =============================================================================
DO $backup_role$
DECLARE
  v_password text := 'CHANGE_ME_IN_EDITOR';   -- <<< substituted by apply_backup_role.mjs, or replaced by hand
BEGIN
  IF v_password = 'CHANGE_ME_IN_EDITOR' OR length(v_password) < 24 THEN
    RAISE EXCEPTION 'Replace CHANGE_ME_IN_EDITOR with a password of at least 24 characters first (nothing was changed)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_backup') THEN
    EXECUTE format('CREATE ROLE hotel_backup LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT 3', v_password);
    RAISE NOTICE 'hotel_backup created';
  ELSE
    EXECUTE format('ALTER ROLE hotel_backup LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS INHERIT CONNECTION LIMIT 3', v_password);
    RAISE NOTICE 'hotel_backup already existed: its password and rights were set again';
  END IF;
END
$backup_role$;

GRANT pg_read_all_data TO hotel_backup;
GRANT pg_monitor       TO hotel_backup;
ALTER ROLE hotel_backup SET default_transaction_read_only = on;

-- The check: one row, every column true.
SELECT r.rolcanlogin  AS can_log_in,
       r.rolbypassrls AS reads_every_row,
       NOT r.rolsuper AND NOT r.rolcreaterole AND NOT r.rolcreatedb AS no_admin_rights,
       r.rolconnlimit = 3 AS connection_limit_3,
       NOT r.rolreplication AS no_replication,
       pg_has_role('hotel_backup', 'pg_read_all_data',  'member') AS reads_all_data,
       pg_has_role('hotel_backup', 'pg_read_all_stats', 'member') AS reads_statistics,
       coalesce('default_transaction_read_only=on' = ANY (s.setconfig), false) AS read_only_by_default
  FROM pg_roles r LEFT JOIN pg_db_role_setting s ON s.setrole = r.oid AND s.setdatabase = 0
 WHERE r.rolname = 'hotel_backup';
