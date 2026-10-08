-- 스레드 토큰 보관용 표. 발행 함수가 service role 로만 접근한다.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행한다.

create table if not exists public.meta_tokens (
  channel      text primary key,
  access_token text not null,
  user_id      text,
  expires_at   timestamptz,
  updated_at   timestamptz not null default now()
);

alter table public.meta_tokens enable row level security;

-- 정책을 만들지 않는다. 즉 anon/authenticated 는 아무것도 못 읽고, service role 만 통과한다.
revoke all on table public.meta_tokens from anon, authenticated;
