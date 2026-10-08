-- META 발행 잠금 표.
--
-- 같은 행의 같은 채널을 두 실행이 동시에 처리하면 같은 글이 두 번 올라간다.
-- (페이지, 채널) 조합을 기본키로 두고 실행이 시작할 때 한 줄을 넣는다. 이미 있으면 다른 실행이 잡고 있다는 뜻이다.
-- 실행이 끝나면 그 줄을 지운다. 15분 넘게 남아 있으면 함수가 가져와 이어서 처리한다.
--
-- Supabase SQL Editor 에서 한 번 실행한다. 표가 없어도 함수는 잠금 없이 동작한다.

create table if not exists public.meta_jobs (
  page_id text not null,
  channel text not null,
  started_at timestamptz not null default now(),
  primary key (page_id, channel)
);

comment on table public.meta_jobs is 'META 발행 채널 잠금. (page_id, channel) 단위로 한 번에 한 실행만 처리한다.';

alter table public.meta_jobs enable row level security;
revoke all on public.meta_jobs from anon, authenticated;
