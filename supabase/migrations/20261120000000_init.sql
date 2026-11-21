-- White Elephant — Supabase schema
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- Safe to re-run (it updates functions/policies in place).
--
-- Security model: players use anonymous sign-in. Tables are NOT directly readable/writable by
-- clients; everything goes through the SECURITY DEFINER functions below, which enforce
-- membership, host rights, game rules, and hide gift contents until each gift is revealed.

-- ───────────── tables ─────────────
create table if not exists public.groups (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique,
  name         text not null check (char_length(name) between 1 and 60),
  host_id      uuid not null,
  signups_open boolean not null default true,
  settings     jsonb not null default '{"maxSteals":3,"noStealBack":true,"finalSwap":true}',
  phase        text not null default 'lobby' check (phase in ('lobby','play','final','reveal')),
  game         jsonb,
  version      bigint not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table if not exists public.group_keys (
  group_id uuid primary key references public.groups on delete cascade,
  host_key text not null
);

create table if not exists public.players (
  id         uuid primary key default gen_random_uuid(),
  group_id   uuid not null references public.groups on delete cascade,
  user_id    uuid,                       -- null = added by host, not yet claimed
  name       text not null check (char_length(name) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (group_id, user_id)
);
create unique index if not exists players_name_uniq on public.players (group_id, lower(name));

create table if not exists public.gifts (
  id          uuid primary key default gen_random_uuid(),
  group_id    uuid not null references public.groups on delete cascade,
  created_by  uuid not null,
  from_player uuid references public.players on delete set null,
  wrap        jsonb not null,
  name        text not null check (char_length(name) between 1 and 120),
  note        text not null default '' check (char_length(note) <= 500),
  img         text not null default '' check (char_length(img) <= 1500000),
  created_at  timestamptz not null default now()
);
create index if not exists gifts_group_idx on public.gifts (group_id);

create table if not exists public.group_history (
  id       bigserial primary key,
  group_id uuid not null references public.groups on delete cascade,
  phase    text not null,
  game     jsonb
);
create index if not exists group_history_idx on public.group_history (group_id, id);

-- ───────────── helpers ─────────────
create or replace function public.is_member(p_group uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from groups where id = p_group and host_id = auth.uid())
      or exists (select 1 from players where group_id = p_group and user_id = auth.uid());
$$;

create or replace function public._touch(p_group uuid) returns void
language sql security definer set search_path = public as $$
  update groups set version = version + 1, updated_at = now() where id = p_group;
$$;

create or replace function public._require_host(p_group uuid) returns public.groups
language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  select * into g from groups where id = p_group for update;
  if not found then raise exception 'Group not found'; end if;
  if g.host_id is distinct from auth.uid() then raise exception 'Only the host can do that'; end if;
  return g;
end $$;

create or replace function public._pname(p_player uuid) returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from players where id = p_player), 'Someone');
$$;

create or replace function public._log(st jsonb, msg text) returns jsonb
language sql immutable as $$
  select jsonb_set(st, '{log}', jsonb_build_array(msg) || coalesce(
    (select jsonb_agg(e order by i) from jsonb_array_elements(coalesce(st->'log', '[]'::jsonb)) with ordinality as x(e, i) where i < 80),
    '[]'::jsonb));
$$;

create or replace function public._event(st jsonb, p_type text, p_gift text, p_text text) returns jsonb
language sql immutable as $$
  select jsonb_set(st, '{event}', jsonb_build_object(
    'seq', coalesce((st->'event'->>'seq')::int, 0) + 1, 'type', p_type, 'gift', p_gift, 'text', p_text));
$$;

-- ───────────── row level security ─────────────
alter table public.groups        enable row level security;
alter table public.group_keys    enable row level security;
alter table public.players       enable row level security;
alter table public.gifts         enable row level security;
alter table public.group_history enable row level security;

revoke all on public.groups, public.group_keys, public.players, public.gifts, public.group_history from anon, authenticated;
-- Members may read their group's row: only needed so Realtime can push "something changed" pings.
grant select on public.groups to authenticated;
drop policy if exists groups_member_read on public.groups;
create policy groups_member_read on public.groups for select to authenticated using (public.is_member(id));

do $$ begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'groups') then
    alter publication supabase_realtime add table public.groups;
  end if;
end $$;

