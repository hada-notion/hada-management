// META 업로드 자동화 — 노션 웹훅을 받아 인스타그램·스레드에 발행한다.
//
// 발행 소스는 컨텐츠 DB 의 '형식'으로 정한다.
//   카드뉴스    → 컷(프롬프트)의 미리보기 이미지 캐러셀
//   이미지      → 컨텐츠 '미리보기' 한 장
//   숏폼(9:16)  → 컨텐츠 '미리보기' 영상 (릴스)
//   롱폼(16:9)  → 컨텐츠 '미리보기' 영상 (릴스)
//   짧은글      → 글만. 스레드 전용이다. 인스타그램은 미디어 없는 발행을 지원하지 않는다.
//   긴글        → 자동 발행하지 않는다(블로그용).
//   예전 이름(영상-세로(9:16)·영상-가로(16:9)·카피)도 그대로 받는다.
//
// '캡션'은 선택이다. 비면 글 없이 미디어만 올린다(글을 요구하는 건 '짧은글' 형식뿐이다).
// 그래서 이미지·캐러셀 발행에서는 caption·text 파라미터를 아예 빼고 보낸다.
//
// 호출: POST /functions/v1/hada-publish   (헤더 x-admin-key 필요)
//   본문에 페이지 지정(pageUrl/pageId/url/id)이 있거나 본문 어딘가에 노션 페이지 주소가 실려 있으면
//   그 페이지만 처리한다. ?channel=instagram|threads 로 채널을 지정할 수 있다.
//   지정이 없으면 상태가 ⚪ 대기인 채널과 '배포 채널'에 고른 채널을 처리한다.
//   배포 채널 중 인스타그램·스레드는 발행하고(이미 ✅ 완료면 건너뜀),
//   유튜브는 연결 설정(YOUTUBE_CLIENT_ID)이 있고 영상 형식이면 업로드한다(세로 영상은 Shorts).
//   블로그 같은 나머지 채널은 게시물 DB 에 채널을 연결한 기록만 만든다.
//   페이지를 찾지 못하면 큐 조회로 넘어간다.
//
// 버튼 웹훅에는 항상 202(접수)로 응답하고 실제 발행은 백그라운드에서 이어간다.
// 노션 버튼 웹훅은 10초 안에 응답이 와야 하는데 발행은 그보다 오래 걸리기 때문이다.
// 실제 결과는 페이지의 '인스타그램 상태'·'스레드 상태'와 '실시간 처리 상태' 수식으로 확인한다.
// 테스트처럼 결과를 바로 보고 싶으면 ?wait=1 을 붙인다.
//
// 오류 문구에는 비밀값이 섞여 들어올 수 있다(메타는 거절한 토큰을 오류 문구에 되돌려준다).
// 노션에 쓰기 전에 summarizeApiError 로 요약하고 maskSecrets 로 가린다.
//
// 스레드 인증 안내: GET /functions/v1/hada-publish?threads_auth=1
// 스레드 인증 콜백: GET /functions/v1/hada-publish?code=...  (스레드가 브라우저를 돌려보내는 주소)
// 유튜브 인증 안내: GET /functions/v1/hada-publish?youtube_auth=1
// 유튜브 인증 콜백: GET /functions/v1/hada-publish?code=...&state=youtube  (구글이 돌려보내는 주소)
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
  sortCuts,
  optionalText,
  summarizeApiError,
  threadsLength,
  threadsAuthorizeUrl,
  truncate,
  METRIC_CHANNEL_LABELS,
  METRIC_FIELDS,
  importedPostTitle,
  metricChannelByLabel,
  metricsErrorSummary,
  metricsResultSummary,
  kstDateTime,
  publishedOnOrAfter,
  kstDate,
  metricChannelOf,
  metricDelta,
  postCodeOf,
  readInsights,
  isShortsFormat,
  splitYoutube,
  youtubeAuthorizeUrl,
  youtubeDescription,
  youtubePrivacy,
  youtubeTitle,
  youtubeWatchUrl,
  YOUTUBE_CHANNEL,
  YOUTUBE_OAUTH_STATE,
  YOUTUBE_SCOPES,
} from "./lib.ts";
import type { MediaKind, MetricChannel, Metrics } from "./lib.ts";

const NOTION_BASE = "https://api.notion.com/v1";
const IG_CONTAINER_POLL_ATTEMPTS = 10;
const IG_CONTAINER_POLL_INTERVAL_MS = 3000;
// 영상은 메타가 처리하는 데 시간이 걸린다. 다만 함수 실행 한도(150초)를 넘기면
// 백그라운드 작업이 중간에 잘리므로, 기다리는 시간을 한도 안쪽으로 묶어둔다.
const IG_VIDEO_POLL_ATTEMPTS = 12;
const IG_VIDEO_POLL_INTERVAL_MS = 6000;
const THREADS_CONTAINER_POLL_ATTEMPTS = 10;
const THREADS_CONTAINER_POLL_INTERVAL_MS = 4000;
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
    // 큐 모드에서 조회할 컨텐츠(학원관리) DB.
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

