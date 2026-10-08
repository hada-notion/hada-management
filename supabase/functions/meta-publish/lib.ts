// 순수 로직만 둔다. 네트워크 호출이 없어야 deno test 로 검증할 수 있다.

export const IG_CAROUSEL_MIN = 2;
export const IG_CAROUSEL_MAX = 10;
export const THREADS_CAROUSEL_MIN = 2;
export const THREADS_CAROUSEL_MAX = 20;

export type Cut = {
  pageId: string;
  order: number;
  imageUrls: string[];
};

export type NotionFile = {
  type?: string;
  name?: string;
  file?: { url?: string };
  external?: { url?: string };
};

/** 노션 페이지 주소나 ID에서 32자리 페이지 ID를 뽑는다. */
export function parsePageId(input: string): string {
  const raw = (input ?? "").trim();
  if (raw === "") throw new Error("페이지 주소나 ID가 비어 있습니다.");

  const uuid = raw.match(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/,
  );
  if (uuid) return uuid[0].replace(/-/g, "").toLowerCase();

  const hex = raw.replace(/-/g, "").match(/[0-9a-fA-F]{32}/g);
  if (hex && hex.length > 0) return hex[hex.length - 1].toLowerCase();

  throw new Error(`페이지 주소에서 ID를 찾지 못했습니다: ${raw}`);
}

/** 컷 순서 오름차순으로 정렬한다. 순서가 같으면 페이지 ID로 안정 정렬한다. */
export function sortCuts<T extends { order: number; pageId: string }>(cuts: T[]): T[] {
  return [...cuts].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.pageId < b.pageId ? -1 : 1;
  });
}

/** 캡션을 만든다. 캡션이 비어 있으면 대본을 쓰고, 끝에 고정 멘트를 붙인다. */
export function buildCaption(primary: string, fallback: string, fixedComment: string): string {
  const p = (primary ?? "").trim();
  const f = (fallback ?? "").trim();
  const base = p !== "" ? p : f;
  const fixed = (fixedComment ?? "").trim();
  if (fixed === "") return base;
  if (base === "") return fixed;
  return `${base}\n\n${fixed}`;
}

export const IG_CAPTION_LIMIT = 2200;
export const THREADS_TEXT_LIMIT = 500;

/** 채널별 캡션 한도. 넘으면 발행하지 않고 멈춘다. */
export const CAPTION_LIMITS: Record<string, number> = {
  "인스타그램": IG_CAPTION_LIMIT,
  "스레드": THREADS_TEXT_LIMIT,
};

/**
 * 발행 대상 채널 중 한도를 넘은 것이 있으면 사유를 돌려준다. 없으면 null.
 * 잘림 판정과 같은 기준(문자열 길이)으로 세어, 잘릴 조건이면 발행 전에 멈춘다.
 */
export function captionLimitError(caption: string, channels: string[]): string | null {
  for (const channel of channels) {
    const limit = CAPTION_LIMITS[channel];
    if (limit === undefined) continue;
    if (caption.length > limit) {
      return `${channel} 한도(${limit}자)를 넘었습니다. 현재 ${caption.length}자, ${
        caption.length - limit
      }자를 줄여야 합니다.`;
    }
  }
  return null;
}

/** 스레드 토큰은 60일짜리라, 마지막 갱신 후 이 일수가 지나면 미리 갱신한다. */
export const THREADS_REFRESH_AFTER_DAYS = 30;

export const THREADS_AUTHORIZE_SCOPES = ["threads_basic", "threads_content_publish"];

/** 스레드 승인 화면 주소를 만든다. 브라우저에서 열면 code 를 받아 되돌아온다. */
export function threadsAuthorizeUrl(appId: string, redirectUri: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: (appId ?? "").trim(),
    redirect_uri: (redirectUri ?? "").trim(),
    scope: scopes.join(","),
    response_type: "code",
  });
  return `https://threads.com/oauth/authorize?${params.toString()}`;
}

/** 마지막 갱신 후 refreshAfterDays 일이 지났으면 true. 시각을 못 읽으면 갱신하지 않는다. */
export function needsRefresh(updatedAtMs: number, nowMs: number, refreshAfterDays: number): boolean {
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) return false;
  const elapsed = nowMs - updatedAtMs;
  if (elapsed < 0) return false;
  return elapsed >= refreshAfterDays * 24 * 60 * 60 * 1000;
}

