create function public.bridge_acknowledge_webhook_events(
  p_installation_id uuid,
  p_event_ids uuid[],
  p_expected_lease_owner text,
  p_consumed_at timestamptz
)
returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  requested_count integer;
  locked_count integer;
begin
  requested_count := cardinality(p_event_ids);
  if (
    p_installation_id is null
    or p_event_ids is null
    or requested_count is null
    or requested_count < 1
    or requested_count > 50
    or p_expected_lease_owner is null
    or length(p_expected_lease_owner) = 0
    or length(p_expected_lease_owner) > 128
    or p_consumed_at is null
    or (select count(distinct event_id) from unnest(p_event_ids) as event_id) <> requested_count
  ) then
    return false;
  end if;

  select count(*) into locked_count
  from (
    select event_id
    from public.webhook_event
    where installation_id = p_installation_id
      and event_id = any(p_event_ids)
    for update
  ) as locked_events;

  if locked_count <> requested_count then
    return false;
  end if;

  if exists (
    select 1
    from public.webhook_event
    where installation_id = p_installation_id
      and event_id = any(p_event_ids)
      and (
        consumed_at is not null
        or lease_owner <> p_expected_lease_owner
        or lease_expires_at is null
        or lease_expires_at <= p_consumed_at
      )
  ) then
    return false;
  end if;

  update public.webhook_event
  set consumed_at = p_consumed_at, lease_owner = null, lease_expires_at = null
  where installation_id = p_installation_id
    and event_id = any(p_event_ids);

  return true;
end;
$$;

revoke all on function public.bridge_acknowledge_webhook_events(uuid, uuid[], text, timestamptz) from public, anon, authenticated;
grant execute on function public.bridge_acknowledge_webhook_events(uuid, uuid[], text, timestamptz) to service_role;
