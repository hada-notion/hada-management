-- 성과 자동 수집 예약. GitHub Actions 예약 실행은 늦거나 건너뛰어서 Supabase 안에서 돌린다.
-- 매시 5분에 hada-publish?metrics=1&scheduled=1 을 부르고, 함수가 채널 DB '자동 수집 시각'이 된 채널만 모은다.
-- 인증 값(x-cron-key)은 여기서 무작위로 만들어 meta_tokens 표(channel = cron)에만 둔다. 함수가 같은 표에서 읽어 맞춰 본다.
-- Supabase 대시보드 > SQL Editor 에 붙여넣고 실행한다. 다시 실행해도 된다(키는 그대로, 작업은 덮어쓴다).

create extension if not exists pg_cron;
create extension if not exists pg_net;

insert into public.meta_tokens (channel, access_token)
values ('cron', encode(extensions.gen_random_bytes(32), 'hex'))
on conflict (channel) do nothing;

select cron.schedule(
  'hada-collect-metrics',
  '5 * * * *',
  $$
  select net.http_post(
    url := 'https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/hada-publish?metrics=1&scheduled=1',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-key', (select access_token from public.meta_tokens where channel = 'cron')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);
