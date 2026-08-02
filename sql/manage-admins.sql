-- Project Battle administrators are stored in pb_users.role.
-- Add every administrator nickname to this list and run the statement in Supabase SQL Editor.
update pb_users
set role = 'admin', updated_at = now()
where lower(nickname) in (
  lower('vokisu')
  -- , lower('another_nickname')
);

-- Remove administrator access from a nickname when needed:
-- update pb_users
-- set role = 'user', updated_at = now()
-- where lower(nickname) = lower('nickname_to_remove');

-- Show the current administrator list.
select nickname, email, role, updated_at
from pb_users
where role = 'admin'
order by lower(nickname);
