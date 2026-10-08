// META 업로드 자동화 — 노션 웹훅을 받아 인스타그램·스레드에 카드뉴스를 발행한다.
//
// 호출: POST /functions/v1/meta-publish   (헤더 x-admin-key 필요)
//   본문에 페이지 지정(pageUrl/pageId/url/id)이 있으면 그 페이지만 처리하고 결과를 그대로 돌려준다.
//   지정이 없으면 큐 모드다. '인스타그램 작업중'·'스레드 작업중' 체크가 켜진 행을 찾아 처리한다.
//
// 큐 모드는 즉시 202(접수)로 응답하고 실제 발행은 백그라운드에서 이어간다.
// 노션 버튼 웹훅은 10초 안에 응답이 와야 하는데 발행은 그보다 오래 걸리기 때문이다.
// 실제 결과는 페이지의 '발행 상태'·'실시간 처리 상태'·'인스타그램 상태'·'스레드 상태'로 확인한다.
// 테스트처럼 결과를 바로 보고 싶으면 ?wait=1 을 붙인다.
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
  parsePageId,
  readTarget,
  resolveRedirectUri,
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

// ---------- 채널 ----------

const CHANNELS = ["인스타그램", "스레드"] as const;
type Channel = typeof CHANNELS[number];

const WORK_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 작업중",
  "스레드": "스레드 작업중",
};
const RESULT_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 상태",
  "스레드": "스레드 상태",
};
const LINK_PROP: Record<Channel, string> = {
  "인스타그램": "인스타그램 링크",
  "스레드": "스레드 링크",
};

function isChecked(prop: Json | undefined): boolean {
  return prop?.checkbox === true;
}

