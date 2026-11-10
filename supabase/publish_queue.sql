-- 배포 대기열(publish_queue). (261111, 학원관리 sync_queue 방식을 배포에 옮김)
--
-- 배경: 배포 버튼 한 번이 인스타그램·스레드·유튜브를 함수 실행 한 번(한도 150초) 안에서 차례로 올렸다.
-- 그래서 영상 처리 대기를 짧게 묶을 수밖에 없었고(스레드 4초×10), 69초짜리 숏폼은 스레드가
-- '아직 파일을 처리하는 중'으로 계속 실패했다. 다시 누르면 컨테이너를 새로 만들어 처리가 처음부터 다시 시작됐다.
--
-- 이제는
--   1) 배포 버튼(웹훅)·예약 발행(?due=1)은 채널마다 이 표에 한 줄을 넣고(enqueue_publish_job) 바로 202 로 답한다.
--      같은 (페이지, 채널)에 pending/processing 줄이 있으면 새로 넣지 않는다.
--   2) 워커(?worker=1)가 잠금(publish_worker_lock)을 걸고 쌓인 순서대로 한 줄만 꺼내(claim_next_publish_job) 처리한다.
--      한 실행이 한 채널만 맡으므로 150초 한도를 채널마다 따로 쓴다. 접수 직후 함수가 워커를 바로 깨우고,
--      아래 pg_cron 이 1분마다 깨우는 안전망이 된다.
--   3) 메타 컨테이너가 아직 처리 중이면 실패로 치지 않는다. container_id 를 남기고 1분 뒤로 미룬다(pending).
--      다음 실행은 새로 올리지 않고 그 컨테이너를 이어서 확인한 뒤 발행한다. 처리 대기는 attempts 에 넣지 않고
--      wait_started_at 으로 전체 한도(30분)만 본다.
--   4) 진짜 실패는 attempts 를 하나 올려 3번까지 다시 시도하고, 그래도 실패하면 failed 로 확정한다.
--      processing 으로 15분 넘게 멈춘 줄은 recover_stale_publish_jobs 가 되돌린다.
--
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행한다. 다시 실행해도 된다(표·함수는 그대로 두고 작업만 덮어쓴다).
-- metrics_cron.sql 을 먼저 실행해 x-cron-key(meta_tokens, channel = cron)가 있어야 1분 크론이 통과한다.
-- 끄기: select cron.unschedule('hada-publish-worker');

create table if not exists public.publish_queue (
  id bigint generated always as identity primary key,
  page_id text not null,
  -- 인스타그램 | 스레드 | 유튜브
  channel text not null,
  -- 접수 때 정한 값(manualPending 등). 실제 발행 내용은 처리할 때 노션 페이지를 다시 읽는다.
  payload jsonb not null default '{}'::jsonb,
  -- pending | processing | done | failed
  status text not null default 'pending',
  -- 진짜 실패 횟수. 처리 대기 재확인은 세지 않는다.
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  -- 메타 처리 번호. 처리 중인 컨테이너(단일 글이면 그 글, 캐러셀이면 부모)를 이어서 확인할 때 쓴다.
  container_id text,
  -- 스레드 캐러셀의 자식 컨테이너. 자식이 다 끝나야 부모를 만든다.
  container_children jsonb,
  -- 컨테이너는 24시간 뒤 만료된다. 그 전이면 이어 쓰고, 지나면 새로 만든다.
  container_created_at timestamptz,
  -- 처리 대기를 처음 시작한 시각. 30분이 넘으면 실패로 확정한다.
  wait_started_at timestamptz,
  -- 발행 API 가 성공해 받은 글 번호. 그 뒤 단계가 실패해 다시 시도해도 두 번 올리지 않는다.
  published_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  constraint publish_queue_status_check check (status in ('pending', 'processing', 'done', 'failed'))
);

comment on table public.publish_queue is '배포 대기열. (페이지, 채널) 한 줄씩 쌓고 워커가 쌓인 순서대로 한 줄씩 처리한다.';

-- (페이지, 채널)마다 살아 있는 줄은 하나뿐이다. 버튼을 여러 번 눌러도 줄이 늘지 않는다.
create unique index if not exists publish_queue_active_uniq
  on public.publish_queue (page_id, channel)
  where status in ('pending', 'processing');
create index if not exists publish_queue_ready_idx
  on public.publish_queue (next_attempt_at, created_at)
  where status = 'pending';
create index if not exists publish_queue_page_idx on public.publish_queue (page_id);

alter table public.publish_queue enable row level security;
revoke all on public.publish_queue from anon, authenticated;

