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
declare
  envelope_created_at text;
  envelope_nonce text;
  envelope_ciphertext text;
  decoded_nonce bytea;
  decoded_ciphertext bytea;
  canonical_nonce text;
  canonical_ciphertext text;
begin
  if (
    p_sequence <= 0
    or p_sequence > 9007199254740991
    or p_key_id is null
    or length(p_key_id) = 0
    or length(p_key_id) > 256
    or p_installation_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_graph_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_byte_length is null
    or p_byte_length not between 1 and 8388608
    or p_created_at is null
    or (p_expected_sequence is not null and (p_expected_sequence < 0 or p_expected_sequence >= 9007199254740991))
  ) then
    return false;
  end if;

  if p_envelope is null or jsonb_typeof(p_envelope) <> 'object' then
    return false;
  end if;

  if (
    (select count(*) from jsonb_object_keys(p_envelope)) <> 8
    or not (p_envelope ?& array['version', 'algorithm', 'installationId', 'keyId', 'sequence', 'createdAt', 'nonce', 'ciphertext'])
    or jsonb_typeof(p_envelope -> 'version') <> 'number'
    or p_envelope ->> 'version' <> '1'
    or jsonb_typeof(p_envelope -> 'algorithm') <> 'string'
    or p_envelope ->> 'algorithm' <> 'A256GCM'
    or jsonb_typeof(p_envelope -> 'installationId') <> 'string'
    or p_envelope ->> 'installationId' <> p_installation_id::text
    or jsonb_typeof(p_envelope -> 'keyId') <> 'string'
    or p_envelope ->> 'keyId' <> p_key_id
    or jsonb_typeof(p_envelope -> 'sequence') <> 'number'
    or p_envelope ->> 'sequence' <> p_sequence::text
    or jsonb_typeof(p_envelope -> 'createdAt') <> 'string'
    or jsonb_typeof(p_envelope -> 'nonce') <> 'string'
    or jsonb_typeof(p_envelope -> 'ciphertext') <> 'string'
  ) then
    return false;
  end if;

  envelope_created_at := p_envelope ->> 'createdAt';
  if length(envelope_created_at) > 64
    or envelope_created_at !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T(?:[01][0-9]|2[0-3]):[0-5][0-9](?::[0-5][0-9](?:[.][0-9]+)?)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$' then
    return false;
  end if;
  begin
    if envelope_created_at::timestamptz <> p_created_at then
      return false;
    end if;
  exception when others then
    return false;
  end;

  envelope_nonce := p_envelope ->> 'nonce';
  if envelope_nonce !~ '^[A-Za-z0-9_-]{16}$' then
    return false;
  end if;
  begin
    decoded_nonce := decode(translate(envelope_nonce, '-_', '+/'), 'base64');
  exception when others then
    return false;
  end;
  canonical_nonce := regexp_replace(translate(replace(encode(decoded_nonce, 'base64'), E'\n', ''), '+/', '-_'), '=+$', '');
  if octet_length(decoded_nonce) <> 12 or canonical_nonce <> envelope_nonce then
    return false;
  end if;

  envelope_ciphertext := p_envelope ->> 'ciphertext';
  if (
    envelope_ciphertext !~ '^[A-Za-z0-9_-]+$'
    or length(envelope_ciphertext) % 4 = 1
    or length(envelope_ciphertext) > 8388608
  ) then
    return false;
  end if;
  begin
    decoded_ciphertext := decode(
      translate(envelope_ciphertext, '-_', '+/') || repeat('=', (4 - length(envelope_ciphertext) % 4) % 4),
      'base64'
    );
  exception when others then
    return false;
  end;
  canonical_ciphertext := regexp_replace(translate(replace(encode(decoded_ciphertext, 'base64'), E'\n', ''), '+/', '-_'), '=+$', '');
  if canonical_ciphertext <> envelope_ciphertext or octet_length(decoded_ciphertext) <> p_byte_length then
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