function cutOrder(prop: Json | undefined): number {
  return typeof prop?.number === "number" ? prop.number : Number.POSITIVE_INFINITY;
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
      throw new Error(`영상 파일이 아닙니다(${detail}). '형식'과 '미리보기' 파일을 확인하세요.`);
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
  index: number,
  sourceUrl: string,
  role: MediaRole,
): Promise<string> {
  if (!cfg.storageUrl || !cfg.storageKey) {
    throw new Error("미디어 저장소 설정(SB_URL, SB_SERVICE_ROLE_KEY)이 없습니다.");
  }

  const { bytes, ext, contentType } = await downloadMedia(sourceUrl, role);
  const path = `${pageId}/${String(index + 1).padStart(2, "0")}.${ext}`;
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

async function waitForIgContainer(
  cfg: Config,
  containerId: string,
  attempts = IG_CONTAINER_POLL_ATTEMPTS,
  intervalMs = IG_CONTAINER_POLL_INTERVAL_MS,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const info = await igGet(cfg, `${containerId}?fields=status_code,status`);
    const status = info.status_code ?? info.status;
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      const detail = maskSecrets(JSON.stringify(info), secretsOf(cfg));
      throw new Error(`인스타 컨테이너 처리 실패: ${truncate(detail, 300)}`);
    }
    await sleep(intervalMs);
  }
  throw new Error(
    "메타가 아직 파일을 처리하는 중입니다. 올라간 글은 없으니 잠시 뒤 같은 버튼을 다시 누르면 새로 처리합니다.",
  );
}

async function publishInstagram(cfg: Config, imageUrls: string[], caption: string): Promise<string> {
  const text = truncate(caption, IG_CAPTION_LIMIT);

  let containerId: string;
  if (imageUrls.length === 1) {
    const container = await igPost(cfg, `${cfg.igUserId}/media`, {
      image_url: imageUrls[0],
      ...optionalText("caption", text),
    });
    containerId = container.id;
  } else {
    assertCarouselSize(imageUrls.length, IG_CAROUSEL_MIN, IG_CAROUSEL_MAX, "인스타그램");
    const children: string[] = [];
    for (const url of imageUrls) {
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

  await waitForIgContainer(cfg, containerId);
  const published = await igPost(cfg, `${cfg.igUserId}/media_publish`, { creation_id: containerId });
  const info = await igGet(cfg, `${published.id}?fields=permalink`);
  return info.permalink ?? "";
}

/**
 * 릴스 발행. 영상은 컨테이너를 만든 뒤 메타가 처리할 때까지 기다려야 발행할 수 있다.
 * 처리 시간이 길어 함수 한도에 걸리면 여기서 멈추는데, 그때는 media_publish 를 부르지 않았으므로
 * 다시 실행해도 같은 글이 두 번 올라가지 않는다.
 */
async function publishInstagramReel(cfg: Config, videoUrl: string, caption: string): Promise<string> {
  const text = truncate(caption, IG_CAPTION_LIMIT);
  const container = await igPost(cfg, `${cfg.igUserId}/media`, {
    media_type: "REELS",
    video_url: videoUrl,
    ...optionalText("caption", text),
    share_to_feed: "true",
  });
  await waitForIgContainer(cfg, container.id, IG_VIDEO_POLL_ATTEMPTS, IG_VIDEO_POLL_INTERVAL_MS);
  const published = await igPost(cfg, `${cfg.igUserId}/media_publish`, { creation_id: container.id });
  const info = await igGet(cfg, `${published.id}?fields=permalink`);
  return info.permalink ?? "";
}

// ---------- 스레드 인증 ----------
// Threads API 는 페이스북 로그인으로 붙는 경로가 없다. 스레드 자체 OAuth 를 한 번 거쳐
// 60일짜리 토큰을 받고, meta_tokens 표에 담아두고 발행할 때마다 오래된 토큰을 자동 갱신한다.

const THREADS_OAUTH_FALLBACK = "https://graph.threads.net";

// Supabase 게이트웨이가 응답의 Content-Type 을 text/plain 으로 덮어써서 HTML 은 렌더링되지 않는다.
// 그래서 사람이 읽기 좋은 평문으로 돌려주고, 한글이 깨지지 않게 UTF-8 BOM 을 앞에 붙인다.
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
 * 발행 소스. 형식에 따라 컷 이미지 캐러셀 / 미리보기 한 장 / 미리보기 영상 / 글만 중 하나가 된다.
 * 인스타그램은 글만 올리는 걸 지원하지 않으므로 text 는 스레드 전용이다.
 */
type MediaPlan =
  | { kind: "images"; urls: string[] }
  | { kind: "video"; url: string }
  | { kind: "text" };

async function waitForThreadsContainer(
  cfg: Config,
  auth: ThreadsAuth,
  containerId: string,
): Promise<void> {
  for (let attempt = 0; attempt < THREADS_CONTAINER_POLL_ATTEMPTS; attempt++) {
    let info: Json;
    try {
      info = await threadsGet(cfg, auth, `${containerId}?fields=status,error_message`);
    } catch (e) {
      // 컨테이너를 막 만든 직후에는 아직 안 보일 수 있다. 그 오류만 넘긴다.
      if (!isThreadsNotFound(e) || attempt === THREADS_CONTAINER_POLL_ATTEMPTS - 1) throw e;
      await sleep(THREADS_CONTAINER_POLL_INTERVAL_MS);
      continue;
    }
    const status = String(info.status ?? "").toUpperCase();
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      const detail = maskSecrets(String(info.error_message ?? JSON.stringify(info)), secretsOf(cfg));
      throw new Error(`스레드 컨테이너 처리 실패: ${truncate(detail, 300)}`);
    }
    await sleep(THREADS_CONTAINER_POLL_INTERVAL_MS);
  }
  throw new Error(
    "스레드가 아직 파일을 처리하는 중입니다. 올라간 글은 없으니 잠시 뒤 같은 버튼을 다시 누르면 새로 처리합니다.",
  );
}

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

async function publishThreads(
  cfg: Config,
  auth: ThreadsAuth,
  media: MediaPlan,
  caption: string,
): Promise<string> {
  const text = truncate(caption, THREADS_TEXT_LIMIT);
  const uid = auth.userId;

  let containerId: string;
  if (media.kind === "text") {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "TEXT",
      ...optionalText("text", text),
    });
    containerId = container.id;
  } else if (media.kind === "video") {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "VIDEO",
      video_url: media.url,
      ...optionalText("text", text),
    });
    containerId = container.id;
    await waitForThreadsContainer(cfg, auth, containerId);
  } else if (media.urls.length === 1) {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "IMAGE",
      image_url: media.urls[0],
      ...optionalText("text", text),
    });
    containerId = container.id;
    await waitForThreadsContainer(cfg, auth, containerId);
  } else {
    assertCarouselSize(media.urls.length, THREADS_CAROUSEL_MIN, THREADS_CAROUSEL_MAX, "스레드");
    const children: string[] = [];
    for (const url of media.urls) {
      const child = await threadsPost(cfg, auth, `${uid}/threads`, {
        media_type: "IMAGE",
        image_url: url,
        is_carousel_item: "true",
      });
      children.push(child.id);
    }
    console.log("스레드 자식 컨테이너", children.length, "개 생성");
    // 부모를 만들기 전에 자식들이 처리를 마쳐야 한다. 건너뛰면 4279004 로 거절당한다.
    await Promise.all(children.map((id) => waitForThreadsContainer(cfg, auth, id)));
    const container = await createThreadsCarousel(cfg, auth, children, text);
    containerId = container.id;
    await waitForThreadsContainer(cfg, auth, containerId);
  }

  const published = await publishThreadsContainer(cfg, auth, containerId);
  const info = await threadsGet(cfg, auth, `${published.id}?fields=permalink`);
  return info.permalink ?? "";
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

