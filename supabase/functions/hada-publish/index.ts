// META 업로드 자동화 — 노션 웹훅을 받아 인스타그램·스레드에 발행한다.
//
// 콘텐츠 DB 에서 올리는 칸은 넷이다: 타이틀 · 섬네일 · 콘텐츠(파일) · 본문.
// 발행 소스는 '형식'으로 정한다.
//   카드뉴스    → '콘텐츠' 이미지 캐러셀(칸에 넣은 순서대로)
//   이미지      → '콘텐츠' 한 장
//   숏폼(9:16)  → '콘텐츠' 영상 (릴스)
//   롱폼(16:9)  → '콘텐츠' 영상 (릴스)
//   짧은글      → 글만. 스레드 전용이다. 인스타그램은 미디어 없는 발행을 지원하지 않는다.
//   긴글        → 자동 발행하지 않는다(블로그용).
//   예전 이름(영상-세로(9:16)·영상-가로(16:9)·카피)도 그대로 받는다.
// '타이틀'은 유튜브 제목, '섬네일'은 유튜브(일반 영상) 섬네일과 인스타그램 릴스 커버로 쓴다.
// 스레드는 '하위 항목'을 만든 순서대로 바로 앞 글의 답글로 이어 단다. 하위 항목마다 게시물 기록이 따로 생긴다.
//
// '본문'은 선택이다. 비면 글 없이 미디어만 올린다(글을 요구하는 건 '짧은글' 형식뿐이다).
// 그래서 이미지·캐러셀 발행에서는 caption·text 파라미터를 아예 빼고 보낸다.
//
// 호출: POST /functions/v1/hada-publish   (헤더 x-admin-key 필요)
//   본문에 페이지 지정(pageUrl/pageId/url/id)이 있거나 본문 어딘가에 노션 페이지 주소가 실려 있으면
//   그 페이지만 처리한다. ?channel=instagram|threads 로 채널을 지정할 수 있다.
//   지정이 없으면 상태가 ⚪ 대기인 채널과 '배포 채널'에 고른 채널을 처리한다.
//   배포 채널 중 인스타그램·스레드는 발행하고(이미 ✅ 완료면 건너뜀),
//   유튜브는 연결 설정(YOUTUBE_CLIENT_ID)이 있고 영상 형식이면 업로드한다(세로 영상은 Shorts).
//   블로그 같은 나머지 채널은 게시물 DB 에 채널을 연결한 기록만 만든다.
//   (네이버 블로그는 Aside 브라우저가 그 기록을 보고 올린 뒤 게시 링크를 채운다. 성과는 ?metrics=1 이 공감·댓글·공유를 모은다.)
//   페이지를 찾지 못하면 큐 조회로 넘어간다.
//
// 배포는 대기열(publish_queue, supabase/publish_queue.sql)로 한다. (261111)
//   버튼 웹훅은 채널마다 대기열에 한 줄씩 넣고 202(접수)로 답한다. 노션 버튼 웹훅은 10초 안에 응답이 와야 한다.
//   워커(?worker=1)가 한 실행에 한 채널씩, 쌓인 순서대로 올린다. 접수 직후 바로 깨우고 pg_cron 이 1분마다 깨운다.
//   메타가 영상을 아직 처리 중이면 실패로 치지 않고 컨테이너 번호를 남겨 1분 뒤 이어서 확인한다(최대 30분).
//   진짜 실패는 3번까지 다시 시도한다. 자세한 규칙은 queue.ts.
// 실제 결과는 페이지의 '인스타그램 상태'·'스레드 상태'·'유튜브 상태'와 '실시간 처리 상태' 수식으로 확인한다.
// ?wait=1 을 붙이면 접수 결과(넣은 채널)를 바로 돌려준다. ?worker=1&wait=1 은 워커 한 번의 결과를 돌려준다.
//
// 예약 발행: POST /functions/v1/hada-publish?due=1  (pg_cron 5분마다, x-cron-key)
//   상태=게시대기이고 '예약 시각'(날짜+시간)이 지난 행을 배포 버튼과 같은 경로로 대기열에 넣는다.
// 워커: POST /functions/v1/hada-publish?worker=1  (pg_cron 1분마다 x-cron-key, 함수 자신이 깨울 때 x-admin-key)
//
// 오류 문구에는 비밀값이 섞여 들어올 수 있다(메타는 거절한 토큰을 오류 문구에 되돌려준다).
// 노션에 쓰기 전에 summarizeApiError 로 요약하고 maskSecrets 로 가린다.
//
// 스레드 인증 안내: GET /functions/v1/hada-publish?threads_auth=1
// 스레드 인증 콜백: GET /functions/v1/hada-publish?code=...  (스레드가 브라우저를 돌려보내는 주소)
// 유튜브 인증 안내: GET /functions/v1/hada-publish?youtube_auth=1
// 유튜브 인증 콜백: GET /functions/v1/hada-publish?code=...&state=youtube  (구글이 돌려보내는 주소)
// 앱 소개·개인정보처리방침: GET /functions/v1/hada-publish?page=home | privacy  (구글 동의 화면 브랜딩용)
//
// 자세한 배포·설정 방법은 저장소 README 를 따른다.

import {
  FORMAT_NAMES,
  IG_CAPTION_LIMIT,
  IG_CAROUSEL_MAX,
  IG_CAROUSEL_MIN,
  THREADS_TEXT_LIMIT,
  THREADS_CAROUSEL_MAX,
  THREADS_CAROUSEL_MIN,
  THREADS_AUTHORIZE_SCOPES,
  THREADS_REFRESH_AFTER_DAYS,
  assertCarouselSize,
  buildCaption,
  channelHint,
  cleanToken,
  collectPageCandidates,
  captionLimitError,
  contentTypeFor,
  detectImageType,
  detectVideoType,
  expiresAtFrom,
  extensionFor,
  hexPreview,
  extractImageUrls,
  extractMediaItems,
  extractVideoUrls,
  isThreadsNotFound,
  isThreadsNotReady,
  maskSecrets,
  mediaKindFor,
  planDeploy,
  needsRefresh,
  parsePageId,
  readTarget,
  resolveRedirectUri,
  sortByCreated,
  contentFieldName,
  replyMediaKind,
  scheduleDecision,
  threadsIdFromMemo,
  threadsIdNote,
  optionalText,
  summarizeApiError,
  threadsLength,
  threadsAuthorizeUrl,
  truncate,
  METRIC_CHANNEL_LABELS,
  METRIC_FIELDS,
  importedPostTitle,
  contentFormatFor,
  postHeadline,
  pickPostContentProp,
  pickContentTypeOption,
  metricChannelByLabel,
  metricsErrorSummary,
  metricsResultSummary,
  applyMetricScope,
  autoCollectDue,
  kstDateTime,
  publishedOnOrAfter,
  kstDate,
  metricChannelOf,
  naverBlogIdOf,
  naverBlogMetrics,
  naverBlogPostUrl,
  metricDelta,
  postCodeOf,
  readInsights,
  isShortsFormat,
  splitYoutube,
  youtubeAuthorizeUrl,
  youtubeDescription,
  youtubePrivacy,
  youtubeTitle,
  youtubeVideoIdOf,
  youtubeWatchUrl,
  YOUTUBE_CHANNEL,
  YOUTUBE_OAUTH_STATE,
  YOUTUBE_SCOPES,
} from "./lib.ts";
import type { ContentField, MediaItem, MediaKind, MetricChannel, Metrics, MetricScope } from "./lib.ts";
import {
  ContainerExpired,
  PermanentError,
  containerStep,
  isContainerExpired,
  isPermanent,
  resumableContainer,
  runWorkerOnce,
} from "./queue.ts";
import type { ContainerState, JobHandlers, JobPatch, ProcessHooks, ProcessResult, PublishJob, QueueStore } from "./queue.ts";

const NOTION_BASE = "https://api.notion.com/v1";
// 본글·답글 컨테이너 처리 대기는 대기열 워커가 실행 사이에 이어서 기다린다(JOB_POLL_BUDGET_MS 참고).
// 자식 컨테이너가 준비되기 전에 부모를 만들면 메타가 400(subcode 4279004)으로 거절한다. 그때 다시 시도한다.
const THREADS_CAROUSEL_CREATE_ATTEMPTS = 6;
const THREADS_CAROUSEL_CREATE_DELAY_MS = 3000;
// 발행 직후 컨테이너가 아직 전파되지 않아 "없다"는 답이 올 때가 있다.
const THREADS_PUBLISH_ATTEMPTS = 5;
const THREADS_PUBLISH_DELAY_MS = 2000;
const COMMENT_LIMIT = 1900;
const MIN_TOKEN_LENGTH = 40;

type Json = Record<string, any>;
type Config = ReturnType<typeof buildConfig>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

function optionalEnv(name: string): string {
  return (Deno.env.get(name) ?? "").trim();
}

function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (value === "") throw new Error(`환경값 ${name}이(가) 설정되지 않았습니다.`);
  return value;
}

/**
 * 환경값 토큰을 정리한다.
 * 붙여넣기 사고로 값에 따옴표나 JSON 조각이 섞이면 토큰 부분만 남기고 로그로 알린다.
 */
function cleanEnvToken(name: string): string {
  const raw = optionalEnv(name);
  const token = cleanToken(raw);
  if (raw !== "" && raw !== token) {
    console.warn(`${name} 값에 토큰 외 문자(따옴표·중괄호 등)가 섞여 있어 토큰 부분만 사용합니다.`);
  }
  return token;
}

function assertToken(name: string, value: string): string {
  if (value === "") throw new Error(`환경값 ${name}이(가) 설정되지 않았습니다.`);
  if (value.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `${name} 값이 토큰으로 보이지 않습니다(길이 ${value.length}). 토큰 문자열만 저장했는지 확인하세요.`,
    );
  }
  return value;
}

/** 오류 문구에서 지워야 할 비밀값 목록. 값 자체는 로그에도 남기지 않는다. */
function secretsOf(cfg: Config): string[] {
  return [
    cfg.igToken,
    cfg.threadsToken,
    cfg.threadsAppSecret,
    cfg.notionToken,
    cfg.storageKey,
    cfg.adminSecret,
    cfg.youtubeApiKey,
    cfg.youtubeClientSecret,
  ];
}

/** API 오류를 요약하고 비밀값을 지운 뒤 예외로 만든다. 응답을 통째로 남기지 않는 게 요점이다. */
function apiError(cfg: Config, label: string, status: number, text: string, limit = 400): Error {
  return new Error(`${label} ${status}: ${maskSecrets(summarizeApiError(text, limit), secretsOf(cfg))}`);
}

/** 코드 값까지 들고 다니는 오류. 메타는 같은 400 이라도 하위 코드로 원인을 구분한다. */
type ApiFailure = Error & { status?: number; code?: unknown; subcode?: unknown };

function apiFailure(cfg: Config, label: string, status: number, text: string, limit = 400): ApiFailure {
  const failure = apiError(cfg, label, status, text, limit) as ApiFailure;
  failure.status = status;
  try {
    const parsed = JSON.parse(text) as Record<string, any>;
    const detail = (parsed.error ?? parsed) as Record<string, any>;
    failure.code = detail.code;
    failure.subcode = detail.error_subcode;
  } catch {
    // JSON 이 아니면 코드 정보가 없다.
  }
  return failure;
}

/** 메타 쪽 전파가 늦어 생기는 오류만 골라 다시 시도한다. */
async function retryWhen(
  attempts: number,
  delayMs: number,
  shouldRetry: (e: unknown) => boolean,
  run: () => Promise<Json>,
  label: string,
): Promise<Json> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (e) {
      lastError = e;
      if (!shouldRetry(e) || attempt === attempts - 1) throw e;
      console.warn(`${label} 재시도 ${attempt + 2}/${attempts}`, message(e));
      await sleep(delayMs);
    }
  }
  throw lastError;
}

function buildConfig() {
  return {
    notionToken: requiredEnv("NOTION_TOKEN"),
    notionVersion: optionalEnv("NOTION_VERSION") || "2022-06-28",
    adminSecret: requiredEnv("ADMIN_SECRET"),
    storageUrl: optionalEnv("SB_URL") || optionalEnv("SUPABASE_URL"),
    storageKey: optionalEnv("SB_SERVICE_ROLE_KEY") || optionalEnv("SUPABASE_SERVICE_ROLE_KEY"),
    bucket: optionalEnv("PUBLISH_BUCKET") || "meta-publish",
    jobTable: optionalEnv("JOB_TABLE") || "meta_jobs",
    fixedComment: optionalEnv("PUBLISH_FIXED_COMMENT"),
    // 큐 모드에서 조회할 콘텐츠(하다) DB.
    contentDataSourceId: optionalEnv("CONTENT_DATA_SOURCE_ID") ||
      "dda5e4d7-d1b1-4c24-a75a-9442ce9664ca",
    contentDatabaseId: optionalEnv("CONTENT_DATABASE_ID") ||
      "ef3145878aba4994af456e11c27c9028",
    // 배포 채널 중 자동 발행하지 않는 채널(블로그·유튜브 등)의 기록을 만드는 게시물 DB.
    postDataSourceId: optionalEnv("POST_DATA_SOURCE_ID") ||
      "3cce3c09-0fa1-422e-a4e4-c81791da2241",
    // 게시물의 '채널' 관계가 가리키는 채널 DB. 채널 이름으로 페이지를 찾는다.
    channelDataSourceId: optionalEnv("CHANNEL_DATA_SOURCE_ID") ||
      "285ba040-586b-80ce-b1d4-000b163952b9",
    metaVersion: optionalEnv("META_GRAPH_VERSION") || "v26.0",
    igApiBase: optionalEnv("IG_API_BASE") || "https://graph.facebook.com",
    igUserId: optionalEnv("IG_USER_ID"),
    igToken: cleanEnvToken("IG_ACCESS_TOKEN"),
    threadsVersion: optionalEnv("THREADS_GRAPH_VERSION") || "v1.0",
    threadsApiBase: optionalEnv("THREADS_API_BASE") || "https://graph.threads.net",
    threadsUserId: optionalEnv("THREADS_USER_ID"),
    threadsToken: cleanEnvToken("THREADS_ACCESS_TOKEN"),
    threadsAppId: optionalEnv("THREADS_APP_ID"),
    threadsAppSecret: optionalEnv("THREADS_APP_SECRET"),
    threadsOauthBase: optionalEnv("THREADS_OAUTH_BASE") || "https://graph.threads.com",
    threadsRedirectUri: optionalEnv("THREADS_REDIRECT_URI"),
    tokenTable: optionalEnv("TOKEN_TABLE") || "meta_tokens",
    // 성과 수집(?metrics=1)이 증가분을 쌓는 성과 로그 DB.
    metricLogDataSourceId: optionalEnv("METRIC_LOG_DATA_SOURCE_ID") ||
      "b7759760-49e5-425a-89f2-022232c576c3",
    youtubeApiKey: optionalEnv("YOUTUBE_API_KEY"),
    youtubeClientId: optionalEnv("YOUTUBE_CLIENT_ID"),
    youtubeClientSecret: optionalEnv("YOUTUBE_CLIENT_SECRET"),
    youtubeRedirectUri: optionalEnv("YOUTUBE_REDIRECT_URI"),
    youtubePrivacy: youtubePrivacy(optionalEnv("YOUTUBE_PRIVACY")),
    // 22 = 인물/블로그, 27 = 교육
    youtubeCategoryId: optionalEnv("YOUTUBE_CATEGORY_ID") || "27",
    // 유튜브 업로드 목록을 볼 채널. 비우면 게시물 DB 에 있는 영상의 채널을 쓴다.
    youtubeChannelId: optionalEnv("YOUTUBE_CHANNEL_ID"),
    // 계정에서 찾은 게시물 중 이 날짜(한국 시간) 이후에 올린 것만 게시물 기록을 새로 만든다.
    // 예전 게시물까지 한꺼번에 가져오면 노션에 수백 행이 생기기 때문이다. 비우면 날짜 제한 없음.
    metricsImportSince: optionalEnv("METRICS_IMPORT_SINCE") || "2026-10-01",
  };
}

