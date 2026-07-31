alter table pb_users
  add column if not exists role text not null default 'user';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pb_users_role_check'
  ) then
    alter table pb_users
      add constraint pb_users_role_check check (role in ('user', 'admin'));
  end if;
end $$;

create table if not exists pb_game_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references pb_users(id) on delete cascade,
  nickname text not null,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists pb_game_tickets_token_hash_idx
  on pb_game_tickets (token_hash);

create index if not exists pb_game_tickets_expires_at_idx
  on pb_game_tickets (expires_at);

-- Replace the email below with your Project Battle account email, then run
-- the UPDATE separately to enable the administrator panel for that account.
-- update pb_users set role = 'admin' where email = 'your-email@example.com';