/** 이 산출물의 유튜브 게시물 기록 중 게시 링크가 있는 것이 있으면 이미 올린 것으로 본다. */
async function youtubeAlreadyPosted(cfg: Config, pageId: string): Promise<boolean> {
  const channelId = await findChannelPageId(cfg, YOUTUBE_CHANNEL);
  const rows = await findPostRecords(cfg, pageId, channelId);
  return rows.some((row) => Boolean(((row.properties ?? {}) as Json)["게시 링크"]?.url));
}

// ---------- 채널 ----------

const CHANNELS = ["인스타그램", "스레드"] as const;
type Channel = typeof CHANNELS[number];

const RESULT_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 상태",
  "스레드": "스레드 상태",
};

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

const QUEUE_TIME_BUDGET_MS = 110000;

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
    throw new Error(`컨텐츠 DB 조회에 실패했습니다. (${firstError} / ${message(e)})`);
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

type PostRecord = { channel: string; url: string; created: boolean };

/** 이 산출물·채널의 게시물 기록들. */
async function findPostRecords(cfg: Config, pageId: string, channelId: string): Promise<Json[]> {
  return await queryDataSource(cfg, cfg.postDataSourceId, {
    and: [
      { property: "산출물", relation: { contains: pageId } },
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
        "산출물": { relation: [{ id: pageId }] },
        ...extra,
      },
    }),
  });
}

/**
 * 자동 발행에 성공한 채널을 게시물 DB 에 기록한다. 성과 트래킹은 이 게시물 기록에 붙는다.
 * 같은 산출물·채널 기록 중 게시 링크가 빈 것이 있으면 그 기록을 채우고, 없으면 새로 만든다.
 * 다시 발행한 경우(상태를 비우고 재발행)에는 이전 기록을 덮어쓰지 않고 새 기록이 생긴다.
 */
async function recordPublishedPost(
  cfg: Config,
  pageId: string,
  props: Json,
  channel: string,
  link: string,
): Promise<string> {
  const channelId = await findChannelPageId(cfg, channel);
  const fields: Json = {
    "게시 상태": { select: { name: "게시" } },
    "게시일": { date: { start: new Date().toISOString() } },
  };
  if (link) fields["게시 링크"] = { url: link };

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
 * 같은 산출물·채널 기록이 이미 있으면 새로 만들지 않는다. 버튼을 여러 번 눌러도 기록은 하나다.
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
        records.push({ channel, url: (existing[0].url as string) ?? "", created: false });
        continue;
      }
      const page = await createPostPage(cfg, pageId, title, channel, channelId);
      records.push({ channel, url: (page.url as string) ?? "", created: true });
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