function json(body: Json, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ---------- 노션 ----------

async function notion(cfg: Config, path: string, init: RequestInit = {}): Promise<Json> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    ...init,
    headers: {
      "Authorization": `Bearer ${cfg.notionToken}`,
      "Notion-Version": cfg.notionVersion,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw apiError(cfg, `노션 API ${path}`, res.status, text);
  return text ? JSON.parse(text) : {};
}

function richText(prop: Json | undefined): string {
  const items = (prop?.rich_text ?? prop?.title ?? []) as Json[];
  return items.map((item) => item.plain_text ?? "").join("");
}

function selectName(prop: Json | undefined): string {
  return prop?.select?.name ?? "";
}

function multiSelectNames(prop: Json | undefined): string[] {
  return ((prop?.multi_select ?? []) as Json[]).map((option) => option.name);
}

function relationIds(prop: Json | undefined): string[] {
  return ((prop?.relation ?? []) as Json[]).map((item) => item.id);
}

/** 콘텐츠 페이지의 올리는 칸(타이틀·섬네일·콘텐츠·본문). 예전 칸 이름도 읽는다. */
function contentField(props: Json, field: ContentField): Json | undefined {
  return props[contentFieldName(Object.keys(props), field)];
}

function contentFiles(props: Json, field: ContentField = "file"): any[] {
  return (contentField(props, field)?.files ?? []) as any[];
}

async function updatePage(cfg: Config, pageId: string, properties: Json): Promise<void> {
  await notion(cfg, `/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties }),
  });
}

async function addComment(cfg: Config, pageId: string, content: string): Promise<void> {
  await notion(cfg, "/comments", {
    method: "POST",
    body: JSON.stringify({
      parent: { page_id: pageId },
      rich_text: [{ type: "text", text: { content: truncate(content, COMMENT_LIMIT) } }],
    }),
  });
}

// ---------- 미디어 공개 호스팅 ----------
// 메타는 공개 URL 로만 파일을 가져간다. 노션 파일 주소는 만료되므로 우리 버킷에 다시 올려 쓴다.

type MediaRole = "image" | "video";

type MediaFile = { bytes: Uint8Array; ext: string; contentType: string };

/** 노션 파일을 내려받아 실제 형식을 확인한다. */
async function downloadMedia(sourceUrl: string, role: MediaRole): Promise<MediaFile> {
  const download = await fetch(sourceUrl);
  if (!download.ok) throw new Error(`파일 내려받기 실패(${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("파일이 비어 있습니다.");

  // 노션은 업로드 파일을 binary/octet-stream 으로 돌려주기도 한다.
  // 그래서 content-type 을 믿지 않고 파일 앞바이트로 실제 형식을 판별한다.
  const headerType = (download.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
  const detail = `content-type: ${headerType || "없음"}, 앞바이트: ${hexPreview(bytes)}, 크기: ${bytes.byteLength}바이트`;

  let ext: string;
  if (role === "video") {
    const detected = detectVideoType(bytes);
    if (!detected && !headerType.startsWith("video/")) {
      throw new Error(`영상 파일이 아닙니다(${detail}). '형식'과 '콘텐츠' 파일을 확인하세요.`);
    }
    ext = detected ?? extensionFor(headerType, sourceUrl);
    if (!["mp4", "mov", "webm"].includes(ext)) {
      throw new Error(`영상 형식을 알아내지 못했습니다(${detail}). mp4 로 다시 올려주세요.`);
    }
  } else {
    const detected = detectImageType(bytes);
    if (!detected && !headerType.startsWith("image/")) {
      throw new Error(
        `이미지가 아닌 파일입니다(${detail}). 영상은 '형식'을 숏폼(9:16)이나 롱폼(16:9)으로 두세요.`,
      );
    }
    ext = detected ?? extensionFor(headerType, sourceUrl);
  }
  return { bytes, ext, contentType: contentTypeFor(ext) };
}

async function uploadMedia(
  cfg: Config,
  pageId: string,
  index: number | string,
  sourceUrl: string,
  role: MediaRole,
): Promise<string> {
  if (!cfg.storageUrl || !cfg.storageKey) {
    throw new Error("미디어 저장소 설정(SB_URL, SB_SERVICE_ROLE_KEY)이 없습니다.");
  }

  const { bytes, ext, contentType } = await downloadMedia(sourceUrl, role);
  // 숫자는 콘텐츠 파일 순번(01, 02 …), 글자는 섬네일처럼 이름을 정해 둔 파일이다.
  const name = typeof index === "number" ? String(index + 1).padStart(2, "0") : index;
  const path = `${pageId}/${name}.${ext}`;
  const upload = await fetch(`${cfg.storageUrl}/storage/v1/object/${cfg.bucket}/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${cfg.storageKey}`,
      "Content-Type": contentType,
      "x-upsert": "true",
      "cache-control": "max-age=31536000",
    },
    body: bytes,
  });
  if (!upload.ok) {
    throw apiError(cfg, "미디어 업로드 실패", upload.status, await upload.text(), 300);
  }
  return `${cfg.storageUrl}/storage/v1/object/public/${cfg.bucket}/${path}`;
}

// ---------- 토큰 저장소 ----------
// 스레드 토큰은 60일짜리라 환경값만으로는 만료된다. meta_tokens 표에 담아두고
// 발행할 때마다 오래된 토큰을 자동으로 갱신한다.

type TokenRow = {
  channel: string;
  access_token: string;
  user_id: string | null;
  expires_at: string | null;
  updated_at: string;
};

function storageReady(cfg: Config): boolean {
  return cfg.storageUrl !== "" && cfg.storageKey !== "";
}

async function sbRest(cfg: Config, path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${cfg.storageUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      "apikey": cfg.storageKey,
      "Authorization": `Bearer ${cfg.storageKey}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function readToken(cfg: Config, channel: string): Promise<TokenRow | null> {
  if (!storageReady(cfg)) return null;
  const res = await sbRest(
    cfg,
    `${cfg.tokenTable}?channel=eq.${encodeURIComponent(channel)}` +
      `&select=channel,access_token,user_id,expires_at,updated_at&limit=1`,
  );
  if (!res.ok) {
    throw apiError(cfg, "토큰 저장소 조회 실패", res.status, await res.text(), 200);
  }
  const rows = (await res.json()) as TokenRow[];
  return rows.length > 0 ? rows[0] : null;
}

async function saveToken(cfg: Config, row: TokenRow): Promise<void> {
  if (!storageReady(cfg)) {
    throw new Error("토큰 저장소 설정(SB_URL, SB_SERVICE_ROLE_KEY)이 없습니다.");
  }
  const res = await sbRest(cfg, cfg.tokenTable, {
    method: "POST",
    headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    throw apiError(cfg, "토큰 저장 실패", res.status, await res.text(), 200);
  }
}

// ---------- 인스타그램 ----------

function formBody(params: Json): URLSearchParams {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    body.set(key, String(value));
  }
  return body;
}

async function igRequest(cfg: Config, path: string, init: RequestInit = {}): Promise<Json> {
  if (!cfg.igUserId || !cfg.igToken) {
    throw new Error("인스타그램 설정(IG_USER_ID, IG_ACCESS_TOKEN)이 없습니다.");
  }
  // 값이 오염된 채로 저장되면 메타가 "Malformed access token" 으로 거절한다. 그 전에 우리가 먼저 알려준다.
  assertToken("IG_ACCESS_TOKEN", cfg.igToken);
  const res = await fetch(`${cfg.igApiBase}/${cfg.metaVersion}/${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${cfg.igToken}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw apiError(cfg, "인스타 API", res.status, text);
  return text ? JSON.parse(text) : {};
}

const igPost = (cfg: Config, path: string, params: Json) =>
  igRequest(cfg, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(params),
  });

const igGet = (cfg: Config, path: string) => igRequest(cfg, path);

// 인스타그램 발행은 대기열 워커가 한다(publishInstagramQueued). 컨테이너 처리 대기를 실행 사이에 이어서 확인한다.

// ---------- 스레드 인증 ----------
// Threads API 는 페이스북 로그인으로 붙는 경로가 없다. 스레드 자체 OAuth 를 한 번 거쳐
// 60일짜리 토큰을 받고, meta_tokens 표에 담아두고 발행할 때마다 오래된 토큰을 자동 갱신한다.

const THREADS_OAUTH_FALLBACK = "https://graph.threads.net";

// Supabase 게이트웨이가 응답의 Content-Type 을 text/plain 으로 덮어써서 HTML 은 렌더링되지 않는다.
// 그래서 사람이 읽기 좋은 평문으로 돌려주고, 한글이 깨지지 않게 UTF-8 BOM 을 앞에 붙인다.
// 구글 OAuth 앱을 프로덕션으로 게시하려면 홈페이지·개인정보처리방침 주소가 필요하다.
// 이미 승인된 도메인인 이 함수 주소에 붙여 둔다.
const HOME_PAGE_TEXT =
  "하다(HADA)가 직접 만든 콘텐츠를 자기 계정에 발행하고 성과를 기록하는 내부 도구입니다.\n\n" +
  "- 노션에 정리한 콘텐츠를 하다의 인스타그램·스레드·유튜브 계정에 발행합니다.\n" +
  "- 발행한 게시물의 조회수·좋아요·댓글 등 성과를 하다의 노션에 기록합니다.\n\n" +
  "외부 사용자에게 제공하는 서비스가 아니며, 하다 운영자 본인의 계정에만 연결됩니다.\n" +
  "개인정보처리방침: ?page=privacy";

const PRIVACY_PAGE_TEXT =
  "하다(HADA) 발행 도구는 하다 운영자 본인의 계정에만 연결해 쓰는 내부 도구입니다.\n\n" +
  "1. 받는 정보\n" +
  "   - 유튜브: 영상 업로드와 채널 확인에 필요한 권한(youtube.upload, youtube.readonly)의 인증 토큰\n" +
  "   - 인스타그램·스레드: 게시물 발행과 성과 조회에 필요한 인증 토큰\n\n" +
  "2. 쓰는 곳\n" +
  "   - 운영자가 노션에서 고른 콘텐츠를 운영자 본인의 채널에 발행하고, 그 게시물의 공개 성과 지표를 노션에 기록하는 데만 씁니다.\n\n" +
  "3. 보관과 공유\n" +
  "   - 토큰은 하다의 Supabase 데이터베이스에 저장하며 제3자에게 제공하거나 판매하지 않습니다.\n" +
  "   - 다른 사람의 개인정보는 수집하지 않습니다.\n\n" +
  "4. 삭제\n" +
  "   - 구글 계정 설정(https://myaccount.google.com/permissions)에서 언제든 연결을 끊을 수 있으며, 요청하면 저장된 토큰을 삭제합니다.\n\n" +
  "YouTube API 서비스를 사용하며, YouTube 서비스 약관(https://www.youtube.com/t/terms)과 Google 개인정보처리방침(https://policies.google.com/privacy)이 함께 적용됩니다.";

function textPage(title: string, body: string, status = 200): Response {
  return new Response(`\uFEFF${title}\n\n${body}\n`, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

/** OAuth 호스트는 graph.threads.com 과 graph.threads.net 이 혼용되어 있어 둘 다 시도한다. */
async function threadsOauthRequest(
  cfg: Config,
  path: string,
  params: Json,
  method: "GET" | "POST",
): Promise<Json> {
  const bases = [cfg.threadsOauthBase, THREADS_OAUTH_FALLBACK]
    .map((base) => base.replace(/\/+$/, ""))
    .filter((base, index, list) => base !== "" && list.indexOf(base) === index);

  let lastError = "";
  for (const base of bases) {
    try {
      const res = method === "POST"
        ? await fetch(`${base}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: formBody(params),
        })
        : await fetch(`${base}${path}?${formBody(params).toString()}`);
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : {};
      lastError = `스레드 OAuth ${res.status}: ${maskSecrets(summarizeApiError(text, 300), secretsOf(cfg))}`;
    } catch (e) {
      lastError = maskSecrets(message(e), secretsOf(cfg));
    }
  }
  throw new Error(lastError || "스레드 OAuth 요청에 실패했습니다.");
}

function assertThreadsApp(cfg: Config): void {
  if (cfg.threadsAppId === "" || cfg.threadsAppSecret === "") {
    throw new Error("스레드 앱 설정(THREADS_APP_ID, THREADS_APP_SECRET)이 없습니다.");
  }
}

/** 승인 code 를 1시간짜리 단기 토큰으로 바꾼다. */
async function exchangeThreadsCode(cfg: Config, code: string, redirectUri: string): Promise<Json> {
  assertThreadsApp(cfg);
  return await threadsOauthRequest(cfg, "/oauth/access_token", {
    client_id: cfg.threadsAppId,
    client_secret: cfg.threadsAppSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  }, "POST");
}

/** 단기 토큰을 60일짜리 장기 토큰으로 바꾼다. */
async function exchangeThreadsLongToken(cfg: Config, shortToken: string): Promise<Json> {
  assertThreadsApp(cfg);
  return await threadsOauthRequest(cfg, "/access_token", {
    grant_type: "th_exchange_token",
    client_secret: cfg.threadsAppSecret,
    access_token: shortToken,
  }, "GET");
}

/** 장기 토큰을 60일 더 연장한다. */
async function refreshThreadsToken(cfg: Config, token: string): Promise<Json> {
  return await threadsOauthRequest(cfg, "/refresh_access_token", {
    grant_type: "th_refresh_token",
    access_token: token,
  }, "GET");
}

type ThreadsAuth = { userId: string; token: string };

/** 발행에 쓸 스레드 인증 정보를 정한다. 저장된 토큰이 오래됐으면 먼저 갱신한다. */
async function resolveThreadsAuth(cfg: Config): Promise<ThreadsAuth> {
  let row: TokenRow | null = null;
  try {
    row = await readToken(cfg, "threads");
  } catch {
    row = null; // 표를 못 읽으면 환경값으로 넘어간다.
  }

  if (!row) {
    if (cfg.threadsUserId === "" || cfg.threadsToken === "") {
      throw new Error("스레드 인증 정보가 없습니다. 브라우저에서 스레드 인증을 먼저 진행하세요.");
    }
    return { userId: cfg.threadsUserId, token: assertToken("THREADS_ACCESS_TOKEN", cfg.threadsToken) };
  }

  const now = Date.now();
  const expiresMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    throw new Error("스레드 토큰이 만료되었습니다. 브라우저에서 스레드 인증을 다시 진행하세요.");
  }

  let token = cleanToken(row.access_token);
  if (needsRefresh(Date.parse(row.updated_at), now, THREADS_REFRESH_AFTER_DAYS)) {
    try {
      const refreshed = await refreshThreadsToken(cfg, token);
      const next = String(refreshed.access_token ?? "");
      if (next !== "") {
        token = next;
        await saveToken(cfg, {
          channel: "threads",
          access_token: token,
          user_id: row.user_id,
          expires_at: expiresAtFrom(now, refreshed.expires_in),
          updated_at: new Date(now).toISOString(),
        });
      }
    } catch {
      // 갱신에 실패해도 아직 살아 있는 토큰으로 계속 진행한다.
    }
  }

  return { userId: row.user_id ?? cfg.threadsUserId, token: assertToken("스레드 토큰", token) };
}

/** 브라우저로 열어 승인을 시작하는 안내 페이지. 링크만 보여주므로 인증이 필요 없다. */
function handleThreadsAuthPage(url: URL, cfg: Config): Response {
  try {
    assertThreadsApp(cfg);
    const redirectUri = resolveRedirectUri(url.toString(), cfg.storageUrl, cfg.threadsRedirectUri);
    const link = threadsAuthorizeUrl(cfg.threadsAppId, redirectUri, THREADS_AUTHORIZE_SCOPES);
    return textPage(
      "스레드 인증",
      `아래 주소를 복사해 브라우저 주소창에 붙여넣고 @ha.da_2025 로 승인하세요.\n\n` +
        `${link}\n\n` +
        `되돌아올 주소: ${redirectUri}`,
    );
  } catch (e) {
    return textPage("스레드 인증 준비 실패", message(e), 500);
  }
}

/** 스레드가 브라우저를 되돌려보내는 주소. code 를 장기 토큰으로 바꿔 저장한다. */
async function handleThreadsCallback(url: URL, cfg: Config): Promise<Response> {
  const denied = url.searchParams.get("error");
  if (denied) {
    const detail = url.searchParams.get("error_description") ?? denied;
    return textPage("스레드 인증 취소", detail, 400);
  }

  const code = url.searchParams.get("code") ?? "";
  if (code === "") return textPage("스레드 인증 실패", "code 값이 없습니다.", 400);

  try {
    const redirectUri = resolveRedirectUri(url.toString(), cfg.storageUrl, cfg.threadsRedirectUri);

    const short = await exchangeThreadsCode(cfg, code, redirectUri);
    const shortToken = String(short.access_token ?? "");
    if (shortToken === "") throw new Error("단기 토큰을 받지 못했습니다.");

    const long = await exchangeThreadsLongToken(cfg, shortToken);
    const token = String(long.access_token ?? "");
    if (token === "") throw new Error("장기 토큰을 받지 못했습니다.");

    const me = await threadsFetch(cfg, token, "me?fields=id,username");
    const now = Date.now();
    await saveToken(cfg, {
      channel: "threads",
      access_token: token,
      user_id: me.id ? String(me.id) : null,
      expires_at: expiresAtFrom(now, long.expires_in),
      updated_at: new Date(now).toISOString(),
    });

    return textPage(
      "스레드 인증 완료",
      `@${me.username ?? ""} (ID ${me.id ?? ""}) 연결을 저장했습니다. 이 창은 닫아도 됩니다.`,
    );
  } catch (e) {
    return textPage("스레드 인증 실패", message(e), 500);
  }
}

// ---------- 스레드 발행 ----------

async function threadsFetch(
  cfg: Config,
  token: string,
  path: string,
  init: RequestInit = {},
): Promise<Json> {
  const res = await fetch(`${cfg.threadsApiBase}/${cfg.threadsVersion}/${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw apiFailure(cfg, "스레드 API", res.status, text);
  return text ? JSON.parse(text) : {};
}

const threadsPost = (cfg: Config, auth: ThreadsAuth, path: string, params: Json) =>
  threadsFetch(cfg, auth.token, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(params),
  });

const threadsGet = (cfg: Config, auth: ThreadsAuth, path: string) =>
  threadsFetch(cfg, auth.token, path);

/**
 * 발행 소스. 형식에 따라 '콘텐츠' 이미지(한 장 또는 캐러셀) / '콘텐츠' 영상 / 글만 중 하나가 된다.
 * 인스타그램은 글만 올리는 걸 지원하지 않으므로 text 는 스레드 전용이다.
 */
type MediaPlan =
  | { kind: "images"; urls: string[] }
  // 카드뉴스에 영상이 섞이면 넣은 순서대로 이미지·영상을 함께 캐러셀로 올린다(스레드).
  | { kind: "mixed"; items: MediaItem[] }
  | { kind: "video"; url: string }
  | { kind: "text" };

/**
 * 캐러셀 부모 컨테이너를 만든다.
 * 자식들이 준비되기 전에 부모를 만들면 메타가 400(code 100, subcode 4279004)으로 거절하므로
 * 조금 기다렸다 다시 시도한다.
 */
async function createThreadsCarousel(
  cfg: Config,
  auth: ThreadsAuth,
  children: string[],
  text: string,
  replyToId = "",
): Promise<Json> {
  return await retryWhen(
    THREADS_CAROUSEL_CREATE_ATTEMPTS,
    THREADS_CAROUSEL_CREATE_DELAY_MS,
    isThreadsNotReady,
    () =>
      threadsPost(cfg, auth, `${auth.userId}/threads`, {
        media_type: "CAROUSEL",
        children: children.join(","),
        ...optionalText("text", text),
        ...optionalText("reply_to_id", replyToId),
      }),
    "스레드 캐러셀 컨테이너",
  );
}

/** 발행 직후에는 컨테이너가 아직 전파되지 않아 "없다"는 답이 올 수 있다. 그때만 다시 시도한다. */
async function publishThreadsContainer(
  cfg: Config,
  auth: ThreadsAuth,
  containerId: string,
): Promise<Json> {
  return await retryWhen(
    THREADS_PUBLISH_ATTEMPTS,
    THREADS_PUBLISH_DELAY_MS,
    isThreadsNotFound,
    () => threadsPost(cfg, auth, `${auth.userId}/threads_publish`, { creation_id: containerId }),
    "스레드 발행",
  );
}

// ---------- 유튜브 ----------
// 구글 OAuth 로 한 번 승인해 refresh token 을 받아 meta_tokens 표(channel = youtube)에 담아둔다.
// refresh token 은 만료가 없으므로(앱이 '프로덕션' 상태일 때) 업로드할 때마다 1시간짜리 접근 토큰을 새로 받는다.
// 표의 access_token 칸에 refresh token 을, user_id 칸에 유튜브 채널 ID 를 넣는다.

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos";

function youtubeReady(cfg: Config): boolean {
  return cfg.youtubeClientId !== "" && cfg.youtubeClientSecret !== "";
}

async function googleToken(cfg: Config, params: Json): Promise<Json> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: cfg.youtubeClientId, client_secret: cfg.youtubeClientSecret, ...params }),
  });
  const text = await res.text();
  if (!res.ok) throw apiError(cfg, "구글 토큰", res.status, text, 300);
  return text ? JSON.parse(text) : {};
}

async function youtubeFetch(cfg: Config, accessToken: string, path: string): Promise<Json> {
  const res = await fetch(`${YOUTUBE_API}/${path}`, { headers: { "Authorization": `Bearer ${accessToken}` } });
  const text = await res.text();
  if (!res.ok) throw apiError(cfg, "유튜브 API", res.status, text);
  return text ? JSON.parse(text) : {};
}

/** 저장된 refresh token 으로 접근 토큰을 받는다. */
async function youtubeAccessToken(cfg: Config): Promise<string> {
  const row = await readToken(cfg, "youtube");
  if (!row) throw new Error("유튜브 인증 정보가 없습니다. 브라우저에서 유튜브 인증(?youtube_auth=1)을 먼저 진행하세요.");
  try {
    const token = await googleToken(cfg, { grant_type: "refresh_token", refresh_token: row.access_token });
    const access = String(token.access_token ?? "");
    if (access === "") throw new Error("접근 토큰을 받지 못했습니다.");
    return access;
  } catch (e) {
    // invalid_grant 는 승인이 취소됐거나, 구글 앱이 '테스트' 상태라 7일이 지나 만료된 경우다.
    throw new Error(`유튜브 인증이 만료되었습니다. 유튜브 인증(?youtube_auth=1)을 다시 진행하세요. (${message(e)})`);
  }
}

function handleYoutubeAuthPage(url: URL, cfg: Config): Response {
  if (!youtubeReady(cfg)) {
    return textPage("유튜브 인증 준비 실패", "환경값 YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET 이 없습니다.", 500);
  }
  const redirectUri = resolveRedirectUri(url.toString(), cfg.storageUrl, cfg.youtubeRedirectUri);
  const link = youtubeAuthorizeUrl(cfg.youtubeClientId, redirectUri, YOUTUBE_SCOPES);
  return textPage(
    "유튜브 인증",
    `아래 주소를 복사해 브라우저 주소창에 붙여넣고, 영상을 올릴 유튜브 채널의 구글 계정으로 승인하세요.\n\n` +
      `${link}\n\n` +
      `되돌아올 주소(구글 클라우드 '승인된 리디렉션 URI'에 같은 값을 넣어야 합니다): ${redirectUri}`,
  );
}

async function handleYoutubeCallback(url: URL, cfg: Config): Promise<Response> {
  const denied = url.searchParams.get("error");
  if (denied) return textPage("유튜브 인증 취소", denied, 400);
  const code = url.searchParams.get("code") ?? "";
  if (code === "") return textPage("유튜브 인증 실패", "code 값이 없습니다.", 400);

  try {
    const redirectUri = resolveRedirectUri(url.toString(), cfg.storageUrl, cfg.youtubeRedirectUri);
    const token = await googleToken(cfg, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
    const refresh = String(token.refresh_token ?? "");
    if (refresh === "") {
      throw new Error("refresh token 을 받지 못했습니다. 구글 계정 > 보안 > 서드파티 연결에서 이 앱을 지운 뒤 다시 승인하세요.");
    }
    const me = await youtubeFetch(cfg, String(token.access_token ?? ""), "channels?part=snippet&mine=true");
    const channel = ((me.items ?? []) as Json[])[0];
    if (!channel) throw new Error("이 구글 계정에 유튜브 채널이 없습니다. 채널이 있는 계정으로 다시 승인하세요.");

    await saveToken(cfg, {
      channel: "youtube",
      access_token: refresh,
      user_id: String(channel.id),
      expires_at: null,
      updated_at: new Date().toISOString(),
    });
    return textPage(
      "유튜브 인증 완료",
      `'${channel.snippet?.title ?? ""}' 채널(ID ${channel.id}) 연결을 저장했습니다. 이 창은 닫아도 됩니다.`,
    );
  } catch (e) {
    return textPage("유튜브 인증 실패", message(e), 500);
  }
}

type YoutubeUpload = { id: string; privacy: string };

/**
 * 영상을 올린다. 재개 가능 업로드로 메타데이터를 먼저 보내고 받은 주소에 파일을 PUT 한다.
 * 유튜브는 업로드 직후 영상 ID 를 돌려주고 처리는 나중에 하므로 기다리지 않는다.
 */
async function uploadYoutube(
  cfg: Config,
  file: MediaFile,
  title: string,
  description: string,
): Promise<YoutubeUpload> {
  const accessToken = await youtubeAccessToken(cfg);
  const start = await fetch(`${YOUTUBE_UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(file.bytes.byteLength),
      "X-Upload-Content-Type": file.contentType,
    },
    body: JSON.stringify({
      snippet: { title, description, categoryId: cfg.youtubeCategoryId },
      status: { privacyStatus: cfg.youtubePrivacy, selfDeclaredMadeForKids: false },
    }),
  });
  if (!start.ok) throw apiError(cfg, "유튜브 업로드 준비", start.status, await start.text());
  const location = start.headers.get("location");
  if (!location) throw new Error("유튜브가 업로드 주소를 돌려주지 않았습니다.");

  const put = await fetch(location, {
    method: "PUT",
    headers: { "Content-Type": file.contentType },
    body: file.bytes,
  });
  const text = await put.text();
  if (!put.ok) throw apiError(cfg, "유튜브 업로드", put.status, text);
  const video = JSON.parse(text) as Json;
  return { id: String(video.id ?? ""), privacy: String(video.status?.privacyStatus ?? "") };
}

const YOUTUBE_THUMBNAIL_URL = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const YOUTUBE_THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 올린 영상에 '섬네일' 이미지를 붙인다. 쇼츠도 부른다(스튜디오는 쇼츠 섬네일을 받는다). 거절되면 그 오류를 안내로 남긴다.
 * 채널이 전화번호 인증을 마치지 않았으면 유튜브가 거절한다. 영상은 이미 올라갔으므로 호출부는 안내로만 남긴다.
 */
async function setYoutubeThumbnail(cfg: Config, videoId: string, imageUrl: string): Promise<void> {
  const image = await downloadMedia(imageUrl, "image");
  if (image.bytes.byteLength > YOUTUBE_THUMBNAIL_MAX_BYTES) {
    throw new Error(`섬네일이 2MB를 넘습니다(${Math.ceil(image.bytes.byteLength / 1024)}KB). 줄여서 유튜브 스튜디오에서 바꿔주세요.`);
  }
  const accessToken = await youtubeAccessToken(cfg);
  const res = await fetch(`${YOUTUBE_THUMBNAIL_URL}?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": image.contentType },
    body: image.bytes,
  });
  if (!res.ok) throw apiError(cfg, "유튜브 섬네일", res.status, await res.text());
}

/** 이 콘텐츠의 유튜브 게시물 기록 중 게시 링크가 있으면 그 링크를 준다(이미 올린 것). 없으면 빈 문자열. */
async function youtubePostedLink(cfg: Config, pageId: string): Promise<string> {
  const channelId = await findChannelPageId(cfg, YOUTUBE_CHANNEL);
  const rows = await findPostRecords(cfg, pageId, channelId);
  for (const row of rows) {
    const url = ((row.properties ?? {}) as Json)["게시 링크"]?.url;
    if (url) return String(url);
  }
  return "";
}

// ---------- 채널 ----------

const CHANNELS = ["인스타그램", "스레드"] as const;
type Channel = typeof CHANNELS[number];

const RESULT_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 상태",
  "스레드": "스레드 상태",
};
// 유튜브는 배포 채널로만 요청하고 ⚪ 대기를 쓰지 않는다. 함수가 🔄 작업중 → ✅ 완료/⚠️ 오류만 기록한다.
const YOUTUBE_RESULT_PROP = "유튜브 상태";
// 콘텐츠 DB `상태` 선택지: 기획 → 게시대기 → 게시완료 (보류). 함수는 게시완료만 쓴다.
const CONTENT_STATUS_PUBLISHED = "게시완료";
// 사람이 직접 올리는 채널의 기록을 만들면 '게시대기'로 둔다. Aside가 '블로그 대기' 보기에서 가져가 올린 뒤 '게시완료'로 바꾼다.
const CONTENT_STATUS_WAITING = "게시대기";
const MANUAL_PUBLISH_CHANNELS = new Set(["블로그"]);

// 채널 상태 값. 학원관리 다른 DB 와 같은 5단계를 쓴다.
const STATUS_WAITING = "⚪ 대기";
const STATUS_WORKING = "🔄 작업중";
const STATUS_DONE = "✅ 완료";
const STATUS_ERROR = "⚠️ 오류";

/**
 * 요청이 접수된 채널.
 * 배포 버튼이 상태를 ⚪ 대기로 바꾸고 웹훅을 보내므로, 대기이거나 이미 작업중인 채널이 처리 대상이다.
 */
function requestedChannels(props: Json): Channel[] {
  return CHANNELS.filter((channel) => {
    const name = selectName(props[RESULT_PROP[channel]]);
    return name === STATUS_WAITING || name === STATUS_WORKING;
  });
}

// ---------- 작업 잠금 ----------
// 같은 행의 같은 채널을 두 실행이 동시에 처리하면 같은 글이 두 번 올라간다.
// Supabase 표에 (페이지, 채널) 잠금을 걸어 한 번에 한 실행만 처리하게 한다.
// 표가 없거나 잠금 장치가 막혀도 발행 자체를 막지는 않는다.

const JOB_STALE_MS = 15 * 60 * 1000;

async function claimJob(cfg: Config, pageId: string, channel: string): Promise<boolean> {
  if (!storageReady(cfg)) return true;
  const now = new Date().toISOString();
  const key = `page_id=eq.${encodeURIComponent(pageId)}&channel=eq.${encodeURIComponent(channel)}`;
  try {
    const res = await sbRest(cfg, cfg.jobTable, {
      method: "POST",
      headers: { "Prefer": "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({ page_id: pageId, channel, started_at: now }),
    });
    if (res.status === 404) return true;
    if (!res.ok) {
      console.error("잠금 실패", res.status, (await res.text()).slice(0, 200));
      return true;
    }
    const rows = (await res.json()) as Json[];
    if (rows.length > 0) return true;

    // 누가 이미 잡고 있다. 15분 넘게 멈춘 잠금이면 가져온다.
    const cutoff = new Date(Date.now() - JOB_STALE_MS).toISOString();
    const takeover = await sbRest(cfg, `${cfg.jobTable}?${key}&started_at=lt.${encodeURIComponent(cutoff)}`, {
      method: "PATCH",
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({ started_at: now }),
    });
    if (!takeover.ok) return false;
    const taken = (await takeover.json()) as Json[];
    return taken.length > 0;
  } catch (e) {
    console.error("잠금 오류", message(e));
    return true;
  }
}

async function releaseJob(cfg: Config, pageId: string, channel: string): Promise<void> {
  if (!storageReady(cfg)) return;
  const key = `page_id=eq.${encodeURIComponent(pageId)}&channel=eq.${encodeURIComponent(channel)}`;
  try {
    await sbRest(cfg, `${cfg.jobTable}?${key}`, { method: "DELETE" });
  } catch (e) {
    console.error("잠금 해제 실패", message(e));
  }
}

// ---------- 큐 ----------
// 노션 버튼 웹훅은 페이지 URL 을 실어 보낼 수 없다(보낼 수 있는 건 DB 속성뿐).
// 그래서 작업중 체크가 켜진 행을 서버가 직접 조회한다.

async function queryQueuedPageIds(cfg: Config): Promise<string[]> {
  // 버튼이 상태를 ⚪ 대기로 바꾼 뒤 웹훅을 보내므로, 웹훅이 오지 않은 행은 대기로 남는다.
  const filter = {
    or: CHANNELS.map((channel) => ({
      property: RESULT_PROP[channel],
      select: { equals: STATUS_WAITING },
    })),
  };
  const body = JSON.stringify({ filter, page_size: 20 });
  const ids = (res: Json) => ((res.results ?? []) as Json[]).map((page) => page.id as string);

  let firstError = "";
  try {
    // 데이터 소스 단위 조회가 최신 방식이다.
    return ids(await notion(cfg, `/data_sources/${cfg.contentDataSourceId}/query`, {
      method: "POST",
      headers: { "Notion-Version": "2025-09-03" },
      body,
    }));
  } catch (e) {
    firstError = message(e);
  }
  try {
    // 예전 버전 경로. 데이터 소스가 하나뿐인 DB 는 이쪽으로도 조회된다.
    return ids(await notion(cfg, `/databases/${cfg.contentDatabaseId}/query`, {
      method: "POST",
      body,
    }));
  } catch (e) {
    throw new Error(`콘텐츠 DB 조회에 실패했습니다. (${firstError} / ${message(e)})`);
  }
}

// 웹훅이 페이지를 실어 보내면 이 경로는 쓰이지 않는다.
// 웹훅이 실패해 ⚪ 대기로 남은 행을 줍는 백업 경로다.
async function findQueuedPageIds(cfg: Config): Promise<string[]> {
  return await queryQueuedPageIds(cfg);
}

// ---------- 게시물 기록 ----------
// 블로그·유튜브처럼 자동 발행하지 않는 채널은 게시물 DB 에 기록만 만든다.
// 사람이 직접 올린 뒤 그 기록에 게시 링크를 붙인다.

const POST_API_VERSION = "2025-09-03";

function pageTitle(props: Json): string {
  for (const prop of Object.values(props)) {
    if ((prop as Json)?.type === "title") return richText(prop as Json).trim();
  }
  return "";
}

async function queryDataSource(cfg: Config, dataSourceId: string, filter: Json): Promise<Json[]> {
  const res = await notion(cfg, `/data_sources/${dataSourceId}/query`, {
    method: "POST",
    headers: { "Notion-Version": POST_API_VERSION },
    body: JSON.stringify({ filter, page_size: 10 }),
  });
  return (res.results ?? []) as Json[];
}

/** 채널 DB 에서 이름이 같은 채널 페이지를 찾는다. */
async function findChannelPageId(cfg: Config, name: string): Promise<string> {
  const rows = await queryDataSource(cfg, cfg.channelDataSourceId, {
    property: "이름",
    title: { equals: name },
  });
  if (rows.length === 0) {
    throw new Error(`채널 DB 에 '${name}' 채널이 없습니다. 채널 이름을 '배포 채널' 옵션과 같게 맞춰주세요.`);
  }
  return rows[0].id as string;
}

type PostRecord = { channel: string; url: string; created: boolean; linked: boolean };

let postContentPropName = "";

/** 게시물 DB 에서 콘텐츠를 가리키는 관계 칸 이름('콘텐츠', 예전 이름 '산출물'). 한 번 읽어 둔다. */
async function postContentProp(cfg: Config): Promise<string> {
  if (postContentPropName === "") {
    const source = await notion(cfg, `/data_sources/${cfg.postDataSourceId}`, {
      headers: { "Notion-Version": POST_API_VERSION },
    });
    postContentPropName = pickPostContentProp(Object.keys((source.properties ?? {}) as Json));
  }
  return postContentPropName;
}

/** 이 콘텐츠·채널의 게시물 기록들. */
async function findPostRecords(cfg: Config, pageId: string, channelId: string): Promise<Json[]> {
  return await queryDataSource(cfg, cfg.postDataSourceId, {
    and: [
      { property: await postContentProp(cfg), relation: { contains: pageId } },
      { property: "채널", relation: { contains: channelId } },
    ],
  });
}

async function createPostPage(
  cfg: Config,
  pageId: string,
  title: string,
  channel: string,
  channelId: string,
  extra: Json = {},
): Promise<Json> {
  return await notion(cfg, "/pages", {
    method: "POST",
    headers: { "Notion-Version": POST_API_VERSION },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: cfg.postDataSourceId },
      properties: {
        "이름": { title: [{ type: "text", text: { content: truncate(`${title} · ${channel}`, 1900) } }] },
        "채널": { relation: [{ id: channelId }] },
        [await postContentProp(cfg)]: { relation: [{ id: pageId }] },
        ...extra,
      },
    }),
  });
}

/**
 * 자동 발행에 성공한 채널을 게시물 DB 에 기록한다. 성과 트래킹은 이 게시물 기록에 붙는다.
 * 같은 콘텐츠·채널 기록 중 게시 링크가 빈 것이 있으면 그 기록을 채우고, 없으면 새로 만든다.
 * 다시 발행한 경우(상태를 비우고 재발행)에는 이전 기록을 덮어쓰지 않고 새 기록이 생긴다.
 */
async function recordPublishedPost(
  cfg: Config,
  pageId: string,
  props: Json,
  channel: string,
  link: string,
  threadsId = "",
): Promise<string> {
  const channelId = await findChannelPageId(cfg, channel);
  const fields: Json = {
    "게시 상태": { select: { name: "게시" } },
    "게시일": { date: { start: new Date().toISOString() } },
  };
  if (link) fields["게시 링크"] = { url: link };
  // 스레드 답글의 성과를 읽을 때 쓴다(threadsIdNote 설명 참고).
  if (threadsId) fields["메모"] = { rich_text: [{ type: "text", text: { content: threadsIdNote(threadsId) } }] };

  const existing = await findPostRecords(cfg, pageId, channelId);
  const empty = existing.find((row) => !((row.properties ?? {}) as Json)["게시 링크"]?.url);
  if (empty) {
    await notion(cfg, `/pages/${empty.id}`, {
      method: "PATCH",
      headers: { "Notion-Version": POST_API_VERSION },
      body: JSON.stringify({ properties: fields }),
    });
    return (empty.url as string) ?? "";
  }
  const page = await createPostPage(cfg, pageId, pageTitle(props) || "제목 없음", channel, channelId, fields);
  return (page.url as string) ?? "";
}

/**
 * 채널마다 게시물 DB 에 기록을 하나 만든다.
 * 같은 콘텐츠·채널 기록이 이미 있으면 새로 만들지 않는다. 버튼을 여러 번 눌러도 기록은 하나다.
 * 실패해도 발행은 계속 가도록 실패 목록만 돌려준다.
 */
async function createPostRecords(
  cfg: Config,
  pageId: string,
  props: Json,
  channels: string[],
): Promise<{ records: PostRecord[]; failures: string[] }> {
  const records: PostRecord[] = [];
  const failures: string[] = [];
  const title = pageTitle(props) || "제목 없음";
  for (const channel of channels) {
    try {
      const channelId = await findChannelPageId(cfg, channel);
      const existing = await findPostRecords(cfg, pageId, channelId);
      if (existing.length > 0) {
        const linked = Boolean(((existing[0].properties as Json)?.["게시 링크"] as Json)?.url);
        records.push({ channel, url: (existing[0].url as string) ?? "", created: false, linked });
        continue;
      }
      const page = await createPostPage(cfg, pageId, title, channel, channelId);
      records.push({ channel, url: (page.url as string) ?? "", created: true, linked: false });
      console.log("게시물 기록 생성", pageId, channel, page.url ?? "");
    } catch (e) {
      failures.push(`${channel} — ${maskSecrets(message(e), secretsOf(cfg))}`);
    }
  }

  const lines: string[] = [];
  for (const record of records) {
    lines.push(`${record.channel}: ${record.created ? "새로 만들었습니다" : "이미 있습니다"} ${record.url}`);
  }
  for (const failure of failures) lines.push(`실패 — ${failure}`);
  if (lines.length > 0) {
    try {
      await addComment(
        cfg,
        pageId,
        `게시물 기록\n\n${lines.join("\n")}\n\n직접 올린 뒤 게시물의 '게시 링크'를 채워주세요.`,
      );
    } catch (e) {
      console.error("게시물 기록 코멘트 실패", message(e));
    }
  }
  return { records, failures };
}

// ---------- 발행 ----------

/**
 * '형식'에 따라 발행 소스를 정한다.
 * 카드뉴스는 '콘텐츠' 이미지 캐러셀(넣은 순서대로), 이미지는 한 장, 영상은 '콘텐츠' 영상, 짧은글은 글만 올린다.
 */
function collectSources(props: Json, kind: MediaKind): MediaPlan {
  const files = contentFiles(props);
  if (kind === "carousel") {
    const items = extractMediaItems(files);
    if (items.some((item) => item.type === "video")) return { kind: "mixed", items };
    const urls = extractImageUrls(files);
    if (urls.length === 0) {
      throw new Error("'콘텐츠'에 이미지가 없습니다. 카드뉴스 이미지를 올릴 순서대로 넣어주세요.");
    }
    return { kind: "images", urls };
  }
  if (kind === "image") {
    const urls = extractImageUrls(files);
    if (urls.length === 0) {
      throw new Error("'콘텐츠'에 이미지 파일이 없습니다. 발행할 이미지를 올려주세요.");
    }
    return { kind: "images", urls: urls.slice(0, 1) };
  }
  if (kind === "video") {
    const urls = extractVideoUrls(files);
    if (urls.length === 0) {
      throw new Error("'콘텐츠'에 영상 파일이 없습니다. mp4 파일을 올려주세요.");
    }
    if (urls.length > 1) {
      console.warn("'콘텐츠'에 영상이 여러 개라 첫 번째만 발행합니다.");
    }
    return { kind: "video", url: urls[0] };
  }
  return { kind: "text" };
}

/** '섬네일' 칸의 첫 이미지. 없으면 빈 문자열. */
function thumbnailUrl(props: Json): string {
  return extractImageUrls(contentFiles(props, "thumbnail"))[0] ?? "";
}

/** 하위 항목의 발행 소스. 형식을 따로 두지 않고 '콘텐츠' 칸에 든 파일로 정한다. */
function replySources(props: Json): MediaPlan {
  const files = contentFiles(props);
  const videos = extractVideoUrls(files);
  const images = extractImageUrls(files);
  switch (replyMediaKind(images.length, videos.length)) {
    case "video":
      return { kind: "video", url: videos[0] };
    case "carousel":
      return { kind: "images", urls: images };
    case "image":
      return { kind: "images", urls: images.slice(0, 1) };
    default:
      return { kind: "text" };
  }
}

const SUB_ITEMS_PROP = "하위 항목";

/**
 * 스레드 본글에 하위 항목을 만든 순서대로 답글로 이어 단다. 바로 앞 글에 다는 사슬이라 하나가 실패하면 거기서 멈춘다.
 * 하위 항목마다 스레드 상태·상태를 완료로 두고 게시물 기록을 따로 만든다(답글마다 조회수·좋아요가 따로 잡힌다).
 * 고정 멘트는 본글에만 붙인다.
 */
/** 이 콘텐츠의 스레드 게시물 기록 메모에 남긴 글 ID. 없으면 빈 문자열. */
async function threadsIdOfPage(cfg: Config, pageId: string): Promise<string> {
  const channelId = await findChannelPageId(cfg, "스레드");
  for (const row of await findPostRecords(cfg, pageId, channelId)) {
    const props = (row.properties ?? {}) as Json;
    // 내린(지운) 글에는 답글을 이을 수 없다.
    if (selectName(props["게시 상태"]) === "내림") continue;
    const id = threadsIdFromMemo(richText(props["메모"]));
    if (id !== "") return id;
  }
  return "";
}

/** 답글 결과. wait 가 있으면 그 답글의 컨테이너가 아직 처리 중이라 1분 뒤 이어서 확인한다. */
type RepliesResult = { posted: string[]; failures: string[]; postFailures: string[]; wait?: ContainerState };

/** 답글을 대기열 줄(본글의 스레드 줄)에서 이어 올릴 때 쓰는 값. */
type ReplyQueue = { job: PublishJob; hooks: ProcessHooks; deadline: number };

/** 본글이 이미 올라간 콘텐츠를 다시 배포하면, 아직 못 단 하위 항목만 답글로 단다. */
async function resumeThreadsReplies(
  cfg: Config,
  pageId: string,
  props: Json,
  queue: ReplyQueue,
): Promise<RepliesResult> {
  const empty = { posted: [] as string[], failures: [] as string[], postFailures: [] as string[] };
  if (relationIds(props[SUB_ITEMS_PROP]).length === 0) return empty;
  const rootId = await threadsIdOfPage(cfg, pageId);
  if (rootId === "") {
    return { ...empty, failures: ["스레드 답글 — 본글의 게시물 기록에 글 ID가 없어 답글을 이을 수 없습니다."] };
  }
  return await publishThreadsReplies(cfg, await resolveThreadsAuth(cfg), props, rootId, queue);
}

/** 답글 결과를 코멘트로 남긴다. 본글 발행 흐름 밖(다시 배포)에서 쓴다. */
async function reportReplies(
  cfg: Config,
  pageId: string,
  replies: { posted: string[]; failures: string[]; postFailures: string[] },
): Promise<void> {
  const lines = [...replies.failures, ...replies.postFailures.map((line) => `게시물 기록 실패: ${line}`)];
  if (lines.length === 0) return;
  try {
    await addComment(cfg, pageId, `스레드 답글 실패\n\n${maskSecrets(lines.join("\n"), secretsOf(cfg))}`);
  } catch (e) {
    console.error("답글 실패 코멘트 실패", message(e));
  }
}

/**
 * 답글 컨테이너는 본글과 같은 대기열 줄의 컨테이너 칸에 남긴다. 답글은 하나씩 차례로 달고, 단 직후 칸을 비우므로
 * 남아 있는 컨테이너는 항상 '아직 못 단 첫 답글'의 것이다. 처리 중이면 wait 를 돌려주고 1분 뒤 이어서 확인한다.
 */
async function publishThreadsReplies(
  cfg: Config,
  auth: ThreadsAuth,
  props: Json,
  rootId: string,
  queue: ReplyQueue,
): Promise<RepliesResult> {
  const posted: string[] = [];
  const failures: string[] = [];
  const postFailures: string[] = [];
  const ids = relationIds(props[SUB_ITEMS_PROP]);
  if (ids.length === 0 || rootId === "") return { posted, failures, postFailures };

  const items: { pageId: string; createdTime: string; props: Json }[] = [];
  for (const id of ids) {
    const page = await notion(cfg, `/pages/${id}`);
    items.push({ pageId: id, createdTime: String(page.created_time ?? ""), props: (page.properties ?? {}) as Json });
  }

  let replyTo = rootId;
  for (const item of sortByCreated(items)) {
    const name = pageTitle(item.props) || "제목 없음";
    // 이미 단 답글은 건너뛰고, 다음 답글은 그 답글에 잇는다(다시 배포할 때 남은 답글만 단다).
    if (selectName(item.props[RESULT_PROP["스레드"]]) === STATUS_DONE) {
      const doneId = await threadsIdOfPage(cfg, item.pageId);
      if (doneId === "") {
        failures.push(`스레드 답글 '${name}' — 이미 올렸지만 게시물 기록에 글 ID가 없어 다음 답글을 이을 수 없습니다.`);
        break;
      }
      replyTo = doneId;
      continue;
    }
    try {
      const text = richText(contentField(item.props, "body")).trim();
      const limitError = captionLimitError(text, ["스레드"]);
      if (limitError) throw new Error(limitError);
      const plan = replySources(item.props);
      if (plan.kind === "text" && text === "") throw new Error("'본문'과 '콘텐츠'가 모두 비어 있습니다.");
      const reply = await publishThreadsQueued(
        cfg,
        auth,
        queue.job,
        queue.hooks,
        () => uploadPlan(cfg, item.pageId, plan),
        text,
        queue.deadline,
        replyTo,
      );
      if (reply.kind === "wait") {
        console.log("hada-publish 답글 처리 대기", item.pageId, reply.container.id || "(자식 대기)");
        return { posted, failures, postFailures, wait: reply.container };
      }
      replyTo = reply.id;
      posted.push(reply.link || name);
      console.log("hada-publish 답글 완료", item.pageId, reply.link || "(링크 없음)");
      await updatePage(cfg, item.pageId, {
        [RESULT_PROP["스레드"]]: { select: { name: STATUS_DONE } },
        "상태": { select: { name: CONTENT_STATUS_PUBLISHED } },
        "발행 시각": { date: { start: new Date().toISOString() } },
      });
      try {
        await recordPublishedPost(cfg, item.pageId, item.props, "스레드", reply.link, reply.id);
      } catch (e) {
        postFailures.push(`스레드 답글 '${name}' — ${maskSecrets(message(e), secretsOf(cfg))}`);
      }
    } catch (e) {
      // 실패한 답글의 컨테이너는 버린다. 다시 배포하면 새로 만든다.
      await queue.hooks.clearContainer().catch(() => {});
      failures.push(
        `스레드 답글 '${name}' — ${maskSecrets(message(e), secretsOf(cfg))}. ` +
          "본글은 올라갔습니다. 원인을 고친 뒤 배포 버튼을 다시 누르면 본글은 건너뛰고 남은 답글만 이어 답니다.",
      );
      break;
    }
  }
  return { posted, failures, postFailures };
}

/** 요청한 채널들이 같은 파일을 쓰도록 한 번만 올린다. */
async function uploadPlan(cfg: Config, pageId: string, plan: MediaPlan): Promise<MediaPlan> {
  if (plan.kind === "text") return plan;
  if (plan.kind === "video") {
    return { kind: "video", url: await uploadMedia(cfg, pageId, 0, plan.url, "video") };
  }
  if (plan.kind === "mixed") {
    const items: MediaItem[] = [];
    for (let index = 0; index < plan.items.length; index++) {
      const item = plan.items[index];
      items.push({ type: item.type, url: await uploadMedia(cfg, pageId, index, item.url, item.type) });
    }
    return { kind: "mixed", items };
  }
  const urls: string[] = [];
  for (let index = 0; index < plan.urls.length; index++) {
    urls.push(await uploadMedia(cfg, pageId, index, plan.urls[index], "image"));
  }
  return { kind: "images", urls };
}

// ---------- 대기열: 접수 ----------
// 배포 버튼(웹훅)·큐 조회·예약 발행은 여기서 채널마다 대기열(publish_queue)에 한 줄씩 넣기만 한다.
// 실제 발행은 워커(?worker=1)가 한 실행에 한 채널씩 한다(supabase/publish_queue.sql, queue.ts).

/** 대기열 저장소. supabase/publish_queue.sql 의 표·함수를 PostgREST 로 부른다. */
class RestQueueStore implements QueueStore {
  constructor(private cfg: Config) {}

  private async rpc(name: string, args: Json = {}): Promise<unknown> {
    const res = await sbRest(this.cfg, `rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
    const text = await res.text();
    if (!res.ok) throw apiError(this.cfg, `대기열 ${name} 실패`, res.status, text, 200);
    return text ? JSON.parse(text) : null;
  }

  async enqueue(pageId: string, channel: string, payload: Record<string, unknown>): Promise<boolean> {
    return (await this.rpc("enqueue_publish_job", {
      p_page_id: pageId,
      p_channel: channel,
      p_payload: payload,
    })) === true;
  }

  async claimNext(): Promise<PublishJob | null> {
    const rows = (await this.rpc("claim_next_publish_job")) as PublishJob[] | null;
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async update(id: number, patch: JobPatch): Promise<void> {
    const res = await sbRest(this.cfg, `${QUEUE_TABLE}?id=eq.${id}`, {
      method: "PATCH",
      headers: { "Prefer": "return=minimal" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) throw apiError(this.cfg, "대기열 갱신 실패", res.status, await res.text(), 200);
  }

  async recoverStale(staleSeconds: number, maxAttempts: number): Promise<number> {
    const rows = (await this.rpc("recover_stale_publish_jobs", {
      stale_after_seconds: staleSeconds,
      max_attempts: maxAttempts,
    })) as Json[] | null;
    return rows?.length ?? 0;
  }

  async tryLock(leaseSeconds: number): Promise<boolean> {
    return (await this.rpc("try_acquire_publish_lock", { lease_seconds: leaseSeconds })) === true;
  }

  async renewLock(leaseSeconds: number): Promise<void> {
    await this.rpc("renew_publish_lock", { lease_seconds: leaseSeconds });
  }

  async releaseLock(): Promise<void> {
    await this.rpc("release_publish_lock");
  }

  async hasReady(): Promise<boolean> {
    const now = encodeURIComponent(new Date().toISOString());
    const res = await sbRest(
      this.cfg,
      `${QUEUE_TABLE}?status=eq.pending&next_attempt_at=lte.${now}&select=id&limit=1`,
    );
    if (!res.ok) return false;
    return ((await res.json()) as Json[]).length > 0;
  }
}

const QUEUE_TABLE = "publish_queue";

/** 워커를 바로 깨운다. 실패해도 1분 크론이 줍는다. */
function wakeWorker(cfg: Config): void {
  if (cfg.storageUrl === "") return;
  const call = fetch(`${cfg.storageUrl}/functions/v1/hada-publish?worker=1`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-admin-key": cfg.adminSecret },
    body: JSON.stringify({ source: "wake" }),
  })
    .then((res) => res.body?.cancel())
    .catch((e) => console.error("워커 깨우기 실패(1분 크론이 대신 줍는다)", message(e)));
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } }).EdgeRuntime;
  runtime?.waitUntil?.(call);
}

/**
 * 한 페이지의 배포 요청을 접수한다. 채널마다 대기열에 한 줄씩 넣는다(이미 대기·처리 중이면 넣지 않는다).
 * 블로그처럼 사람이 올리는 채널의 게시물 기록은 여기서 만든다(금방 끝난다).
 * 테스트 실행(dryRun)은 대기열에 넣지 않고 파일 업로드와 인증만 점검해 돌려준다.
 */
async function intakeRow(
  cfg: Config,
  pageId: string,
  dryRun: boolean,
  only: Channel | null = null,
  useDeployChannels = false,
): Promise<Json> {
  const page = await notion(cfg, `/pages/${pageId}`);
  const props = (page.properties ?? {}) as Json;

  const requested = requestedChannels(props);
  const format = selectName(props["형식"]);
  const kind = mediaKindFor(format);
  // only 는 웹훅 주소의 ?channel= 로 지정한 채널이다. 지정이 있으면 그것만 처리한다.
  // 지정이 없는 배포 버튼은 ⚪ 대기 채널에 '배포 채널'에 고른 채널을 더한다.
  // 큐 모드는 '배포 채널'을 읽지 않는다. 대기로 남은 채널만 줍는 백업 경로라서다.
  const wanted = new Set<Channel>(only !== null ? [only] : requested);
  let recordChannels: string[] = [];
  let doneChannels: string[] = [];
  // 유튜브는 연결 설정이 있고 영상 형식일 때 업로드한다. 아니면 다른 채널처럼 기록만 만든다.
  let youtube = false;
  if (only === null && useDeployChannels) {
    const split = splitYoutube(multiSelectNames(props["배포 채널"]), youtubeReady(cfg), kind);
    youtube = split.youtube;
    const plan = planDeploy(
      split.rest,
      (channel) => selectName(props[RESULT_PROP[channel as Channel]]),
      STATUS_DONE,
    );
    for (const channel of plan.publish) wanted.add(channel as Channel);
    recordChannels = plan.record;
    doneChannels = plan.done;
  }

  // 테스트 실행은 요청 채널이 없어도 두 채널 기준으로 점검한다.
  let channels: Channel[] = CHANNELS.filter((channel) => wanted.has(channel));
  if (channels.length === 0 && dryRun && recordChannels.length === 0 && !youtube) channels = [...CHANNELS];

  if (dryRun) return await dryRunRow(cfg, pageId, props, channels, youtube, recordChannels);

  let records: PostRecord[] = [];
  let recordFailures: string[] = [];
  if (recordChannels.length > 0) {
    ({ records, failures: recordFailures } = await createPostRecords(cfg, pageId, props, recordChannels));
  }
  // 블로그처럼 사람이 올리는 채널이 아직 안 올라갔으면(기록에 게시 링크 없음) 콘텐츠 상태를 '게시대기'로 둔다.
  // 그래야 Aside의 '블로그 대기' 보기(상태=게시대기)에 뜬다. 이 경우 자동 발행이 성공해도 '게시완료'로 넘기지 않는다.
  const manualPending = records.some((record) => MANUAL_PUBLISH_CHANNELS.has(record.channel) && !record.linked);
  if (manualPending) {
    try {
      await updatePage(cfg, pageId, { "상태": { select: { name: CONTENT_STATUS_WAITING } } });
    } catch (e) {
      console.error("게시대기 상태 기록 실패", pageId, message(e));
    }
  }

  // 대기열에 넣을 채널. 유튜브를 먼저 넣는다(업로드만 하면 끝나 금방 끝난다).
  const jobs: string[] = [...(youtube ? [YOUTUBE_CHANNEL] : []), ...channels];
  // 스레드 본글은 이미 올라갔고 하위 항목 답글이 남았으면 스레드 줄을 넣어 답글만 잇게 한다.
  if (
    !jobs.includes("스레드") && doneChannels.includes("스레드") && relationIds(props[SUB_ITEMS_PROP]).length > 0
  ) {
    jobs.push("스레드");
  }

  if (jobs.length === 0) {
    if (recordChannels.length > 0 || doneChannels.length > 0) {
      return { ok: recordFailures.length === 0, pageId, records, recordFailures, alreadyDone: doneChannels };
    }
    // 버튼 설정이 어긋나면 여기로 온다. '배포 채널'이 비었거나, 예전 버튼이 상태를 ⚪ 대기로 바꾸지 않은 경우다.
    console.log("hada-publish 건너뜀", pageId, "요청된 채널 없음");
    const reason = "요청된 채널이 없어 아무것도 하지 않았습니다. " +
      "'배포 채널'에서 올릴 채널을 골랐는지 확인하세요.";
    if (only === null) {
      try {
        await addComment(cfg, pageId, `META 업로드 안내\n\n${reason}`);
      } catch (e) {
        console.error("안내 코멘트 실패", message(e));
      }
    }
    return { ok: true, pageId, skipped: true, reason };
  }

  const store = new RestQueueStore(cfg);
  const enqueued: string[] = [];
  const alreadyQueued: string[] = [];
  const queueFailures: string[] = [];
  for (const channel of jobs) {
    try {
      if (await store.enqueue(pageId, channel, { manualPending })) enqueued.push(channel);
      else alreadyQueued.push(channel);
    } catch (e) {
      queueFailures.push(`${channel} — ${maskSecrets(message(e), secretsOf(cfg))}`);
    }
  }
  console.log("hada-publish 접수", pageId, "넣음", enqueued.join(",") || "-", "이미 대기", alreadyQueued.join(",") || "-");

  if (queueFailures.length > 0) {
    // 대기열 표가 없으면(publish_queue.sql 미실행) 여기서 막힌다. 조용히 끝나지 않게 페이지에 남긴다.
    const detail = `대기열에 넣지 못했습니다. supabase/publish_queue.sql 을 실행했는지 확인하세요.\n${queueFailures.join("\n")}`;
    try {
      await updatePage(cfg, pageId, {
        "마지막 오류": { rich_text: [{ type: "text", text: { content: truncate(detail, 1800) } }] },
      });
      await addComment(cfg, pageId, `META 업로드 실패\n\n${detail}`);
    } catch (e) {
      console.error("접수 실패 기록 실패", message(e));
    }
  }

  return {
    ok: queueFailures.length === 0 && recordFailures.length === 0,
    pageId,
    queued: true,
    enqueued,
    alreadyQueued,
    queueFailures,
    records,
    recordFailures,
    alreadyDone: doneChannels,
  };
}

/** 테스트 실행: 파일 업로드까지만 하고 발행도 상태 변경도 하지 않는다. */
async function dryRunRow(
  cfg: Config,
  pageId: string,
  props: Json,
  channels: Channel[],
  youtube: boolean,
  recordChannels: string[],
): Promise<Json> {
  const format = selectName(props["형식"]);
  const kind = mediaKindFor(format);
  if (channels.length === 0 && !youtube) {
    return { ok: true, dryRun: true, pageId, records: recordChannels, skipped: channels.length === 0 };
  }
  if (kind === null) throw new Error(formatError(format));
  const plan = collectSources(props, kind);
  const caption = buildCaption(richText(contentField(props, "body")), cfg.fixedComment);
  const title = youtubeTitle(richText(contentField(props, "title")), pageTitle(props));
  const thumbnail = thumbnailUrl(props);
  if (caption.trim() === "" && kind === "text") throw new Error(bodyRequiredError(format));

  const uploaded = await uploadPlan(cfg, pageId, plan);
  let threadsAuthNote = "요청 채널에 스레드가 없습니다.";
  if (channels.includes("스레드")) {
    try {
      threadsAuthNote = `정상 (사용자 ID ${(await resolveThreadsAuth(cfg)).userId})`;
    } catch (e) {
      threadsAuthNote = message(e);
    }
  }
  let youtubeNote = "배포 채널에 유튜브가 없거나 업로드 대상이 아닙니다.";
  if (youtube) {
    try {
      await youtubeAccessToken(cfg);
      youtubeNote = "정상";
    } catch (e) {
      youtubeNote = message(e);
    }
  }
  const shorts = isShortsFormat(format);
  return {
    ok: true,
    dryRun: true,
    pageId,
    channels,
    records: recordChannels,
    youtube: youtube
      ? {
        auth: youtubeNote,
        shorts,
        privacy: cfg.youtubePrivacy,
        title,
        description: youtubeDescription(caption, shorts),
        thumbnail: thumbnail === "" ? "없음" : "붙임",
      }
      : youtubeNote,
    format,
    mediaKind: kind,
    media: uploaded,
    caption,
    captionLength: caption.length,
    threadsCaptionLength: threadsLength(caption),
    threadsReplies: relationIds(props[SUB_ITEMS_PROP]).length,
    threadsAuth: threadsAuthNote,
    note: "테스트 실행입니다. 대기열에 넣지 않았고 발행도 페이지 상태 변경도 하지 않았습니다.",
  };
}

function formatError(format: string): string {
  return `'형식' 값을 확인하세요. 지금 값: '${format || "비어 있음"}'. 쓸 수 있는 값: ${FORMAT_NAMES.join(" / ")}`;
}

function bodyRequiredError(format: string): string {
  return `'${format}' 형식은 글이 본체라 '본문'이 필요합니다. '본문'을 채운 뒤 다시 실행하세요.`;
}

async function runQueue(cfg: Config, dryRun: boolean): Promise<Json> {
  const queued = await findQueuedPageIds(cfg);
  if (queued.length === 0) {
    return {
      ok: true,
      queue: true,
      dryRun,
      requested: 0,
      processed: 0,
      results: [],
      message: "요청(⚪ 대기)으로 남아 있는 콘텐츠가 없습니다.",
    };
  }

  // 접수만 하므로 금방 끝난다. 실제 발행은 워커가 한다.
  const results: Json[] = [];
  for (const pageId of queued) {
    try {
      results.push({ pageId, ...(await intakeRow(cfg, pageId, dryRun)) });
    } catch (e) {
      results.push({ pageId, ok: false, error: message(e) });
    }
  }
  return {
    ok: results.every((item) => item.ok !== false),
    queue: true,
    dryRun,
    requested: queued.length,
    processed: results.length,
    results,
  };
}

// ---------- 대기열: 워커 ----------
// 한 실행이 대기열에서 한 줄(한 페이지의 한 채널)만 꺼내 처리한다.
// 메타 컨테이너가 아직 처리 중이면 실패로 치지 않고 container_id 를 남겨 1분 뒤 이어서 확인한다.

// 한 실행에서 컨테이너 처리를 기다리는 시간(실행 시작부터). 넘으면 1분 뒤 다음 실행이 이어서 확인한다.
// 함수 실행 한도(150초) 안에서 발행·노션 기록·답글까지 끝낼 여유를 남긴다.
const JOB_POLL_BUDGET_MS = 90_000;
const JOB_POLL_INTERVAL_MS = 5000;
// 방금 만든 스레드 컨테이너는 잠깐 "없다"고 답할 수 있다. 이보다 오래된 컨테이너가 없다고 하면 만료로 본다.
const THREADS_FRESH_MS = 5 * 60_000;

type ContainerCheck = { status: string; detail: string };

/**
 * 컨테이너가 끝날 때까지 deadline 까지만 기다린다. 끝나면 true, 아직 처리 중이면 false.
 * 처리 실패(ERROR)는 예외, 만료(EXPIRED)는 ContainerExpired 를 던진다.
 */
async function pollContainer(
  check: () => Promise<ContainerCheck>,
  deadline: number,
  label: string,
): Promise<boolean> {
  while (true) {
    const info = await check();
    const step = containerStep(info.status);
    if (step === "ready") return true;
    if (step === "error") throw new Error(`${label} 컨테이너 처리 실패: ${truncate(info.detail, 300)}`);
    if (step === "expired") throw new ContainerExpired(`${label} 컨테이너가 만료되었습니다.`);
    if (Date.now() + JOB_POLL_INTERVAL_MS > deadline) return false;
    await sleep(JOB_POLL_INTERVAL_MS);
  }
}

async function igContainerCheck(cfg: Config, id: string): Promise<ContainerCheck> {
  const info = await igGet(cfg, `${id}?fields=status_code,status`);
  return {
    status: String(info.status_code ?? info.status ?? ""),
    detail: maskSecrets(JSON.stringify(info), secretsOf(cfg)),
  };
}

async function threadsContainerCheck(
  cfg: Config,
  auth: ThreadsAuth,
  id: string,
  createdAt: string,
): Promise<ContainerCheck> {
  try {
    const info = await threadsGet(cfg, auth, `${id}?fields=status,error_message`);
    return {
      status: String(info.status ?? ""),
      detail: maskSecrets(String(info.error_message ?? JSON.stringify(info)), secretsOf(cfg)),
    };
  } catch (e) {
    if (!isThreadsNotFound(e)) throw e;
    const fresh = Date.now() - Date.parse(createdAt) < THREADS_FRESH_MS;
    return { status: fresh ? "IN_PROGRESS" : "EXPIRED", detail: message(e) };
  }
}

type QueuedPublish = { kind: "done"; id: string; link: string } | { kind: "wait"; container: ContainerState };

/**
 * 인스타그램 발행(대기열용). 저장해 둔 컨테이너가 있으면 새로 올리지 않고 그 상태를 이어서 확인한다.
 * 컨테이너가 만료됐으면 한 번 새로 만든다.
 */
async function publishInstagramQueued(
  cfg: Config,
  job: PublishJob,
  hooks: ProcessHooks,
  loadMedia: () => Promise<MediaPlan>,
  loadCover: () => Promise<string>,
  caption: string,
  deadline: number,
): Promise<QueuedPublish> {
  const text = truncate(caption, IG_CAPTION_LIMIT);
  let publishedId = job.published_id ?? "";
  if (publishedId === "") {
    for (let round = 0; round < 2; round++) {
      let state = round === 0 ? resumableContainer(job, Date.now()) : null;
      try {
        if (!state) {
          const media = await loadMedia();
          const createdAt = new Date().toISOString();
          let containerId: string;
          if (media.kind === "video") {
            const container = await igPost(cfg, `${cfg.igUserId}/media`, {
              media_type: "REELS",
              video_url: media.url,
              ...optionalText("caption", text),
              ...optionalText("cover_url", await loadCover()),
              share_to_feed: "true",
            });
            containerId = container.id;
          } else {
            const urls = media.kind === "images" ? media.urls : [];
            if (urls.length === 1) {
              const container = await igPost(cfg, `${cfg.igUserId}/media`, {
                image_url: urls[0],
                ...optionalText("caption", text),
              });
              containerId = container.id;
            } else {
              assertCarouselSize(urls.length, IG_CAROUSEL_MIN, IG_CAROUSEL_MAX, "인스타그램");
              const children: string[] = [];
              for (const url of urls) {
                const child = await igPost(cfg, `${cfg.igUserId}/media`, { image_url: url, is_carousel_item: "true" });
                children.push(child.id);
              }
              const container = await igPost(cfg, `${cfg.igUserId}/media`, {
                media_type: "CAROUSEL",
                children: children.join(","),
                ...optionalText("caption", text),
              });
              containerId = container.id;
            }
          }
          state = { id: String(containerId), children: [], createdAt };
          await hooks.saveContainer(state);
          console.log("인스타 컨테이너 생성", job.page_id, state.id);
        } else {
          console.log("인스타 컨테이너 이어서 확인", job.page_id, state.id);
        }
        const container = state;
        if (!(await pollContainer(() => igContainerCheck(cfg, container.id), deadline, "인스타"))) {
          return { kind: "wait", container };
        }
        const published = await igPost(cfg, `${cfg.igUserId}/media_publish`, { creation_id: container.id });
        publishedId = String(published.id ?? "");
        await hooks.markPublished(publishedId);
        break;
      } catch (e) {
        if (round === 0 && isContainerExpired(e)) {
          console.warn("인스타 컨테이너 만료, 새로 만든다", job.page_id);
          continue;
        }
        throw e;
      }
    }
  }
  const info = await igGet(cfg, `${publishedId}?fields=permalink`);
  return { kind: "done", id: publishedId, link: info.permalink ?? "" };
}

/** 스레드 컨테이너를 만든다. 캐러셀은 자식만 만들고(id 비움) 자식이 끝나면 부모를 만든다. */
async function createThreadsContainers(
  cfg: Config,
  auth: ThreadsAuth,
  media: MediaPlan,
  text: string,
  replyTo = "",
): Promise<ContainerState> {
  const uid = auth.userId;
  const createdAt = new Date().toISOString();
  if (media.kind === "video") {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "VIDEO",
      video_url: media.url,
      ...optionalText("text", text),
      ...optionalText("reply_to_id", replyTo),
    });
    return { id: String(container.id), children: [], createdAt };
  }
  if (media.kind === "images" && media.urls.length === 1) {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "IMAGE",
      image_url: media.urls[0],
      ...optionalText("text", text),
      ...optionalText("reply_to_id", replyTo),
    });
    return { id: String(container.id), children: [], createdAt };
  }
  const items: MediaItem[] = media.kind === "mixed"
    ? media.items
    : media.kind === "images"
    ? media.urls.map((url) => ({ type: "image" as const, url }))
    : [];
  assertCarouselSize(items.length, THREADS_CAROUSEL_MIN, THREADS_CAROUSEL_MAX, "스레드");
  const children: string[] = [];
  for (const item of items) {
    const child = await threadsPost(cfg, auth, `${uid}/threads`, item.type === "video"
      ? { media_type: "VIDEO", video_url: item.url, is_carousel_item: "true" }
      : { media_type: "IMAGE", image_url: item.url, is_carousel_item: "true" });
    children.push(String(child.id));
  }
  return { id: "", children, createdAt };
}

/**
 * 스레드 발행(대기열용). 저장해 둔 컨테이너가 있으면 새로 올리지 않고 이어서 확인한다.
 * 짧은글(글만)은 처리를 기다리지 않으므로 컨테이너를 남기지 않고 바로 발행한다.
 * replyTo 가 있으면 그 글의 답글(하위 항목)이다. 본글은 published_id 로 두 번 올리지 않고,
 * 답글은 올린 직후 컨테이너 칸을 비우고 노션 상태(✅)로 두 번 올리지 않는다.
 */
async function publishThreadsQueued(
  cfg: Config,
  auth: ThreadsAuth,
  job: PublishJob,
  hooks: ProcessHooks,
  loadMedia: () => Promise<MediaPlan>,
  caption: string,
  deadline: number,
  replyTo = "",
): Promise<QueuedPublish> {
  const text = truncate(caption, THREADS_TEXT_LIMIT);
  const done = async (id: string) => {
    if (replyTo === "") await hooks.markPublished(id);
    else await hooks.clearContainer();
  };
  let publishedId = replyTo === "" ? job.published_id ?? "" : "";
  if (publishedId === "") {
    for (let round = 0; round < 2; round++) {
      let state = round === 0 ? resumableContainer(job, Date.now()) : null;
      try {
        if (!state) {
          const media = await loadMedia();
          if (media.kind === "text") {
            const container = await threadsPost(cfg, auth, `${auth.userId}/threads`, {
              media_type: "TEXT",
              ...optionalText("text", text),
              ...optionalText("reply_to_id", replyTo),
            });
            const published = await publishThreadsContainer(cfg, auth, String(container.id));
            publishedId = String(published.id ?? "");
            await done(publishedId);
            break;
          }
          state = await createThreadsContainers(cfg, auth, media, text, replyTo);
          await hooks.saveContainer(state);
          console.log("스레드 컨테이너 생성", job.page_id, state.id || `자식 ${state.children.length}개`);
        } else {
          console.log("스레드 컨테이너 이어서 확인", job.page_id, state.id || `자식 ${state.children.length}개`);
        }

        if (state.id === "") {
          // 부모를 만들기 전에 자식들이 처리를 마쳐야 한다. 건너뛰면 4279004 로 거절당한다.
          const pending = state;
          const ready = await Promise.all(
            pending.children.map((id) =>
              pollContainer(() => threadsContainerCheck(cfg, auth, id, pending.createdAt), deadline, "스레드")
            ),
          );
          if (ready.some((done) => !done)) return { kind: "wait", container: pending };
          const parent = await createThreadsCarousel(cfg, auth, pending.children, text, replyTo);
          state = { ...pending, id: String(parent.id) };
          await hooks.saveContainer(state);
        }

        const container = state;
        const ready = await pollContainer(
          () => threadsContainerCheck(cfg, auth, container.id, container.createdAt),
          deadline,
          "스레드",
        );
        if (!ready) return { kind: "wait", container };
        const published = await publishThreadsContainer(cfg, auth, container.id);
        publishedId = String(published.id ?? "");
        await done(publishedId);
        break;
      } catch (e) {
        if (round === 0 && isContainerExpired(e)) {
          console.warn("스레드 컨테이너 만료, 새로 만든다", job.page_id);
          continue;
        }
        throw e;
      }
    }
  }
  const info = await threadsGet(cfg, auth, `${publishedId}?fields=permalink`);
  return { kind: "done", id: publishedId, link: info.permalink ?? "" };
}

/** 한 채널이라도 올라갔으면 콘텐츠 상태를 '게시완료'로 옮긴다(사람이 올릴 채널이 남았으면 '게시대기' 유지). */
async function markContentPublished(cfg: Config, pageId: string, manualPending: boolean): Promise<void> {
  await updatePage(cfg, pageId, {
    "발행 시각": { date: { start: new Date().toISOString() } },
    ...(manualPending ? {} : { "상태": { select: { name: CONTENT_STATUS_PUBLISHED } } }),
  });
}

/** '마지막 오류'가 이 채널 것이면 비운다. 다른 채널의 오류는 남겨 둔다. */
async function clearOwnError(cfg: Config, pageId: string, props: Json, channel: string): Promise<void> {
  const last = richText(props["마지막 오류"] as Json).trim();
  if (last === "" || !last.startsWith(`${channel} — `)) return;
  await updatePage(cfg, pageId, { "마지막 오류": { rich_text: [] } });
}

async function commentLines(cfg: Config, pageId: string, title: string, lines: string[], note = ""): Promise<void> {
  if (lines.length === 0) return;
  try {
    const body = maskSecrets(lines.join("\n"), secretsOf(cfg));
    await addComment(cfg, pageId, `${title}\n\n${body}${note ? `\n\n${note}` : ""}`);
  } catch (e) {
    console.error(`${title} 코멘트 실패`, message(e));
  }
}

function statusPropOf(channel: string): string {
  return channel === YOUTUBE_CHANNEL ? YOUTUBE_RESULT_PROP : RESULT_PROP[channel as Channel];
}

/** 대기열 한 줄을 처리한다. 다시 시도해도 소용없는 오류는 PermanentError 로 던진다. */
async function processJob(cfg: Config, job: PublishJob, hooks: ProcessHooks): Promise<ProcessResult> {
  const deadline = Date.now() + JOB_POLL_BUDGET_MS;
  if (job.channel !== YOUTUBE_CHANNEL && !(CHANNELS as readonly string[]).includes(job.channel)) {
    throw new PermanentError(`알 수 없는 채널입니다: ${job.channel}`);
  }
  // 채널 잠금(meta_jobs). 예전 방식 실행이 같은 채널을 잡고 있으면 1분 뒤 다시 본다.
  if (!(await claimJob(cfg, job.page_id, job.channel))) {
    return { kind: "wait", container: null, reason: "다른 실행이 같은 채널을 처리 중" };
  }
  try {
    const page = await notion(cfg, `/pages/${job.page_id}`);
    const props = (page.properties ?? {}) as Json;
    const manualPending = job.payload?.manualPending === true;
    if (job.channel === YOUTUBE_CHANNEL) return await processYoutubeJob(cfg, job, hooks, props, manualPending);
    return await processMetaJob(cfg, job, hooks, props, manualPending, deadline);
  } finally {
    await releaseJob(cfg, job.page_id, job.channel);
  }
}

async function processMetaJob(
  cfg: Config,
  job: PublishJob,
  hooks: ProcessHooks,
  props: Json,
  manualPending: boolean,
  deadline: number,
): Promise<ProcessResult> {
  const pageId = job.page_id;
  const channel = job.channel as Channel;
  const status = selectName(props[RESULT_PROP[channel]]);

  // 이미 완료면 다시 올리지 않는다. 스레드는 아직 못 단 하위 항목 답글만 잇는다.
  if (status === STATUS_DONE) {
    if (channel === "스레드") {
      let replies: RepliesResult = { posted: [], failures: [], postFailures: [] };
      try {
        replies = await resumeThreadsReplies(cfg, pageId, props, { job, hooks, deadline });
      } catch (e) {
        replies.failures.push(`스레드 답글 — ${maskSecrets(message(e), secretsOf(cfg))}`);
      }
      await reportReplies(cfg, pageId, replies);
      if (replies.wait) return { kind: "wait", container: replies.wait, reason: "답글 파일을 메타가 처리하는 중" };
      return { kind: "done", detail: `이미 완료, 답글 ${replies.posted.length}개` };
    }
    return { kind: "done", detail: "이미 완료" };
  }

  if (status !== STATUS_WORKING) {
    await updatePage(cfg, pageId, {
      [RESULT_PROP[channel]]: { select: { name: STATUS_WORKING } },
      "처리 시작 시각": { date: { start: new Date().toISOString() } },
    });
  }

  const format = selectName(props["형식"]);
  const kind = mediaKindFor(format);
  if (kind === null) throw new PermanentError(formatError(format));
  let plan: MediaPlan;
  try {
    plan = collectSources(props, kind);
  } catch (e) {
    throw new PermanentError(message(e));
  }
  const captionText = richText(contentField(props, "body"));
  const caption = buildCaption(captionText, cfg.fixedComment);
  if (caption.trim() === "" && kind === "text") throw new PermanentError(bodyRequiredError(format));

  // 한도 초과는 그 채널의 업로드와 발행보다 앞에서 막는다. 어느 값이 길이를 만들었는지 같이 알려준다.
  const limitError = captionLimitError(caption, [channel]);
  if (limitError) {
    const fixedLength = cfg.fixedComment.trim().length;
    throw new PermanentError(
      `${limitError} (본문 ${captionText.trim().length}자 + 고정 멘트 ${fixedLength}자 = 발행 문구 ${caption.length}자)`,
    );
  }
  if (channel === "인스타그램") {
    // 인스타그램은 미디어 없는 발행을 지원하지 않는다.
    if (kind === "text") {
      throw new PermanentError(`'${format}' 형식은 미디어가 없어 인스타그램에 발행할 수 없습니다. '배포 채널'에서 인스타그램을 빼주세요.`);
    }
    if (plan.kind === "mixed") {
      throw new PermanentError("인스타그램은 영상이 섞인 카드뉴스를 아직 올리지 못합니다. '배포 채널'에서 인스타그램을 빼거나 이미지만 넣어주세요.");
    }
  }

  // 파일은 새 컨테이너를 만들 때만 올린다. 처리 대기를 이어서 확인할 때는 올리지 않는다.
  let uploaded: MediaPlan | null = null;
  const loadMedia = async () => (uploaded ??= await uploadPlan(cfg, pageId, plan));
  const thumbnail = thumbnailUrl(props);

  let posted: QueuedPublish;
  let threadsAuth: ThreadsAuth | null = null;
  if (channel === "인스타그램") {
    // 섬네일은 릴스 커버로 쓴다. 공개 주소가 필요해 콘텐츠 파일과 같은 곳에 올린다.
    const loadCover = async () => thumbnail === "" ? "" : await uploadMedia(cfg, pageId, "cover", thumbnail, "image");
    posted = await publishInstagramQueued(cfg, job, hooks, loadMedia, loadCover, caption, deadline);
  } else {
    threadsAuth = await resolveThreadsAuth(cfg);
    posted = await publishThreadsQueued(cfg, threadsAuth, job, hooks, loadMedia, caption, deadline);
  }
  if (posted.kind === "wait") {
    console.log("hada-publish 처리 대기", pageId, channel, posted.container.id || "(자식 대기)");
    return { kind: "wait", container: posted.container, reason: "메타가 파일을 처리하는 중" };
  }

  const link = posted.link;
  await updatePage(cfg, pageId, { [RESULT_PROP[channel]]: { select: { name: STATUS_DONE } } });
  console.log("hada-publish 완료", pageId, channel, link || "(링크 없음)");

  const failures: string[] = [];
  const postFailures: string[] = [];
  // 링크는 게시물 기록에 남긴다. 이미 올라간 글이므로 기록 실패는 발행 실패로 치지 않고 따로 알린다.
  try {
    await recordPublishedPost(cfg, pageId, props, channel, link, channel === "스레드" ? posted.id : "");
  } catch (e) {
    postFailures.push(`${channel} — ${maskSecrets(message(e), secretsOf(cfg))}${link ? ` (링크: ${link})` : ""}`);
  }
  await markContentPublished(cfg, pageId, manualPending);

  // 본글이 올라간 뒤 하위 항목을 답글로 잇는다. 답글 실패는 본글 성공을 되돌리지 않는다.
  // 답글 파일이 아직 처리 중이면 1분 뒤 이 줄이 다시 돌아와(본글은 ✅ 라) 남은 답글만 잇는다.
  let replyWait: ContainerState | undefined;
  if (threadsAuth && posted.id !== "") {
    try {
      const replies = await publishThreadsReplies(cfg, threadsAuth, props, posted.id, { job, hooks, deadline });
      failures.push(...replies.failures);
      postFailures.push(...replies.postFailures);
      replyWait = replies.wait;
    } catch (e) {
      failures.push(`스레드 답글 — ${maskSecrets(message(e), secretsOf(cfg))}. 본글은 올라갔습니다.`);
    }
  }
  if (failures.length === 0) await clearOwnError(cfg, pageId, props, channel);
  await commentLines(
    cfg,
    pageId,
    "META 업로드 실패",
    failures,
    "본글은 올라갔습니다. 원인을 고친 뒤 배포 버튼을 다시 누르면 남은 답글만 이어 답니다.",
  );
  await commentLines(
    cfg,
    pageId,
    "게시물 기록 실패",
    postFailures,
    "발행은 됐습니다. 게시물 DB 에 직접 기록하고 링크를 붙여주세요.",
  );
  if (replyWait) return { kind: "wait", container: replyWait, reason: "답글 파일을 메타가 처리하는 중" };
  return { kind: "done", detail: link || "성공" };
}

/**
 * 유튜브 업로드. 업로드만 하면 끝나고(처리는 유튜브가 나중에 한다) 컨테이너 대기가 없다.
 * '이미 올렸는지'는 게시물 기록의 게시 링크와 이 줄의 published_id 로 본다.
 */
async function processYoutubeJob(
  cfg: Config,
  job: PublishJob,
  hooks: ProcessHooks,
  props: Json,
  manualPending: boolean,
): Promise<ProcessResult> {
  const pageId = job.page_id;
  const format = selectName(props["형식"]);
  const kind = mediaKindFor(format);
  if (kind !== "video") throw new PermanentError(`유튜브는 영상 형식만 올립니다. 지금 '형식': '${format || "비어 있음"}'`);
  let plan: MediaPlan;
  try {
    plan = collectSources(props, kind);
  } catch (e) {
    throw new PermanentError(message(e));
  }
  if (plan.kind !== "video") throw new PermanentError("'콘텐츠'에 영상 파일이 없습니다.");
  const caption = buildCaption(richText(contentField(props, "body")), cfg.fixedComment);
  const title = youtubeTitle(richText(contentField(props, "title")), pageTitle(props));
  const thumbnail = thumbnailUrl(props);
  const shorts = isShortsFormat(format);

  await updatePage(cfg, pageId, {
    [YOUTUBE_RESULT_PROP]: { select: { name: STATUS_WORKING } },
    "처리 시작 시각": { date: { start: new Date().toISOString() } },
  });

  const notices: string[] = [];
  const postFailures: string[] = [];
  const postedLink = job.published_id ? "" : await youtubePostedLink(cfg, pageId);
  if (postedLink !== "") {
    // 다시 배포하면 '섬네일'만 다시 붙인다. 섬네일을 바꾼 뒤 영상은 그대로 두고 섬네일만 갈 때 쓴다.
    const postedId = youtubeVideoIdOf(postedLink);
    if (thumbnail !== "" && postedId !== "") {
      try {
        await setYoutubeThumbnail(cfg, postedId, thumbnail);
        notices.push("유튜브: 이미 올린 영상에 '섬네일'을 다시 붙였습니다.");
      } catch (e) {
        notices.push(`유튜브 섬네일: ${maskSecrets(message(e), secretsOf(cfg))}`);
      }
    }
    await updatePage(cfg, pageId, { [YOUTUBE_RESULT_PROP]: { select: { name: STATUS_DONE } } });
    await clearOwnError(cfg, pageId, props, YOUTUBE_CHANNEL);
    await commentLines(cfg, pageId, "배포 안내", notices);
    return { kind: "done", detail: "이미 올린 기록(게시 링크)이 있어 건너뛰었습니다." };
  }

  let videoId = job.published_id ?? "";
  let privacy = "";
  if (videoId === "") {
    const file = await downloadMedia(plan.url, "video");
    const video = await uploadYoutube(cfg, file, title, youtubeDescription(caption, shorts));
    videoId = video.id;
    privacy = video.privacy;
    await hooks.markPublished(videoId);
  }
  const link = youtubeWatchUrl(videoId, shorts);
  if (thumbnail !== "") {
    try {
      await setYoutubeThumbnail(cfg, videoId, thumbnail);
    } catch (e) {
      notices.push(`유튜브 섬네일: ${maskSecrets(message(e), secretsOf(cfg))} 영상은 올라갔습니다.`);
    }
  }
  await updatePage(cfg, pageId, { [YOUTUBE_RESULT_PROP]: { select: { name: STATUS_DONE } } });
  console.log("hada-publish 완료", pageId, YOUTUBE_CHANNEL, link, privacy);
  if (privacy !== "" && privacy !== cfg.youtubePrivacy) {
    notices.push(
      `유튜브: '${cfg.youtubePrivacy}'로 요청했지만 '${privacy}'로 올라갔습니다. ` +
        "구글 클라우드 프로젝트가 유튜브 API 감사를 받기 전에는 API 로 올린 영상이 비공개로 묶입니다. " +
        "유튜브 스튜디오에서 공개 범위를 바꿔주세요.",
    );
  }
  try {
    await recordPublishedPost(cfg, pageId, props, YOUTUBE_CHANNEL, link);
  } catch (e) {
    postFailures.push(`${YOUTUBE_CHANNEL} — ${maskSecrets(message(e), secretsOf(cfg))} (링크: ${link})`);
  }
  await markContentPublished(cfg, pageId, manualPending);
  await clearOwnError(cfg, pageId, props, YOUTUBE_CHANNEL);
  await commentLines(cfg, pageId, "배포 안내", notices);
  await commentLines(
    cfg,
    pageId,
    "게시물 기록 실패",
    postFailures,
    "발행은 됐습니다. 게시물 DB 에 직접 기록하고 링크를 붙여주세요.",
  );
  return { kind: "done", detail: link };
}

/** 워커가 쓰는 처리기. 오류 문구의 비밀값은 대기열 표에 남기기 전에 가린다. */
function queueHandlers(cfg: Config): JobHandlers {
  return {
    async process(job, hooks) {
      try {
        return await processJob(cfg, job, hooks);
      } catch (e) {
        const masked = maskSecrets(message(e), secretsOf(cfg));
        throw isPermanent(e) ? new PermanentError(masked) : new Error(masked);
      }
    },
    async onRetry(job, error, attempt, maxAttempts) {
      console.warn("hada-publish 재시도 예정", job.page_id, job.channel, `${attempt}/${maxAttempts}`, error);
      await updatePage(cfg, job.page_id, {
        "마지막 오류": {
          rich_text: [{
            type: "text",
            text: { content: truncate(`${job.channel} — 재시도 예정(${attempt}/${maxAttempts}): ${error}`, 1800) },
          }],
        },
      });
    },
    async onFailed(job, error) {
      console.error("hada-publish 실패 확정", job.page_id, job.channel, error);
      await updatePage(cfg, job.page_id, {
        [statusPropOf(job.channel)]: { select: { name: STATUS_ERROR } },
        "마지막 오류": { rich_text: [{ type: "text", text: { content: truncate(`${job.channel} — ${error}`, 1800) } }] },
      });
      await commentLines(
        cfg,
        job.page_id,
        "META 업로드 실패",
        [`${job.channel} — ${error}`],
        "올라간 글은 없습니다. 원인을 고친 뒤 배포 버튼을 다시 누르면 다시 대기열에 넣습니다(완료된 채널은 건너뜁니다).",
      );
    },
  };
}

/** 워커 한 번. 남은 줄이 있으면 다음 실행을 바로 깨운다(한 실행 = 한 채널). */
async function runWorker(cfg: Config): Promise<Json> {
  if (!storageReady(cfg)) throw new Error("대기열 저장소 설정(SB_URL, SB_SERVICE_ROLE_KEY)이 없습니다.");
  const report = await runWorkerOnce(new RestQueueStore(cfg), queueHandlers(cfg));
  if (report.ran && report.hasMore) wakeWorker(cfg);
  return { ok: !(report.ran && report.job !== null && report.outcome === "failed"), worker: true, ...report };
}

// ---------- 예약 발행 ----------
// 대표가 콘텐츠를 '게시대기'로 두고 '예약 시각'(날짜+시간)을 넣으면, pg_cron 이 5분마다 ?due=1 을 불러
// 시각이 된 행을 배포 버튼과 같은 경로(intakeRow → 대기열)로 넣는다(supabase/publish_cron.sql).
// 직접 올리지 않으므로 1분 워커 크론과 겹쳐도 같은 글을 두 번 처리하지 않는다.
// 발행할 채널 상태가 이미 있으면(대기·작업중·완료·오류) 건너뛴다. 실패한 글을 5분마다 다시 올리는 일을 막는다.

const SCHEDULE_PROP = "예약 시각";
const SCHEDULE_NO_TIME_NOTE = "예약 시각에 시간이 없어 예약 발행을 건너뛰었습니다. 날짜와 시간을 함께 넣어 주세요.";

async function findDuePages(cfg: Config, nowIso: string): Promise<Json[]> {
  const filter = {
    and: [
      { property: "상태", select: { equals: CONTENT_STATUS_WAITING } },
      { property: SCHEDULE_PROP, date: { on_or_before: nowIso } },
      {
        or: CHANNELS.map((channel) => ({ property: "배포 채널", multi_select: { contains: channel } })),
      },
    ],
  };
  const res = await notion(cfg, `/data_sources/${cfg.contentDataSourceId}/query`, {
    method: "POST",
    headers: { "Notion-Version": "2025-09-03" },
    body: JSON.stringify({ filter, page_size: 20 }),
  });
  return (res.results ?? []) as Json[];
}

async function runDue(cfg: Config, dryRun: boolean): Promise<Json> {
  const startedAt = Date.now();
  const nowIso = new Date(startedAt).toISOString();
  const pages = await findDuePages(cfg, nowIso);
  const results: Json[] = [];
  const skipped: Json[] = [];
  for (const page of pages) {
    const pageId = page.id as string;
    const props = (page.properties ?? {}) as Json;
    const deploy = multiSelectNames(props["배포 채널"]);
    const statuses = CHANNELS.filter((channel) => deploy.includes(channel))
      .map((channel) => selectName(props[RESULT_PROP[channel]]));
    const start = ((props[SCHEDULE_PROP] as Json)?.date as Json | null)?.start as string | undefined;
    const decision = scheduleDecision(start, startedAt, statuses);
    if (decision !== "publish") {
      skipped.push({ pageId, decision });
      // 시간 없는 예약은 페이지에 한 번만 알린다(같은 문구면 다시 쓰지 않는다).
      if (decision === "no-time" && !dryRun && richText(props["마지막 오류"] as Json) !== SCHEDULE_NO_TIME_NOTE) {
        await updatePage(cfg, pageId, {
          "마지막 오류": { rich_text: [{ type: "text", text: { content: SCHEDULE_NO_TIME_NOTE } }] },
        }).catch((e) => console.error("예약 안내 기록 실패", pageId, message(e)));
      }
      continue;
    }
    try {
      results.push({ pageId, scheduledAt: start, ...(await intakeRow(cfg, pageId, dryRun, null, true)) });
    } catch (e) {
      results.push({ pageId, scheduledAt: start, ok: false, error: message(e) });
    }
  }
  if (!dryRun && results.some((item) => (item.enqueued as string[] | undefined)?.length)) wakeWorker(cfg);
  return {
    ok: results.every((item) => item.ok !== false),
    due: true,
    dryRun,
    now: nowIso,
    found: pages.length,
    processed: results.length,
    results,
    skipped,
  };
}

// ---------- 진입점 ----------

/**
 * 발행할 페이지를 정한다.
 * 본문에 페이지 지정이 있으면 그것을 쓰고, 없으면 본문 어딘가에 실린 노션 주소 중
 * 실제 콘텐츠 페이지('배포 채널' 칸이 있는 페이지)를 골라 쓴다.
 * 아무것도 못 찾으면 빈 문자열을 돌려주고 호출부는 큐 모드로 넘어간다.
 */
// ---------- 성과 수집 ----------
// 게시물 DB 에서 게시 링크가 있는 기록을 모아 채널 API 로 누적 지표를 읽고,
// 성과 로그 DB 에 '지난 기록 이후 늘어난 만큼'을 한 행으로 쌓는다. 게시물의 총 조회수 등은 롤업이 합친다.
//   인스타그램 → 미디어 목록(like_count·comments_count) + 인사이트(views·saved·shares)
//   스레드     → 게시물 인사이트(views·likes·replies·reposts·quotes·shares). threads_manage_insights 권한 필요
//   유튜브     → YouTube Data API videos.statistics (YOUTUBE_API_KEY, 공개 통계라 OAuth 불필요)
// 계정에는 있는데 게시물 DB 에 없는 게시물(직접 올린 것 등)은 게시물 기록을 새로 만든 뒤 함께 수집한다.
// 호출: POST /functions/v1/hada-publish?metrics=1   (헤더 x-admin-key)
//   GitHub Actions 는 매일 새벽 ?wait=1 로 결과를 기다리고, 노션 버튼은 접수(202)만 받는다.

const METRICS_TIME_BUDGET_MS = 110000;
const MEDIA_LIST_PAGES = 5;

// threadsId: 발행할 때 게시물 메모에 남긴 스레드 글 ID. 계정 글 목록에 없는 답글의 성과를 읽을 때 쓴다.
type PostTarget = {
  id: string;
  title: string;
  link: string;
  channel: MetricChannel;
  code: string;
  publishedAt: string;
  threadsId: string;
};
type CollectResult = { post: string; channel: MetricChannel; status: string; delta?: Metrics; error?: string };

async function queryAll(cfg: Config, dataSourceId: string, filter?: Json): Promise<Json[]> {
  const rows: Json[] = [];
  let cursor: string | undefined;
  do {
    const res = await notion(cfg, `/data_sources/${dataSourceId}/query`, {
      method: "POST",
      headers: { "Notion-Version": POST_API_VERSION },
      body: JSON.stringify({ ...(filter ? { filter } : {}), page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    });
    rows.push(...((res.results ?? []) as Json[]));
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return rows;
}

/** 성과 로그에 이미 쌓인 값을 게시물별로 합친다. 직접 입력한 행도 합계에 들어간다. */
async function loggedTotals(cfg: Config): Promise<Map<string, Metrics>> {
  const totals = new Map<string, Metrics>();
  for (const row of await queryAll(cfg, cfg.metricLogDataSourceId)) {
    const props = (row.properties ?? {}) as Json;
    for (const postId of relationIds(props["게시물"])) {
      const sum = totals.get(postId) ?? {};
      for (const field of METRIC_FIELDS) {
        const value = props[field]?.number;
        if (typeof value === "number") sum[field] = (sum[field] ?? 0) + value;
      }
      totals.set(postId, sum);
    }
  }
  return totals;
}

/** 계정의 미디어 목록을 shortcode → 항목으로 모은다. 최근 것부터 MEDIA_LIST_PAGES 쪽까지만 본다. */
async function listByShortcode(fetchPage: (after: string) => Promise<Json>): Promise<Map<string, Json>> {
  const map = new Map<string, Json>();
  let after = "";
  for (let page = 0; page < MEDIA_LIST_PAGES; page++) {
    const res = await fetchPage(after);
    for (const item of (res.data ?? []) as Json[]) {
      const code = item.shortcode || postCodeOf(String(item.permalink ?? ""));
      if (code) map.set(code, item);
    }
    after = res.paging?.next ? String(res.paging?.cursors?.after ?? "") : "";
    if (after === "") break;
  }
  return map;
}

async function instagramMetrics(cfg: Config, media: Json): Promise<Metrics> {
  const metrics: Metrics = {};
  if (typeof media.like_count === "number") metrics["좋아요"] = media.like_count;
  if (typeof media.comments_count === "number") metrics["댓글"] = media.comments_count;
  try {
    const insights = readInsights(await igGet(cfg, `${media.id}/insights?metric=views,likes,comments,saved,shares`));
    if (insights.views !== undefined) metrics["조회수"] = insights.views;
    if (insights.likes !== undefined) metrics["좋아요"] = insights.likes;
    if (insights.comments !== undefined) metrics["댓글"] = insights.comments;
    if (insights.saved !== undefined) metrics["저장"] = insights.saved;
    if (insights.shares !== undefined) metrics["공유"] = insights.shares;
  } catch (e) {
    // 인사이트 권한이 없으면 좋아요·댓글만 남긴다.
    console.warn("인스타 인사이트 실패", media.id, message(e));
  }
  return metrics;
}

async function threadsMetrics(cfg: Config, auth: ThreadsAuth, mediaId: string): Promise<Metrics> {
  const insights = readInsights(
    await threadsGet(cfg, auth, `${mediaId}/insights?metric=views,likes,replies,reposts,quotes,shares`),
  );
  const metrics: Metrics = {};
  if (insights.views !== undefined) metrics["조회수"] = insights.views;
  if (insights.likes !== undefined) metrics["좋아요"] = insights.likes;
  if (insights.replies !== undefined) metrics["댓글"] = insights.replies;
  const shared = ["reposts", "quotes", "shares"].filter((name) => insights[name] !== undefined);
  if (shared.length > 0) metrics["공유"] = shared.reduce((sum, name) => sum + insights[name], 0);
  return metrics;
}

/** 유튜브 공개 통계. 50개씩 묶어 한 번에 묻는다. */
async function youtubeStats(cfg: Config, ids: string[]): Promise<Map<string, Metrics>> {
  const out = new Map<string, Metrics>();
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({ part: "statistics", id: ids.slice(i, i + 50).join(","), key: cfg.youtubeApiKey });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/videos?${params}`);
    const text = await res.text();
    if (!res.ok) throw apiError(cfg, "유튜브 API", res.status, text);
    for (const item of (JSON.parse(text).items ?? []) as Json[]) {
      const stats = (item.statistics ?? {}) as Json;
      const metrics: Metrics = {};
      if (stats.viewCount !== undefined) metrics["조회수"] = Number(stats.viewCount);
      if (stats.likeCount !== undefined) metrics["좋아요"] = Number(stats.likeCount);
      if (stats.commentCount !== undefined) metrics["댓글"] = Number(stats.commentCount);
      out.set(item.id, metrics);
    }
  }
  return out;
}

async function createMetricLog(cfg: Config, target: PostTarget, delta: Metrics, date: string): Promise<void> {
  const numbers: Json = {};
  for (const [field, value] of Object.entries(delta)) numbers[field] = { number: value };
  await notion(cfg, "/pages", {
    method: "POST",
    headers: { "Notion-Version": POST_API_VERSION },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: cfg.metricLogDataSourceId },
      properties: {
        "이름": { title: [{ type: "text", text: { content: truncate(`${target.title} · ${date}`, 1900) } }] },
        "게시물": { relation: [{ id: target.id }] },
        "기록일": { date: { start: date } },
        "수집 방식": { select: { name: "자동 수집" } },
        ...numbers,
      },
    }),
  });
}