/** 토큰 응답의 expires_in(초)으로 만료 시각을 계산한다. 값이 없으면 null. */
export function expiresAtFrom(nowMs: number, expiresInSeconds: unknown): string | null {
  const seconds = typeof expiresInSeconds === "number" ? expiresInSeconds : Number(expiresInSeconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(nowMs + seconds * 1000).toISOString();
}

/**
 * 스레드가 되돌아올 주소를 정한다.
 * Supabase 함수는 요청 주소를 내부 주소(http://ref.supabase.co/함수이름)로 넘겨주기 때문에
 * 그대로 쓰면 스레드가 거부한다. 공개 주소(SB_URL)에 함수 경로를 붙여 만든다.
 * THREADS_REDIRECT_URI 가 있으면 그 값을 그대로 쓴다.
 */
export function resolveRedirectUri(requestUrl: string, publicBaseUrl: string, override: string): string {
  const trimmed = (override ?? "").trim();
  if (trimmed !== "") return trimmed.replace(/\/+$/, "");

  const parsed = new URL(requestUrl);
  const base = (publicBaseUrl ?? "").trim().replace(/\/+$/, "");
  const path = parsed.pathname.replace(/\/+$/, "");

  if (path.startsWith("/functions/v1/")) return `${base}${path}`;
  if (base !== "") return `${base}/functions/v1${path}`;
  return `https://${parsed.host}${path}`;
}

/**
 * 요청에서 발행 대상 페이지를 뽑는다. 지정이 없으면 빈 문자열을 돌려주고,
 * 호출부는 그때 큐 모드(⚪ 대기 행 조회)로 넘어간다.
 */
export function readTarget(payload: Record<string, any>, requestUrl: string): string {
  let params: URLSearchParams;
  try {
    params = new URL(requestUrl).searchParams;
  } catch {
    params = new URLSearchParams();
  }
  const value = payload.pageUrl ??
    payload.pageId ??
    payload.url ??
    payload.id ??
    payload.page?.url ??
    params.get("pageUrl") ??
    params.get("pageId") ??
    "";
  return String(value).trim();
}

/**
 * 웹훅 본문 어디에 있든 노션 페이지 주소처럼 생긴 값을 모은다.
 * 노션 버튼 웹훅의 본문 키 이름이 화면마다 달라질 수 있어서 이름에 기대지 않는다.
 */
export function collectPageCandidates(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (
      /notion\.(so|com)\//i.test(text) ||
      /^[0-9a-f]{32}$/i.test(text) ||
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)
    ) {
      out.push(text);
    }
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPageCandidates(item, out);
    return out;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectPageCandidates(item, out);
    }
  }
  return out;
}

/** URL 의 channel 값으로 채널을 알아낸다. 없으면 null. */
export function channelHint(value: string | null): string | null {
  const key = (value ?? "").trim().toLowerCase();
  if (key === "") return null;
  if (["instagram", "ig", "인스타그램", "인스타"].includes(key)) return "인스타그램";
  if (["threads", "thread", "스레드"].includes(key)) return "스레드";
  return null;
}

export function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

export function assertCarouselSize(count: number, min: number, max: number, label: string): void {
  if (count < min) {
    throw new Error(`${label}: 이미지가 ${count}장입니다. 캐러셀은 최소 ${min}장이 필요합니다.`);
  }
  if (count > max) {
    throw new Error(
      `${label}: 이미지가 ${count}장입니다. 캐러셀은 최대 ${max}장까지입니다. 분할 규칙이 아직 정해지지 않았습니다.`,
    );
  }
}

/** 영상 확장자는 제외한다. 이미지 여부의 최종 판단은 업로드 시 content-type으로 한 번 더 한다. */
export function isImageUrl(url: string, name?: string): boolean {
  const target = (name && name.trim() !== "" ? name : url).toLowerCase().split("?")[0];
  return !/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(target);
}

export function extractImageUrls(files: NotionFile[] | undefined): string[] {
  const urls: string[] = [];
  for (const f of files ?? []) {
    const url = f?.file?.url ?? f?.external?.url ?? "";
    if (url === "") continue;
    if (isImageUrl(url, f?.name)) urls.push(url);
  }
  return urls;
}

export type ImageExt = "png" | "jpg" | "webp" | "gif";

/**
 * 파일 앞머리 바이트로 실제 이미지 형식을 판별한다.
 * 노션은 업로드된 파일을 binary/octet-stream 으로 돌려주기도 해서 content-type 만으로는 부족하다.
 */
export function detectImageType(bytes: Uint8Array): ImageExt | null {
  const b = bytes;
  if (
    b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (
    b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "webp";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  return null;
}

/** 확장자에 맞는 content-type. 메타가 파일 형식을 판단할 때 쓴다. */
export function contentTypeFor(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "jpg") return "image/jpeg";
  if (ext === "webp") return "image/webp";
  if (ext === "gif") return "image/gif";
  if (ext === "mp4") return "video/mp4";
  if (ext === "mov") return "video/quicktime";
  if (ext === "webm") return "video/webm";
  return "application/octet-stream";
}

/** 실패했을 때 원인을 남기기 위한 앞바이트 표시. */
export function hexPreview(bytes: Uint8Array, limit = 8): string {
  return Array.from(bytes.slice(0, limit))
    .map((n) => n.toString(16).padStart(2, "0"))
    .join(" ");
}

export function extensionFor(contentType: string, url: string): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  if (type.includes("mp4")) return "mp4";
  if (type.includes("quicktime") || type.includes("mov")) return "mov";
  if (type.includes("webm")) return "webm";
  const match = url.toLowerCase().split("?")[0].match(/\.(png|jpe?g|webp|gif|mp4|mov|webm)$/);
  return match ? match[1].replace("jpeg", "jpg") : "png";
}