/** 컷(프롬프트)에 연결된 컷들의 미리보기 이미지를 컷 순서대로 모은다. */
async function collectCutImageUrls(cfg: Config, props: Json): Promise<string[]> {
  const cutIds = relationIds(props["컷(프롬프트)"]);
  if (cutIds.length === 0) {
    throw new Error("'컷(프롬프트)' 관계가 비어 있습니다. 발행할 컷을 먼저 연결하세요.");
  }
  const cuts: { pageId: string; order: number; files: any[] }[] = [];
  for (const cutId of cutIds) {
    const cutPage = await notion(cfg, `/pages/${cutId}`);
    const cutProps = (cutPage.properties ?? {}) as Json;
    cuts.push({
      pageId: cutId,
      order: cutOrder(cutProps["컷 순서"]),
      files: cutProps["미리보기"]?.files ?? [],
    });
  }
  const sourceUrls: string[] = [];
  for (const cut of sortCuts(cuts)) sourceUrls.push(...extractImageUrls(cut.files));
  if (sourceUrls.length === 0) {
    throw new Error("발행할 이미지를 찾지 못했습니다. 컷의 '미리보기' 파일을 확인하세요.");
  }
  return sourceUrls;
}

/** 컨텐츠 페이지의 '미리보기' 파일. 영상·이미지·짧은글처럼 한 덩어리인 형식에서 쓴다. */
function previewFiles(props: Json): any[] {
  return (props["미리보기"]?.files ?? []) as any[];
}

/**
 * '형식'에 따라 발행 소스를 정한다.
 * 카드뉴스는 컷 이미지 캐러셀, 이미지는 미리보기 한 장, 영상은 미리보기 영상, 짧은글은 글만 올린다.
 */
async function collectSources(cfg: Config, props: Json, kind: MediaKind): Promise<MediaPlan> {
  if (kind === "carousel") {
    return { kind: "images", urls: await collectCutImageUrls(cfg, props) };
  }
  if (kind === "image") {
    const urls = extractImageUrls(previewFiles(props));
    if (urls.length === 0) {
      throw new Error("'미리보기'에 이미지 파일이 없습니다. 발행할 이미지를 올려주세요.");
    }
    return { kind: "images", urls: urls.slice(0, 1) };
  }
  if (kind === "video") {
    const urls = extractVideoUrls(previewFiles(props));
    if (urls.length === 0) {
      throw new Error("'미리보기'에 영상 파일이 없습니다. mp4 파일을 올려주세요.");
    }
    if (urls.length > 1) {
      console.warn("'미리보기'에 영상이 여러 개라 첫 번째만 발행합니다.");
    }
    return { kind: "video", url: urls[0] };
  }
  return { kind: "text" };
}

/** 요청한 채널들이 같은 파일을 쓰도록 한 번만 올린다. */
async function uploadPlan(cfg: Config, pageId: string, plan: MediaPlan): Promise<MediaPlan> {
  if (plan.kind === "text") return plan;
  if (plan.kind === "video") {
    return { kind: "video", url: await uploadMedia(cfg, pageId, 0, plan.url, "video") };
  }
  const urls: string[] = [];
  for (let index = 0; index < plan.urls.length; index++) {
    urls.push(await uploadMedia(cfg, pageId, index, plan.urls[index], "image"));
  }
  return { kind: "images", urls };
}