/** 게시물 DB 에서 게시 링크가 있는 기록을 읽는다. 내린 기록은 수집하지 않지만, 다시 만들지 않도록 알고는 있는다. */
type MetricTargets = {
  targets: PostTarget[];
  known: Set<string>;
  // 콘텐츠가 연결된 게시물: 채널:코드 → 콘텐츠 id. 같은 게시물의 다른 기록을 이 콘텐츠에 붙인다.
  contentByKey: Map<string, string>;
  // 콘텐츠가 비어 있는 게시물 기록(내림 제외). 같은 게시물 기록이 둘 이상일 수 있다.
  unlinked: Map<string, { id: string; title: string }[]>;
};

async function findMetricTargets(cfg: Config): Promise<MetricTargets> {
  const rows = await queryAll(cfg, cfg.postDataSourceId, {
    property: "게시 링크",
    url: { is_not_empty: true },
  });
  const targets: PostTarget[] = [];
  const known = new Set<string>();
  const contentByKey = new Map<string, string>();
  const unlinked = new Map<string, { id: string; title: string }[]>();
  const contentProp = await postContentProp(cfg);
  for (const row of rows) {
    const props = (row.properties ?? {}) as Json;
    const link = String(props["게시 링크"]?.url ?? "").trim();
    const channel = metricChannelOf(link);
    const code = postCodeOf(link);
    if (channel === null || code === "") continue;
    const key = `${channel}:${code}`;
    known.add(key);
    const contentId = relationIds(props[contentProp])[0];
    if (contentId) contentByKey.set(key, contentId);
    if (selectName(props["게시 상태"]) === "내림") continue;
    if (!contentId) unlinked.set(key, [...(unlinked.get(key) ?? []), { id: row.id, title: pageTitle(props) }]);
    const publishedAt = String(props["게시일"]?.date?.start ?? "");
    const threadsId = threadsIdFromMemo(richText(props["메모"]));
    targets.push({ id: row.id, title: pageTitle(props), link, channel, code, publishedAt, threadsId });
  }
  return { targets, known, contentByKey, unlinked };
}

