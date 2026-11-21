-- Option: unwrap every present after round 1, so the swap rounds are played with the presents open.
-- Contents become visible to group members once a gift is in game.revealed, now also during the swap turns.

create or replace function public.update_group(p_group uuid, p_name text default null, p_settings jsonb default null, p_signups boolean default null)
returns void language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  g := public._require_host(p_group);
  update groups set
    name = coalesce(nullif(trim(coalesce(p_name, '')), ''), name),
    settings = case when p_settings is null then settings else jsonb_build_object(
      'maxSteals',   least(20, greatest(1, coalesce((p_settings->>'maxSteals')::int, 3))),
      'rounds',      least(5, greatest(1, coalesce((p_settings->>'rounds')::int, 1))),
      'noStealBack', coalesce((p_settings->>'noStealBack')::boolean, true),
      'finalSwap',   coalesce((p_settings->>'finalSwap')::boolean, true),
      'noOwnGift',   coalesce((p_settings->>'noOwnGift')::boolean, true),
      'openAfterFirst', coalesce((p_settings->>'openAfterFirst')::boolean, false)) end,
    signups_open = coalesce(p_signups, signups_open),
    version = version + 1, updated_at = now()
  where id = p_group;
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
     or (g.phase in ('final', 'reveal') and coalesce(g.game->'revealed', '[]'::jsonb) ? x.id::text) then
    return jsonb_build_object('id', x.id, 'name', x.name, 'note', x.note, 'img', x.img, 'from', x.from_player);
  end if;
  raise exception 'No peeking! 🙈';
end $$;

create or replace function public.get_state(p_group uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare g groups; uid uuid := auth.uid(); rev jsonb;
begin
  select * into g from groups where id = p_group and expires_at > now();
  if not found then raise exception 'Group not found'; end if;
  if not public.is_member(p_group) then raise exception 'You are not in this group'; end if;
  rev := case when g.phase in ('final', 'reveal') then coalesce(g.game->'revealed', '[]'::jsonb) else '[]'::jsonb end;
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

-- p_action: pick | steal | swap | keep | reveal | end | undo
create or replace function public.game_action(p_group uuid, p_action text, p_gift uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare
  g groups; h group_history; st jsonb;
  is_h boolean; me uuid; actor uuid; holder uuid; gfrom uuid;
  gid text := p_gift::text; tag text; mine text; msg text;
  maxs int; n int; t int; cnt int; no_own boolean;
  q jsonb; qi int; r int; adv boolean := false;
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
    if not is_h and coalesce((st->>'guided')::boolean, false) then
      raise exception 'The host is unwrapping the presents one at a time — sit tight!'; end if;
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
      else
        -- everyone has a gift: queue up the swap-or-keep turns (extra rounds, then the first player's final swap)
        r := least(5, greatest(1, coalesce((g.settings->>'rounds')::int, 1)));
        q := '[]'::jsonb;
        if n > 1 then
          for i in 2..r loop q := q || (st->'order'); end loop;
          if coalesce((g.settings->>'finalSwap')::boolean, true) then q := q || jsonb_build_array(st->'order'->0); end if;
        end if;
        if jsonb_array_length(q) = 0 then
          g.phase := 'reveal';
        else
          g.phase := 'final';
          st := jsonb_set(st, '{queue}', q);
          st := jsonb_set(st, '{qi}', to_jsonb(0));
          st := jsonb_set(st, '{rounds}', to_jsonb(r));
          st := jsonb_set(st, '{active}', q->0);
          st := public._log(st, case when r > 1 then '🔁 Round 2 of ' || r || ': everyone may swap or keep.'
            else '🏁 Final round: ' || public._pname((q->>0)::uuid) || ' may swap or keep.' end);
          -- optional: open every claimed present now, so the swap turns are played knowing what's inside
          if coalesce((g.settings->>'openAfterFirst')::boolean, false) then
            st := jsonb_set(st, '{revealed}', coalesce((select jsonb_agg(k) from jsonb_object_keys(st->'holdings') k), '[]'::jsonb));
            st := jsonb_set(st, '{opened}', 'true'::jsonb);
            st := public._log(st, '🎉 Every present is unwrapped! From here on you swap knowing what''s inside.');
          end if;
        end if;
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
      if g.phase <> 'final' then raise exception 'You can''t swap right now'; end if;
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
      adv := true;

    elsif p_action = 'keep' then
      if g.phase <> 'final' then raise exception 'Nothing to keep right now'; end if;
      msg := '👍 ' || public._pname(actor) || ' kept their gift.';
      st := public._log(st, msg);
      adv := true;

    else
      raise exception 'Unknown action %', p_action;
    end if;

    -- after a swap or keep: next swap turn, or the reveal when the queue runs out
    if adv then
      q := coalesce(st->'queue', '[]'::jsonb);
      qi := coalesce((st->>'qi')::int, 0) + 1;
      n := jsonb_array_length(st->'order');
      r := coalesce((st->>'rounds')::int, 1);
      if qi >= jsonb_array_length(q) then
        g.phase := 'reveal';
      else
        st := jsonb_set(st, '{qi}', to_jsonb(qi));
        st := jsonb_set(st, '{active}', q->qi);
        if qi = (r - 1) * n then
          st := public._log(st, '🏁 Final round: ' || public._pname((q->>qi)::uuid) || ' may swap or keep.');
        elsif qi % n = 0 then
          st := public._log(st, '🔁 Round ' || (2 + qi / n) || ' of ' || r || ': everyone may swap or keep.');
        end if;
      end if;
    end if;
  end if;

  if g.phase = 'reveal' then
    st := jsonb_set(st, '{active}', 'null'::jsonb);
    st := public._log(st, '🎁 Time for the big reveal!');
  end if;
  st := public._event(st, p_action, gid, msg);
  update groups set phase = g.phase, game = st, version = version + 1, updated_at = now() where id = p_group;
end $$;
