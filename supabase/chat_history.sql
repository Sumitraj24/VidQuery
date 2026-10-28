-- VidQuery chat history.
-- The existing table stores user_id as bigint, but Supabase Auth user ids are
-- UUIDs, so every insert fails. Run this in the Supabase SQL editor to fix it.
-- WARNING: drops the current chat_history table (it cannot hold any rows today).

drop table if exists public.chat_history;

create table public.chat_history (
    id           bigint generated always as identity primary key,
    user_id      uuid not null references auth.users (id) on delete cascade,
    video_id     text not null,
    user_message text not null,
    ai_response  text not null,
    created_at   timestamptz not null default now()
);

create index chat_history_user_video_idx on public.chat_history (user_id, video_id, created_at);

alter table public.chat_history enable row level security;

create policy "Users read their own chats" on public.chat_history
    for select using (auth.uid() = user_id);

create policy "Users insert their own chats" on public.chat_history
    for insert with check (auth.uid() = user_id);