-- ───────────── group & membership API ─────────────
create or replace function public.create_group(p_name text, p_host_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid; c text; k text;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'Group name must be 1–60 characters'; end if;
  loop
    c := (select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '')
          from generate_series(1, 7));
    exit when not exists (select 1 from groups where code = c);
  end loop;
  k := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into groups (code, name, host_id) values (c, trim(p_name), auth.uid()) returning id into gid;
  insert into group_keys values (gid, k);
  if char_length(trim(coalesce(p_host_name, ''))) between 1 and 40 then
    insert into players (group_id, user_id, name) values (gid, auth.uid(), trim(p_host_name));
  end if;
  return jsonb_build_object('id', gid, 'code', c, 'host_key', k);
end $$;

create or replace function public.group_info(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name, 'phase', g.phase,
    'signups_open', g.signups_open, 'member', public.is_member(g.id), 'is_host', g.host_id = auth.uid())
  from groups g where g.code = lower(trim(p_code));
$$;

create or replace function public.claim_host(p_code text, p_key text)
returns uuid language plpgsql security definer set search_path = public as $$
declare gid uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select g.id into gid from groups g join group_keys k on k.group_id = g.id
   where g.code = lower(trim(p_code)) and k.host_key = p_key;
  if gid is null then raise exception 'That host link is not valid'; end if;
  update groups set host_id = auth.uid(), version = version + 1, updated_at = now() where id = gid;
  return gid;
end $$;

create or replace function public.get_host_key(p_group uuid)
returns text language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from groups where id = p_group and host_id = auth.uid()) then
    raise exception 'Only the host can do that'; end if;
  return (select host_key from group_keys where group_id = p_group);
end $$;