async function publishRow(
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

  let records: PostRecord[] = [];
  let recordFailures: string[] = [];
  if (recordChannels.length > 0 && !dryRun) {
    ({ records, failures: recordFailures } = await createPostRecords(cfg, pageId, props, recordChannels));
  }

  // 테스트 실행은 요청 채널이 없어도 두 채널 기준으로 점검한다.
  let channels: Channel[] = CHANNELS.filter((channel) => wanted.has(channel));
  if (channels.length === 0 && dryRun && recordChannels.length === 0 && !youtube) channels = [...CHANNELS];
  if (channels.length === 0 && !youtube && (recordChannels.length > 0 || doneChannels.length > 0)) {
    return {
      ok: recordFailures.length === 0,
      pageId,
      dryRun,
      records: dryRun ? recordChannels : records,
      recordFailures,
      alreadyDone: doneChannels,
    };
  }
  if (channels.length === 0 && !youtube) {
    // 버튼 설정이 어긋나면 여기로 온다. '배포 채널'이 비었거나, 예전 버튼이 상태를 ⚪ 대기로 바꾸지 않은 경우다.
    // 예전에는 아무 흔적 없이 끝나서 원인을 찾기 어려웠다. 이제는 로그와 안내를 남긴다.
    console.log("hada-publish 건너뜀", pageId, "요청된 채널 없음");
    const reason = "요청된 채널이 없어 아무것도 하지 않았습니다. " +
      "'배포 채널'에서 올릴 채널을 골랐는지 확인하세요.";
    if (!dryRun && only === null) {
      try {
        await addComment(cfg, pageId, `META 업로드 안내\n\n${reason}`);
      } catch (e) {
        console.error("안내 코멘트 실패", message(e));
      }
    }
    return { ok: true, pageId, skipped: true, reason };
  }

  if (kind === null) {
    throw new Error(
      `'형식' 값을 확인하세요. 지금 값: '${format || "비어 있음"}'. 쓸 수 있는 값: ${FORMAT_NAMES.join(" / ")}`,
    );
  }

  const plan = await collectSources(cfg, props, kind);
  // 발행 문구는 '캡션'만 쓴다. '대본'은 제작 메모가 섞인 작업 문서라 대체재로 쓰지 않는다.
  // 대본으로 대체하면 메모가 그대로 게시되고, 길이가 한도를 넘어 한 채널만 실패한다.
  const captionText = richText(props["캡션"]);
  const scriptText = richText(props["대본"]);
  const caption = buildCaption(captionText, cfg.fixedComment);
  // 캡션이 비어도 막지 않는다. 카드뉴스는 그림이 본체라 글 없이 올리는 편이 낫다.
  // 글이 본체인 '짧은글' 형식만 캡션이 필요하다(텍스트 전용 발행은 메타가 글을 요구한다).
  if (caption.trim() === "" && kind === "text") {
    const scriptNote = scriptText.trim() === ""
      ? "대본도 비어 있습니다."
      : `대본은 ${scriptText.trim().length}자지만 발행 문구로 쓰지 않습니다(제작 메모가 섞여 있습니다).`;
    throw new Error(
      `'${format}' 형식은 글이 본체라 '캡션'이 필요합니다. ${scriptNote} '캡션'을 채운 뒤 다시 실행하세요.`,
    );
  }

  // 테스트 실행: 파일 업로드까지만 하고 발행도 상태 변경도 하지 않는다.
  if (dryRun) {
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
      youtube: youtube
        ? {
          auth: youtubeNote,
          shorts,
          privacy: cfg.youtubePrivacy,
          title: youtubeTitle(richText(props["유튜브 제목"]), pageTitle(props)),
          description: youtubeDescription(caption, shorts),
        }
        : youtubeNote,
      format,
      mediaKind: kind,
      media: uploaded,
      caption,
      captionLength: caption.length,
      threadsCaptionLength: threadsLength(caption),
      threadsAuth: threadsAuthNote,
      note: "테스트 실행입니다. 발행하지 않았고 페이지 상태도 바꾸지 않았습니다.",
    };
  }

  await updatePage(cfg, pageId, {
    "처리 시작 시각": { date: { start: new Date().toISOString() } },
  });
  console.log("hada-publish 시작", pageId, channels.join(","), `${format} · ${kind} · 캡션 ${caption.length}자`);

  // 파일은 채널마다 공개 URL이 필요하다. 한 번 올려서 요청한 채널이 같이 쓴다.
  let uploaded: MediaPlan | null = null;
  const results: Json = {};
  const failures: string[] = [];
  const postFailures: string[] = [];
  const notices: string[] = [];
  let succeeded = false;

  // 유튜브는 업로드만 하면 처리를 기다리지 않아 금방 끝난다. 영상 처리를 기다리는 메타 채널보다 먼저 해서
  // 함수 실행 한도에 밀려 잘리지 않게 한다. 채널 상태 칸이 없으므로 '이미 올렸는지'는 게시물 기록의 게시 링크로 본다.
  if (youtube && plan.kind === "video") {
    if (!(await claimJob(cfg, pageId, YOUTUBE_CHANNEL))) {
      results[YOUTUBE_CHANNEL] = "다른 실행이 처리 중이라 건너뛰었습니다.";
    } else {
      try {
        if (await youtubeAlreadyPosted(cfg, pageId)) {
          doneChannels.push(YOUTUBE_CHANNEL);
          results[YOUTUBE_CHANNEL] = "이미 올린 기록(게시 링크)이 있어 건너뛰었습니다.";
        } else {
          const shorts = isShortsFormat(format);
          const file = await downloadMedia(plan.url, "video");
          const video = await uploadYoutube(
            cfg,
            file,
            youtubeTitle(richText(props["유튜브 제목"]), pageTitle(props)),
            youtubeDescription(caption, shorts),
          );
          const link = youtubeWatchUrl(video.id, shorts);
          succeeded = true;
          results[YOUTUBE_CHANNEL] = link;
          console.log("hada-publish 완료", pageId, YOUTUBE_CHANNEL, link, video.privacy);
          if (video.privacy !== "" && video.privacy !== cfg.youtubePrivacy) {
            notices.push(
              `유튜브: '${cfg.youtubePrivacy}'로 요청했지만 '${video.privacy}'로 올라갔습니다. ` +
                "구글 클라우드 프로젝트가 유튜브 API 감사를 받기 전에는 API 로 올린 영상이 비공개로 묶입니다. " +
                "유튜브 스튜디오에서 공개 범위를 바꿔주세요.",
            );
          }
          try {
            await recordPublishedPost(cfg, pageId, props, YOUTUBE_CHANNEL, link);
          } catch (e) {
            postFailures.push(`${YOUTUBE_CHANNEL} — ${maskSecrets(message(e), secretsOf(cfg))} (링크: ${link})`);
          }
        }
      } catch (e) {
        const detail = maskSecrets(message(e), secretsOf(cfg));
        failures.push(`${YOUTUBE_CHANNEL} — ${detail}`);
        results[YOUTUBE_CHANNEL] = detail;
        try {
          await updatePage(cfg, pageId, {
            "마지막 오류": {
              rich_text: [{ type: "text", text: { content: truncate(`${YOUTUBE_CHANNEL} — ${detail}`, 1800) } }],
            },
          });
        } catch {
          // 아래 실패 코멘트로 남는다.
        }
      } finally {
        await releaseJob(cfg, pageId, YOUTUBE_CHANNEL);
      }
    }
  }

  for (const channel of channels) {
    if (!(await claimJob(cfg, pageId, channel))) {
      results[channel] = "다른 실행이 처리 중이라 건너뛰었습니다.";
      continue;
    }
    try {
      await updatePage(cfg, pageId, {
        [RESULT_PROP[channel]]: { select: { name: STATUS_WORKING } },
      });

      // 한도 초과는 그 채널의 업로드와 발행보다 앞에서 막는다.
      const limitError = captionLimitError(caption, [channel]);
      if (limitError) {
        // 어느 값이 길이를 만들었는지 같이 알려준다. 그래야 바로 고칠 수 있다.
        const fixedLength = cfg.fixedComment.trim().length;
        throw new Error(
          `${limitError} (캡션 ${captionText.trim().length}자 + 고정 멘트 ${fixedLength}자 = 발행 문구 ${caption.length}자)`,
        );
      }

      // 인스타그램은 미디어 없는 발행을 지원하지 않는다. 이 채널만 실패로 남기고 스레드는 계속 간다.
      if (kind === "text" && channel === "인스타그램") {
        throw new Error(`'${format}' 형식은 미디어가 없어 인스타그램에 발행할 수 없습니다. '배포 채널'에서 인스타그램을 빼주세요.`);
      }

      if (!uploaded) uploaded = await uploadPlan(cfg, pageId, plan);
      const media: MediaPlan = uploaded;

      let link = "";
      if (channel === "인스타그램") {
        link = media.kind === "video"
          ? await publishInstagramReel(cfg, media.url, caption)
          : await publishInstagram(cfg, media.kind === "images" ? media.urls : [], caption);
      } else {
        link = await publishThreads(cfg, await resolveThreadsAuth(cfg), media, caption);
      }

      succeeded = true;
      await updatePage(cfg, pageId, {
        [RESULT_PROP[channel]]: { select: { name: STATUS_DONE } },
      });
      console.log("hada-publish 완료", pageId, channel, link || "(링크 없음)");
      results[channel] = link || "성공";

      // 링크는 게시물 기록에 남긴다. 이미 올라간 글이므로 기록 실패는 발행 실패로 치지 않고 따로 알린다.
      try {
        await recordPublishedPost(cfg, pageId, props, channel, link);
      } catch (e) {
        postFailures.push(`${channel} — ${maskSecrets(message(e), secretsOf(cfg))}${link ? ` (링크: ${link})` : ""}`);
      }
    } catch (e) {
      // 메타는 거절한 토큰을 오류 문구에 되돌려준다. 노션에 쓰기 전에 한 번 더 가린다.
      const detail = maskSecrets(message(e), secretsOf(cfg));
      failures.push(`${channel} — ${detail}`);
      results[channel] = detail;
      try {
        await updatePage(cfg, pageId, {
          [RESULT_PROP[channel]]: { select: { name: STATUS_ERROR } },
          "마지막 오류": {
            rich_text: [{ type: "text", text: { content: truncate(`${channel} — ${detail}`, 1800) } }],
          },
        });
      } catch {
        // 상태 기록까지 실패하면 코멘트로만 남긴다.
      }
    } finally {
      await releaseJob(cfg, pageId, channel);
    }
  }

  if (succeeded) {
    await updatePage(cfg, pageId, {
      "발행 시각": { date: { start: new Date().toISOString() } },
    });
  }

  // 실패가 없으면 지난 오류 메시지를 비운다.
  // 전체 요약은 '실시간 처리 상태' 수식이 채널 상태를 읽어 계산하므로 함수가 따로 쓰지 않는다.
  if (failures.length === 0) {
    await updatePage(cfg, pageId, { "마지막 오류": { rich_text: [] } });
  }

  if (failures.length > 0) {
    const note = succeeded
      ? "성공한 채널은 그대로 두었습니다. 배포 버튼을 다시 누르면 완료된 채널은 건너뛰고 실패한 채널만 다시 시도합니다."
      : "발행된 채널이 없습니다. 원인을 고친 뒤 다시 실행하세요.";
    const detail = maskSecrets(failures.join("\n"), secretsOf(cfg));
    await addComment(cfg, pageId, `META 업로드 실패\n\n${detail}\n\n${note}`);
  }

  if (notices.length > 0) {
    try {
      await addComment(cfg, pageId, `배포 안내\n\n${notices.join("\n")}`);
    } catch (e) {
      console.error("배포 안내 코멘트 실패", message(e));
    }
  }

  if (postFailures.length > 0) {
    try {
      await addComment(
        cfg,
        pageId,
        `게시물 기록 실패\n\n${postFailures.join("\n")}\n\n발행은 됐습니다. 게시물 DB 에 직접 기록하고 링크를 붙여주세요.`,
      );
    } catch (e) {
      console.error("게시물 기록 실패 코멘트 실패", message(e));
    }
  }

  return {
    ok: failures.length === 0,
    pageId,
    channels: youtube ? [...channels, YOUTUBE_CHANNEL] : channels,
    format,
    mediaKind: kind,
    results,
    failures,
    records,
    recordFailures,
    postFailures,
    alreadyDone: doneChannels,
  };
}

