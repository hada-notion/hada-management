// META 업로드 자동화 — 노션 웹훅을 받아 인스타그램·스레드에 발행한다.
//
// 발행 소스는 컨텐츠 DB 의 '형식'으로 정한다.
//   카드뉴스        → 컷(프롬프트)의 미리보기 이미지 캐러셀
//   이미지          → 컨텐츠 '미리보기' 한 장
//   영상-세로(9:16) → 컨텐츠 '미리보기' 영상 (릴스)
//   영상-가로(16:9) → 컨텐츠 '미리보기' 영상 (릴스)
//   카피            → 글만. 스레드 전용이다. 인스타그램은 미디어 없는 발행을 지원하지 않는다.
//
// 호출: POST /functions/v1/meta-publish   (헤더 x-admin-key 필요)
//   본문에 페이지 지정(pageUrl/pageId/url/id)이 있거나 본문 어딘가에 노션 페이지 주소가 실려 있으면
//   그 페이지만 처리한다. ?channel=instagram|threads 로 채널을 지정할 수 있다.
//   지정이 없으면 상태가 ⚪ 대기인 채널을 처리하고, 그것도 없으면 큐 조회로 넘어간다.
//
// 버튼 웹훅에는 항상 202(접수)로 응답하고 실제 발행은 백그라운드에서 이어간다.
// 노션 버튼 웹훅은 10초 안에 응답이 와야 하는데 발행은 그보다 오래 걸리기 때문이다.
// 실제 결과는 페이지의 '인스타그램 상태'·'스레드 상태'와 '실시간 처리 상태' 수식으로 확인한다.
// 테스트처럼 결과를 바로 보고 싶으면 ?wait=1 을 붙인다.
//
// 오류 문구에는 비밀값이 섞여 들어올 수 있다(메타는 거절한 토큰을 오류 문구에 되돌려준다).
// 노션에 쓰기 전에 summarizeApiError 로 요약하고 maskSecrets 로 가린다.
//
// 스레드 인증 안내: GET /functions/v1/meta-publish?threads_auth=1
// 스레드 인증 콜백: GET /functions/v1/meta-publish?code=...  (스레드가 브라우저를 돌려보내는 주소)
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
  needsRefresh,
  parsePageId,
  readTarget,
  resolveRedirectUri,
  sortCuts,
  summarizeApiError,
  threadsAuthorizeUrl,
  truncate,
} from "./lib.ts";
import type { MediaKind } from "./lib.ts";

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
  return [cfg.igToken, cfg.threadsToken, cfg.threadsAppSecret, cfg.notionToken, cfg.storageKey, cfg.adminSecret];
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
        `이미지가 아닌 파일입니다(${detail}). 영상은 '형식'을 영상-세로(9:16)나 영상-가로(16:9)로 두세요.`,
      );
    }
    ext = detected ?? extensionFor(headerType, sourceUrl);
  }
  const contentType = contentTypeFor(ext);

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
    const container = await igPost(cfg, `${cfg.igUserId}/media`, { image_url: imageUrls[0], caption: text });
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
      caption: text,
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
    caption: text,
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
        text,
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
    const container = await threadsPost(cfg, auth, `${uid}/threads`, { media_type: "TEXT", text });
    containerId = container.id;
  } else if (media.kind === "video") {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "VIDEO",
      video_url: media.url,
      text,
    });
    containerId = container.id;
    await waitForThreadsContainer(cfg, auth, containerId);
  } else if (media.urls.length === 1) {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "IMAGE",
      image_url: media.urls[0],
      text,
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

// ---------- 채널 ----------

const CHANNELS = ["인스타그램", "스레드"] as const;
type Channel = typeof CHANNELS[number];

const RESULT_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 상태",
  "스레드": "스레드 상태",
};
const LINK_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 링크",
  "스레드": "스레드 링크",
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

