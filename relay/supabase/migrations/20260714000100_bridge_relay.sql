create table bridge_installation (
  id uuid primary key,
  graph_id uuid not null unique,
  relay_token_hash text not null,
  pending_relay_token_hash text,
  pending_relay_token_expires_at timestamptz,
  check ((pending_relay_token_hash is null) = (pending_relay_token_expires_at is null)),
  graph_key_id text not null,
  snapshot_sequence bigint not null default 0 check (snapshot_sequence >= 0),
  bootstrap_public_jwk jsonb,
  pending_webhook_token_ciphertext text,
  api_rate_window_started_at timestamptz not null default now(),
  api_rate_count integer not null default 0 check (api_rate_count >= 0),
  webhook_rate_window_started_at timestamptz not null default now(),
  webhook_rate_count integer not null default 0 check (webhook_rate_count >= 0),
  graph_rate_window_started_at timestamptz not null default now(),
  graph_rate_count integer not null default 0 check (graph_rate_count >= 0),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table synced_page_registry (
  installation_id uuid not null references bridge_installation(id) on delete cascade,
  notion_page_id uuid not null,
  bridge_id uuid not null,
  primary key (installation_id, notion_page_id),
  unique (installation_id, bridge_id)
);

create table webhook_event (
  installation_id uuid not null references bridge_installation(id) on delete cascade,
  event_id uuid not null,
  event_type text not null,
  entity_id uuid not null,
  event_at timestamptz not null,
  received_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  consumed_at timestamptz,
  primary key (installation_id, event_id)
);

create table graph_snapshot (
  installation_id uuid primary key references bridge_installation(id) on delete cascade,
  graph_id uuid not null unique,
  sequence bigint not null check (sequence > 0),
  key_id text not null,
  envelope jsonb not null,
  byte_length integer not null check (byte_length between 1 and 8388608),
  created_at timestamptz not null
);

comment on column bridge_installation.bootstrap_public_jwk is
  'Contains only the RSA-OAEP-encrypted bootstrap verification token and must be nulled after setup.';
comment on column bridge_installation.pending_webhook_token_ciphertext is
  'Contains only RSA-OAEP ciphertext for a pending webhook verification token and must be nulled after setup.';

alter table bridge_installation enable row level security;
alter table synced_page_registry enable row level security;
alter table webhook_event enable row level security;
alter table graph_snapshot enable row level security;

revoke all privileges on table bridge_installation from public, anon, authenticated;
revoke all privileges on table synced_page_registry from public, anon, authenticated;
revoke all privileges on table webhook_event from public, anon, authenticated;
revoke all privileges on table graph_snapshot from public, anon, authenticated;
revoke all privileges on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke execute on functions from anon;
alter default privileges in schema public revoke execute on functions from authenticated;

grant select, insert, update, delete on table bridge_installation to service_role;
grant select, insert, update, delete on table synced_page_registry to service_role;
grant select, insert, update, delete on table webhook_event to service_role;
grant select, insert, update, delete on table graph_snapshot to service_role;
