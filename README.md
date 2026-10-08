# meta-publish

노션에서 카드뉴스를 검수한 뒤 **발행 대기**로 바꾸면 인스타그램과 스레드에 자동으로 발행하는 시스템이다.

## 구조

| 경로 | 설명 |
| --- | --- |
| `supabase/functions/meta-publish/index.ts` | 발행 함수 본체 |
| `supabase/functions/meta-publish/lib.ts` | 캡션·정렬·장수 검사 등 순수 로직 |
| `supabase/functions/meta-publish/lib_test.ts` | 순수 로직 테스트 |
| `supabase/meta_tokens.sql` | 스레드 토큰 보관 표 생성 SQL |
| `.github/workflows/deploy-supabase-functions.yml` | 타입 검사·테스트 후 Supabase로 배포 |

## 동작

1. 노션 자동화가 웹훅을 호출한다 (`발행 상태`가 `발행 대기`로 바뀔 때)
2. 함수가 컨텐츠 페이지와 연결된 컷 페이지를 읽는다
3. 컷 이미지를 Supabase Storage 공개 버킷에 올린다 — 인스타그램은 공개 URL만 받기 때문
4. 인스타그램·스레드에 캐러셀을 발행한다
5. 게시물 링크와 발행 시각을 기록하고 `발행 완료`로 바꾼다

발행 상태가 이미 `발행 중`이거나 `발행 완료`면 아무 것도 하지 않는다.

스레드 토큰은 60일짜리라 `meta_tokens` 표에 담아두고, 발행할 때마다 마지막 갱신 후 30일이 지났으면 먼저 자동으로 연장한다.

## 한 번만 준비하면 되는 것

### 1. 공개 저장소 버킷

Supabase 대시보드 → Storage → 새 버킷 `meta-publish`, Public bucket 켜기.

### 2. GitHub 저장소 시크릿

Settings → Secrets and variables → Actions

| 이름 | 값 |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Supabase 계정 액세스 토큰 |
| `SUPABASE_PROJECT_ID` | 배포 대상 프로젝트 ref |

### 3. Supabase 함수 환경값

| 이름 | 필수 | 설명 |
| --- | --- | --- |
| `NOTION_TOKEN` | 예 | 노션 통합 토큰 |
| `ADMIN_SECRET` | 예 | 웹훅 인증 키. 노션 자동화 헤더와 같아야 한다 |
| `SB_URL` | 예 | Supabase 프로젝트 URL |
| `SB_SERVICE_ROLE_KEY` | 예 | 서비스 롤 키 (Storage 업로드용) |
| `IG_USER_ID` | 예 | 인스타그램 비즈니스 계정 ID |
| `IG_ACCESS_TOKEN` | 예 | 인스타그램 액세스 토큰 |
| `THREADS_APP_ID` | 예 | 메타 앱의 Threads App ID (스레드 인증용) |
| `THREADS_APP_SECRET` | 예 | 메타 앱의 Threads App secret (스레드 인증용). 페이스북 앱 시크릿 코드와 다른 값이다 |
| `PUBLISH_FIXED_COMMENT` | 아니오 | 캡션 뒤에 붙는 고정 멘트 |
| `META_GRAPH_VERSION` | 아니오 | 기본 `v26.0` |
| `IG_API_BASE` | 아니오 | 기본 `https://graph.facebook.com`. 인스타그램 로그인 방식이면 `https://graph.instagram.com` |
| `THREADS_GRAPH_VERSION` | 아니오 | 기본 `v1.0` |
| `THREADS_OAUTH_BASE` | 아니오 | 기본 `https://graph.threads.com`. 실패하면 `https://graph.threads.net` 을 자동으로 다시 시도한다 |
| `THREADS_REDIRECT_URI` | 아니오 | 비우면 함수가 `SB_URL` 로 공개 주소를 스스로 만든다. 스레드 앱에 등록한 값과 달라야 할 때만 채운다 |
| `THREADS_USER_ID` | 아니오 | 스레드 인증 전 임시값. 인증하면 `meta_tokens` 표의 값이 우선한다 |
| `THREADS_ACCESS_TOKEN` | 아니오 | 위와 같다 |
| `TOKEN_TABLE` | 아니오 | 기본 `meta_tokens` |
| `PUBLISH_BUCKET` | 아니오 | 기본 `meta-publish` |

