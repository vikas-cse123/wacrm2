-- Quick Replies — canned responses agents can insert into the chat composer.
-- Two visibility levels:
--   • 'personal'  — visible only to the creator
--   • 'shared'    — visible to every member of the account

create table if not exists quick_replies (
  id            uuid primary key default gen_random_uuid(),
  account_id    uuid not null references accounts(id) on delete cascade,
  created_by    uuid not null references auth.users(id) on delete cascade,
  title         text not null,
  shortcut      text not null,
  message       text not null,
  category      text not null default '',
  visibility    text not null default 'shared'
                  check (visibility in ('personal', 'shared')),
  is_favorite   boolean not null default false,
  use_count     integer not null default 0,
  last_used_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Shortcut must be unique within an account + visibility scope.
create unique index quick_replies_account_shortcut_idx
  on quick_replies (account_id, shortcut)
  where visibility = 'shared';

create unique index quick_replies_user_shortcut_idx
  on quick_replies (created_by, shortcut)
  where visibility = 'personal';

create index quick_replies_account_id_idx on quick_replies (account_id);
create index quick_replies_created_by_idx on quick_replies (created_by);

-- RLS ------------------------------------------------------------------

alter table quick_replies enable row level security;

-- SELECT: see shared replies for your account + your own personal replies.
create policy "Members can view account quick replies"
  on quick_replies for select
  using (
    account_id in (
      select account_id from profiles where user_id = auth.uid()
    )
    and (
      visibility = 'shared'
      or created_by = auth.uid()
    )
  );

-- INSERT: any authenticated member can create.
create policy "Members can create quick replies"
  on quick_replies for insert
  with check (
    account_id in (
      select account_id from profiles where user_id = auth.uid()
    )
    and created_by = auth.uid()
  );

-- UPDATE: owner of a personal reply, or admin/owner for shared replies.
create policy "Members can update quick replies"
  on quick_replies for update
  using (
    account_id in (
      select account_id from profiles where user_id = auth.uid()
    )
    and (
      created_by = auth.uid()
      or (
        visibility = 'shared'
        and exists (
          select 1 from profiles
          where user_id = auth.uid()
            and account_id = quick_replies.account_id
            and account_role in ('owner', 'admin')
        )
      )
    )
  );

-- DELETE: same rules as UPDATE.
create policy "Members can delete quick replies"
  on quick_replies for delete
  using (
    account_id in (
      select account_id from profiles where user_id = auth.uid()
    )
    and (
      created_by = auth.uid()
      or (
        visibility = 'shared'
        and exists (
          select 1 from profiles
          where user_id = auth.uid()
            and account_id = quick_replies.account_id
            and account_role in ('owner', 'admin')
        )
      )
    )
  );