let contentTypeOptionName = "";
let contentBodyPropName = "";

/** 콘텐츠 DB 의 칸 구성을 한 번 읽어 둔다. 칸·선택지 이름을 바꾸는 동안 예전 이름도 받는다. */
async function loadContentSchema(cfg: Config): Promise<void> {
  if (contentTypeOptionName !== "") return;
  const source = await notion(cfg, `/data_sources/${cfg.contentDataSourceId}`, {
    headers: { "Notion-Version": POST_API_VERSION },
  });
  const properties = (source.properties ?? {}) as Json;
  const options = ((properties["유형"]?.select?.options ?? []) as Json[]).map((option) => String(option.name));
  contentTypeOptionName = pickContentTypeOption(options);
  contentBodyPropName = contentFieldName(Object.keys(properties), "body");
}

/** 콘텐츠 DB `유형`에서 올리는 콘텐츠를 뜻하는 선택지('콘텐츠', 예전 철자 '컨텐츠'). */
async function contentTypeOption(cfg: Config): Promise<string> {
  await loadContentSchema(cfg);
  return contentTypeOptionName;
}

/** 콘텐츠 DB 의 본문 칸 이름('본문', 예전 이름 '캡션'). */
async function contentBodyProp(cfg: Config): Promise<string> {
  await loadContentSchema(cfg);
  return contentBodyPropName;
}