값은 저장소에 넣지 않는다.

### 4. 스레드 토큰 표

Supabase 대시보드 → SQL Editor 에 `supabase/meta_tokens.sql` 내용을 붙여넣고 실행한다. service role 만 읽고 쓸 수 있다.

### 5. 스레드 인증 (한 번만, 그리고 60일마다 한 번씩)

Threads API 는 페이스북 로그인으로 붙는 경로가 없어 스레드 자체 OAuth 를 한 번 거쳐야 한다.

1. 메타 앱 대시보드 → 이용 사례 → Threads API 액세스 → 설정 에서 **리디렉션 콜백 URL** 을 등록한다.
   `https://<프로젝트 ref>.supabase.co/functions/v1/meta-publish`
   입력 후 반드시 **Enter** 를 눌러 태그로 만들어야 저장된다.
2. 같은 화면에서 앱 역할에 `ha.da_2025` 를 Threads 테스터로 추가한다.
3. 브라우저에서 아래 주소를 열면 승인 링크가 나온다. 링크를 눌러 승인한다.

   ```
   https://<프로젝트 ref>.supabase.co/functions/v1/meta-publish?threads_auth=1
   ```

4. 승인하면 함수로 되돌아오고, 함수가 code 를 60일 토큰으로 바꿔 `meta_tokens` 표에 저장한 뒤 `스레드 인증 완료` 안내를 보여준다.

이후에는 발행할 때마다 토큰이 자동으로 연장된다. 60일 넘게 발행을 쉬어 토큰이 만료되면 3번을 다시 하면 된다.

### 6. 노션 자동화

컨텐츠(학원관리) DB → ⚡ 자동화 → 새 자동화

- 트리거: `발행 상태`가 `발행 대기`로 바뀌면
- 액션: 웹훅으로 요청 보내기
  - URL: `https://<프로젝트 ref>.supabase.co/functions/v1/meta-publish`
  - 헤더: `x-admin-key: <ADMIN_SECRET 값>`
  - 본문: `{ "pageUrl": "<페이지 URL>" }`

## 수동 테스트

```bash
curl -X POST "https://<프로젝트 ref>.supabase.co/functions/v1/meta-publish" \
  -H "x-admin-key: <ADMIN_SECRET 값>" \
  -H "Content-Type: application/json" \
  -d '{"pageUrl":"<컨텐츠 페이지 주소>"}'
```

테스트만 하고 실제로 발행하지 않으려면 본문에 `"dryRun": true` 를 넣습니다. 노션 읽기, 컷 정렬, 이미지 내려받기, Storage 업로드까지만 확인하고 발행과 상태 변경은 하지 않습니다.

## 알아둘 제약

- 인스타그램 캐러셀은 2~10장, 스레드는 2~20장이다. 10장을 넘는 카드뉴스는 인스타그램에 올릴 수 없어 지금은 분할하지 않고 실패로 기록한다.
- 인스타그램은 이미지가 공개 URL이어야 한다. 노션 파일 링크는 만료되는 서명 URL이라 발행할 때마다 Storage에 다시 올린다.
- 노션은 업로드된 파일을 `binary/octet-stream` 으로 돌려주기도 한다. 그래서 content-type 을 믿지 않고 파일 앞바이트(PNG·JPEG·WebP·GIF)로 실제 형식을 판별한다.
- 영상 발행은 아직 지원하지 않는다. 이미지가 아니면 실패로 기록한다.
- 한 채널만 실패하면 성공한 채널은 그대로 두고 `발행 실패`로 기록한다. 재시도할 때는 `발행 채널`을 실패한 채널만 남겨야 중복 게시를 피할 수 있다.
- 캡션은 인스타그램과 스레드가 같은 값을 쓴다. 해시태그 없이, 고정 멘트를 포함해 500자(스레드 한도) 안으로 쓴다. 넘으면 이미지 업로드와 인스타그램 발행보다 앞에서 막고 발행 실패로 기록한다.

## 검증 상태

- 통과: `deno check` 타입 검사, 순수 로직 테스트 17개
- 통과: 스레드 승인 화면 진입, 승인 code 수신까지 실제 앱으로 확인
- 미검증: 실제 발행, 노션 자동화 연결, Storage 업로드, 앱 심사