create or replace function public.join_group(p_code text, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; pid uuid; n text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(n) not between 1 and 40 then raise exception 'Names must be 1–40 characters'; end if;
  select * into g from groups where code = lower(trim(p_code)) for update;
  if not found then raise exception 'That invite link is not valid'; end if;
  select id into pid from players where group_id = g.id and user_id = auth.uid();
  if pid is not null then
    update players set name = n where id = pid;                       -- rename
  else
    select id into pid from players where group_id = g.id and user_id is null and lower(name) = lower(n);
    if pid is not null then
      update players set user_id = auth.uid() where id = pid;         -- claim a host-added spot
    else
      if g.phase <> 'lobby' then raise exception 'This game has already started — ask the host to add you'; end if;
      if not g.signups_open and g.host_id <> auth.uid() then raise exception 'Signups are closed — ask the host to add you'; end if;
      insert into players (group_id, user_id, name) values (g.id, auth.uid(), n) returning id into pid;
    end if;
  end if;
  perform public._touch(g.id);
  return pid;
exception when unique_violation then
  raise exception 'Someone in this group already uses that name';
end $$;

create or replace function public.host_add_player(p_group uuid, p_name text)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; pid uuid; n text := trim(coalesce(p_name, ''));
begin
  g := public._require_host(p_group);
  if g.phase <> 'lobby' then raise exception 'Players are locked once the game starts'; end if;
  if char_length(n) not between 1 and 40 then raise exception 'Names must be 1–40 characters'; end if;
  insert into players (group_id, user_id, name) values (p_group, null, n) returning id into pid;
  perform public._touch(p_group);
  return pid;
exception when unique_violation then
  raise exception 'Someone in this group already uses that name';
end $$;

create or replace function public.remove_player(p_player uuid)
returns void language plpgsql security definer set search_path = public as $$
declare p players; g groups;
begin
  select * into p from players where id = p_player;
  if not found then return; end if;
  select * into g from groups where id = p.group_id for update;
  if not coalesce(g.host_id = auth.uid() or p.user_id = auth.uid(), false) then raise exception 'You can''t remove that player'; end if;
  if g.phase <> 'lobby' then raise exception 'Players are locked once the game starts'; end if;
  delete from gifts where group_id = g.id
    and (from_player = p.id or (p.user_id is not null and created_by = p.user_id and created_by <> g.host_id));
  delete from players where id = p.id;
  perform public._touch(g.id);
end $$;

create or replace function public.update_group(p_group uuid, p_name text default null, p_settings jsonb default null, p_signups boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  g := public._require_host(p_group);
  update groups set
    name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    settings = case when p_settings is null then settings else jsonb_build_object(
      'maxSteals',   least(20, greatest(1, coalesce((p_settings->>'maxSteals')::int, 3))),
      'noStealBack', coalesce((p_settings->>'noStealBack')::boolean, true),
      'finalSwap',   coalesce((p_settings->>'finalSwap')::boolean, true)) end,
    signups_open = coalesce(p_signups, signups_open),
    version = version + 1, updated_at = now()
  where id = p_group;
end $$;

create or replace function public.delete_group(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_host(p_group);
  delete from groups where id = p_group;
end $$;

-- ───────────── gifts API ─────────────
create or replace function public.save_gift(p_group uuid, p_gift uuid, p_wrap jsonb, p_name text,
  p_note text default '', p_img text default '', p_from uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; me uuid; is_h boolean; gid uuid; fromp uuid;
begin
  select * into g from groups where id = p_group for update;
  if not found then raise exception 'Group not found'; end if;
  if g.phase <> 'lobby' then raise exception 'Gifts are locked once the game starts'; end if;
  is_h := coalesce(g.host_id = auth.uid(), false);
  select id into me from players where group_id = p_group and user_id = auth.uid();
  if not is_h and me is null then raise exception 'Join the group first'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'Give the item a name (up to 120 characters)'; end if;
  if jsonb_typeof(p_wrap) is distinct from 'object' then raise exception 'Invalid wrapping'; end if;
  if is_h then
    fromp := p_from;
    if fromp is not null and not exists (select 1 from players where id = fromp and group_id = p_group) then
      raise exception 'Unknown player'; end if;
  else
    fromp := me;
  end if;
  if p_gift is null then
    if not is_h and exists (select 1 from gifts where group_id = p_group and created_by = auth.uid()) then
      raise exception 'You already added a gift — edit that one instead'; end if;
    insert into gifts (group_id, created_by, from_player, wrap, name, note, img)
    values (p_group, auth.uid(), fromp, p_wrap, trim(p_name), coalesce(p_note, ''), coalesce(p_img, ''))
    returning id into gid;
  else
    update gifts set wrap = p_wrap, name = trim(p_name), note = coalesce(p_note, ''), img = coalesce(p_img, ''), from_player = fromp
     where id = p_gift and group_id = p_group and created_by = auth.uid()
    returning id into gid;
    if gid is null then raise exception 'You can only edit gifts you added'; end if;
  end if;
  perform public._touch(p_group);
  return gid;
end $$;

create or replace function public.delete_gift(p_gift uuid)
returns void language plpgsql security definer set search_path = public as $$
declare x gifts; g groups;
begin
  select * into x from gifts where id = p_gift;
  if not found then return; end if;
  select * into g from groups where id = x.group_id for update;
  if not coalesce(x.created_by = auth.uid() or g.host_id = auth.uid(), false) then raise exception 'You can''t delete that gift'; end if;
  if g.phase <> 'lobby' then raise exception 'Gifts are locked once the game starts'; end if;
  delete from gifts where id = p_gift;
  perform public._touch(g.id);
end $$;

create or replace function public.get_gift(p_gift uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare x gifts; g groups;
begin
  select * into x from gifts where id = p_gift;
  if not found then raise exception 'Gift not found'; end if;
  select * into g from groups where id = x.group_id;
  if not public.is_member(g.id) then raise exception 'You are not in this group'; end if;
  if x.created_by = auth.uid()
     or (g.phase = 'reveal' and coalesce(g.game->'revealed', '[]'::jsonb) ? x.id::text) then
    return jsonb_build_object('id', x.id, 'name', x.name, 'note', x.note, 'img', x.img, 'from', x.from_player);
  end if;
  raise exception 'No peeking! 🙈';
end $$;

create or replace function public.get_state(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g groups; uid uuid := auth.uid(); rev jsonb;
begin
  select * into g from groups where id = p_group;
  if not found then raise exception 'Group not found'; end if;
  if not public.is_member(p_group) then raise exception 'You are not in this group'; end if;
  rev := case when g.phase = 'reveal' then coalesce(g.game->'revealed', '[]'::jsonb) else '[]'::jsonb end;
  return jsonb_build_object(
    'group', jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name, 'phase', g.phase,
      'settings', g.settings, 'signups_open', g.signups_open, 'game', g.game,
      'is_host', coalesce(g.host_id = uid, false),
      'can_undo', exists (select 1 from group_history h where h.group_id = g.id)),
    'me', (select id from players where group_id = g.id and user_id = uid),
    'players', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name,
        'joined', p.user_id is not null,
        'has_gift', exists (select 1 from gifts x where x.from_player = p.id)) order by p.created_at)
      from players p where p.group_id = g.id), '[]'::jsonb),
    'gifts', coalesce((select jsonb_agg(jsonb_build_object('id', x.id, 'wrap', x.wrap,
        'mine', x.created_by = uid,
        'from', case when x.created_by = uid or rev ? x.id::text then x.from_player end) order by x.created_at)
      from gifts x where x.group_id = g.id), '[]'::jsonb));
end $$;

-- ───────────── game API ─────────────
create or replace function public.start_game(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
declare g groups; ord jsonb; np int; ng int;
begin
  g := public._require_host(p_group);
  if g.phase <> 'lobby' then raise exception 'The game already started'; end if;
  select count(*) into np from players where group_id = p_group;
  select count(*) into ng from gifts where group_id = p_group;
  if np < 2 then raise exception 'You need at least 2 players'; end if;
  if ng < np then raise exception 'You need % more gift(s)', np - ng; end if;
  select jsonb_agg(id::text order by random()) into ord from players where group_id = p_group;
  delete from group_history where group_id = p_group;
  update groups set phase = 'play', signups_open = false, version = version + 1, updated_at = now(),
    game = public._event(public._log(jsonb_build_object(
        'order', ord, 'turn', 0, 'active', ord->0,
        'holdings', '{}'::jsonb, 'steals', '{}'::jsonb, 'blocked', '{}'::jsonb,
        'revealed', '[]'::jsonb, 'log', '[]'::jsonb),
      '🎲 Order shuffled — ' || public._pname((ord->>0)::uuid) || ' goes first!'),
      'start', null, '🎲 The game has started!')
  where id = p_group;
end $$;

create or replace function public.reset_game(p_group uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_host(p_group);
  delete from group_history where group_id = p_group;
  update groups set phase = 'lobby', game = null, version = version + 1, updated_at = now() where id = p_group;
end $$;

-- p_action: pick | steal | swap | keep | reveal | end | undo
create or replace function public.game_action(p_group uuid, p_action text, p_gift uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  g groups; h group_history; st jsonb;
  is_h boolean; me uuid; actor uuid; holder uuid;
  gid text := p_gift::text; tag text; mine text; msg text;
  maxs int; n int; t int; cnt int;
begin
  select * into g from groups where id = p_group for update;
  if not found then raise exception 'Group not found'; end if;
  is_h := coalesce(g.host_id = auth.uid(), false);
  select id into me from players where group_id = p_group and user_id = auth.uid();
  if not is_h and me is null then raise exception 'You are not in this group'; end if;

  if p_action = 'undo' then
    if not is_h then raise exception 'Only the host can undo'; end if;
    select * into h from group_history where group_id = p_group order by id desc limit 1;
    if not found then raise exception 'Nothing to undo'; end if;
    delete from group_history where id = h.id;
    update groups set phase = h.phase, game = h.game, version = version + 1, updated_at = now() where id = p_group;
    return;
  end if;

  if g.phase not in ('play', 'final', 'reveal') then raise exception 'The game has not started yet'; end if;
  st := g.game;
  maxs := coalesce((g.settings->>'maxSteals')::int, 3);

  if p_gift is not null then
    select coalesce(nullif(wrap->>'tag', ''), 'a gift') into tag from gifts where id = p_gift and group_id = p_group;
    if not found then raise exception 'Unknown gift'; end if;
    holder := (st->'holdings'->>gid)::uuid;
  elsif p_action in ('pick', 'steal', 'swap', 'reveal') then
    raise exception 'No gift chosen';
  end if;

  -- unwrapping (no undo history)
  if p_action = 'reveal' then
    if g.phase <> 'reveal' then raise exception 'It''s not time to unwrap yet'; end if;
    if not (is_h or (holder is not null and holder = me)) then
      raise exception 'Only the host or the gift''s owner can unwrap it'; end if;
    if coalesce(st->'revealed', '[]'::jsonb) ? gid then return; end if;
    st := jsonb_set(st, '{revealed}', coalesce(st->'revealed', '[]'::jsonb) || to_jsonb(gid));
    st := public._event(st, 'reveal', gid, null);
    update groups set game = st, version = version + 1, updated_at = now() where id = p_group;
    return;
  end if;

  -- turn actions: keep the previous state for undo
  insert into group_history (group_id, phase, game) values (p_group, g.phase, st);
  delete from group_history where group_id = p_group
    and id not in (select id from group_history where group_id = p_group order by id desc limit 60);

  actor := (st->>'active')::uuid;

  if p_action = 'end' then
    if not is_h then raise exception 'Only the host can do that'; end if;
    if g.phase = 'reveal' then raise exception 'Already revealing'; end if;
    msg := '⏩ The host ended the game early.';
    st := public._log(st, msg);
    g.phase := 'reveal';
  else
    if g.phase = 'reveal' then raise exception 'The game is over — time to unwrap!'; end if;
    if not is_h and me is distinct from actor then raise exception 'It''s not your turn'; end if;

    if p_action = 'pick' then
      if g.phase <> 'play' then raise exception 'You can''t pick from the pile right now'; end if;
      if holder is not null then raise exception 'That gift is already taken'; end if;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      msg := '🎁 ' || public._pname(actor) || ' picked ' || tag || '.';
      st := public._log(st, msg);
      st := jsonb_set(st, '{blocked}', '{}'::jsonb);
      t := (st->>'turn')::int + 1;
      n := jsonb_array_length(st->'order');
      st := jsonb_set(st, '{turn}', to_jsonb(t));
      if t < n then
        st := jsonb_set(st, '{active}', st->'order'->t);
      elsif coalesce((g.settings->>'finalSwap')::boolean, true) and n > 1 then
        g.phase := 'final';
        st := jsonb_set(st, '{active}', st->'order'->0);
        st := public._log(st, '🏁 Final round: ' || public._pname((st->'order'->>0)::uuid) || ' may swap or keep.');
      else
        g.phase := 'reveal';
      end if;

    elsif p_action = 'steal' then
      if g.phase <> 'play' then raise exception 'You can''t steal right now'; end if;
      if holder is null then raise exception 'Nobody has that gift yet'; end if;
      if holder = actor then raise exception 'That gift is already yours'; end if;
      cnt := coalesce((st->'steals'->>gid)::int, 0);
      if cnt >= maxs then raise exception 'That gift is locked 🔒'; end if;
      if coalesce((g.settings->>'noStealBack')::boolean, true)
         and coalesce(st->'blocked'->(actor::text), '[]'::jsonb) ? gid then
        raise exception 'No immediate steal-backs'; end if;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      st := jsonb_set(st, array['steals', gid], to_jsonb(cnt + 1));
      st := jsonb_set(st, array['blocked', holder::text], coalesce(st->'blocked'->(holder::text), '[]'::jsonb) || to_jsonb(gid));
      st := jsonb_set(st, '{active}', to_jsonb(holder::text));
      msg := '😈 ' || public._pname(actor) || ' stole ' || tag || ' from ' || public._pname(holder)
             || case when cnt + 1 >= maxs then ' — now LOCKED 🔒' else '' end || '!';
      st := public._log(st, msg);

    elsif p_action = 'swap' then
      if g.phase <> 'final' then raise exception 'Swapping only happens in the final round'; end if;
      if holder is null then raise exception 'Nobody has that gift'; end if;
      if holder = actor then raise exception 'That gift is already yours'; end if;
      cnt := coalesce((st->'steals'->>gid)::int, 0);
      if cnt >= maxs then raise exception 'That gift is locked 🔒'; end if;
      select key into mine from jsonb_each_text(st->'holdings') where value = actor::text limit 1;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      if mine is not null then st := jsonb_set(st, array['holdings', mine], to_jsonb(holder::text)); end if;
      st := jsonb_set(st, array['steals', gid], to_jsonb(cnt + 1));
      msg := '🔁 ' || public._pname(actor) || ' swapped with ' || public._pname(holder) || '!';
      st := public._log(st, msg);
      g.phase := 'reveal';

    elsif p_action = 'keep' then
      if g.phase <> 'final' then raise exception 'Nothing to keep right now'; end if;
      msg := '👍 ' || public._pname(actor) || ' kept their gift.';
      st := public._log(st, msg);
      g.phase := 'reveal';

    else
      raise exception 'Unknown action %', p_action;
    end if;
  end if;

  if g.phase = 'reveal' then
    st := jsonb_set(st, '{active}', 'null'::jsonb);
    st := public._log(st, '🎁 Time for the big reveal!');
  end if;
  st := public._event(st, p_action, gid, msg);
  update groups set phase = g.phase, game = st, version = version + 1, updated_at = now() where id = p_group;
end $$;

-- ───────────── function permissions ─────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function public._touch(uuid), public._require_host(uuid), public._pname(uuid),
  public._log(jsonb, text), public._event(jsonb, text, text, text) from authenticated;
grant execute on function
  public.is_member(uuid),
  public.create_group(text, text),
  public.group_info(text),
  public.claim_host(text, text),
  public.get_host_key(uuid),
  public.join_group(text, text),
  public.host_add_player(uuid, text),
  public.remove_player(uuid),
  public.update_group(uuid, text, jsonb, boolean),
  public.delete_group(uuid),
  public.save_gift(uuid, uuid, jsonb, text, text, text, uuid),
  public.delete_gift(uuid),
  public.get_gift(uuid),
  public.get_state(uuid),
  public.start_game(uuid),
  public.reset_game(uuid),
  public.game_action(uuid, text, uuid)
to authenticated;