async function runQueue(cfg: Config, dryRun: boolean): Promise<Json> {
  const startedAt = Date.now();
  const queued = await findQueuedPageIds(cfg);
  if (queued.length === 0) {
    return {
      ok: true,
      queue: true,
      dryRun,
      requested: 0,
      processed: 0,
      results: [],
      remaining: [],
      message: "요청(⚪ 대기)으로 남아 있는 컨텐츠가 없습니다.",
    };
  }

  const results: Json[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < queued.length; index++) {
    // 한 번의 실행이 함수 실행 시간 한도를 넘지 않도록 남은 행은 다음 호출로 미룬다.
    if (index > 0 && Date.now() - startedAt > QUEUE_TIME_BUDGET_MS) {
      remaining.push(queued[index]);
      continue;
    }
    try {
      results.push({ pageId: queued[index], ...(await publishRow(cfg, queued[index], dryRun)) });
    } catch (e) {
      results.push({ pageId: queued[index], ok: false, error: message(e) });
    }
  }

  const body: Json = {
    ok: results.every((item) => item.ok !== false),
    queue: true,
    dryRun,
    requested: queued.length,
    processed: results.length,
    results,
    remaining,
  };
  if (remaining.length > 0) {
    body.note = "처리 시간이 부족해 남은 행은 그대로 두었습니다. 버튼을 한 번 더 눌러주세요.";
  }
  return body;
}

