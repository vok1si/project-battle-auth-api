create table if not exists pb_support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references pb_support_tickets(id) on delete cascade,
  sender_type text not null check (sender_type in ('user', 'admin')),
  telegram_user_id bigint,
  message_text text,
  media_type text,
  telegram_file_id text,
  telegram_file_unique_id text,
  telegram_message_id bigint,
  created_at timestamptz not null default now()
);

create index if not exists pb_support_messages_ticket_created_idx
  on pb_support_messages (ticket_id, created_at asc);

alter table pb_support_messages enable row level security;

revoke all on table public.pb_support_messages from public, anon, authenticated;
grant select, insert, update, delete on public.pb_support_messages to service_role;
