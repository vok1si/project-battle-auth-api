revoke all on table public.pb_support_messages from public, anon, authenticated;

grant select, insert, update, delete on public.pb_support_messages to service_role;