/**
 * 콘텐츠가 없는 게시물로 콘텐츠를 만든다. 이미 올라간 글이므로 상태는 게시, 그 채널 상태는 ✅ 완료로 둬서
 * 누가 배포 버튼을 눌러도 다시 올리지 않게 한다. 링크는 게시물 기록에만 둔다. 캡션에는 게시물 글을 그대로 담는다.
 */
async function createContentForPost(cfg: Config, post: AccountPost): Promise<string> {
  const label = METRIC_CHANNEL_LABELS[post.channel];
  const format = contentFormatFor(post.channel, post.mediaType, post.link);
  const statusProp = post.channel === "instagram"
    ? RESULT_PROP["인스타그램"]
    : post.channel === "threads"
    ? RESULT_PROP["스레드"]
    : post.channel === "youtube"
    ? YOUTUBE_RESULT_PROP
    : "";
  const channelStatus: Json = statusProp ? { [statusProp]: { select: { name: STATUS_DONE } } } : {};
  const page = await notion(cfg, "/pages", {
    method: "POST",
    headers: { "Notion-Version": POST_API_VERSION },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: cfg.contentDataSourceId },
      properties: {
        "이름": { title: [{ type: "text", text: { content: postHeadline(post.text) || `${label} 게시물` } }] },
        "유형": { select: { name: await contentTypeOption(cfg) } },
        "상태": { select: { name: CONTENT_STATUS_PUBLISHED } },
        ...(format ? { "형식": { select: { name: format } } } : {}),
        "배포 채널": { multi_select: [{ name: label }] },
        ...(post.text.trim()
          ? { [await contentBodyProp(cfg)]: { rich_text: [{ type: "text", text: { content: truncate(post.text, 2000) } }] } }
          : {}),
        ...(post.publishedAt ? { "발행 시각": { date: { start: post.publishedAt } } } : {}),
        ...channelStatus,
      },
    }),
  });
  return page.id;
}