-- 한 줄 넣기. 이미 살아 있는 줄이 있으면 넣지 않고 false 를 돌려준다.
create or replace function public.enqueue_publish_job(p_page_id text, p_channel text, p_payload jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security invoker
as $$
declare
  inserted_id bigint;
begin
  insert into public.publish_queue (page_id, channel, payload)
  values (p_page_id, p_channel, coalesce(p_payload, '{}'::jsonb))
  on conflict (page_id, channel) where status in ('pending', 'processing') do nothing
  returning id into inserted_id;
  return inserted_id is not null;
end;
$$;

-- 다음 시도 시각이 된 pending 줄 중 가장 먼저 쌓인 것 하나를 processing 으로 바꿔 돌려준다.
-- attempts 는 여기서 올리지 않는다(처리 대기 재확인은 시도로 치지 않으므로 실패할 때 함수가 올린다).
create or replace function public.claim_next_publish_job()
returns setof public.publish_queue
language plpgsql
security invoker
as $$
declare
  claimed_id bigint;
begin
  select id into claimed_id
  from public.publish_queue
  where status = 'pending' and next_attempt_at <= now()
  order by created_at asc, id asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
    update public.publish_queue
    set status = 'processing', started_at = now(), updated_at = now()
    where id = claimed_id
    returning *;
end;
$$;

-- processing 으로 오래(기본 15분) 멈춘 줄을 되돌린다. 실행이 중간에 죽은 경우다.
-- 한 번의 시도로 치고, 한도를 넘었으면 failed 로 확정한다. 컨테이너 정보는 그대로 두어 이어서 확인한다.
create or replace function public.recover_stale_publish_jobs(
  stale_after_seconds int default 900,
  max_attempts int default 3
)
returns table(recovered_id bigint, new_status text)
language plpgsql
security invoker
as $$
begin
  return query
  update public.publish_queue q
  set
    attempts = q.attempts + 1,
    status = case when q.attempts + 1 >= max_attempts then 'failed' else 'pending' end,
    next_attempt_at = now(),
    updated_at = now(),
    finished_at = case when q.attempts + 1 >= max_attempts then now() else null end,
    last_error = coalesce(q.last_error || E'\n', '') ||
      case
        when q.attempts + 1 >= max_attempts then '[자동복구] 처리 중 상태로 오래 멈춰 있었고 재시도 한도를 넘어 실패로 확정함'
        else '[자동복구] 처리 중 상태로 오래 멈춰 있어 다시 대기열로 되돌림'
      end
  where q.status = 'processing'
    and q.started_at is not null
    and q.started_at < now() - (stale_after_seconds || ' seconds')::interval
  returning q.id, q.status;
end;
$$;

-- 워커 잠금. 함수 호출마다 연결이 달라 advisory lock 이 이어지지 않으므로 표 한 줄을 리스로 쓴다.
-- 리스가 끝나면(실행이 죽어 못 풀었을 때) 저절로 풀린다.
create table if not exists public.publish_worker_lock (
  id int primary key,
  locked_until timestamptz,
  constraint publish_worker_lock_single_row check (id = 1)
);
insert into public.publish_worker_lock (id, locked_until)
values (1, null)
on conflict (id) do nothing;

alter table public.publish_worker_lock enable row level security;
revoke all on public.publish_worker_lock from anon, authenticated;

create or replace function public.try_acquire_publish_lock(lease_seconds int default 180)
returns boolean
language sql
security invoker
as $$
  update public.publish_worker_lock
  set locked_until = now() + (lease_seconds || ' seconds')::interval
  where id = 1
    and (locked_until is null or locked_until < now())
  returning true;
$$;

create or replace function public.renew_publish_lock(lease_seconds int default 180)
returns void
language sql
security invoker
as $$
  update public.publish_worker_lock
  set locked_until = now() + (lease_seconds || ' seconds')::interval
  where id = 1;
$$;

create or replace function public.release_publish_lock()
returns void
language sql
security invoker
as $$
  update public.publish_worker_lock set locked_until = null where id = 1;
$$;

revoke all on function public.enqueue_publish_job(text, text, jsonb) from public;
revoke all on function public.claim_next_publish_job() from public;
revoke all on function public.recover_stale_publish_jobs(int, int) from public;
revoke all on function public.try_acquire_publish_lock(int) from public;
revoke all on function public.renew_publish_lock(int) from public;
revoke all on function public.release_publish_lock() from public;
grant execute on function public.enqueue_publish_job(text, text, jsonb) to service_role;
grant execute on function public.claim_next_publish_job() to service_role;
grant execute on function public.recover_stale_publish_jobs(int, int) to service_role;
grant execute on function public.try_acquire_publish_lock(int) to service_role;
grant execute on function public.renew_publish_lock(int) to service_role;
grant execute on function public.release_publish_lock() to service_role;

-- 안전망: 접수 직후 깨우기가 유실되거나, 처리 대기로 1분 뒤에 미룬 줄을 1분마다 워커가 줍는다.
-- 예약 발행 크론(hada-scheduled-publish, 5분)은 이제 대기열에 넣기만 하고 직접 올리지 않는다. 그래서 둘이 겹쳐도
-- 같은 글을 두 번 처리하지 않는다(실제 발행은 이 워커만 한다).
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'hada-publish-worker',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/hada-publish?worker=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select access_token from public.meta_tokens where channel = 'cron')
    ),
    body := '{"source":"cron"}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