/** 지금 작업중 체크가 켜져 있는 채널. 버튼이 켜고 함수가 끝날 때 끈다. */
function workingChannels(props: Json): Channel[] {
  return CHANNELS.filter((channel) => isChecked(props[WORK_PROP[channel]]));
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

const QUEUE_SCAN_ATTEMPTS = 5;
const QUEUE_SCAN_INTERVAL_MS = 4000;
const QUEUE_TIME_BUDGET_MS = 110000;

async function queryQueuedPageIds(cfg: Config): Promise<string[]> {
  const filter = {
    or: CHANNELS.map((channel) => ({
      property: WORK_PROP[channel],
      checkbox: { equals: true },
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

// 버튼 액션 순서가 어긋나 웹훅이 먼저 도착하면 그 시점엔 아직 체크가 안 켜져 있다.
// 몇 초 간격으로 몇 번 더 확인해서 그 경우를 흡수한다. 접수 응답을 먼저 보내므로 오래 기다려도 된다.
async function findQueuedPageIds(cfg: Config): Promise<string[]> {
  for (let attempt = 1; attempt <= QUEUE_SCAN_ATTEMPTS; attempt++) {
    const ids = await queryQueuedPageIds(cfg);
    if (ids.length > 0) return ids;
    if (attempt < QUEUE_SCAN_ATTEMPTS) await sleep(QUEUE_SCAN_INTERVAL_MS);
  }
  return [];
}

// ---------- 발행 ----------

async function collectImageUrls(cfg: Config, props: Json): Promise<string[]> {
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

async function publishRow(cfg: Config, pageId: string, dryRun: boolean): Promise<Json> {
  const page = await notion(cfg, `/pages/${pageId}`);
  const props = (page.properties ?? {}) as Json;

  const working = workingChannels(props);
  // 테스트 실행은 요청 채널이 없어도 두 채널 기준으로 점검한다.
  const channels: Channel[] = working.length > 0 ? working : (dryRun ? [...CHANNELS] : []);
  if (channels.length === 0) {
    return {
      ok: true,
      pageId,
      skipped: true,
      reason: "작업중 체크가 켜져 있지 않습니다. '인스타그램 배포'나 '스레드 배포' 버튼을 누르세요.",
    };
  }

  const sourceUrls = await collectImageUrls(cfg, props);
  const caption = buildCaption(
    richText(props["캡션"]),
    richText(props["대본"]),
    cfg.fixedComment,
  );
  if (caption.trim() === "") {
    throw new Error("캡션과 대본이 모두 비어 있습니다. 발행 문구를 채워주세요.");
  }

  // 테스트 실행: 이미지 업로드까지만 하고 발행도 상태 변경도 하지 않는다.
  if (dryRun) {
    const imageUrls: string[] = [];
    for (let index = 0; index < sourceUrls.length; index++) {
      imageUrls.push(await uploadImage(cfg, pageId, index, sourceUrls[index]));
    }
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
      imageCount: imageUrls.length,
      images: imageUrls,
      caption,
      captionLength: caption.length,
      threadsAuth: threadsAuthNote,
      note: "테스트 실행입니다. 발행하지 않았고 페이지 상태도 바꾸지 않았습니다.",
    };
  }

  await updatePage(cfg, pageId, {
    "발행 상태": { select: { name: "발행 중" } },
    "date:처리 시작 시각:start": new Date().toISOString(),
    "date:처리 시작 시각:is_datetime": 1,
  });

  // 이미지는 채널마다 공개 URL이 필요하다. 한 번 올려서 요청한 채널이 같이 쓴다.
  let imageUrls: string[] | null = null;
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
        [RESULT_PROP[channel]]: { select: { name: "진행중" } },
      });

      // 한도 초과는 그 채널의 이미지 업로드와 발행보다 앞에서 막는다.
      const limitError = captionLimitError(caption, [channel]);
      if (limitError) throw new Error(limitError);

      if (!imageUrls) {
        const uploaded: string[] = [];
        for (let index = 0; index < sourceUrls.length; index++) {
          uploaded.push(await uploadImage(cfg, pageId, index, sourceUrls[index]));
        }
        imageUrls = uploaded;
      }

      let link = "";
      if (channel === "인스타그램") {
        link = await publishInstagram(cfg, imageUrls, caption);
      } else {
        link = await publishThreads(cfg, await resolveThreadsAuth(cfg), imageUrls, caption);
      }

      succeeded = true;
      const patch: Json = {
        [RESULT_PROP[channel]]: { select: { name: "성공" } },
        [WORK_PROP[channel]]: { checkbox: false },
      };
      if (link) patch[LINK_PROP[channel]] = { url: link };
      await updatePage(cfg, pageId, patch);
      results[channel] = link || "성공";
    } catch (e) {
      const detail = message(e);
      failures.push(`${channel} — ${detail}`);
      results[channel] = detail;
      try {
        await updatePage(cfg, pageId, {
          [RESULT_PROP[channel]]: { select: { name: "실패" } },
          [WORK_PROP[channel]]: { checkbox: false },
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
      "date:발행 시각:start": new Date().toISOString(),
      "date:발행 시각:is_datetime": 1,
    });
  }

  // 다시 읽어서 판단한다. 다른 실행이 아직 붙잡고 있는 채널이 남아 있으면 전체 상태를 끝내지 않는다.
  const after = ((await notion(cfg, `/pages/${pageId}`)).properties ?? {}) as Json;
  const stillWorking = workingChannels(after);
  const states = CHANNELS.map((channel) => selectName(after[RESULT_PROP[channel]]));

  const summary: Json = {};
  if (stillWorking.length > 0) {
    summary["발행 상태"] = { select: { name: "발행 중" } };
  } else if (failures.length > 0 || states.includes("실패")) {
    summary["발행 상태"] = { select: { name: "발행 실패" } };
  } else {
    summary["발행 상태"] = { select: { name: "발행 완료" } };
    summary["마지막 오류"] = { rich_text: [] };
  }
  await updatePage(cfg, pageId, summary);

  if (failures.length > 0) {
    const note = succeeded
      ? "성공한 채널은 그대로 두었습니다. 실패한 채널만 해당 버튼을 다시 눌러 재시도하세요."
      : "발행된 채널이 없습니다. 원인을 고친 뒤 다시 실행하세요.";
    await addComment(cfg, pageId, `META 업로드 실패\n\n${failures.join("\n")}\n\n${note}`);
  }

  return {
    ok: failures.length === 0,
    pageId,
    channels,
    imageCount: imageUrls ? imageUrls.length : 0,
    results,
    failures,
    status: selectName(after["발행 상태"]),
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
      message: "작업중 체크가 켜진 컨텐츠가 없습니다.",
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

  const dryRun = payload.dryRun === true || reqUrl.searchParams.get("dryRun") === "true";
  const wait = reqUrl.searchParams.get("wait") === "1";
  const target = readTarget(payload, req.url);

  let pageId = "";
  if (target !== "") {
    try {
      pageId = parsePageId(target);
    } catch (e) {
      return json({ ok: false, error: message(e) }, 400);
    }
  }

  const task: Promise<Json> = pageId !== ""
    ? publishRow(cfg, pageId, dryRun)
    : runQueue(cfg, dryRun);

  // 페이지를 지정한 수동 호출이나 ?wait=1 은 결과를 그대로 돌려준다.
  if (pageId !== "" || wait) {
    try {
      const body = await task;
      return json(body, body.ok === false ? 500 : 200);
    } catch (e) {
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
      message: "접수했습니다. 실제 결과는 페이지의 발행 상태와 실시간 처리 상태로 확인하세요.",
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
