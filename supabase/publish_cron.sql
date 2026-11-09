-- 예약 발행. 콘텐츠 DB에서 상태=게시대기이고 '예약 시각'(날짜+시간)이 지난 글을 5분마다 올린다.
-- 성과 수집 예약(metrics_cron.sql)과 같은 x-cron-key(meta_tokens, channel = cron)를 쓴다. 그 파일을 먼저 실행해 둔다.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행한다. 다시 실행해도 된다(작업은 덮어쓴다).
-- 끄기: select cron.unschedule('hada-scheduled-publish');

create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'hada-scheduled-publish',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/hada-publish?due=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select access_token from public.meta_tokens where channel = 'cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