const MEMO_CONTENT_LINKED = "성과 수집이 같은 링크의 콘텐츠를 찾아 자동으로 연결함.";
const MEMO_CONTENT_CREATED = "성과 수집이 콘텐츠가 없어 게시물 글로 콘텐츠를 자동으로 만들어 연결함.";

async function linkPostToContent(cfg: Config, postId: string, contentId: string, created: boolean): Promise<void> {
  await notion(cfg, `/pages/${postId}`, {
    method: "PATCH",
    body: JSON.stringify({
      properties: {
        [await postContentProp(cfg)]: { relation: [{ id: contentId }] },
        "메모": { rich_text: [{ type: "text", text: { content: created ? MEMO_CONTENT_CREATED : MEMO_CONTENT_LINKED } }] },
      },
    }),
  });
}

/** 계정에서 찾은 게시물 하나. 게시물 DB 에 없으면 이걸로 새 기록을 만든다. */
type AccountPost = {
  channel: MetricChannel;
  code: string;
  link: string;
  text: string;
  publishedAt: string;
  // API 의 미디어 종류(REELS·CAROUSEL_ALBUM·TEXT_POST 등). 콘텐츠 형식을 고를 때 쓴다.
  mediaType: string;
};

/**
 * 계정에는 있는데 게시물 DB 에 없는 게시물(직접 올린 것 등)의 게시물 기록을 만든다.
 * content 가 있으면 그 콘텐츠를 연결한다. 메모로 자동 생성임을 남긴다.
 */