// ---------- 진입점 ----------

/**
 * 발행할 페이지를 정한다.
 * 본문에 페이지 지정이 있으면 그것을 쓰고, 없으면 본문 어딘가에 실린 노션 주소 중
 * 실제 컨텐츠 페이지('컷(프롬프트)' 관계가 있는 페이지)를 골라 쓴다.
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

type PostTarget = { id: string; title: string; link: string; channel: MetricChannel; code: string };
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
async function findMetricTargets(cfg: Config): Promise<{ targets: PostTarget[]; known: Set<string> }> {
  const rows = await queryAll(cfg, cfg.postDataSourceId, {
    property: "게시 링크",
    url: { is_not_empty: true },
  });
  const targets: PostTarget[] = [];
  const known = new Set<string>();
  for (const row of rows) {
    const props = (row.properties ?? {}) as Json;
    const link = String(props["게시 링크"]?.url ?? "").trim();
    const channel = metricChannelOf(link);
    const code = postCodeOf(link);
    if (channel === null || code === "") continue;
    known.add(`${channel}:${code}`);
    if (selectName(props["게시 상태"]) === "내림") continue;
    targets.push({ id: row.id, title: pageTitle(props), link, channel, code });
  }
  return { targets, known };
}

/** 계정에서 찾은 게시물 하나. 게시물 DB 에 없으면 이걸로 새 기록을 만든다. */
type AccountPost = { channel: MetricChannel; code: string; link: string; text: string; publishedAt: string };

/**
 * 계정에는 있는데 게시물 DB 에 없는 게시물(직접 올린 것 등)의 게시물 기록을 만든다.
 * 산출물은 연결하지 않는다(어느 산출물인지 알 수 없다). 메모로 자동 생성임을 남긴다.
 */
async function importPost(cfg: Config, post: AccountPost, channelIds: Map<MetricChannel, string>): Promise<PostTarget> {
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
        "메모": {
          rich_text: [{ type: "text", text: { content: "성과 수집이 계정에서 찾아 자동으로 만든 기록. 산출물은 직접 연결하세요." } }],
        },
      },
    }),
  });
  return { id: page.id, title, link: post.link, channel: post.channel, code: post.code };
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
        });
      }
      pageToken = String(list.nextPageToken ?? "");
      if (pageToken === "") break;
    }
  }
  return posts;
}

