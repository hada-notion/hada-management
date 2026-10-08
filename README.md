# meta-publish

노션에서 카드뉴스를 검수한 뒤 **발행 대기**로 바꾸면 인스타그램과 스레드에 자동으로 발행하는 시스템이다.

## 구조

| 경로 | 설명 |
| --- | --- |
| `supabase/functions/meta-publish/index.ts` | 발행 함수 본체 |
| `supabase/functions/meta-publish/lib.ts` | 캡션·정렬·장수 검사 등 순수 로직 |
| `supabase/functions/meta-publish/lib_test.ts` | 순수 로직 테스트 |
| `.github/workflows/deploy-supabase-functions.yml` | 타입 검사·테스트 후 Supabase로 배포 |

## 동작

1. 노션 자동화가 웹훅을 호출한다 (`발행 상태`가 `발행 대기`로 바뀔 때)
2. 함수가 컨텐츠 페이지와 연결된 컷 페이지를 읽는다
3. 컷 이미지를 Supabase Storage 공개 버킷에 올린다 — 인스타그램은 공개 URL만 받기 때문
4. 인스타그램·스레드에 캐러셀을 발행한다
5. 게시물 링크와 발행 시각을 기록하고 `발행 완료`로 바꾼다

발행 상태가 이미 `발행 중`이거나 `발행 완료`면 아무 것도 하지 않는다.

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
| `THREADS_USER_ID` | 예 | 스레드 사용자 ID |
| `THREADS_ACCESS_TOKEN` | 예 | 스레드 액세스 토큰 |
| `PUBLISH_FIXED_COMMENT` | 아니오 | 캡션 뒤에 붙는 고정 멘트 |
| `META_GRAPH_VERSION` | 아니오 | 기본 `v26.0` |
| `IG_API_BASE` | 아니오 | 기본 `https://graph.facebook.com`. 인스타그램 로그인 방식이면 `https://graph.instagram.com` |
| `THREADS_GRAPH_VERSION` | 아니오 | 기본 `v1.0` |
| `PUBLISH_BUCKET` | 아니오 | 기본 `meta-publish` |

값은 저장소에 넣지 않는다.

### 4. 노션 자동화

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

## 알아둘 제약

- 인스타그램 캐러셀은 2~10장, 스레드는 2~20장이다. 10장을 넘는 카드뉴스는 인스타그램에 올릴 수 없어 지금은 분할하지 않고 실패로 기록한다.
- 인스타그램은 이미지가 공개 URL이어야 한다. 노션 파일 링크는 만료되는 서명 URL이라 발행할 때마다 Storage에 다시 올린다.
- 영상 발행은 아직 지원하지 않는다. 이미지가 아니면 실패로 기록한다.
- 한 채널만 실패하면 성공한 채널은 그대로 두고 `발행 실패`로 기록한다. 재시도할 때는 `발행 채널`을 실패한 채널만 남겨야 중복 게시를 피할 수 있다.
- 스레드 텍스트는 500자, 인스타그램 캡션은 2200자에서 잘린다.

## 검증 상태

- 통과: `deno check` 타입 검사, 순수 로직 테스트 8개
- 미검증: 실제 메타 앱·토큰으로 발행, 노션 자동화 연결, Storage 업로드, 앱 심사
