create extension if not exists pgcrypto;

create table if not exists pb_users (
  id uuid primary key default gen_random_uuid(),
  email text unique not null,
  nickname text unique,
  password_hash text,
  email_verified boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

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

create table if not exists pb_email_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null default 'register',
  code text not null,
  expires_at timestamptz not null,
  used boolean default false,
  created_at timestamptz default now()
);

create table if not exists pb_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references pb_users(id) on delete cascade,
  token_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);

create table if not exists pb_game_tickets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references pb_users(id) on delete cascade,
  nickname text not null,
  token_hash text unique not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists pb_email_codes_email_purpose_idx
  on pb_email_codes (email, purpose, created_at desc);

create index if not exists pb_sessions_user_id_idx
  on pb_sessions (user_id);

create index if not exists pb_sessions_token_hash_idx
  on pb_sessions (token_hash);

create index if not exists pb_game_tickets_token_hash_idx
  on pb_game_tickets (token_hash);

create index if not exists pb_game_tickets_expires_at_idx
  on pb_game_tickets (expires_at);