async function importPost(
  cfg: Config,
  post: AccountPost,
  channelIds: Map<MetricChannel, string>,
  content?: { id: string; created: boolean },
): Promise<PostTarget> {
  const label = METRIC_CHANNEL_LABELS[post.channel];
  let channelId = channelIds.get(post.channel);
  if (channelId === undefined) {
    channelId = await findChannelPageId(cfg, label);
    channelIds.set(post.channel, channelId);
  }
  const title = importedPostTitle(post.text, label);
  const page = await notion(cfg, "/pages", {
    method: "POST",
    headers: { "Notion-Version": POST_API_VERSION },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: cfg.postDataSourceId },
      properties: {
        "이름": { title: [{ type: "text", text: { content: title } }] },
        "채널": { relation: [{ id: channelId }] },
        "게시 링크": { url: post.link },
        "게시 상태": { select: { name: "게시" } },
        ...(post.publishedAt ? { "게시일": { date: { start: post.publishedAt } } } : {}),
        ...(content ? { [await postContentProp(cfg)]: { relation: [{ id: content.id }] } } : {}),
        "메모": {
          rich_text: [{
            type: "text",
            text: {
              content: content
                ? `성과 수집이 계정에서 찾아 자동으로 만든 기록. ${content.created ? MEMO_CONTENT_CREATED : MEMO_CONTENT_LINKED}`
                : "성과 수집이 계정에서 찾아 자동으로 만든 기록. 콘텐츠는 직접 연결하세요.",
            },
          }],
        },
      },
    }),
  });
  return {
    id: page.id,
    title,
    link: post.link,
    channel: post.channel,
    code: post.code,
    publishedAt: post.publishedAt,
    threadsId: "",
  };
}

/** 유튜브 채널 업로드 목록. 채널은 게시물 DB 에 이미 있는 영상에서 알아낸다(YOUTUBE_CHANNEL_ID 가 있으면 그것도). */
async function youtubeUploads(cfg: Config, knownIds: string[]): Promise<AccountPost[]> {
  const yt = async (path: string, params: Record<string, string>) => {
    const query = new URLSearchParams({ ...params, key: cfg.youtubeApiKey });
    const res = await fetch(`https://www.googleapis.com/youtube/v3/${path}?${query}`);
    const text = await res.text();
    if (!res.ok) throw apiError(cfg, "유튜브 API", res.status, text);
    return JSON.parse(text) as Json;
  };
  const channels = new Set<string>(cfg.youtubeChannelId ? [cfg.youtubeChannelId] : []);
  if (knownIds.length > 0) {
    const res = await yt("videos", { part: "snippet", id: knownIds.slice(0, 50).join(",") });
    for (const item of (res.items ?? []) as Json[]) if (item.snippet?.channelId) channels.add(item.snippet.channelId);
  }
  if (channels.size === 0) return [];
  const posts: AccountPost[] = [];
  const res = await yt("channels", { part: "contentDetails", id: [...channels].join(",") });
  for (const channel of (res.items ?? []) as Json[]) {
    const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!playlistId) continue;
    let pageToken = "";
    for (let page = 0; page < MEDIA_LIST_PAGES; page++) {
      const list = await yt("playlistItems", {
        part: "snippet",
        playlistId,
        maxResults: "50",
        ...(pageToken ? { pageToken } : {}),
      });
      for (const item of (list.items ?? []) as Json[]) {
        const videoId = item.snippet?.resourceId?.videoId;
        if (!videoId) continue;
        posts.push({
          channel: "youtube",
          code: videoId,
          link: `https://www.youtube.com/watch?v=${videoId}`,
          text: String(item.snippet?.title ?? ""),
          publishedAt: String(item.snippet?.publishedAt ?? ""),
          mediaType: "",
        });
      }
      pageToken = String(list.nextPageToken ?? "");
      if (pageToken === "") break;
    }
  }
  return posts;
}

/** 네이버 블로그 아이디. 채널 DB '블로그' 행의 URL 과 게시물 DB 에 이미 있는 블로그 글 주소에서 찾는다. */
async function naverBlogIds(cfg: Config, knownCodes: string[]): Promise<string[]> {
  const ids = new Set(knownCodes.map((code) => code.split("/")[0]).filter((id) => id !== ""));
  const rows = await queryDataSource(cfg, cfg.channelDataSourceId, {
    property: "이름",
    title: { equals: METRIC_CHANNEL_LABELS.naver_blog },
  });
  for (const row of rows) {
    const id = naverBlogIdOf(String(((row.properties ?? {}) as Json)["URL"]?.url ?? ""));
    if (id) ids.add(id);
  }
  return [...ids];
}

/**
 * 블로그 글 목록(최근 것부터 MEDIA_LIST_PAGES 쪽). 공개 모바일 API 라 인증이 필요 없다.
 * 코드("아이디/글번호") → { 계정 게시물, 누적 지표 }.
 */
