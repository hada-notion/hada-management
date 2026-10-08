// META 업로드 자동화 — 노션 자동화 웹훅을 받아 인스타그램·스레드에 카드뉴스를 발행한다.
//
// 호출: POST /functions/v1/meta-publish   (헤더 x-admin-key 필요)
// 본문: { "pageUrl": "https://app.notion.com/p/..." }  — pageId/url/id 도 허용
//
// 자세한 배포·설정 방법은 저장소 README 를 따른다.

import {
  IG_CAROUSEL_MAX,
  IG_CAROUSEL_MIN,
  THREADS_CAROUSEL_MAX,
  THREADS_CAROUSEL_MIN,
  assertCarouselSize,
  buildCaption,
  extensionFor,
  extractImageUrls,
  normalizeChannels,
  parsePageId,
  shouldPublish,
  sortCuts,
  truncate,
} from "./lib.ts";

const NOTION_BASE = "https://api.notion.com/v1";
const IG_CAPTION_LIMIT = 2200;
const THREADS_TEXT_LIMIT = 500;
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
    metaVersion: optionalEnv("META_GRAPH_VERSION") || "v26.0",
    igApiBase: optionalEnv("IG_API_BASE") || "https://graph.facebook.com",
    igUserId: optionalEnv("IG_USER_ID"),
    igToken: optionalEnv("IG_ACCESS_TOKEN"),
    threadsVersion: optionalEnv("THREADS_GRAPH_VERSION") || "v1.0",
    threadsApiBase: optionalEnv("THREADS_API_BASE") || "https://graph.threads.net",
    threadsUserId: optionalEnv("THREADS_USER_ID"),
    threadsToken: optionalEnv("THREADS_ACCESS_TOKEN"),
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
  const contentType = download.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new Error(`이미지가 아닌 파일입니다(content-type: ${contentType || "없음"}). 영상 발행은 아직 지원하지 않습니다.`);
  }
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("이미지 파일이 비어 있습니다.");

  const path = `${pageId}/${String(index + 1).padStart(2, "0")}.${extensionFor(contentType, sourceUrl)}`;
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

// ---------- 스레드 ----------

async function threadsRequest(cfg: Config, path: string, init: RequestInit = {}): Promise<Json> {
  if (!cfg.threadsUserId || !cfg.threadsToken) {
    throw new Error("스레드 설정(THREADS_USER_ID, THREADS_ACCESS_TOKEN)이 없습니다.");
  }
  const res = await fetch(`${cfg.threadsApiBase}/${cfg.threadsVersion}/${path}`, {
    ...init,
    headers: { "Authorization": `Bearer ${cfg.threadsToken}`, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`스레드 API ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

const threadsPost = (cfg: Config, path: string, params: Json) =>
  threadsRequest(cfg, path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: formBody(params),
  });

const threadsGet = (cfg: Config, path: string) => threadsRequest(cfg, path);

async function publishThreads(cfg: Config, imageUrls: string[], caption: string): Promise<string> {
  const text = truncate(caption, THREADS_TEXT_LIMIT);

  let containerId: string;
  if (imageUrls.length === 1) {
    const container = await threadsPost(cfg, `${cfg.threadsUserId}/threads`, {
      media_type: "IMAGE",
      image_url: imageUrls[0],
      text,
    });
    containerId = container.id;
  } else {
    assertCarouselSize(imageUrls.length, THREADS_CAROUSEL_MIN, THREADS_CAROUSEL_MAX, "스레드");
    const children: string[] = [];
    for (const url of imageUrls) {
      const child = await threadsPost(cfg, `${cfg.threadsUserId}/threads`, {
        media_type: "IMAGE",
        image_url: url,
        is_carousel_item: "true",
      });
      children.push(child.id);
    }
    const container = await threadsPost(cfg, `${cfg.threadsUserId}/threads`, {
      media_type: "CAROUSEL",
      children: children.join(","),
      text,
    });
    containerId = container.id;
  }

  const published = await threadsPost(cfg, `${cfg.threadsUserId}/threads_publish`, { creation_id: containerId });
  const info = await threadsGet(cfg, `${published.id}?fields=permalink`);
  return info.permalink ?? "";
}

// ---------- 진입점 ----------

function readTarget(payload: Json, requestUrl: string): string {
  const url = new URL(requestUrl);
  return String(
    payload.pageUrl ??
      payload.pageId ??
      payload.url ??
      payload.id ??
      payload.page?.url ??
      url.searchParams.get("pageUrl") ??
      url.searchParams.get("pageId") ??
      "",
  );
}

Deno.serve(async (req) => {
  let cfg: Config;
  try {
    cfg = buildConfig();
  } catch (e) {
    return json({ ok: false, error: message(e) }, 500);
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
        return json({ ok: false, error: "본문을 JSON으로 읽지 못했습니다." }, 400);
      }
    }
  }

  let pageId = "";
  try {
    pageId = parsePageId(readTarget(payload, req.url));
  } catch (e) {
    return json({ ok: false, error: message(e) }, 400);
  }

  try {
    const page = await notion(cfg, `/pages/${pageId}`);
    const props = (page.properties ?? {}) as Json;

    const currentStatus = selectName(props["발행 상태"]);
    if (!shouldPublish(currentStatus)) {
      return json({
        ok: true,
        pageId,
        skipped: true,
        reason: currentStatus === ""
          ? "발행 상태가 비어 있습니다. '발행 대기'일 때만 발행합니다."
          : `발행 상태가 '${currentStatus}'입니다. '발행 대기'일 때만 발행합니다.`,
      });
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

    await setPublishStatus(cfg, pageId, "발행 중");

    const imageUrls: string[] = [];
    for (let index = 0; index < sourceUrls.length; index++) {
      imageUrls.push(await uploadImage(cfg, pageId, index, sourceUrls[index]));
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
        results.threads = await publishThreads(cfg, imageUrls, caption);
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

    return json({
      ok: failures.length === 0,
      pageId,
      imageCount: imageUrls.length,
      channels,
      results,
      failures,
    });
  } catch (e) {
    const detail = message(e);
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
    return json({ ok: false, pageId, error: detail }, 500);
  }
});
