-- ============================================================================
-- 068  A CATEGORY SAYS WHERE IT POSTS, AND THE REFUSAL SAYS WHO MAY SET IT
-- ============================================================================
-- 1.1h4 item 10's database half. It is NOT what it was asked to be, and the
-- difference is the whole content of this header.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS WAS ASKED TO DO, AND WHY IT DOES NOT
-- ----------------------------------------------------------------------------
-- The shipment was scoped as "admin-gate charge_categories", on the strength of
-- a report that said a cashier could create a charge category through PostgREST
-- and route revenue anywhere. THAT REPORT WAS WRONG. Both write policies
-- already require is_tenant_admin:
--
--     charge_categories_member_insert  INSERT  with_check  is_tenant_admin(tenant_id)
--     charge_categories_member_update  UPDATE  using + with_check  is_tenant_admin(tenant_id)
--
-- The mistake was reading the policy NAMES and the `roles={authenticated}`
-- column instead of the expressions. Rule 29, exactly: a listing that agreed
-- with a suspicion, written into a plan without opening each match. Settled the
-- second time by BEHAVIOUR rather than by reading it again — a front_desk member
-- created inside a rolled-back transaction, with the role actually SET so RLS
-- applies:
--
--     creating a charge category
--       owner/manager           is_tenant_admin=true    INSERT ACCEPTED
--       front_desk (non-admin)                          INSERT REFUSED 42501
--
-- So there is no gate to add.
--
-- ----------------------------------------------------------------------------
-- AND THE NAMES ARE NOT A LIE EITHER, WHICH THE CENSUS SETTLED
-- ----------------------------------------------------------------------------
-- The next instinct was to rename the two policies so the name stops
-- contradicting the expression — rule 28 in policy form. A census says that
-- would be backwards: THIRTY-NINE policies across EIGHTEEN tables carry
-- `_member_` in the name while requiring is_tenant_admin — companies,
-- company_rates, guests, inventory_categories, inventory_items, locations,
-- media_assets, properties, property_finance_settings, property_settings,
-- room_types, rooms, seasonal_rates, tax_charges, tenant_settings, tenants,
-- units_of_measure, and this one.
--
-- `_member_` is a TENANCY qualifier — scoped to this member's tenants — and the
-- permission lives in the expression. account_mappings's two `_admin_` policies
-- are the OUTLIER, not the standard. Renaming this table's pair to match two
-- policies would make it inconsistent with thirty-seven, so the names are left
-- exactly as they are and this paragraph is the answer for the next person who
-- reads one and reaches for ALTER POLICY.
--
-- ----------------------------------------------------------------------------
-- WHAT IS ACTUALLY WRONG, AND IT IS WORSE THAN A MISSING GATE
-- ----------------------------------------------------------------------------
--     editing a charge category
--       owner/manager           UPDATE touched 1 row
--       front_desk (non-admin)  UPDATE touched 0 rows   -- AND DID NOT ERROR
--
-- AN UPDATE WHOSE ROWS ARE FILTERED OUT BY A `USING` CLAUSE DOES NOT FAIL. It
-- reports success and changes nothing. A non-admin editing a category through
-- PostgREST gets a 204 and no change, which is the "quietly lies" shape this
-- codebase treats as worse than a loud failure — the same family as rule 1's
-- capped list and rule 22's green proof over a broken screen. The screen is
-- admin-only, so nobody meets this at a keyboard; PostgREST is reachable
-- whatever the screen does, which is the whole premise of rule 19.
--
-- AND A BARE RLS REFUSAL NAMES NO REMEDY. What the INSERT path says today is
-- "new row violates row-level security policy for table charge_categories" —
-- true, and useless to the person holding the terminal. Rule 21 applies to a
-- policy refusal exactly as it does to a trigger's hint: the message carries the
-- rule, the hint carries the way out.
--
-- ----------------------------------------------------------------------------
-- SO, TWO CHANGES AND NEITHER PERMITS ANYTHING NEW
-- ----------------------------------------------------------------------------
--   SECTION 1  UPDATE's USING becomes member-level, so a non-admin's edit is
--              LOUD instead of silent. WITH CHECK stays is_tenant_admin, so the
--              set of writes that succeed is UNCHANGED — only the set of writes
--              that fail quietly moves to failing by name. Nothing is granted.
--   SECTION 2  enforce_charge_category_account — the EXISTING trigger, extended
--              rather than joined by a second one enforcing the same rule —
--              raises the named refusal with the remedy.
--   SECTION 3  the self-verify: 12 assertions, rolled back.
--
-- WHY THE EXISTING TRIGGER AND NOT A NEW ONE: it already fires BEFORE INSERT OR
-- UPDATE on this table and already owns "a category must say where it posts".
-- Two triggers enforcing one rule is how they drift, which was ruled on this
-- very function when 062 proposed its twin.
--
-- WHY THE TRIGGER AND NOT THE POLICY ALONE: a BEFORE trigger fires before RLS's
-- WITH CHECK, so its sentence is what the caller actually meets. With USING
-- opened to members, the row is visible to the UPDATE, the trigger fires, and
-- the named refusal wins. RLS stays underneath as the floor (rule 19): delete
-- the trigger and the write is still refused, just anonymously.
--
-- ----------------------------------------------------------------------------
-- THE ONE WAY THIS COULD HAVE BROKEN SOMETHING, CAUGHT BEFORE IT DID
-- ----------------------------------------------------------------------------
-- An unconditional admin check in that trigger would REFUSE seed_charge_categories
-- and break the next tenant's creation. It is SECURITY DEFINER, it inserts eleven
-- categories, and it runs with no session — 044's own backfill loop called it
-- from a migration, where auth.uid() is NULL. is_tenant_admin(NULL user) is
-- false, so every seeded category would have been refused.
--
-- The exemption is therefore `auth.uid() is not null`, which is §6's reasoning
-- for the actor columns one rule over: a definer RPC or service_role path has no
-- session, and the check belongs to the client path it is protecting. Asserted
-- in SECTION 3 by seeding a throwaway tenant with no session, because "it would
-- have broken tenant creation" is not a thing to leave to a paragraph.
--
-- ----------------------------------------------------------------------------
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ----------------------------------------------------------------------------
--   * IT DOES NOT FIX THE SILENT UPDATE ON THE OTHER SEVENTEEN TABLES. All
--     eighteen put is_tenant_admin in UPDATE's USING and all eighteen fail the
--     same quiet way. Fixing one is the one-screen fix rule 23 warns about, and
--     doing eighteen inside a shipment about charge categories is how a money
--     path gets a policy sweep nobody reviewed. It is on the tracker as its own
--     line (1.3a), with this file as the worked example.
--
--   * AND THE FIX IN THIS FILE DOES NOT WORK FOR `DELETE` AT ALL, which has to
--     be said HERE rather than only on the tracker, because a worked example
--     that silently fails to cover a third of the cases is how a sweep misses
--     them. There are FIVE admin-only DELETE policies — account_mappings,
--     media_assets, properties, property_settings, tenant_settings — every one
--     of them with the test in USING, because A DELETE HAS NO `WITH CHECK` for
--     it to move to. And no trigger can stand in: RLS filters the row before a
--     BEFORE DELETE trigger would fire, so there is nothing left to refuse.
--     Measured on a throwaway table, with a trigger that always raises:
--
--         non-admin DELETE                    touched 0 rows, NO error,
--                                             trigger never fired
--         admin DELETE (same trigger)         REFUSED PT403 — so it CAN fire
--         non-admin UPDATE (068's shape)      REFUSED 42501
--
--     The only remedy for a DELETE is therefore to stop exposing it: revoke it
--     from the client roles and route deletes through an RPC that refuses by
--     name. That is 1.3a's work, not this file's.
--
--     charge_categories itself has NO delete policy, so nothing can delete a
--     category through PostgREST — not even an admin, which the same test
--     confirms. Retiring one (is_active) is the path, and soft delete is the
--     house rule anyway (rule 5, §6). So this file could not have demonstrated
--     the DELETE case even if it had tried, which is precisely why the limit is
--     written down instead of left to be inferred from the example.
--   * It does not rename the policies (see above).
--   * It does not touch the misc category or its mapping. Kept deliberately as a
--     NAMED BUCKET: deleting it would not remove the one-off charge, it would
--     remove the honest place to put one, and the desk would bill it to Laundry
--     at 11pm instead. Its expiry condition is on the tracker, 044's model.
--   * It adds no RPC. The form writes the table, the trigger guards it, RLS is
--     the floor. A write RPC here would be a fourth place to say the same rule.
--
-- ----------------------------------------------------------------------------
-- LINEAGE
-- ----------------------------------------------------------------------------
--   001  tenant_users and its role list; is_tenant_admin's owner/manager test
--   044  §8 account_role_key, NOT NULL with no default, and
--        enforce_charge_category_account: the key must exist AND be mapped
--   052  refuse at the moment of the decision, not of the consequence
--   059  the charge captures account_role_key, so a repoint cannot rewrite
--        where a posted charge went
--   062  one trigger per rule, ruled on this exact function
--   067  a table guard is the floor and the sentence is the interface
-- ============================================================================

-- ############################################################################
-- SECTION 1 — A NON-ADMIN'S EDIT FAILS LOUDLY
-- ############################################################################
-- ONE CLAUSE MOVES AND NOTHING IS GRANTED. UPDATE's USING goes from
-- is_tenant_admin to the tenancy test every SELECT policy already uses; its
-- WITH CHECK stays is_tenant_admin. The two clauses answer different questions:
--
--   USING       which existing rows may this statement TARGET
--   WITH CHECK  what the row is allowed to look like AFTERWARDS
--
-- With the admin test in USING, a non-admin's UPDATE matched NO ROWS and
-- returned success. With it in WITH CHECK only, the same statement targets the
-- row, fails the check, and raises. THE SET OF WRITES THAT SUCCEED IS
-- IDENTICAL — only the set that fails silently moves to failing by name.
--
-- The policy NAME is deliberately unchanged; the header says why at length.
drop policy if exists charge_categories_member_update on charge_categories;
create policy charge_categories_member_update on charge_categories
  for update
  -- rule 19's floor, same expression as the select policy beside it
  using (tenant_id = ANY (get_tenant_ids()))
  -- and the permission, unchanged
  with check (is_tenant_admin(tenant_id));

comment on policy charge_categories_member_update on charge_categories is
  'UPDATE: any member of the tenant may TARGET the row; only an admin may leave '
  'it changed. The admin test is in WITH CHECK rather than USING on purpose — '
  'in USING it filtered a non-admin''s UPDATE down to zero rows and returned '
  'SUCCESS, so the edit vanished without an error. Named _member_update like '
  'thirty-eight of its siblings: that prefix is a tenancy qualifier, not a '
  'permission one. SECTION 2''s trigger is what actually names the remedy; this '
  'is the floor underneath it.';

-- ############################################################################
-- SECTION 2 — THE REFUSAL NAMES WHO MAY SET IT, AND WHERE
-- ############################################################################
-- 044's function, re-emitted with ONE new guard at the top and everything else
-- byte-for-byte. Extended rather than joined by a second trigger: this one
-- already fires BEFORE INSERT OR UPDATE on this table and already owns "a
-- category must say where it posts", and two triggers enforcing one rule is how
-- they drift — ruled on this very function when 062 proposed its twin.
--
-- THE NEW GUARD GOES FIRST, before the blank-key and unmapped-key checks,
-- because the answer "you may not do this at all" is more use than "the key you
-- chose is not mapped" to somebody who may not choose a key. 052's ordering.
--
-- EXEMPT WHEN THERE IS NO SESSION, and this is the line that stops the shipment
-- breaking tenant creation. seed_charge_categories is SECURITY DEFINER and
-- inserts eleven categories; 044's own backfill loop called it from a migration,
-- where auth.uid() is NULL and is_tenant_admin is therefore false. Unconditional,
-- this guard would refuse every seeded category and the next tenant could not be
-- created. Same reasoning as §6's actor columns: `coalesce(auth.uid(), ...)`
-- preserves the no-session path deliberately, because a definer RPC has no
-- session and the check belongs to the client path it is protecting.
--
-- AND THE EXEMPTION IS KEYED ON THE ABSENCE OF A SESSION, NOT ON `SECURITY
-- DEFINER`, which is a distinction worth stating because the two are easy to
-- conflate and they come apart in one direction:
--
--   * A definer function called from a MIGRATION or by service_role has no
--     session, so auth.uid() is NULL and this guard stands aside. That is the
--     case it was written for.
--   * A definer function called by a LOGGED-IN NON-ADMIN bypasses RLS — that is
--     what definer means — and is then refused HERE, because auth.uid() is not
--     null and that user is not an admin.
--
-- The second is correct today: no such function exists, and if one appeared it
-- would be creating a charge category on a non-admin's behalf, which is exactly
-- the act this guard exists to refuse. But it is a surprise rather than a
-- deduction, and nobody will reason it out from first principles while debugging
-- it, so: THE DAY A DEFINER FUNCTION LEGITIMATELY HAS TO CREATE A CATEGORY FOR A
-- NON-ADMIN, THIS LINE IS THE ONE THAT HAS TO CHANGE — and it changes by taking
-- the actor explicitly, as §6 requires of definer RPCs ("those RPCs must set the
-- columns explicitly because auth.uid() inside them resolves to the caller"),
-- never by widening the exemption to all definer callers. Widening it would
-- leave the client path unguarded, which is the whole thing this file adds.
--
-- IT IS NOT THE ONLY GUARD AND IS NOT MEANT TO BE (rule 19). RLS refuses the
-- same writes underneath; delete this block and a non-admin is still refused,
-- just anonymously. What this adds is the SENTENCE.
create or replace function enforce_charge_category_account()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 068: WHO MAY SET WHERE REVENUE POSTS.
  if auth.uid() is not null and not is_tenant_admin(new.tenant_id) then
    raise exception
      'Only a manager or owner can change what a charge category posts to.'
      using errcode = 'PT403',
            hint = 'Ask a manager to open Settings, then Accounts, then Charge categories. A category decides which revenue account every charge in it lands in, which is why it is set once by somebody who owns the books rather than at the desk.';
  end if;

  if new.account_role_key is null or btrim(new.account_role_key) = '' then
    raise exception
      'A charge category must say which account its revenue posts to.'
      using errcode = 'PT422',
            hint = 'Open Settings, then Accounts, and choose the revenue account for this category.';
  end if;
  if tg_op = 'UPDATE'
     and new.account_role_key is not distinct from old.account_role_key then
    return new;                       -- unchanged: nothing to re-check
  end if;
  if not exists (
    select 1
    from account_mappings am
    join accounts a
      on a.id = am.account_id
     and a.tenant_id = am.tenant_id
    where am.tenant_id = new.tenant_id
      and am.property_id is null
      and am.role_key = new.account_role_key
      and a.deleted_at is null
      and a.is_active
  ) then
    raise exception
      'Nothing is mapped to "%", so charges in this category could not be posted.',
      new.account_role_key
      using errcode = 'PT424',
            hint = 'Open Settings, then Accounts, and map that role key to a revenue account first. A category that cannot be charged to should not exist.';
  end if;

  return new;
end;
$$;

comment on function enforce_charge_category_account() is
  'Refuses a charge category that a non-admin is trying to write (068), one '
  'whose account_role_key is blank, or one whose key is not mapped — at the '
  'moment it is created or the key is changed, so the refusal lands on the '
  'person configuring the hotel rather than on the front desk in front of a '
  'guest. The admin check is SKIPPED when there is no session, because '
  'seed_charge_categories is SECURITY DEFINER and runs with auth.uid() NULL; '
  'unconditional, it would refuse every seeded category and break tenant '
  'creation. THE EXEMPTION IS THE ABSENCE OF A SESSION, NOT SECURITY DEFINER: a '
  'definer function called by a logged-in non-admin is still refused here, '
  'which is correct today and is the line to change — by taking the actor '
  'explicitly, never by widening the exemption — the day one legitimately has '
  'to create a category on a non-admin''s behalf. Checks the TENANT DEFAULT '
  'mapping only: a property override is an '
  'override of something, and requiring one per property would make a '
  'four-hotel group do the same work four times.';

-- The trigger itself is unchanged and is re-emitted only so this file reads as
-- the whole rule rather than half of it. before insert OR UPDATE, for each row.
drop trigger if exists enforce_charge_category_account_trigger on charge_categories;
create trigger enforce_charge_category_account_trigger
  before insert or update on charge_categories
  for each row execute function enforce_charge_category_account();

-- ############################################################################
-- SECTION 3 — THE SELF-VERIFY, ROLLED BACK
-- ############################################################################
-- Twelve assertions. The defect each one goes red for is named beside it.
--
-- TWO DIFFERENT LAYERS ARE BEING TESTED AND THEY NEED DIFFERENT SETUPS, which
-- is worth stating because getting it wrong would make half of these vacuous:
--
--   * THE TRIGGER fires for any caller, so setting request.jwt.claims is
--     enough — assertions 1, 2, 7, 8, 9, 11.
--   * THE POLICIES are not enforced for the table owner, which this migration
--     runs as. Proving the SILENT UPDATE is gone therefore needs the database
--     role actually SET to `authenticated` — assertion 3. Without that it would
--     pass against RLS that was never consulted.
--
--   1  A NON-ADMIN'S INSERT IS REFUSED BY NAME. PT403 and a message naming who
--      may do it. PT403 is distinct from the three other refusals this function
--      can raise (PT422 blank key, PT424 unmapped key) and from RLS's own
--      42501, so the assertion cannot pass on the wrong refusal (rule 27's
--      sixth shape).
--   2  AND SO IS A NON-ADMIN'S UPDATE, which before this file returned SUCCESS
--      and changed nothing. Asserted on the refusal AND on the row being
--      unchanged afterwards.
--   3  THE SILENT UPDATE IS GONE AT THE RLS LAYER TOO, with the role really
--      set. RED if USING goes back to is_tenant_admin: the statement then
--      matches no rows, raises nothing, and reports success.
--   4  AN ADMIN'S INSERT STILL WORKS, and it writes a LEGITIMATE category
--      rather than a half-formed one, then removes it. 067's lesson: a control
--      that writes an illegal row is not a control.
--   5  AN ADMIN'S UPDATE STILL WORKS, and the row really changed. This is the
--      positive control for SECTION 1 — a policy edit that quietly stopped
--      admins editing would be a worse defect than the one it fixed.
--   6  THE SEED STILL WORKS WITH NO SESSION. seed_charge_categories is
--      SECURITY DEFINER and runs with auth.uid() NULL; an unconditional admin
--      check would have refused all eleven categories and broken the creation
--      of every future tenant. Asserted on a throwaway tenant, because "it
--      would have broken tenant creation" is not a thing to leave to a comment.
--   7  THE BLANK-KEY REFUSAL SURVIVED the re-emission (PT422).
--   8  THE UNMAPPED-KEY REFUSAL SURVIVED (PT424).
--   9  AND SO DID THE UNCHANGED-KEY SHORT-CIRCUIT. An admin renaming a category
--      whose key is no longer mapped must still succeed, because the key did
--      not change. RED if that branch is dropped — and the fixture has to
--      UNMAP a key to make the two paths differ, or the assertion passes either
--      way (rule 27's fourth shape).
--  10  THE POLICIES' END STATE, READ BACK FROM pg_policies rather than from
--      this file: UPDATE using the tenancy test and checking admin, INSERT
--      still checking admin, SELECT untouched.
--  11  THE ADMIN GUARD FIRES FIRST. A non-admin sending a BLANK key gets PT403,
--      not PT422 — "you may not do this" is more use than "the key you chose is
--      wrong" to somebody who may not choose a key (052's ordering). RED if the
--      new block is placed after the existing ones.
--  12  AND A NON-ADMIN CAN STILL READ THEM. The select policy is untouched, and
--      it had better be: AddChargeForm's category list is the front desk's
--      billing menu, so breaking reads here takes down every charge at the
--      counter. Asserted with the role set, like 3.
do $$
declare
  v_tenant   uuid;
  v_user     uuid;
  v_staff    uuid;
  v_t2       uuid;
  v_cat      uuid;
  v_new      uuid;
  v_name     text;
  v_n        integer;
  v_bad      integer;
  v_ok       boolean;
  v_err      text;
  v_state    text;
  v_fail     text := '';
begin
  begin
    select tu.tenant_id, tu.user_id into v_tenant, v_user
    from tenant_users tu where tu.is_active and tu.role in ('owner','manager') limit 1;
    if v_tenant is null then
      raise notice '068 SELF-VERIFY SKIPPED: no tenant with an active owner/manager.';
      raise exception 'ZZ_068_FIXTURE_DONE';
    end if;

    -- A NON-ADMIN MEMBER OF THE SAME TENANT. 'front_desk' is a real role from
    -- 001's list and is_tenant_admin accepts only owner/manager, so this is the
    -- actual shape of the person the guard is about.
    insert into auth.users (id, instance_id, aud, role, email)
    values (gen_random_uuid(), '00000000-0000-0000-0000-000000000000',
            'authenticated', 'authenticated', 'zz068-desk@example.invalid')
    returning id into v_staff;
    insert into tenant_users (tenant_id, user_id, role, is_active)
    values (v_tenant, v_staff, 'front_desk', true);

    select cc.id, cc.name into v_cat, v_name
    from charge_categories cc
    where cc.tenant_id = v_tenant and cc.deleted_at is null
    order by cc.display_order limit 1;
    if v_cat is null then
      raise exception '068 SELF-VERIFY needs at least one charge category.';
    end if;

    -- ===================== 1: A NON-ADMIN CANNOT CREATE ===================
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','sub', v_staff::text)::text, true);
    v_ok := false; v_err := null; v_state := null;
    begin
      insert into charge_categories
        (tenant_id, code, name, is_taxable, service_chargeable, display_order,
         account_role_key)
      values (v_tenant, 'zz068a', 'ZZ068 by the desk', true, false, 901, 'revenue_misc');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT403'
       or v_err not like '%Only a manager or owner can change what a charge category posts to%' then
      v_fail := v_fail || format(
        '1: a front_desk member creating a charge category was answered by %s / %s. A category decides which revenue account every charge in it lands in. ',
        coalesce(v_state, 'a written row'), coalesce(left(v_err, 140), '(no error)'));
    end if;

    -- ===================== 11: AND THE GUARD FIRES FIRST ==================
    v_ok := false; v_err := null; v_state := null;
    begin
      insert into charge_categories
        (tenant_id, code, name, is_taxable, service_chargeable, display_order,
         account_role_key)
      values (v_tenant, 'zz068b', 'ZZ068 blank key', true, false, 902, '   ');
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT403' then
      v_fail := v_fail || format(
        '11: a non-admin sending a BLANK key was answered by %s rather than PT403. "You may not do this" is more use than "the key you chose is wrong" to somebody who may not choose a key, so the admin check belongs first. ',
        coalesce(v_state, 'a written row'));
    end if;

    -- ===================== 2: NOR EDIT, AND NOT SILENTLY ==================
    v_ok := false; v_err := null; v_state := null;
    begin
      update charge_categories set name = 'ZZ068 renamed by the desk' where id = v_cat;
      v_ok := true;
    exception when others then v_err := sqlerrm; v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT403' then
      v_fail := v_fail || format(
        '2: a front_desk member editing a charge category was answered by %s. Before this file it returned SUCCESS and changed nothing, which is the failure shape this codebase treats as worse than a loud one. ',
        coalesce(v_state, 'success with no error'));
    end if;
    select cc.name into v_name from charge_categories cc where cc.id = v_cat;
    if v_name = 'ZZ068 renamed by the desk' then
      v_fail := v_fail || '2: and the edit LANDED. The refusal is decoration if the row changed anyway. ';
    end if;

    -- ===================== 3, 12: WITH THE ROLE REALLY SET ================
    -- The policies are not enforced for the owner this migration runs as, so
    -- without this the RLS half of the shipment would go untested while reading
    -- as proven.
    begin
      execute 'set local role authenticated';
      v_ok := false; v_err := null; v_state := null;
      begin
        update charge_categories set display_order = display_order + 1 where id = v_cat;
        v_ok := true;
      exception when others then v_err := sqlerrm; v_state := sqlstate; end;
      if v_ok then
        v_fail := v_fail || format(
          '3: with the role set to authenticated, a front_desk member''s UPDATE did not raise (it reported success). That is the silent failure SECTION 1 moves the admin test out of USING to end: a statement whose rows are filtered by USING affects nothing and errors about nothing. ', '');
      end if;

      -- and reads still work, which is the front desk's billing menu
      select count(*)::integer into v_n from charge_categories
      where tenant_id = v_tenant and deleted_at is null and is_active;
      if v_n = 0 then
        v_fail := v_fail || '12: a front_desk member can no longer READ charge categories. AddChargeForm''s list is the billing menu, so this would stop every charge at the counter. ';
      end if;
      execute 'reset role';
    exception
      when insufficient_privilege then
        execute 'reset role';
        v_fail := v_fail || '3/12: could not SET ROLE authenticated to test the policies, so the RLS half of this shipment is UNPROVEN rather than proven. ';
    end;

    -- ===================== 4, 5: THE ADMIN PATH STILL WORKS ===============
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','sub', v_user::text)::text, true);
    v_ok := false; v_err := null;
    begin
      insert into charge_categories
        (tenant_id, code, name, is_taxable, service_chargeable, display_order,
         account_role_key)
      values (v_tenant, 'zz068ok', 'ZZ068 conference hall', true, true, 903, 'revenue_misc')
      returning id into v_new;
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if not v_ok then
      v_fail := v_fail || format(
        '4: an ADMIN could not create a legitimate charge category (%s). A guard that blocks the work it is protecting does not get obeyed, it gets routed around. ',
        left(coalesce(v_err, ''), 160));
    else
      update charge_categories set name = 'ZZ068 conference room' where id = v_new;
      select cc.name into v_name from charge_categories cc where cc.id = v_new;
      if v_name is distinct from 'ZZ068 conference room' then
        v_fail := v_fail || format(
          '5: an ADMIN''s rename did not land (name reads %s). SECTION 1 edited this table''s UPDATE policy, so a policy change that quietly stopped admins editing would be worse than the defect it fixed. ',
          coalesce(v_name, 'null'));
      end if;
      -- and cleaned up: the positive control leaves nothing behind.
      delete from charge_categories where id = v_new;
    end if;

    -- ===================== 7, 8: THE OLD REFUSALS SURVIVED ================
    v_ok := false; v_state := null;
    begin
      insert into charge_categories
        (tenant_id, code, name, is_taxable, service_chargeable, display_order,
         account_role_key)
      values (v_tenant, 'zz068c', 'ZZ068 blank', true, false, 904, '  ');
      v_ok := true;
    exception when others then v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT422' then
      v_fail := v_fail || format('7: an ADMIN sending a blank key was answered by %s rather than PT422. ',
        coalesce(v_state, 'a written row'));
    end if;

    v_ok := false; v_state := null;
    begin
      insert into charge_categories
        (tenant_id, code, name, is_taxable, service_chargeable, display_order,
         account_role_key)
      values (v_tenant, 'zz068d', 'ZZ068 unmapped', true, false, 905, 'revenue_zz068_nothing');
      v_ok := true;
    exception when others then v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT424' then
      v_fail := v_fail || format('8: an ADMIN sending an UNMAPPED key was answered by %s rather than PT424. ',
        coalesce(v_state, 'a written row'));
    end if;

    -- ===================== 9: THE UNCHANGED-KEY SHORT-CIRCUIT =============
    -- The fixture has to make the two paths DIFFER, so a key that is mapped now
    -- is unmapped before the rename. Without that, a rename succeeds whether the
    -- short-circuit is there or not and the assertion tests nothing.
    insert into charge_categories
      (tenant_id, code, name, is_taxable, service_chargeable, display_order,
       account_role_key)
    values (v_tenant, 'zz068e', 'ZZ068 orphaned', true, false, 906, 'revenue_damage')
    returning id into v_new;
    delete from account_mappings
    where tenant_id = v_tenant and property_id is null and role_key = 'revenue_damage';
    v_ok := false; v_err := null;
    begin
      update charge_categories set name = 'ZZ068 orphaned, renamed' where id = v_new;
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if not v_ok then
      v_fail := v_fail || format(
        '9: renaming a category whose key is no longer mapped was refused (%s). The key did not change, so the mapping must not be re-checked — otherwise un-mapping an account makes every category on it uneditable, including to repoint it. ',
        left(coalesce(v_err, ''), 140));
    end if;
    -- and changing the KEY on that same row must still be checked
    v_ok := false; v_state := null;
    begin
      update charge_categories set account_role_key = 'revenue_zz068_nothing' where id = v_new;
      v_ok := true;
    exception when others then v_state := sqlstate; end;
    if v_ok or v_state is distinct from 'PT424' then
      v_fail := v_fail || format(
        '9: and changing the key to an unmapped one was answered by %s rather than PT424, so the short-circuit is swallowing the check instead of skipping an unchanged key. ',
        coalesce(v_state, 'a written row'));
    end if;

    -- ===================== 6: THE SEED, WITH NO SESSION ===================
    -- THE ASSERTION THAT WOULD HAVE CAUGHT THIS SHIPMENT BREAKING EVERY FUTURE
    -- TENANT. No claims at all, which is how a migration and a definer RPC run.
    perform set_config('request.jwt.claims', null, true);
    insert into tenants (name, slug) values ('ZZ068 Throwaway', 'zz068-throwaway')
    returning id into v_t2;
    v_ok := false; v_err := null;
    begin
      perform seed_charge_categories(v_t2);
      v_ok := true;
    exception when others then v_err := sqlerrm; end;
    if not v_ok then
      v_fail := v_fail || format(
        '6: seed_charge_categories FAILED with no session (%s). It is SECURITY DEFINER and auth.uid() is NULL there, so an unconditional admin check refuses all eleven categories and no new tenant can be created. ',
        left(coalesce(v_err, ''), 160));
    else
      select count(*)::integer into v_n from charge_categories
      where tenant_id = v_t2 and deleted_at is null;
      if v_n < 11 then
        v_fail := v_fail || format(
          '6: the seed wrote %s categories for a new tenant, expected 11. ', v_n);
      end if;
    end if;
    perform set_config('request.jwt.claims',
      json_build_object('role','authenticated','sub', v_user::text)::text, true);

    -- ===================== 10: THE POLICIES, READ BACK ====================
    select count(*)::integer into v_bad
    from pg_policies p
    where p.tablename = 'charge_categories'
      and p.cmd = 'UPDATE'
      and (coalesce(p.qual, '') like '%is_tenant_admin%'
           or coalesce(p.with_check, '') not like '%is_tenant_admin%');
    if v_bad > 0 then
      v_fail := v_fail || format(
        '10: the UPDATE policy still has is_tenant_admin in USING, or has lost it from WITH CHECK (%s). In USING it filters a non-admin''s statement to nothing and returns success; in WITH CHECK it refuses. Read back from pg_policies rather than from the migration, because the migration is what is being doubted. ',
        v_bad);
    end if;
    select count(*)::integer into v_bad
    from pg_policies p
    where p.tablename = 'charge_categories'
      and p.cmd = 'INSERT'
      and coalesce(p.with_check, '') not like '%is_tenant_admin%';
    if v_bad > 0 then
      v_fail := v_fail || '10: the INSERT policy no longer requires is_tenant_admin. Nothing in this file was meant to touch it. ';
    end if;
    select count(*)::integer into v_bad
    from pg_policies p
    where p.tablename = 'charge_categories'
      and p.cmd = 'SELECT'
      and coalesce(p.qual, '') not like '%get_tenant_ids%';
    if v_bad > 0 then
      v_fail := v_fail || '10: the SELECT policy changed. It is the front desk''s billing menu and nothing here was meant to go near it. ';
    end if;
    select count(*)::integer into v_n from pg_policies where tablename = 'charge_categories';
    if v_n <> 3 then
      v_fail := v_fail || format(
        '10: charge_categories carries %s policies, expected 3 (select, insert, update). A dropped policy fails CLOSED and a duplicated one fails OPEN. ', v_n);
    end if;
    select count(*)::integer into v_n
    from pg_trigger t
    where t.tgrelid = 'charge_categories'::regclass
      and t.tgname = 'enforce_charge_category_account_trigger'
      and t.tgtype & 2 = 2            -- BEFORE
      and t.tgtype & 4 = 4            -- INSERT
      and t.tgtype & 16 = 16;         -- UPDATE
    if v_n <> 1 then
      v_fail := v_fail || '10: the trigger is not present as BEFORE INSERT OR UPDATE. On UPDATE only, a non-admin could create freely; on INSERT only, edit freely. ';
    end if;

    if v_fail <> '' then
      raise exception '068 SELF-VERIFY FAILED — %', v_fail;
    end if;

    raise notice '068 SELF-VERIFY: 12 assertions passed.';
    raise exception 'ZZ_068_FIXTURE_DONE';
  exception
    when others then
      if sqlerrm = 'ZZ_068_FIXTURE_DONE' then
        raise notice '068 self-verify complete; fixture rolled back.';
      else
        raise;
      end if;
  end;
end $$;