async function naverBlogPosts(blogId: string): Promise<Map<string, { post: AccountPost; metrics: Metrics }>> {
  const out = new Map<string, { post: AccountPost; metrics: Metrics }>();
  for (let page = 1; page <= MEDIA_LIST_PAGES; page++) {
    const params = new URLSearchParams({ categoryNo: "0", itemCount: "30", page: String(page) });
    const res = await fetch(`https://m.blog.naver.com/api/blogs/${encodeURIComponent(blogId)}/post-list?${params}`, {
      headers: { Referer: `https://m.blog.naver.com/${blogId}`, "User-Agent": "Mozilla/5.0" },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`네이버 블로그 목록 HTTP ${res.status}: ${truncate(text, 300)}`);
    const body = JSON.parse(text) as Json;
    if (body.isSuccess === false) throw new Error(`네이버 블로그 목록 실패: ${truncate(text, 300)}`);
    const items = (body.result?.items ?? []) as Json[];
    for (const item of items) {
      if (item.logNo === undefined || item.logNo === null) continue;
      const code = `${blogId}/${item.logNo}`;
      const added = Number(item.addDate);
      out.set(code, {
        post: {
          channel: "naver_blog",
          code,
          link: naverBlogPostUrl(blogId, item.logNo),
          text: String(item.titleWithInspectMessage ?? ""),
          publishedAt: Number.isFinite(added) && added > 0 ? new Date(added).toISOString() : "",
          mediaType: "",
        },
        metrics: naverBlogMetrics(item),
      });
    }
    if (items.length < 30) break;
  }
  return out;
}

/** only 가 있으면 그 채널만 수집한다(채널 DB 의 버튼). 없으면 전체. */
async function runMetrics(
  cfg: Config,
  dryRun: boolean,
  channels: MetricChannel[] | null = null,
  scopes: Map<MetricChannel, MetricScope> = new Map(),
): Promise<Json> {
  const started = Date.now();
  const date = kstDate(started);
  const wants = (channel: MetricChannel) => channels === null || channels.includes(channel);
  const found = await findMetricTargets(cfg);
  // 채널 DB 의 '갱신 기간(일)'·'갱신 개수'로 채널마다 갱신할 게시물을 줄인다.
  const targets = (Object.keys(METRIC_CHANNEL_LABELS) as MetricChannel[])
    .filter(wants)
    .flatMap((channel) => {
      const mine = found.targets.filter((t) => t.channel === channel);
      const scope = scopes.get(channel);
      return scope ? applyMetricScope(mine, scope, started) : mine;
    });
  const known = found.known;
  const logged = await loggedTotals(cfg);
  const results: CollectResult[] = [];
  const channelIds = new Map<MetricChannel, string>();
  const imported: string[] = [];
  const contents = { linked: [] as MetricChannel[], created: [] as MetricChannel[], errors: [] as string[] };

  // 게시물에 붙일 콘텐츠: 같은 게시물이 연결된 콘텐츠가 있으면 그것, 없으면 새로 만든다(dryRun 이면 만들지 않는다).
  const resolveContent = async (post: AccountPost): Promise<{ id: string; created: boolean }> => {
    const key = `${post.channel}:${post.code}`;
    const existing = found.contentByKey.get(key);
    if (existing) return { id: existing, created: false };
    const id = dryRun ? "" : await createContentForPost(cfg, post);
    if (id) found.contentByKey.set(key, id);
    return { id, created: true };
  };

  // 계정에서 찾은 게시물 중 게시물 DB 에 없는 것은 기록을 새로 만들어 대상에 더한다.
  // dryRun 이면 만들지 않고 만들 목록만 돌려준다.
  const addMissing = async (posts: AccountPost[]) => {
    for (const post of posts) {
      const key = `${post.channel}:${post.code}`;
      // 한 번에 많이 만들면 함수 시간 한도에 걸린다. 남은 것은 다음 실행이 이어서 만든다.
      if (!dryRun && Date.now() - started > METRICS_TIME_BUDGET_MS / 2) break;
      if (known.has(key)) {
        // 이미 있는 게시물 기록 중 콘텐츠가 빈 것은 콘텐츠를 찾아 붙이거나 새로 만든다.
        const rows = found.unlinked.get(key);
        if (!rows) continue;
        found.unlinked.delete(key);
        try {
          const content = await resolveContent(post);
          if (!dryRun) for (const row of rows) await linkPostToContent(cfg, row.id, content.id, content.created);
          (content.created ? contents.created : contents.linked).push(post.channel);
        } catch (e) {
          console.warn("콘텐츠 연결 실패", rows[0].title, message(e));
          contents.errors.push(`${rows[0].title}: ${message(e)}`);
        }
        continue;
      }
      if (!publishedOnOrAfter(post.publishedAt, cfg.metricsImportSince)) continue;
      known.add(key);
      const title = importedPostTitle(post.text, METRIC_CHANNEL_LABELS[post.channel]);
      if (dryRun) {
        imported.push(title);
        try {
          const content = await resolveContent(post);
          (content.created ? contents.created : contents.linked).push(post.channel);
        } catch (e) {
          contents.errors.push(`${title}: ${message(e)}`);
        }
        continue;
      }
      let content: { id: string; created: boolean } | undefined;
      try {
        content = await resolveContent(post);
        (content.created ? contents.created : contents.linked).push(post.channel);
      } catch (e) {
        console.warn("콘텐츠 연결 실패", title, message(e));
        contents.errors.push(`${title}: ${message(e)}`);
      }
      try {
        targets.push(await importPost(cfg, post, channelIds, content));
        imported.push(title);
      } catch (e) {
        results.push({ post: title, channel: post.channel, status: "실패", error: `게시물 기록 생성 실패: ${message(e)}` });
      }
    }
  };

  // 채널별로 현재 누적값을 먼저 모은다. 한 채널이 실패해도 나머지 채널은 그대로 기록한다.
  const current = new Map<string, Metrics>();
  const channelError = new Map<MetricChannel, string>();

  if (wants("instagram") && cfg.igUserId && cfg.igToken) {
    try {
      const media = await listByShortcode((after) =>
        igGet(
          cfg,
          `${cfg.igUserId}/media?fields=id,shortcode,permalink,caption,timestamp,media_type,media_product_type,like_count,comments_count&limit=100${
            after ? `&after=${after}` : ""
          }`,
        )
      );
      await addMissing([...media.entries()].map(([code, item]) => ({
        channel: "instagram" as const,
        code,
        link: String(item.permalink ?? `https://www.instagram.com/p/${code}/`),
        text: String(item.caption ?? ""),
        publishedAt: String(item.timestamp ?? ""),
        mediaType: String(item.media_product_type === "REELS" ? "REELS" : item.media_type ?? ""),
      })));
      for (const target of targets.filter((t) => t.channel === "instagram")) {
        const item = media.get(target.code);
        if (item) current.set(target.id, await instagramMetrics(cfg, item));
      }
    } catch (e) {
      channelError.set("instagram", message(e));
    }
  }

  if (wants("threads")) try {
    const auth = await resolveThreadsAuth(cfg);
    const media = await listByShortcode((after) =>
      threadsGet(
        cfg,
        auth,
        `${auth.userId || "me"}/threads?fields=id,shortcode,permalink,text,timestamp,media_type&limit=100${
          after ? `&after=${after}` : ""
        }`,
      )
    );
    // 다른 사람 글을 리포스트한 항목은 내 게시물이 아니다.
    for (const [code, item] of media) if (item.media_type === "REPOST_FACADE") media.delete(code);
    await addMissing([...media.entries()].map(([code, item]) => ({
      channel: "threads" as const,
      code,
      link: String(item.permalink ?? ""),
      text: String(item.text ?? ""),
      publishedAt: String(item.timestamp ?? ""),
      mediaType: String(item.media_type ?? ""),
    })));
    for (const target of targets.filter((t) => t.channel === "threads")) {
      // 답글은 계정 글 목록에 없다. 발행 때 남긴 글 ID가 있으면 그것으로 읽는다.
      const mediaId = String(media.get(target.code)?.id ?? "") || target.threadsId;
      if (mediaId === "") continue;
      try {
        current.set(target.id, await threadsMetrics(cfg, auth, mediaId));
      } catch (e) {
        results.push({ post: target.title, channel: "threads", status: "실패", error: message(e) });
      }
    }
  } catch (e) {
    channelError.set("threads", message(e));
  }

  if (!wants("youtube")) {
    // 이번 실행은 다른 채널만 수집한다.
  } else if (cfg.youtubeApiKey === "") {
    if (targets.some((t) => t.channel === "youtube")) {
      channelError.set("youtube", "환경값 YOUTUBE_API_KEY 가 없어 유튜브는 건너뜁니다.");
    }
  } else {
    try {
      const knownIds = [...known].filter((key) => key.startsWith("youtube:")).map((key) => key.slice(8));
      await addMissing(await youtubeUploads(cfg, knownIds));
      const yt = targets.filter((t) => t.channel === "youtube");
      const stats = await youtubeStats(cfg, [...new Set(yt.map((t) => t.code))]);
      for (const target of yt) {
        const metrics = stats.get(target.code);
        if (metrics) current.set(target.id, metrics);
      }
    } catch (e) {
      channelError.set("youtube", message(e));
    }
  }

  if (wants("naver_blog")) try {
    const knownCodes = [...known].filter((key) => key.startsWith("naver_blog:")).map((key) => key.slice(11));
    const blogIds = await naverBlogIds(cfg, knownCodes);
    if (blogIds.length === 0 && targets.some((t) => t.channel === "naver_blog")) {
      channelError.set("naver_blog", "채널 DB '블로그' 행의 URL(https://blog.naver.com/아이디)이 비어 있습니다.");
    }
    const all = new Map<string, { post: AccountPost; metrics: Metrics }>();
    for (const blogId of blogIds) for (const [code, entry] of await naverBlogPosts(blogId)) all.set(code, entry);
    await addMissing([...all.values()].map((entry) => entry.post));
    for (const target of targets.filter((t) => t.channel === "naver_blog")) {
      const entry = all.get(target.code);
      if (entry) current.set(target.id, entry.metrics);
    }
  } catch (e) {
    channelError.set("naver_blog", message(e));
  }

  let created = 0;
  for (const target of targets) {
    if (results.some((r) => r.post === target.title && r.channel === target.channel)) continue;
    const failed = channelError.get(target.channel);
    if (failed) {
      results.push({ post: target.title, channel: target.channel, status: "실패", error: failed });
      continue;
    }
    const metrics = current.get(target.id);
    if (!metrics) {
      results.push({ post: target.title, channel: target.channel, status: "못 찾음", error: `계정에서 ${target.code} 게시물을 찾지 못했습니다.` });
      continue;
    }
    const delta = metricDelta(metrics, logged.get(target.id) ?? {});
    if (delta === null) {
      results.push({ post: target.title, channel: target.channel, status: "변화 없음" });
      continue;
    }
    if (Date.now() - started > METRICS_TIME_BUDGET_MS) {
      results.push({ post: target.title, channel: target.channel, status: "시간 초과로 다음에", delta });
      continue;
    }
    if (!dryRun) {
      try {
        await createMetricLog(cfg, target, delta, date);
      } catch (e) {
        results.push({ post: target.title, channel: target.channel, status: "실패", delta, error: message(e) });
        continue;
      }
    }
    created++;
    results.push({ post: target.title, channel: target.channel, status: dryRun ? "기록 예정" : "기록", delta });
  }

  const failures = results.filter((r) => r.status === "실패").length;
  return {
    ok: failures === 0,
    dryRun,
    date,
    targets: targets.length,
    created,
    imported: { count: imported.length, titles: imported },
    contents: {
      linked: contents.linked.length,
      created: contents.created.length,
      linkedChannels: contents.linked,
      createdChannels: contents.created,
      errors: contents.errors,
    },
    failures,
    channelErrors: Object.fromEntries(channelError),
    results,
  };
}

/** 채널 DB 한 행의 수집 설정. */
type ChannelSetting = { pageId: string; hour: number | null; scope: MetricScope; lastCollected: string };

function numberProp(props: Json, name: string): number | null {
  const value = props[name]?.number;
  return typeof value === "number" ? value : null;
}

/** 채널 DB 에서 인스타그램·스레드·유튜브 행의 수집 설정을 읽는다. */
async function loadChannelSettings(cfg: Config): Promise<Map<MetricChannel, ChannelSetting>> {
  const settings = new Map<MetricChannel, ChannelSetting>();
  for (const row of await queryAll(cfg, cfg.channelDataSourceId)) {
    const props = (row.properties ?? {}) as Json;
    const channel = metricChannelByLabel(pageTitle(props));
    if (channel === null || settings.has(channel)) continue;
    settings.set(channel, {
      pageId: row.id as string,
      hour: numberProp(props, "자동 수집 시각"),
      scope: { days: numberProp(props, "갱신 기간(일)"), latest: numberProp(props, "갱신 개수") },
      lastCollected: String(props["마지막 수집"]?.date?.start ?? ""),
    });
  }
  return settings;
}

/** 전체 수집 결과에서 한 채널 몫만 떼어 낸다. 채널 페이지마다 자기 결과를 남기기 위해서다. */
function bodyForChannel(body: Json, channel: MetricChannel | null): Json {
  if (channel === null) return body;
  const results = ((body.results ?? []) as Json[]).filter((r) => r.channel === channel);
  const errors = Object.entries((body.channelErrors ?? {}) as Json).filter(([c]) => c === channel);
  const label = METRIC_CHANNEL_LABELS[channel];
  const titles = (((body.imported ?? {}) as Json).titles ?? []) as string[];
  const contentsOf = (body.contents ?? {}) as Json;
  return {
    targets: results.filter((r) => r.status !== "실패" || !String(r.error ?? "").startsWith("게시물 기록 생성 실패")).length,
    created: results.filter((r) => r.status === "기록").length,
    imported: { count: titles.filter((t) => t.endsWith(` · ${label}`)).length },
    contents: {
      linked: ((contentsOf.linkedChannels ?? []) as string[]).filter((c) => c === channel).length,
      created: ((contentsOf.createdChannels ?? []) as string[]).filter((c) => c === channel).length,
    },
    results,
    channelErrors: Object.fromEntries(errors),
    failures: results.filter((r) => r.status === "실패").length,
  };
}

// 채널 DB 버튼이나 예약 실행으로 부른 수집은 그 채널 페이지에 진행 상태를 남긴다.
// 버튼이 '수집 상태'를 ⚪ 대기로 바꾸고 웹훅을 보내면, 여기서 🔄 작업중 → ✅ 완료 / ⚠️ 오류로 바꾸고
// '처리 결과'에 시각·건수·오류를 남긴다. 여러 채널을 한 번에 돌리면 페이지마다 자기 채널 몫을 적는다.
// 상태 칸이 없는 페이지여도 수집은 그대로 한다(상태 기록 실패는 로그만 남긴다).
async function runMetricsWithStatus(
  cfg: Config,
  pages: { pageId: string; channel: MetricChannel | null }[],
  channels: MetricChannel[] | null,
  scopes: Map<MetricChannel, MetricScope>,
): Promise<Json> {
  const mark = async (pageId: string, properties: Json) => {
    try {
      await updatePage(cfg, pageId, properties);
    } catch (e) {
      console.error("수집 상태 기록 실패", pageId, message(e));
    }
  };
  for (const page of pages) {
    await mark(page.pageId, {
      "수집 상태": { select: { name: STATUS_WORKING } },
      "처리 시작 시각": { date: { start: new Date().toISOString() } },
    });
  }
  try {
    const body = await runMetrics(cfg, false, channels, scopes);
    for (const page of pages) {
      const mine = bodyForChannel(body, page.channel);
      const failed = metricsErrorSummary(mine) !== "";
      const label = page.channel === null ? "전체" : METRIC_CHANNEL_LABELS[page.channel];
      const summary = maskSecrets(metricsResultSummary(mine, Date.now(), label), secretsOf(cfg));
      await mark(page.pageId, {
        "수집 상태": { select: { name: failed ? STATUS_ERROR : STATUS_DONE } },
        "처리 결과": { rich_text: [{ type: "text", text: { content: truncate(summary, 1800) } }] },
        "마지막 수집": { date: { start: new Date().toISOString() } },
      });
    }
    return body;
  } catch (e) {
    const detail = truncate(`${kstDateTime(Date.now())} 수집 실패\n${maskSecrets(message(e), secretsOf(cfg))}`, 1800);
    for (const page of pages) {
      await mark(page.pageId, {
        "수집 상태": { select: { name: STATUS_ERROR } },
        "처리 결과": { rich_text: [{ type: "text", text: { content: detail } }] },
      });
    }
    throw e;
  }
}

/**
 * 성과 수집 요청을 실행할 작업으로 바꾼다.
 * - scheduled: 매시 예약 실행. 채널 DB '자동 수집 시각'이 된 채널만 돌린다. 없으면 null.
 * - 채널 페이지 버튼: 그 채널만(수집 채널이 아닌 행이면 전체) 돌리고 그 페이지에 상태를 남긴다.
 * - 그 밖(손으로 부른 실행): 전체를 돌린다.
 * 어느 경우든 채널 DB 의 갱신 범위를 적용한다.
 */
async function planMetrics(cfg: Config, data: Json, scheduled: boolean, dryRun: boolean): Promise<(() => Promise<Json>) | null> {
  let settings = new Map<MetricChannel, ChannelSetting>();
  try {
    settings = await loadChannelSettings(cfg);
  } catch (e) {
    // 설정을 못 읽어도 수집은 한다(범위 제한 없이). 예약 실행만은 시각을 알 수 없어 건너뛴다.
    console.error("채널 설정 읽기 실패", message(e));
    if (scheduled) throw e;
  }
  const scopes = new Map([...settings].map(([channel, s]) => [channel, s.scope] as const));

  if (scheduled) {
    const now = Date.now();
    const due = [...settings].filter(([, s]) => autoCollectDue(s.hour, s.lastCollected, now));
    console.log("예약 수집 대상", due.map(([c]) => c).join(",") || "(없음)");
    if (due.length === 0) return null;
    const channels = due.map(([channel]) => channel);
    if (dryRun) return () => runMetrics(cfg, true, channels, scopes);
    return () => runMetricsWithStatus(cfg, due.map(([channel, s]) => ({ pageId: s.pageId, channel })), channels, scopes);
  }

  // 채널 DB 의 버튼으로 부르면 웹훅 본문에 그 채널 페이지가 실려 온다. 그 채널만 수집한다.
  const isPage = data.object === "page" && typeof data.id === "string";
  const only = isPage ? metricChannelByLabel(pageTitle((data.properties ?? {}) as Json)) : null;
  const channels = only === null ? null : [only];
  console.log("성과 수집 채널", only ?? "(전체)");
  if (!isPage || dryRun) return () => runMetrics(cfg, dryRun, channels, scopes);
  return () => runMetricsWithStatus(cfg, [{ pageId: data.id as string, channel: only }], channels, scopes);
}

async function resolveTargetPage(cfg: Config, payload: Json, requestUrl: string): Promise<string> {
  const explicit = readTarget(payload, requestUrl);
  if (explicit !== "") return parsePageId(explicit);

  // 노션 자동화 웹훅은 실행된 페이지를 data 에 통째로 실어 보낸다. 이게 가장 확실한 단서다.
  const data = (payload.data ?? {}) as Json;
  if (data.object === "page" && typeof data.id === "string") {
    return parsePageId(data.id as string);
  }

  const seen = new Set<string>();
  for (const candidate of collectPageCandidates(payload)) {
    let id = "";
    try {
      id = parsePageId(candidate);
    } catch {
      continue;
    }
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    try {
      const page = await notion(cfg, `/pages/${id}`);
      // 콘텐츠 DB 페이지('배포 채널' 칸이 있는 페이지)만 고른다. 관계 속성에 실려 온 다른 DB 페이지는 뺀다.
      if (((page.properties ?? {}) as Json)["배포 채널"] !== undefined) return id;
    } catch {
      // 접근할 수 없으면 다음 후보로 넘어간다.
    }
  }
  return "";
}

Deno.serve(async (req) => {
  let cfg: Config;
  try {
    cfg = buildConfig();
  } catch (e) {
    return json({ ok: false, error: message(e) }, 500);
  }

  // 인증 없이 열리는 GET 경로.
  // - ?page=home / ?page=privacy : 구글 동의 화면에 적는 앱 소개·개인정보처리방침
  // - ?threads_auth=1 / ?youtube_auth=1 : 승인 링크를 보여주는 안내 페이지
  // - ?code=...       : 스레드·구글이 브라우저를 돌려보내는 콜백 (1회용 code 라서 이것만 열어둔다)
  const reqUrl = new URL(req.url);
  if (req.method === "GET" && reqUrl.searchParams.get("page") === "home") {
    return textPage("하다 발행 도구", HOME_PAGE_TEXT);
  }
  if (req.method === "GET" && reqUrl.searchParams.get("page") === "privacy") {
    return textPage("하다 발행 도구 개인정보처리방침", PRIVACY_PAGE_TEXT);
  }
  if (req.method === "GET" && reqUrl.searchParams.has("threads_auth")) {
    return handleThreadsAuthPage(reqUrl, cfg);
  }
  if (req.method === "GET" && reqUrl.searchParams.has("youtube_auth")) {
    return handleYoutubeAuthPage(reqUrl, cfg);
  }
  // 구글은 보낸 state 를 그대로 돌려준다. 스레드 승인에는 state 를 쓰지 않으므로 이것으로 구분한다.
  if (req.method === "GET" && reqUrl.searchParams.get("state") === YOUTUBE_OAUTH_STATE) {
    return await handleYoutubeCallback(reqUrl, cfg);
  }
  if (req.method === "GET" && (reqUrl.searchParams.has("code") || reqUrl.searchParams.has("error"))) {
    return await handleThreadsCallback(reqUrl, cfg);
  }

  // Supabase pg_cron 의 매시 호출은 x-cron-key 로 들어온다. 값은 meta_tokens 표(channel = cron)에만 있고,
  // 예약 성과 수집(?metrics=1&scheduled=1)과 예약 발행(?due=1)에만 통한다.
  const cronKey = req.headers.get("x-cron-key") ?? "";
  // 예약 발행(?due=1)도 같은 키로 5분마다, 배포 워커(?worker=1)는 1분마다 들어온다.
  const cronRoute = (reqUrl.searchParams.get("metrics") === "1" && reqUrl.searchParams.get("scheduled") === "1") ||
    reqUrl.searchParams.get("due") === "1" || reqUrl.searchParams.get("worker") === "1";
  const cronOk = cronKey !== "" && cronRoute &&
    (await readToken(cfg, "cron").catch(() => null))?.access_token === cronKey;
  if (!cronOk && req.headers.get("x-admin-key") !== cfg.adminSecret) {
    return json({ ok: false, error: "인증에 실패했습니다. x-admin-key 헤더를 확인하세요." }, 401);
  }

  let payload: Json = {};
  if (req.method === "POST") {
    const raw = await req.text();
    if (raw.trim() !== "") {
      console.log("hada-publish 본문", raw.slice(0, 1500));
      try {
        payload = JSON.parse(raw);
      } catch {
        // 노션 버튼 웹훅 본문 형식은 보장되지 않는다. 못 읽어도 큐 조회로 넘어간다.
        payload = {};
      }
    }
  }

  const dryRun = payload.dryRun === true || reqUrl.searchParams.get("dryRun") === "true";

  // 성과 수집. GitHub Actions 는 ?wait=1 로 결과를 기다리고,
  // 노션 버튼은 10초 안에 답을 받아야 하므로 접수(202)만 돌려주고 뒤에서 수집한다.
  if (reqUrl.searchParams.get("metrics") === "1") {
    const data = (payload.data ?? {}) as Json;
    const scheduled = reqUrl.searchParams.get("scheduled") === "1";
    let plan: (() => Promise<Json>) | null;
    try {
      plan = await planMetrics(cfg, data, scheduled, dryRun);
    } catch (e) {
      return json({ ok: false, error: message(e) }, 500);
    }
    if (plan === null) {
      return json({ ok: true, skipped: true, message: "자동 수집 시각이 된 채널이 없습니다." });
    }
    const metricsTask = plan();
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (reqUrl.searchParams.get("wait") !== "1" && runtime?.waitUntil) {
      runtime.waitUntil(
        metricsTask
          .then((body) => console.log("성과 수집 결과", JSON.stringify({ ...body, results: undefined })))
          .catch((e) => console.error("성과 수집 실패", message(e))),
      );
      return json({ ok: true, accepted: true, message: "성과 수집을 시작했습니다. 1분쯤 뒤 성과 로그를 확인하세요." }, 202);
    }
    try {
      const body = await metricsTask;
      return json(body, body.ok === false ? 500 : 200);
    } catch (e) {
      console.error("성과 수집 실패", message(e));
      return json({ ok: false, error: message(e) }, 500);
    }
  }
  const wait = reqUrl.searchParams.get("wait") === "1";

  // 배포 워커. 대기열에서 한 줄(한 채널)만 처리한다. 크론 호출은 10초 안에 끝나야 하므로 접수(202)만 돌려준다.
  if (reqUrl.searchParams.get("worker") === "1") {
    const workerTask = runWorker(cfg);
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (!wait && runtime?.waitUntil) {
      runtime.waitUntil(
        workerTask
          .then((body) => console.log("배포 워커 결과", JSON.stringify(body)))
          .catch((e) => console.error("배포 워커 실패", message(e))),
      );
      return json({ ok: true, accepted: true, message: "배포 워커를 시작했습니다." }, 202);
    }
    try {
      const body = await workerTask;
      return json(body, body.ok === false ? 500 : 200);
    } catch (e) {
      console.error("배포 워커 실패", message(e));
      return json({ ok: false, error: message(e) }, 500);
    }
  }

  // 예약 발행. pg_cron 호출은 10초 안에 끝나야 하므로 접수(202)만 돌려주고 뒤에서 대기열에 넣는다.
  if (reqUrl.searchParams.get("due") === "1") {
    const dueTask = runDue(cfg, dryRun);
    const runtime = (globalThis as {
      EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
    }).EdgeRuntime;
    if (!wait && runtime?.waitUntil) {
      runtime.waitUntil(
        dueTask
          .then((body) => console.log("예약 발행 결과", JSON.stringify(body)))
          .catch((e) => console.error("예약 발행 실패", message(e))),
      );
      return json({ ok: true, accepted: true, message: "예약 발행 확인을 시작했습니다." }, 202);
    }
    try {
      const body = await dueTask;
      return json(body, body.ok === false ? 500 : 200);
    } catch (e) {
      console.error("예약 발행 실패", message(e));
      return json({ ok: false, error: message(e) }, 500);
    }
  }

  const hintText = channelHint(reqUrl.searchParams.get("channel"));
  const hint: Channel | null = hintText !== null && (CHANNELS as readonly string[]).includes(hintText)
    ? hintText as Channel
    : null;

  let pageId = "";
  try {
    pageId = await resolveTargetPage(cfg, payload, req.url);
  } catch (e) {
    return json({ ok: false, error: message(e) }, 400);
  }
  console.log("hada-publish 대상", pageId || "(없음: 큐 모드)", "채널", hint ?? "(없음)");

  // 접수만 한다(대기열에 넣기). 넣은 줄이 있으면 워커를 바로 깨운다.
  const task: Promise<Json> = (pageId !== ""
    ? intakeRow(cfg, pageId, dryRun, hint, hint === null)
    : runQueue(cfg, dryRun)).then((body) => {
      const enqueued = pageId !== ""
        ? ((body.enqueued as string[] | undefined) ?? []).length > 0
        : ((body.results as Json[] | undefined) ?? []).some((item) => ((item.enqueued as string[] | undefined) ?? []).length > 0);
      if (!dryRun && enqueued) wakeWorker(cfg);
      return body;
    });

  // 수동 호출(?pageId=·?pageUrl=·?url=)이나 ?wait=1 만 접수 결과를 그대로 돌려준다(발행 결과는 워커가 페이지에 남긴다).
  // 버튼 웹훅은 202 로 접수만 알린다.
  const manual = reqUrl.searchParams.has("pageId") || reqUrl.searchParams.has("pageUrl") ||
    reqUrl.searchParams.has("url");
  if (wait || manual) {
    try {
      const body = await task;
      return json(body, body.ok === false ? 500 : 200);
    } catch (e) {
      console.error("동기 실행 실패", message(e));
      return json({ ok: false, pageId, error: message(e) }, 500);
    }
  }

  // 노션 웹훅: 접수만 알려주고 실제 발행은 백그라운드에서 이어간다.
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void };
  }).EdgeRuntime;
  if (runtime?.waitUntil) {
    runtime.waitUntil(task.catch((e) => console.error("백그라운드 처리 실패", message(e))));
    return json({
      ok: true,
      accepted: true,
      message: "접수했습니다. 실제 결과는 페이지의 채널 상태와 실시간 처리 상태로 확인하세요.",
    }, 202);
  }

  // 백그라운드 실행을 못 쓰는 환경이면 그대로 기다린다.
  try {
    const body = await task;
    return json(body, body.ok === false ? 500 : 200);
  } catch (e) {
    return json({ ok: false, error: message(e) }, 500);
  }
});
