-- Guided reveal: the host unwraps every present one at a time; players wait for the host.

create or replace function public.set_guided_reveal(p_group uuid, p_on boolean)
returns void language plpgsql security definer set search_path = public as $$
declare g groups;
begin
  g := public._require_host(p_group);
  if g.phase <> 'reveal' then raise exception 'It''s not time to unwrap yet'; end if;
  update groups set game = jsonb_set(g.game, '{guided}', to_jsonb(coalesce(p_on, false))),
    version = version + 1, updated_at = now() where id = p_group;
end $$;
revoke execute on function public.set_guided_reveal(uuid, boolean) from public, anon;
grant execute on function public.set_guided_reveal(uuid, boolean) to authenticated;

-- Same as before, plus: while the reveal is guided only the host can unwrap.
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