export type VideoExt = "mp4" | "webm";

/** 영상도 content-type 을 믿지 않고 앞바이트로 판별한다. 노션은 octet-stream 으로 돌려주기도 한다. */
export function detectVideoType(bytes: Uint8Array): VideoExt | null {
  const b = bytes;
  if (b.length >= 8 && String.fromCharCode(b[4], b[5], b[6], b[7]) === "ftyp") return "mp4";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  return null;
}

/** 컷 이미지와 짝을 이루는 판별. 이미지 발행 경로에서 영상 파일을 골라내는 데 쓴다. */
export function isVideoUrl(url: string, name?: string): boolean {
  const target = (name && name.trim() !== "" ? name : url).toLowerCase().split("?")[0];
  return /\.(mp4|mov|webm|m4v)$/.test(target);
}

export function extractVideoUrls(files: NotionFile[] | undefined): string[] {
  const urls: string[] = [];
  for (const f of files ?? []) {
    const url = f?.file?.url ?? f?.external?.url ?? "";
    if (url === "") continue;
    if (isVideoUrl(url, f?.name)) urls.push(url);
  }
  return urls;
}

/**
 * 형식별 발행 소스.
 * 카드뉴스는 컷 이미지 캐러셀, 이미지는 미리보기 한 장, 영상은 미리보기 영상, 카피는 글만 올린다.
 */
export const FORMAT_NAMES = ["카드뉴스", "영상-세로(9:16)", "영상-가로(16:9)", "이미지", "카피"] as const;
export type MediaKind = "carousel" | "image" | "video" | "text";

export function mediaKindFor(format: string): MediaKind | null {
  switch ((format ?? "").trim()) {
    case "카드뉴스":
      return "carousel";
    case "이미지":
      return "image";
    case "영상-세로(9:16)":
    case "영상-가로(16:9)":
      return "video";
    case "카피":
      return "text";
    default:
      return null;
  }
}

/**
 * 환경값에 붙여넣기 사고로 따옴표나 JSON 조각이 섞이는 일이 있었다
 * (실제로 토큰 뒤에 `","instagram_business_account":{...}` 가 붙어 있어 메타가 401 로 거절했다).
 * 토큰에 쓸 수 없는 문자가 나오면 그 앞까지만 남긴다.
 */
export function cleanToken(raw: string): string {
  let value = (raw ?? "").trim();
  value = value.replace(/^Bearer\s+/i, "").trim();
  value = value.replace(/^["'\[{,:\s]+/, "");
  const match = value.match(/^[A-Za-z0-9_\-|]+/);
  return match ? match[0] : "";
}

/** 오류 문구에 섞여 들어간 비밀값을 지운다. 값 자체는 어디에도 남기지 않는다. */
export function maskSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret.length < 8) continue;
    out = out.split(secret).join("***");
  }
  return out;
}

/**
 * API 오류 본문에서 사람이 읽을 부분만 뽑는다.
 * 응답을 통째로 남기면 토큰이 그대로 따라 들어온다(메타는 거절한 토큰을 오류 문구에 되돌려준다).
 */
export function summarizeApiError(text: string, limit = 400): string {
  const body = (text ?? "").trim();
  if (body.startsWith("{")) {
    try {
      const parsed = JSON.parse(body) as Record<string, any>;
      const error = (parsed.error ?? parsed) as Record<string, any>;
      const parts: string[] = [];
      const msg = error.message ?? parsed.message;
      if (typeof msg === "string" && msg.trim() !== "") parts.push(msg.trim());
      const code = error.code ?? parsed.code;
      if (code !== undefined && code !== null) parts.push(`code ${code}`);
      if (error.error_subcode !== undefined && error.error_subcode !== null) {
        parts.push(`subcode ${error.error_subcode}`);
      }
      if (error.fbtrace_id) parts.push(`trace ${error.fbtrace_id}`);
      if (parts.length > 0) return truncate(parts.join(" · "), limit);
    } catch {
      // 깨진 JSON 이면 원문을 그대로 쓴다.
    }
  }
  return truncate(body, limit);
}

type ApiFailureLike = { code?: unknown; subcode?: unknown; message?: string };

/**
 * 스레드는 자식 컨테이너가 아직 준비되지 않은 상태에서 부모(캐러셀)를 만들면
 * 400(code 100, subcode 4279004)으로 거절한다. 잠시 뒤 다시 시도하면 통과한다.
 */
export function isThreadsNotReady(e: unknown): boolean {
  const failure = (e ?? {}) as ApiFailureLike;
  return failure.code === 100 && failure.subcode === 4279004;
}

/** 방금 만든 컨테이너는 아직 모든 노드에 보이지 않아 "없다"는 답이 올 수 있다. */
export function isThreadsNotFound(e: unknown): boolean {
  const failure = (e ?? {}) as ApiFailureLike;
  if (failure.code === 24 || failure.subcode === 4279009) return true;
  return /does not exist/i.test(failure.message ?? "");
}