/** only 가 있으면 그 채널만 수집한다(채널 DB 의 버튼). 없으면 전체. */
async function runMetrics(cfg: Config, dryRun: boolean, only: MetricChannel | null = null): Promise<Json> {
  const started = Date.now();
  const date = kstDate(started);
  const wants = (channel: MetricChannel) => only === null || only === channel;
  const found = await findMetricTargets(cfg);
  const targets = found.targets.filter((t) => wants(t.channel));
  const known = found.known;
  const logged = await loggedTotals(cfg);
  const results: CollectResult[] = [];
  const channelIds = new Map<MetricChannel, string>();
  const imported: string[] = [];

  // 계정에서 찾은 게시물 중 게시물 DB 에 없는 것은 기록을 새로 만들어 대상에 더한다.
  // dryRun 이면 만들지 않고 만들 목록만 돌려준다.
  const addMissing = async (posts: AccountPost[]) => {
    for (const post of posts) {
      const key = `${post.channel}:${post.code}`;
      if (known.has(key)) continue;
      if (!publishedOnOrAfter(post.publishedAt, cfg.metricsImportSince)) continue;
      // 한 번에 많이 만들면 함수 시간 한도에 걸린다. 남은 것은 다음 실행이 이어서 만든다.
      if (!dryRun && Date.now() - started > METRICS_TIME_BUDGET_MS / 2) break;
      known.add(key);
      const title = importedPostTitle(post.text, METRIC_CHANNEL_LABELS[post.channel]);
      if (dryRun) {
        imported.push(title);
        continue;
      }
      try {
        targets.push(await importPost(cfg, post, channelIds));
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
          `${cfg.igUserId}/media?fields=id,shortcode,permalink,caption,timestamp,like_count,comments_count&limit=100${
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
    })));
    for (const target of targets.filter((t) => t.channel === "threads")) {
      const item = media.get(target.code);
      if (!item) continue;
      try {
        current.set(target.id, await threadsMetrics(cfg, auth, item.id));
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
    failures,
    channelErrors: Object.fromEntries(channelError),
    results,
  };
}

// 채널 DB 버튼으로 부른 수집은 그 채널 페이지에 진행 상태를 남긴다.
// 버튼이 '수집 상태'를 ⚪ 대기로 바꾸고 웹훅을 보내면, 여기서 🔄 작업중 → ✅ 완료 / ⚠️ 오류로 바꾸고
// '처리 결과'에 시각·건수·오류를 남긴다.
// 상태 칸이 없는 페이지여도 수집은 그대로 한다(상태 기록 실패는 로그만 남긴다).
async function runMetricsWithStatus(cfg: Config, pageId: string, only: MetricChannel | null): Promise<Json> {
  const mark = async (properties: Json) => {
    try {
      await updatePage(cfg, pageId, properties);
    } catch (e) {
      console.error("수집 상태 기록 실패", pageId, message(e));
    }
  };
  await mark({
    "수집 상태": { select: { name: STATUS_WORKING } },
    "처리 시작 시각": { date: { start: new Date().toISOString() } },
  });
  try {
    const body = await runMetrics(cfg, false, only);
    const failed = metricsErrorSummary(body) !== "";
    const scope = only === null ? "전체" : METRIC_CHANNEL_LABELS[only];
    const summary = maskSecrets(metricsResultSummary(body, Date.now(), scope), secretsOf(cfg));
    await mark({
      "수집 상태": { select: { name: failed ? STATUS_ERROR : STATUS_DONE } },
      "처리 결과": { rich_text: [{ type: "text", text: { content: truncate(summary, 1800) } }] },
      "마지막 수집": { date: { start: new Date().toISOString() } },
    });
    return body;
  } catch (e) {
    const detail = truncate(`${kstDateTime(Date.now())} 수집 실패\n${maskSecrets(message(e), secretsOf(cfg))}`, 1800);
    await mark({
      "수집 상태": { select: { name: STATUS_ERROR } },
      "처리 결과": { rich_text: [{ type: "text", text: { content: detail } }] },
    });
    throw e;
  }
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
      // 컷 관계가 없는 페이지(예: 관계 속성에 실려 온 컷 페이지)는 후보에서 뺀다.
      if (((page.properties ?? {}) as Json)["컷(프롬프트)"] !== undefined) return id;
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
  // - ?threads_auth=1 / ?youtube_auth=1 : 승인 링크를 보여주는 안내 페이지
  // - ?code=...       : 스레드·구글이 브라우저를 돌려보내는 콜백 (1회용 code 라서 이것만 열어둔다)
  const reqUrl = new URL(req.url);
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

  if (req.headers.get("x-admin-key") !== cfg.adminSecret) {
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
    // 채널 DB 의 버튼으로 부르면 웹훅 본문에 그 채널 페이지가 실려 온다. 그 채널만 수집한다.
    const data = (payload.data ?? {}) as Json;
    const only = data.object === "page" ? metricChannelByLabel(pageTitle((data.properties ?? {}) as Json)) : null;
    console.log("성과 수집 채널", only ?? "(전체)");
    const statusPage = data.object === "page" && typeof data.id === "string" && !dryRun ? data.id as string : "";
    const metricsTask = statusPage === ""
      ? runMetrics(cfg, dryRun, only)
      : runMetricsWithStatus(cfg, statusPage, only);
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

  const task: Promise<Json> = pageId !== ""
    ? publishRow(cfg, pageId, dryRun, hint, hint === null)
    : runQueue(cfg, dryRun);

  // 수동 호출(?pageId=·?pageUrl=·?url=)이나 ?wait=1 만 결과를 그대로 돌려준다.
  // 버튼 웹훅은 본문에 페이지가 실려 오므로 여기서 걸리면 10초 제한에 걸린다. 항상 202 로 접수만 알린다.
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
