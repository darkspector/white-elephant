-- Groups v2: group password, 5-group cap, 8-week lifetime, event date, gift trail,
-- wrapping validation (XSS hardening), "can't take your own gift" rule, player link reset, keep-alive ping.

-- ───────────── lifetime, cap, event date, group password ─────────────
alter table public.groups add column if not exists expires_at timestamptz not null default (now() + interval '8 weeks');
alter table public.groups add column if not exists event_at timestamptz;
alter table public.group_keys add column if not exists join_password text;
alter table public.players add column if not exists rejoin_token text;
alter table public.players add column if not exists released_user uuid;
update public.groups set expires_at = created_at + interval '8 weeks';

create or replace function public._purge() returns void
language sql security definer set search_path = public as $$
  delete from groups where expires_at < now();
$$;

-- Called by the keep-alive job (and harmless for anyone else): wakes the database and clears expired groups.
create or replace function public.ping() returns int
language plpgsql security definer set search_path = public as $$
begin
  perform public._purge();
  return 1;
end $$;

create or replace function public.site_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('groups', (select count(*) from groups where expires_at > now()), 'max', 5, 'weeks', 8);
$$;

drop function if exists public.create_group(text, text);
create or replace function public.create_group(p_name text, p_host_name text default null, p_password text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid; c text; k text; pw text := nullif(trim(coalesce(p_password, '')), '');
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform pg_advisory_xact_lock(hashtext('white_elephant_create_group'));
  perform public._purge();
  if (select count(*) from groups) >= 5 then
    raise exception 'All 5 group slots are in use. A slot frees up when a host deletes their group or it expires.'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 60 then raise exception 'Group name must be 1–60 characters'; end if;
  if pw is not null and char_length(pw) not between 4 and 40 then raise exception 'The group password must be 4–40 characters'; end if;
  loop
    c := (select string_agg(substr('abcdefghjkmnpqrstuvwxyz23456789', 1 + floor(random() * 31)::int, 1), '')
          from generate_series(1, 7));
    exit when not exists (select 1 from groups where code = c);
  end loop;
  k := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into groups (code, name, host_id) values (c, trim(p_name), auth.uid()) returning id into gid;
  insert into group_keys (group_id, host_key, join_password) values (gid, k, pw);
  if char_length(trim(coalesce(p_host_name, ''))) between 1 and 40 then
    insert into players (group_id, user_id, name) values (gid, auth.uid(), trim(p_host_name));
  end if;
  return jsonb_build_object('id', gid, 'code', c, 'host_key', k);
end $$;

create or replace function public.group_info(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name, 'phase', g.phase,
    'signups_open', g.signups_open, 'member', public.is_member(g.id), 'is_host', g.host_id = auth.uid(),
    'event_at', g.event_at, 'expires_at', g.expires_at,
    'needs_password', exists (select 1 from group_keys k where k.group_id = g.id and k.join_password is not null))
  from groups g where g.code = lower(trim(p_code)) and g.expires_at > now();
$$;

-- Host only: the secret host link key and the current group password.
create or replace function public.host_secrets(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from groups where id = p_group and host_id = auth.uid()) then
    raise exception 'Only the host can do that'; end if;
  return (select jsonb_build_object('host_key', host_key, 'join_password', join_password) from group_keys where group_id = p_group);
end $$;

create or replace function public.set_group_password(p_group uuid, p_password text)
returns void language plpgsql security definer set search_path = public as $$
declare pw text := nullif(trim(coalesce(p_password, '')), '');
begin
  perform public._require_host(p_group);
  if pw is not null and char_length(pw) not between 4 and 40 then raise exception 'The group password must be 4–40 characters'; end if;
  update group_keys set join_password = pw where group_id = p_group;
  perform public._touch(p_group);
end $$;

create or replace function public.set_event(p_group uuid, p_event timestamptz)
returns void language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  g := public._require_host(p_group);
  if p_event is not null and p_event < g.created_at - interval '1 day' then raise exception 'That date is in the past'; end if;
  if p_event is not null and p_event > g.expires_at then
    raise exception 'The event has to happen before this group expires on %', to_char(g.expires_at, 'Mon DD, YYYY'); end if;
  update groups set event_at = p_event, version = version + 1, updated_at = now() where id = p_group;
end $$;

create or replace function public.get_state(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g groups; uid uuid := auth.uid(); rev jsonb;
begin
  select * into g from groups where id = p_group and expires_at > now();
  if not found then raise exception 'Group not found'; end if;
  if not public.is_member(p_group) then raise exception 'You are not in this group'; end if;
  rev := case when g.phase = 'reveal' then coalesce(g.game->'revealed', '[]'::jsonb) else '[]'::jsonb end;
  return jsonb_build_object(
    'group', jsonb_build_object('id', g.id, 'code', g.code, 'name', g.name, 'phase', g.phase,
      'settings', g.settings, 'signups_open', g.signups_open, 'game', g.game,
      'created_at', g.created_at, 'expires_at', g.expires_at, 'event_at', g.event_at,
      'has_password', exists (select 1 from group_keys k where k.group_id = g.id and k.join_password is not null),
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

-- ───────────── gift trail (who has held each gift, in order) ─────────────
create or replace function public._trail(st jsonb, p_gift text, p_player uuid) returns jsonb
language sql immutable as $$
  select jsonb_set(jsonb_set(st, '{trail}', coalesce(st->'trail', '{}'::jsonb)), array['trail', p_gift],
    coalesce(st->'trail'->p_gift, '[]'::jsonb) || to_jsonb(p_player::text));
$$;

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
        'holdings', '{}'::jsonb, 'steals', '{}'::jsonb, 'blocked', '{}'::jsonb, 'trail', '{}'::jsonb,
        'revealed', '[]'::jsonb, 'log', '[]'::jsonb),
      '🎲 Order shuffled — ' || public._pname((ord->>0)::uuid) || ' goes first!'),
      'start', null, '🎲 The game has started!')
  where id = p_group;
end $$;

-- ───────────── wrapping validation ─────────────
create or replace function public._clean_wrap(w jsonb) returns jsonb
language plpgsql immutable as $$
declare c text;
begin
  if jsonb_typeof(w) is distinct from 'object' then raise exception 'Invalid wrapping'; end if;
  foreach c in array array['paper', 'patternColor', 'ribbon'] loop
    if coalesce(w->>c, '') !~ '^#[0-9a-fA-F]{6}$' then raise exception 'Invalid wrapping color'; end if;
  end loop;
  if coalesce(w->>'pattern', '') not in ('plain','stripes','dots','zigzag','stars','plaid','checks','snow') then raise exception 'Invalid wrapping pattern'; end if;
  if coalesce(w->>'bow', '') not in ('classic','pompom','star','none') then raise exception 'Invalid bow'; end if;
  if char_length(coalesce(w->>'topper', '')) > 8 then raise exception 'Invalid topper'; end if;
  if char_length(coalesce(w->>'tag', '')) > 10 then raise exception 'Gift tag is too long'; end if;
  return jsonb_build_object('paper', w->>'paper', 'pattern', w->>'pattern', 'patternColor', w->>'patternColor',
    'ribbon', w->>'ribbon', 'bow', w->>'bow', 'topper', coalesce(w->>'topper', ''), 'tag', coalesce(w->>'tag', ''));
end $$;

create or replace function public.save_gift(p_group uuid, p_gift uuid, p_wrap jsonb, p_name text,
  p_note text default '', p_img text default '', p_from uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; me uuid; is_h boolean; gid uuid; fromp uuid; w jsonb;
begin
  select * into g from groups where id = p_group for update;
  if not found then raise exception 'Group not found'; end if;
  if g.phase <> 'lobby' then raise exception 'Gifts are locked once the game starts'; end if;
  is_h := coalesce(g.host_id = auth.uid(), false);
  select id into me from players where group_id = p_group and user_id = auth.uid();
  if not is_h and me is null then raise exception 'Join the group first'; end if;
  if char_length(trim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'Give the item a name (up to 120 characters)'; end if;
  w := public._clean_wrap(p_wrap);
  if coalesce(p_img, '') <> '' and p_img !~* '^(https?://|data:image/(jpeg|png|gif|webp);base64,)' then
    raise exception 'The picture must be an uploaded photo or an http(s) image link'; end if;
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
    values (p_group, auth.uid(), fromp, w, trim(p_name), coalesce(p_note, ''), coalesce(p_img, ''))
    returning id into gid;
  else
    update gifts set wrap = w, name = trim(p_name), note = coalesce(p_note, ''), img = coalesce(p_img, ''), from_player = fromp
     where id = p_gift and group_id = p_group and created_by = auth.uid()
    returning id into gid;
    if gid is null then raise exception 'You can only edit gifts you added'; end if;
  end if;
  perform public._touch(p_group);
  return gid;
end $$;

-- ───────────── rejoin from a new device ─────────────
-- The host resets a player's link and gets a one-time token back. The app turns it into a personal
-- rejoin link the host sends to that player. Opening it moves the seat (and the gift they added)
-- to the new device. Knowing the player's name is NOT enough to take a reset seat.
drop function if exists public.host_release_player(uuid);
create or replace function public.host_release_player(p_player uuid)
returns text language plpgsql security definer set search_path = public as $$
declare p players; tok text := replace(gen_random_uuid()::text, '-', '');
begin
  select * into p from players where id = p_player;
  if not found then raise exception 'Unknown player'; end if;
  perform public._require_host(p.group_id);
  if p.user_id = auth.uid() then raise exception 'You can''t reset your own link'; end if;
  update players set released_user = coalesce(user_id, released_user), user_id = null, rejoin_token = tok where id = p_player;
  perform public._touch(p.group_id);
  return tok;
end $$;

create or replace function public.rejoin(p_code text, p_token text)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; p players;
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  select * into g from groups where code = lower(trim(p_code)) and expires_at > now() for update;
  if not found then raise exception 'That link is not valid'; end if;
  select * into p from players where group_id = g.id and rejoin_token is not null and rejoin_token = p_token;
  if not found then raise exception 'That rejoin link was already used or replaced — ask the host for a new one'; end if;
  if exists (select 1 from players where group_id = g.id and user_id = auth.uid()) then
    raise exception 'This browser is already in the group as someone else'; end if;
  if p.released_user is not null and p.released_user <> g.host_id then
    update gifts set created_by = auth.uid() where group_id = g.id and created_by = p.released_user;
  end if;
  update players set user_id = auth.uid(), rejoin_token = null, released_user = null where id = p.id;
  perform public._touch(g.id);
  return p.id;
end $$;

-- A device that was reset out of the group must not be able to delete the gift it used to own.
create or replace function public.delete_gift(p_gift uuid)
returns void language plpgsql security definer set search_path = public as $$
declare x gifts; g groups;
begin
  select * into x from gifts where id = p_gift;
  if not found then return; end if;
  select * into g from groups where id = x.group_id for update;
  if not public.is_member(g.id) or not coalesce(x.created_by = auth.uid() or g.host_id = auth.uid(), false) then
    raise exception 'You can''t delete that gift'; end if;
  if g.phase <> 'lobby' then raise exception 'Gifts are locked once the game starts'; end if;
  delete from gifts where id = p_gift;
  perform public._touch(g.id);
end $$;

drop function if exists public.join_group(text, text);
create or replace function public.join_group(p_code text, p_name text, p_password text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare g groups; pid uuid; pw text; n text := trim(coalesce(p_name, ''));
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  if char_length(n) not between 1 and 40 then raise exception 'Names must be 1–40 characters'; end if;
  -- password check happens before taking the row lock so wrong guesses can't stall the group
  select * into g from groups where code = lower(trim(p_code)) and expires_at > now();
  if not found then raise exception 'That invite link is not valid'; end if;
  select id into pid from players where group_id = g.id and user_id = auth.uid();
  select join_password into pw from group_keys where group_id = g.id;
  if pid is null and pw is not null and g.host_id is distinct from auth.uid() and coalesce(p_password, '') <> pw then
    raise exception 'Wrong group password';
  end if;
  select * into g from groups where id = g.id for update;
  if pid is not null then
    update players set name = n where id = pid;                       -- rename
  else
    select id into pid from players
     where group_id = g.id and user_id is null and rejoin_token is null and lower(name) = lower(n);
    if pid is not null then
      update players set user_id = auth.uid() where id = pid;         -- claim a spot the host added (no gift access)
    else
      if g.phase <> 'lobby' then raise exception 'This game has already started — ask the host to add you'; end if;
      if not g.signups_open and g.host_id <> auth.uid() then raise exception 'Signups are closed — ask the host to add you'; end if;
      insert into players (group_id, user_id, name) values (g.id, auth.uid(), n) returning id into pid;
    end if;
  end if;
  perform public._touch(g.id);
  return pid;
exception when unique_violation then
  raise exception 'Someone in this group already uses that name. If that''s you on a new device or browser, ask the host for a personal rejoin link.';
end $$;

-- ───────────── settings: can't take your own gift ─────────────
alter table public.groups alter column settings
  set default '{"maxSteals":3,"noStealBack":true,"finalSwap":true,"noOwnGift":true}';

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
      'finalSwap',   coalesce((p_settings->>'finalSwap')::boolean, true),
      'noOwnGift',   coalesce((p_settings->>'noOwnGift')::boolean, true)) end,
    signups_open = coalesce(p_signups, signups_open),
    version = version + 1, updated_at = now()
  where id = p_group;
end $$;

-- p_action: pick | steal | swap | keep | reveal | end | undo
create or replace function public.game_action(p_group uuid, p_action text, p_gift uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  g groups; h group_history; st jsonb;
  is_h boolean; me uuid; actor uuid; holder uuid; gfrom uuid;
  gid text := p_gift::text; tag text; mine text; msg text;
  maxs int; n int; t int; cnt int; no_own boolean;
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
  no_own := coalesce((g.settings->>'noOwnGift')::boolean, true);

  if p_gift is not null then
    select coalesce(nullif(wrap->>'tag', ''), 'a gift'), from_player into tag, gfrom from gifts where id = p_gift and group_id = p_group;
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
      -- own gift is off limits unless it is the only one left in the pile
      if no_own and gfrom is not null and gfrom = actor and exists (
           select 1 from gifts x where x.group_id = p_group and x.id <> p_gift and not (st->'holdings' ? x.id::text)) then
        raise exception 'That''s the gift % brought — pick a different one', public._pname(actor); end if;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      st := public._trail(st, gid, actor);
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
      if no_own and gfrom is not null and gfrom = actor then
        raise exception 'That''s the gift % brought — no taking it back', public._pname(actor); end if;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      st := public._trail(st, gid, actor);
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
      if no_own and gfrom is not null and gfrom = actor then
        raise exception 'That''s the gift % brought — no taking it back', public._pname(actor); end if;
      select key into mine from jsonb_each_text(st->'holdings') where value = actor::text limit 1;
      if no_own and mine is not null and exists (select 1 from gifts where id = mine::uuid and from_player = holder) then
        raise exception 'That swap isn''t allowed — it would hand someone their own gift back'; end if;
      st := jsonb_set(st, array['holdings', gid], to_jsonb(actor::text));
      st := public._trail(st, gid, actor);
      if mine is not null then
        st := jsonb_set(st, array['holdings', mine], to_jsonb(holder::text));
        st := public._trail(st, mine, holder);
      end if;
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

-- ───────────── permissions ─────────────
revoke execute on all functions in schema public from public, anon;
revoke execute on function public._clean_wrap(jsonb), public._purge(), public._trail(jsonb, text, uuid) from authenticated;
grant execute on function public.ping() to anon, authenticated;
grant execute on function
  public.site_info(),
  public.create_group(text, text, text),
  public.join_group(text, text, text),
  public.host_secrets(uuid),
  public.set_group_password(uuid, text),
  public.set_event(uuid, timestamptz),
  public.host_release_player(uuid),
  public.rejoin(text, text)
to authenticated;
