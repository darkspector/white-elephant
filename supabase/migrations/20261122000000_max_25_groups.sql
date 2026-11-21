-- Raise the site-wide group cap from 5 to 25 (same signatures, so existing grants carry over).

create or replace function public.site_info() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('groups', (select count(*) from groups where expires_at > now()), 'max', 25, 'weeks', 8);
$$;

create or replace function public.create_group(p_name text, p_host_name text default null, p_password text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare gid uuid; c text; k text; pw text := nullif(trim(coalesce(p_password, '')), '');
begin
  if auth.uid() is null then raise exception 'Not signed in'; end if;
  perform pg_advisory_xact_lock(hashtext('white_elephant_create_group'));
  perform public._purge();
  if (select count(*) from groups) >= 25 then
    raise exception 'All 25 group slots are in use. A slot frees up when a host deletes their group or it expires.'; end if;
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
