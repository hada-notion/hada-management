// META 업로드 자동화 — 노션 웹훅을 받아 인스타그램·스레드에 카드뉴스를 발행한다.
//
// 호출: POST /functions/v1/meta-publish   (헤더 x-admin-key 필요)
// 본문: { "pageUrl": "https://app.notion.com/p/..." }  — pageId/url/id 도 허용
//       본문에 페이지 지정이 없으면 큐 모드로 동작한다. 컨텐츠 DB 에서 '발행 상태' 가
//       '발행 대기' 인 행을 찾아 전부 발행한다. 노션 '게시' 버튼 웹훅이 이 경로를 쓴다.
//
// 스레드 인증 안내: GET /functions/v1/meta-publish?threads_auth=1
// 스레드 인증 콜백: GET /functions/v1/meta-publish?code=...  (스레드가 브라우저를 돌려보내는 주소)
//
// 자세한 배포·설정 방법은 저장소 README 를 따른다.

import {
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
  captionLimitError,
  contentTypeFor,
  detectImageType,
  expiresAtFrom,
  extensionFor,
  hexPreview,
  extractImageUrls,
  needsRefresh,
  normalizeChannels,
  parsePageId,
  PUBLISH_READY_STATUS,
  readTarget,
  resolveRedirectUri,
  shouldPublish,
  sortCuts,
  threadsAuthorizeUrl,
  truncate,
} from "./lib.ts";

const NOTION_BASE = "https://api.notion.com/v1";
const IG_CONTAINER_POLL_ATTEMPTS = 10;
const IG_CONTAINER_POLL_INTERVAL_MS = 3000;
const COMMENT_LIMIT = 1900;

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