async function claimJob(cfg: Config, pageId: string, channel: Channel): Promise<boolean> {
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

async function releaseJob(cfg: Config, pageId: string, channel: Channel): Promise<void> {
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

/** 컨텐츠 페이지의 '미리보기' 파일. 영상·이미지·카피처럼 한 덩어리인 형식에서 쓴다. */
function previewFiles(props: Json): any[] {
  return (props["미리보기"]?.files ?? []) as any[];
}

/**
 * '형식'에 따라 발행 소스를 정한다.
 * 카드뉴스는 컷 이미지 캐러셀, 이미지는 미리보기 한 장, 영상은 미리보기 영상, 카피는 글만 올린다.
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
): Promise<Json> {
  const page = await notion(cfg, `/pages/${pageId}`);
  const props = (page.properties ?? {}) as Json;

  const requested = requestedChannels(props);
  // only 는 웹훅 주소의 ?channel= 로 지정한 채널이다. 지정이 있으면 그것만 처리한다.
  // 테스트 실행은 요청 채널이 없어도 두 채널 기준으로 점검한다.
  const channels: Channel[] = only !== null
    ? [only]
    : (requested.length > 0 ? requested : (dryRun ? [...CHANNELS] : []));
  if (channels.length === 0) {
    // 버튼 설정이 어긋나면 여기로 온다. 상태를 ⚪ 대기로 바꾸지 않았거나
    // 웹훅 주소에 ?channel=instagram|threads 가 빠진 경우다.
    // 예전에는 아무 흔적 없이 끝나서 원인을 찾기 어려웠다. 이제는 로그와 안내를 남긴다.
    console.log("meta-publish 건너뜀", pageId, "요청된 채널 없음");
    const reason = "요청된 채널이 없어 아무것도 하지 않았습니다. " +
      "배포 버튼이 상태를 ⚪ 대기로 바꾸는지, 웹훅 주소에 ?channel=instagram 또는 ?channel=threads 가 있는지 확인하세요.";
    if (!dryRun && only === null) {
      try {
        await addComment(cfg, pageId, `META 업로드 안내\n\n${reason}`);
      } catch (e) {
        console.error("안내 코멘트 실패", message(e));
      }
    }
    return { ok: true, pageId, skipped: true, reason };
  }

  const format = selectName(props["형식"]);
  const kind = mediaKindFor(format);
  if (kind === null) {
    throw new Error(
      `'형식' 값을 확인하세요. 지금 값: '${format || "비어 있음"}'. 쓸 수 있는 값: ${FORMAT_NAMES.join(" / ")}`,
    );
  }

  const plan = await collectSources(cfg, props, kind);
  const caption = buildCaption(
    richText(props["캡션"]),
    richText(props["대본"]),
    cfg.fixedComment,
  );
  if (caption.trim() === "") {
    throw new Error("캡션과 대본이 모두 비어 있습니다. 발행 문구를 채워주세요.");
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
    return {
      ok: true,
      dryRun: true,
      pageId,
      channels,
      format,
      mediaKind: kind,
      media: uploaded,
      caption,
      captionLength: caption.length,
      threadsAuth: threadsAuthNote,
      note: "테스트 실행입니다. 발행하지 않았고 페이지 상태도 바꾸지 않았습니다.",
    };
  }

  await updatePage(cfg, pageId, {
    "처리 시작 시각": { date: { start: new Date().toISOString() } },
  });
  console.log("meta-publish 시작", pageId, channels.join(","), `${format} · ${kind}`);

  // 파일은 채널마다 공개 URL이 필요하다. 한 번 올려서 요청한 채널이 같이 쓴다.
  let uploaded: MediaPlan | null = null;
  const results: Json = {};
  const failures: string[] = [];
  let succeeded = false;

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
      if (limitError) throw new Error(limitError);

      // 인스타그램은 미디어 없는 발행을 지원하지 않는다. 이 채널만 실패로 남기고 스레드는 계속 간다.
      if (kind === "text" && channel === "인스타그램") {
        throw new Error("'카피' 형식은 미디어가 없어 인스타그램에 발행할 수 없습니다. '스레드 배포'를 쓰세요.");
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
      const patch: Json = {
        [RESULT_PROP[channel]]: { select: { name: STATUS_DONE } },
      };
      if (link) patch[LINK_PROP[channel]] = { url: link };
      await updatePage(cfg, pageId, patch);
      console.log("meta-publish 완료", pageId, channel, link || "(링크 없음)");
      results[channel] = link || "성공";
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
      ? "성공한 채널은 그대로 두었습니다. 실패한 채널만 해당 버튼을 다시 눌러 재시도하세요."
      : "발행된 채널이 없습니다. 원인을 고친 뒤 다시 실행하세요.";
    const detail = maskSecrets(failures.join("\n"), secretsOf(cfg));
    await addComment(cfg, pageId, `META 업로드 실패\n\n${detail}\n\n${note}`);
  }

  return {
    ok: failures.length === 0,
    pageId,
    channels,
    format,
    mediaKind: kind,
    results,
    failures,
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

  // 인증 없이 열리는 GET 경로 두 개.
  // - ?threads_auth=1 : 승인 링크를 보여주는 안내 페이지
  // - ?code=...       : 스레드가 브라우저를 돌려보내는 콜백 (1회용 code 라서 이것만 열어둔다)
  const reqUrl = new URL(req.url);
  if (req.method === "GET" && reqUrl.searchParams.has("threads_auth")) {
    return handleThreadsAuthPage(reqUrl, cfg);
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
      console.log("meta-publish 본문", raw.slice(0, 1500));
      try {
        payload = JSON.parse(raw);
      } catch {
        // 노션 버튼 웹훅 본문 형식은 보장되지 않는다. 못 읽어도 큐 조회로 넘어간다.
        payload = {};
      }
    }
  }

  const dryRun = payload.dryRun === true || reqUrl.searchParams.get("dryRun") === "true";
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
  console.log("meta-publish 대상", pageId || "(없음: 큐 모드)", "채널", hint ?? "(없음)");

  const task: Promise<Json> = pageId !== ""
    ? publishRow(cfg, pageId, dryRun, hint)
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
