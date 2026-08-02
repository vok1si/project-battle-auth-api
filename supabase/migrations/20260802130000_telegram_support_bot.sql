create table if not exists pb_telegram_links (
  telegram_user_id bigint primary key,
  user_id uuid not null unique references pb_users(id) on delete cascade,
  telegram_username text,
  linked_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists pb_telegram_link_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references pb_users(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists pb_support_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references pb_users(id) on delete set null,
  telegram_user_id bigint not null,
  category text not null,
  message text not null,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pb_support_tickets_status_check check (status in ('open', 'closed'))
);

create index if not exists pb_telegram_link_codes_user_id_idx
  on pb_telegram_link_codes (user_id, expires_at desc);

create index if not exists pb_support_tickets_user_id_idx
  on pb_support_tickets (user_id, created_at desc);

create index if not exists pb_support_tickets_status_idx
  on pb_support_tickets (status, created_at desc);