function buildConfig() {
  return {
    notionToken: requiredEnv("NOTION_TOKEN"),
    notionVersion: optionalEnv("NOTION_VERSION") || "2022-06-28",
    adminSecret: requiredEnv("ADMIN_SECRET"),
    storageUrl: optionalEnv("SB_URL") || optionalEnv("SUPABASE_URL"),
    storageKey: optionalEnv("SB_SERVICE_ROLE_KEY") || optionalEnv("SUPABASE_SERVICE_ROLE_KEY"),
    bucket: optionalEnv("PUBLISH_BUCKET") || "meta-publish",
    fixedComment: optionalEnv("PUBLISH_FIXED_COMMENT"),
    // 큐 모드에서 조회할 컨텐츠(학원관리) DB.
    contentDataSourceId: optionalEnv("CONTENT_DATA_SOURCE_ID") ||
      "dda5e4d7-d1b1-4c24-a75a-9442ce9664ca",
    contentDatabaseId: optionalEnv("CONTENT_DATABASE_ID") ||
      "ef3145878aba4994af456e11c27c9028",
    metaVersion: optionalEnv("META_GRAPH_VERSION") || "v26.0",
    igApiBase: optionalEnv("IG_API_BASE") || "https://graph.facebook.com",
    igUserId: optionalEnv("IG_USER_ID"),
    igToken: optionalEnv("IG_ACCESS_TOKEN"),
    threadsVersion: optionalEnv("THREADS_GRAPH_VERSION") || "v1.0",
    threadsApiBase: optionalEnv("THREADS_API_BASE") || "https://graph.threads.net",
    threadsUserId: optionalEnv("THREADS_USER_ID"),
    threadsToken: optionalEnv("THREADS_ACCESS_TOKEN"),
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
  if (!res.ok) throw new Error(`노션 API ${res.status} (${path}): ${text.slice(0, 400)}`);
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

async function setPublishStatus(cfg: Config, pageId: string, status: string): Promise<void> {
  await updatePage(cfg, pageId, { "발행 상태": { select: { name: status } } });
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

// ---------- 이미지 공개 호스팅 ----------

async function uploadImage(cfg: Config, pageId: string, index: number, sourceUrl: string): Promise<string> {
  if (!cfg.storageUrl || !cfg.storageKey) {
    throw new Error("이미지 저장소 설정(SB_URL, SB_SERVICE_ROLE_KEY)이 없습니다.");
  }

  const download = await fetch(sourceUrl);
  if (!download.ok) throw new Error(`이미지 내려받기 실패(${download.status})`);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("이미지 파일이 비어 있습니다.");

  // 노션은 업로드 파일을 binary/octet-stream 으로 돌려주기도 한다.
  // 그래서 content-type 을 믿지 않고 파일 앞바이트로 실제 형식을 판별한다.
  const headerType = (download.headers.get("content-type") ?? "").toLowerCase().split(";")[0].trim();
  const detected = detectImageType(bytes);
  if (!detected && !headerType.startsWith("image/")) {
    throw new Error(
      `이미지가 아닌 파일입니다(content-type: ${headerType || "없음"}, 앞바이트: ${
        hexPreview(bytes)
      }, 크기: ${bytes.byteLength}바이트). 영상이나 다른 형식은 아직 발행할 수 없습니다.`,
    );
  }
  const ext = detected ?? extensionFor(headerType, sourceUrl);
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
    const detail = await upload.text();
    throw new Error(`이미지 업로드 실패(${upload.status}): ${detail.slice(0, 300)}`);
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
    const detail = await res.text();
    throw new Error(`토큰 저장소 조회 실패(${res.status}): ${detail.slice(0, 200)}`);
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
    const detail = await res.text();
    throw new Error(`토큰 저장 실패(${res.status}): ${detail.slice(0, 200)}`);
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
  const res = await fetch(`${cfg.igApiBase}/${cfg.metaVersion}/${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${cfg.igToken}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`인스타 API ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const igPost = (cfg: Config, path: string, params: Json) =>
  igRequest(cfg, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(params),
  });

const igGet = (cfg: Config, path: string) => igRequest(cfg, path);

async function waitForIgContainer(cfg: Config, containerId: string): Promise<void> {
  for (let attempt = 0; attempt < IG_CONTAINER_POLL_ATTEMPTS; attempt++) {
    const info = await igGet(cfg, `${containerId}?fields=status_code,status`);
    const status = info.status_code ?? info.status;
    if (status === "FINISHED" || status === "PUBLISHED") return;
    if (status === "ERROR" || status === "EXPIRED") {
      throw new Error(`인스타 컨테이너 처리 실패: ${JSON.stringify(info).slice(0, 300)}`);
    }
    await sleep(IG_CONTAINER_POLL_INTERVAL_MS);
  }
  throw new Error("인스타 컨테이너 처리 대기 시간이 초과되었습니다.");
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
      lastError = `스레드 OAuth ${res.status}: ${text.slice(0, 300)}`;
    } catch (e) {
      lastError = message(e);
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
    return { userId: cfg.threadsUserId, token: cfg.threadsToken };
  }

  const now = Date.now();
  const expiresMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  if (Number.isFinite(expiresMs) && expiresMs <= now) {
    throw new Error("스레드 토큰이 만료되었습니다. 브라우저에서 스레드 인증을 다시 진행하세요.");
  }

  let token = row.access_token;
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

  return { userId: row.user_id ?? cfg.threadsUserId, token };
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
  if (!res.ok) throw new Error(`스레드 API ${res.status}: ${text.slice(0, 400)}`);
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

async function publishThreads(
  cfg: Config,
  auth: ThreadsAuth,
  imageUrls: string[],
  caption: string,
): Promise<string> {
  const text = truncate(caption, THREADS_TEXT_LIMIT);
  const uid = auth.userId;

  let containerId: string;
  if (imageUrls.length === 1) {
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "IMAGE",
      image_url: imageUrls[0],
      text,
    });
    containerId = container.id;
  } else {
    assertCarouselSize(imageUrls.length, THREADS_CAROUSEL_MIN, THREADS_CAROUSEL_MAX, "스레드");
    const children: string[] = [];
    for (const url of imageUrls) {
      const child = await threadsPost(cfg, auth, `${uid}/threads`, {
        media_type: "IMAGE",
        image_url: url,
        is_carousel_item: "true",
      });
      children.push(child.id);
    }
    const container = await threadsPost(cfg, auth, `${uid}/threads`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      text,
    });
    containerId = container.id;
  }

  const published = await threadsPost(cfg, auth, `${uid}/threads_publish`, { creation_id: containerId });
  const info = await threadsGet(cfg, auth, `${published.id}?fields=permalink`);
  return info.permalink ?? "";
}

// ---------- 진입점 ----------

const QUEUE_SCAN_ATTEMPTS = 4;
const QUEUE_SCAN_INTERVAL_MS = 5000;
const QUEUE_TIME_BUDGET_MS = 100000;

// 노션 버튼 웹훅은 페이지 URL 을 실어 보낼 수 없다(보낼 수 있는 건 DB 속성뿐).
// 그래서 '발행 대기' 행을 서버가 직접 조회한다. 대기 = 발행 큐.
async function queryQueuedPageIds(cfg: Config): Promise<string[]> {
  const filter = { property: "발행 상태", select: { equals: PUBLISH_READY_STATUS } };
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

// 버튼 액션 순서가 어긋나 웹훅이 먼저 도착하면 그 시점엔 아직 '발행 대기' 가 아니다.
// 몇 초 간격으로 몇 번 더 확인해서 그 경우를 흡수한다.
async function findQueuedPageIds(cfg: Config): Promise<string[]> {
  for (let attempt = 1; attempt <= QUEUE_SCAN_ATTEMPTS; attempt++) {
    const ids = await queryQueuedPageIds(cfg);
    if (ids.length > 0) return ids;
    if (attempt < QUEUE_SCAN_ATTEMPTS) await sleep(QUEUE_SCAN_INTERVAL_MS);
  }
  return [];
}

async function publishOnePage(
  cfg: Config,
  pageId: string,
  dryRun: boolean,
): Promise<{ body: Json; status: number }> {
  try {
    const page = await notion(cfg, `/pages/${pageId}`);
    const props = (page.properties ?? {}) as Json;

    const currentStatus = selectName(props["발행 상태"]);
    if (!dryRun && !shouldPublish(currentStatus)) {
      return {
        status: 200,
        body: {
          ok: true,
          pageId,
          skipped: true,
          reason: currentStatus === ""
            ? "발행 상태가 비어 있습니다. '발행 대기'일 때만 발행합니다."
            : `발행 상태가 '${currentStatus}'입니다. '발행 대기'일 때만 발행합니다.`,
        },
      };
    }

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

    const channels = normalizeChannels(multiSelectNames(props["발행 채널"]));
    const caption = buildCaption(
      richText(props["캡션"]),
      richText(props["대본"]),
      cfg.fixedComment,
    );
    if (caption.trim() === "") {
      throw new Error("캡션과 대본이 모두 비어 있습니다. 발행 문구를 채워주세요.");
    }

    // 한도 초과는 이미지 업로드와 인스타그램 발행보다 앞에서 막는다.
    // 뒤에서 막으면 한 채널만 올라간 반쪽 상태가 된다.
    const limitError = captionLimitError(caption, channels);
    if (limitError) throw new Error(limitError);

    if (!dryRun) await setPublishStatus(cfg, pageId, "발행 중");

    const imageUrls: string[] = [];
    for (let index = 0; index < sourceUrls.length; index++) {
      imageUrls.push(await uploadImage(cfg, pageId, index, sourceUrls[index]));
    }

    let threadsAuth: ThreadsAuth | null = null;
    let threadsAuthNote = "발행 채널에 스레드가 없습니다.";
    if (channels.includes("스레드")) {
      try {
        threadsAuth = await resolveThreadsAuth(cfg);
        threadsAuthNote = `정상 (사용자 ID ${threadsAuth.userId})`;
      } catch (e) {
        threadsAuthNote = message(e);
      }
    }

    if (dryRun) {
      return {
        status: 200,
        body: {
          ok: true,
          dryRun: true,
          pageId,
          status: currentStatus,
          channels,
          imageCount: imageUrls.length,
          images: imageUrls,
          caption,
          captionLength: caption.length,
          threadsAuth: threadsAuthNote,
          note: "테스트 실행입니다. 발행하지 않았고 페이지 상태도 바꾸지 않았습니다.",
        },
      };
    }

    const results: Json = {};
    const failures: string[] = [];

    if (channels.includes("인스타그램")) {
      try {
        results.instagram = await publishInstagram(cfg, imageUrls, caption);
      } catch (e) {
        failures.push(`인스타그램 — ${message(e)}`);
      }
    }
    if (channels.includes("스레드")) {
      try {
        if (!threadsAuth) throw new Error(threadsAuthNote);
        results.threads = await publishThreads(cfg, threadsAuth, imageUrls, caption);
      } catch (e) {
        failures.push(`스레드 — ${message(e)}`);
      }
    }

    const properties: Json = {
      "발행 상태": { select: { name: failures.length === 0 ? "발행 완료" : "발행 실패" } },
    };
    if (results.instagram) properties["인스타그램 링크"] = { url: results.instagram };
    if (results.threads) properties["스레드 링크"] = { url: results.threads };
    if (failures.length === 0) {
      properties["date:발행 시각:start"] = new Date().toISOString();
      properties["date:발행 시각:is_datetime"] = 1;
    }
    await updatePage(cfg, pageId, properties);

    if (failures.length > 0) {
      const note = results.instagram || results.threads
        ? "일부 채널만 발행되었습니다. 다시 실행하면 이미 올라간 채널에 중복 게시되니, '발행 채널'을 실패한 채널만 남기고 재시도하세요."
        : "발행된 채널이 없습니다. 원인을 고친 뒤 다시 실행하세요.";
      await addComment(cfg, pageId, `META 업로드 실패\n\n${failures.join("\n")}\n\n${note}`);
    }

    return {
      status: 200,
      body: {
        ok: failures.length === 0,
        pageId,
        imageCount: imageUrls.length,
        channels,
        results,
        failures,
      },
    };
  } catch (e) {
    const detail = message(e);
    if (dryRun) {
      return { status: 500, body: { ok: false, dryRun: true, pageId, error: detail } };
    }
    try {
      await setPublishStatus(cfg, pageId, "발행 실패");
    } catch {
      // 상태 변경까지 실패하면 코멘트로만 남긴다.
    }
    try {
      await addComment(cfg, pageId, `META 업로드 실패\n\n${detail}`);
    } catch {
      // 코멘트 실패는 무시하고 응답으로 원인을 돌려준다.
    }
    return { status: 500, body: { ok: false, pageId, error: detail } };
  }
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
      try {
        payload = JSON.parse(raw);
      } catch {
        // 노션 버튼 웹훅 본문 형식은 보장되지 않는다. 못 읽어도 큐 조회로 넘어간다.
        payload = {};
      }
    }
  }

  // 테스트 실행: 이미지 수집과 Storage 업로드까지만 하고 발행하지 않는다.
  const dryRun = payload.dryRun === true || reqUrl.searchParams.get("dryRun") === "true";
  const target = readTarget(payload, req.url).trim();

  // 페이지를 지정한 호출(수동 테스트, 재시도)은 그 페이지만 처리한다.
  if (target !== "") {
    let pageId = "";
    try {
      pageId = parsePageId(target);
    } catch (e) {
      return json({ ok: false, error: message(e) }, 400);
    }
    const result = await publishOnePage(cfg, pageId, dryRun);
    return json(result.body, result.status);
  }

  // 큐 모드: 페이지 지정 없이 들어온 호출(노션 '게시' 버튼 웹훅)은 대기 중인 행을 처리한다.
  const startedAt = Date.now();
  const queued = await findQueuedPageIds(cfg);
  if (queued.length === 0) {
    return json({
      ok: true,
      queue: true,
      dryRun,
      requested: 0,
      processed: 0,
      results: [],
      remaining: [],
      message: "발행 대기 상태인 컨텐츠가 없습니다.",
    });
  }

  const results: Json[] = [];
  const remaining: string[] = [];
  for (let index = 0; index < queued.length; index++) {
    // 한 번의 호출이 함수 실행 시간 한도를 넘지 않도록 남은 행은 다음 호출로 미룬다.
    if (index > 0 && Date.now() - startedAt > QUEUE_TIME_BUDGET_MS) {
      remaining.push(queued[index]);
      continue;
    }
    const result = await publishOnePage(cfg, queued[index], dryRun);
    results.push({ pageId: queued[index], ...result.body });
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
    body.note = "처리 시간이 부족해 남은 행은 그대로 두었습니다. '게시' 버튼을 한 번 더 눌러주세요.";
  }
  return json(body, 200);
});
