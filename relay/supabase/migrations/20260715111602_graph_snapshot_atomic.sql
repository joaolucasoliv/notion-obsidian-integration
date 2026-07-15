create function public.bridge_store_graph_snapshot_if_newer(
  p_installation_id uuid,
  p_graph_id uuid,
  p_sequence bigint,
  p_key_id text,
  p_envelope jsonb,
  p_byte_length integer,
  p_created_at timestamptz,
  p_expected_sequence bigint default null
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if (
    p_sequence <= 0
    or p_key_id is null
    or length(p_key_id) = 0
    or length(p_key_id) > 256
    or p_envelope is null
    or jsonb_typeof(p_envelope) <> 'object'
    or p_envelope ->> 'installationId' is distinct from p_installation_id::text
    or p_envelope ->> 'keyId' is distinct from p_key_id
    or p_envelope ->> 'sequence' is distinct from p_sequence::text
    or p_byte_length is null
    or p_byte_length not between 1 and 8388608
    or p_created_at is null
  ) then
    return false;
  end if;

  update public.bridge_installation
  set
    snapshot_sequence = p_sequence,
    graph_key_id = p_key_id,
    last_seen_at = clock_timestamp()
  where id = p_installation_id
    and graph_id = p_graph_id
    and snapshot_sequence < p_sequence
    and (p_expected_sequence is null or snapshot_sequence = p_expected_sequence);

  if not found then
    return false;
  end if;

  insert into public.graph_snapshot (
    installation_id,
    graph_id,
    sequence,
    key_id,
    envelope,
    byte_length,
    created_at
  ) values (
    p_installation_id,
    p_graph_id,
    p_sequence,
    p_key_id,
    p_envelope,
    p_byte_length,
    p_created_at
  )
  on conflict (installation_id) do update set
    graph_id = excluded.graph_id,
    sequence = excluded.sequence,
    key_id = excluded.key_id,
    envelope = excluded.envelope,
    byte_length = excluded.byte_length,
    created_at = excluded.created_at;

  return true;
end;
$$;

create function public.bridge_read_graph_snapshot(
  p_graph_id uuid,
  p_limit integer default 60,
  p_window_seconds integer default 60
)
returns table (
  allowed boolean,
  window_started_at timestamptz,
  envelope jsonb
)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  installation public.bridge_installation%rowtype;
  now_at timestamptz := clock_timestamp();
  next_window_started_at timestamptz;
  snapshot_envelope jsonb;
begin
  if p_limit < 1 or p_window_seconds < 1 then
    raise exception 'invalid graph read window';
  end if;

  select * into installation
  from public.bridge_installation
  where graph_id = p_graph_id
  for update;

  if not found then
    return query select true, now_at, null::jsonb;
    return;
  end if;

  if installation.graph_rate_window_started_at <= now_at - make_interval(secs => p_window_seconds) then
    next_window_started_at := now_at;
    update public.bridge_installation
    set graph_rate_window_started_at = next_window_started_at, graph_rate_count = 1
    where id = installation.id;
  elsif installation.graph_rate_count >= p_limit then
    return query select false, installation.graph_rate_window_started_at, null::jsonb;
    return;
  else
    next_window_started_at := installation.graph_rate_window_started_at;
    update public.bridge_installation
    set graph_rate_count = graph_rate_count + 1
    where id = installation.id;
  end if;

  select snapshot.envelope into snapshot_envelope
  from public.graph_snapshot as snapshot
  where snapshot.installation_id = installation.id
    and snapshot.graph_id = p_graph_id;

  return query select true, next_window_started_at, snapshot_envelope;
end;
$$;

create function public.bridge_read_installation_snapshot(p_installation_id uuid)
returns table (
  installation_id uuid,
  graph_id uuid,
  sequence bigint,
  key_id text,
  envelope jsonb,
  byte_length integer,
  created_at timestamptz
)
language sql
security invoker
set search_path = public, pg_temp
as $$
  select
    snapshot.installation_id,
    snapshot.graph_id,
    snapshot.sequence,
    snapshot.key_id,
    snapshot.envelope,
    snapshot.byte_length,
    snapshot.created_at
  from public.graph_snapshot as snapshot
  where snapshot.installation_id = p_installation_id;
$$;

revoke all on function public.bridge_store_graph_snapshot_if_newer(uuid, uuid, bigint, text, jsonb, integer, timestamptz, bigint) from public, anon, authenticated;
revoke all on function public.bridge_read_graph_snapshot(uuid, integer, integer) from public, anon, authenticated;
revoke all on function public.bridge_read_installation_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.bridge_store_graph_snapshot_if_newer(uuid, uuid, bigint, text, jsonb, integer, timestamptz, bigint) to service_role;
grant execute on function public.bridge_read_graph_snapshot(uuid, integer, integer) to service_role;
grant execute on function public.bridge_read_installation_snapshot(uuid) to service_role;
