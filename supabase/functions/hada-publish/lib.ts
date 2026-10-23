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

/**
 * 발행 문구를 만든다. '캡션' 뒤에 고정 멘트를 한 줄 띄우고 붙인다.
 * '대본'으로 대체하지 않는 이유: 대본은 제작 메모(컨셉·타겟·사진 지시)가 섞인 작업 문서라
 * 발행 문구로 쓰면 메모가 그대로 게시되고 길이도 한도를 넘는다.
 * 캡션이 비면 고정 멘트만 남고, 둘 다 비면 빈 문구가 된다. 그래도 발행은 막지 않는다.
 * 카드뉴스는 그림이 본체라 글 없이 올릴 수 있고, 글이 꼭 필요한 '짧은글' 형식만 호출부가 막는다.
 */
export function buildCaption(caption: string, fixedComment: string): string {
  const base = (caption ?? "").trim();
  const fixed = (fixedComment ?? "").trim();
  if (base === "") return fixed;
  if (fixed === "") return base;
  return `${base}\n\n${fixed}`;
}

/**
 * 글이 비어 있으면 파라미터에서 아예 뺀다.
 * 메타는 빈 문자열을 값으로 보내면 거절할 수 있고, 이미지·캐러셀 발행에는 글이 필수가 아니다.
 */
export function optionalText(key: string, text: string): Record<string, string> {
  const value = (text ?? "").trim();
  return value === "" ? {} : { [key]: value };
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
/** 이모지로 보이는 글자. 스레드는 이 글자들을 UTF-8 바이트 수로 센다. */
const EMOJI_CHAR = /^[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]$/u;

/**
 * 스레드가 세는 글자 수.
 * 스레드 문서 기준으로 이모지는 UTF-8 바이트 수(보통 4자)로 계산되고, 나머지 글자는 1자다.
 * 그래서 이모지가 많으면 우리 글자 수 검사를 통과하고도 메타가 거절한다.
 */
export function threadsLength(text: string): number {
  let total = 0;
  for (const ch of text ?? "") {
    total += EMOJI_CHAR.test(ch) ? new TextEncoder().encode(ch).length : 1;
  }
  return total;
}

/** 채널별 한도 검사. 스레드만 이모지를 바이트로 세는 규칙을 따른다. */
export function captionLimitError(caption: string, channels: string[]): string | null {
  for (const channel of channels) {
    const limit = CAPTION_LIMITS[channel];
    if (limit === undefined) continue;
    const used = channel === "스레드" ? threadsLength(caption) : caption.length;
    if (used > limit) {
      return `${channel} 한도(${limit}자)를 넘었습니다. 현재 ${used}자, ${used - limit}자를 줄여야 합니다.`;
    }
  }
  return null;
}

/** 스레드 토큰은 60일짜리라, 마지막 갱신 후 이 일수가 지나면 미리 갱신한다. */
export const THREADS_REFRESH_AFTER_DAYS = 30;

// threads_manage_insights 는 성과 수집(조회수·좋아요·답글)에 필요하다. 이 권한이 없던 토큰은 인증을 다시 해야 한다.
export const THREADS_AUTHORIZE_SCOPES = ["threads_basic", "threads_content_publish", "threads_manage_insights"];

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
 * 카드뉴스는 컷 이미지 캐러셀, 이미지는 미리보기 한 장, 영상은 미리보기 영상, 짧은글은 글만 올린다.
 * 긴글(블로그용)은 자동 발행 대상이 아니다.
 * 예전 이름(영상-세로(9:16)·영상-가로(16:9)·카피)도 그대로 받는다.
 */
export const FORMAT_NAMES = ["카드뉴스", "이미지", "숏폼(9:16)", "롱폼(16:9)", "짧은글"] as const;
export type MediaKind = "carousel" | "image" | "video" | "text";

export function mediaKindFor(format: string): MediaKind | null {
  switch ((format ?? "").trim()) {
    case "카드뉴스":
      return "carousel";
    case "이미지":
      return "image";
    case "숏폼(9:16)":
    case "롱폼(16:9)":
    case "영상-세로(9:16)":
    case "영상-가로(16:9)":
      return "video";
    case "짧은글":
    case "카피":
      return "text";
    default:
      return null;
  }
}

/** 자동 발행하는 채널. 나머지 배포 채널은 게시물 기록만 만든다. */
export const PUBLISH_CHANNELS = ["인스타그램", "스레드"] as const;

export type DeployPlan = {
  /** 자동 발행할 채널 */
  publish: string[];
  /** 게시물 DB 에 기록만 만들 채널 */
  record: string[];
  /** 이미 완료라 건너뛴 채널 */
  done: string[];
};

/**
 * '배포 채널' 다중 선택으로 할 일을 나눈다.
 * 인스타그램·스레드는 자동 발행하고, 상태가 이미 ✅ 완료면 두 번 올리지 않도록 건너뛴다.
 * 나머지 채널(블로그·유튜브 등)은 게시물 기록만 만든다.
 */
export function planDeploy(
  deployChannels: string[],
  statusOf: (channel: string) => string,
  doneStatus: string,
): DeployPlan {
  const plan: DeployPlan = { publish: [], record: [], done: [] };
  for (const raw of deployChannels) {
    const channel = raw.trim();
    if (channel === "") continue;
    if ((PUBLISH_CHANNELS as readonly string[]).includes(channel)) {
      if (statusOf(channel) === doneStatus) plan.done.push(channel);
      else plan.publish.push(channel);
    } else {
      plan.record.push(channel);
    }
  }
  return plan;
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

// ---------- 성과 수집 ----------

export type MetricChannel = "instagram" | "threads" | "youtube" | "naver_blog";

/** 게시 링크의 주소로 채널을 정한다. 채널 관계를 따로 읽지 않아도 된다. */
export function metricChannelOf(link: string): MetricChannel | null {
  let host = "";
  try {
    host = new URL(link).hostname.toLowerCase().replace(/^(www|m)\./, "");
  } catch {
    return null;
  }
  if (host === "instagram.com") return "instagram";
  if (host === "threads.com" || host === "threads.net") return "threads";
  if (host === "youtube.com" || host === "youtu.be") return "youtube";
  if (host === "blog.naver.com") return "naver_blog";
  return null;
}

/**
 * 게시 링크에서 게시물 고유 코드를 꺼낸다.
 * 인스타그램 /p/{코드}/·/reel/{코드}/, 스레드 /post/{코드}, 유튜브 영상 ID.
 * 메타 API 의 permalink 는 /p/ 와 /reel/ 이 섞여 오고 스레드는 threads.net 으로 오기도 해서
 * 주소 전체가 아니라 이 코드로 맞춘다.
 */
export function postCodeOf(link: string): string {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return "";
  }
  const parts = url.pathname.split("/").filter((part) => part !== "");
  const after = (key: string) => {
    const index = parts.indexOf(key);
    return index >= 0 && index + 1 < parts.length ? parts[index + 1] : "";
  };
  switch (metricChannelOf(link)) {
    case "instagram":
      return after("p") || after("reel") || after("reels") || after("tv");
    case "threads":
      return after("post");
    case "youtube":
      if (url.hostname.endsWith("youtu.be")) return parts[0] ?? "";
      return url.searchParams.get("v") || after("shorts") || after("live") || after("embed");
    case "naver_blog": {
      // blog.naver.com/{아이디}/{글번호} 또는 PostView.naver?blogId=…&logNo=… → "아이디/글번호"
      const blogId = url.searchParams.get("blogId") ?? (parts.length >= 2 ? parts[0] : "");
      const logNo = url.searchParams.get("logNo") ?? (parts.length >= 2 ? parts[1] : "");
      return /^\d+$/.test(logNo) && blogId !== "" ? `${blogId}/${logNo}` : "";
    }
    default:
      return "";
  }
}

export const METRIC_FIELDS = ["조회수", "좋아요", "댓글", "저장", "공유"] as const;
export type MetricField = typeof METRIC_FIELDS[number];
export type Metrics = Partial<Record<MetricField, number>>;

/**
 * 채널이 돌려준 누적값에서 지금까지 성과 로그에 쌓인 합을 빼 이번 기간 증가분을 만든다.
 * 채널이 주지 않은 지표는 빼고, 모든 증가분이 0 이면 null(기록할 것 없음)을 돌려준다.
 * 좋아요 취소처럼 줄어든 값도 그대로 음수로 남겨 합계가 채널 값과 같게 한다.
 */
export function metricDelta(current: Metrics, logged: Metrics): Metrics | null {
  const delta: Metrics = {};
  let changed = false;
  for (const field of METRIC_FIELDS) {
    const now = current[field];
    if (typeof now !== "number" || !Number.isFinite(now)) continue;
    const diff = now - (logged[field] ?? 0);
    delta[field] = diff;
    if (diff !== 0) changed = true;
  }
  return changed ? delta : null;
}

/** 인스타그램·스레드 인사이트 응답(data[].name·values[0].value 또는 total_value.value)을 이름별 숫자로 편다. */
export function readInsights(response: Record<string, any>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of (response.data ?? []) as Record<string, any>[]) {
    const value = item.total_value?.value ?? item.values?.[0]?.value;
    if (typeof item.name === "string" && typeof value === "number") out[item.name] = value;
  }
  return out;
}

/** 한국 시간 기준 오늘 날짜(YYYY-MM-DD). 성과 로그 '기록일'에 쓴다. */
export function kstDate(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// ---------- 유튜브 ----------

/** 배포 채널 옵션 이름. 채널 DB 페이지 이름과 같다. */
export const YOUTUBE_CHANNEL = "유튜브";

/** 업로드는 youtube.upload, 채널 확인(인증 완료 화면)과 이후 성과 조회는 youtube.readonly 로 한다. */
export const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

/** 구글 콜백과 스레드 콜백은 같은 주소로 돌아온다. state 값으로 구분한다. */
export const YOUTUBE_OAUTH_STATE = "youtube";

export const YOUTUBE_TITLE_LIMIT = 100;
/** 설명 한도는 글자가 아니라 UTF-8 바이트(5000)다. 한글은 한 글자에 3바이트라 약 1600자다. */
export const YOUTUBE_DESCRIPTION_BYTES = 5000;

/**
 * 구글 승인 화면 주소.
 * access_type=offline 과 prompt=consent 를 같이 보내야 매번 refresh token 을 돌려준다.
 */
export function youtubeAuthorizeUrl(clientId: string, redirectUri: string, scopes: string[]): string {
  const params = new URLSearchParams({
    client_id: (clientId ?? "").trim(),
    redirect_uri: (redirectUri ?? "").trim(),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state: YOUTUBE_OAUTH_STATE,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/** 세로 영상 형식이면 Shorts 로 본다. 유튜브는 세로·3분 이하 영상을 Shorts 로 분류한다. */
export function isShortsFormat(format: string): boolean {
  return ["숏폼(9:16)", "영상-세로(9:16)"].includes((format ?? "").trim());
}

/** UTF-8 바이트 한도에 맞춰 자른다. 글자 중간에서 끊지 않는다. */
export function truncateBytes(text: string, limit: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= limit) return text;
  let out = "";
  let used = 0;
  const ellipsis = encoder.encode("…").length;
  for (const ch of text) {
    const size = encoder.encode(ch).length;
    if (used + size + ellipsis > limit) break;
    out += ch;
    used += size;
  }
  return `${out.trimEnd()}…`;
}

/** 유튜브는 제목·설명에 < > 가 있으면 업로드를 거절한다. */
function stripAngles(text: string): string {
  return (text ?? "").replace(/[<>]/g, "");
}

/**
 * 영상 제목. '유튜브 제목'이 있으면 그것을, 없으면 페이지 이름을 쓴다.
 * 줄바꿈은 한 칸으로 바꾸고 100자에서 자른다. 제목이 비면 업로드가 거절되므로 기본값을 둔다.
 */
export function youtubeTitle(custom: string, pageTitle: string): string {
  const pick = (custom ?? "").trim() !== "" ? custom : pageTitle;
  const clean = stripAngles(pick).replace(/\s+/g, " ").trim();
  return truncate(clean === "" ? "제목 없음" : clean, YOUTUBE_TITLE_LIMIT);
}

/** 영상 설명. 발행 문구(캡션 + 고정 멘트)를 쓰고, Shorts 면 #Shorts 를 붙인다. */
export function youtubeDescription(caption: string, shorts: boolean): string {
  let text = stripAngles(caption).trim();
  if (shorts && !/#shorts\b/i.test(text)) text = text === "" ? "#Shorts" : `${text}\n\n#Shorts`;
  return truncateBytes(text, YOUTUBE_DESCRIPTION_BYTES);
}

/** 공개 범위. 모르는 값이면 공개로 둔다. */
export function youtubePrivacy(value: string): "public" | "unlisted" | "private" {
  const key = (value ?? "").trim().toLowerCase();
  if (["private", "비공개"].includes(key)) return "private";
  if (["unlisted", "일부공개", "일부 공개"].includes(key)) return "unlisted";
  return "public";
}

export function youtubeWatchUrl(videoId: string, shorts: boolean): string {
  return shorts ? `https://youtube.com/shorts/${videoId}` : `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * '배포 채널'에서 유튜브를 자동 업로드로 뺄지 정한다.
 * 유튜브 연결 설정이 있고 영상 형식일 때만 업로드한다. 아니면 예전처럼 게시물 기록만 만든다.
 */
export function splitYoutube(
  deployChannels: string[],
  enabled: boolean,
  kind: MediaKind | null,
): { youtube: boolean; rest: string[] } {
  const picked = deployChannels.some((channel) => channel.trim() === YOUTUBE_CHANNEL);
  if (!picked || !enabled || kind !== "video") return { youtube: false, rest: deployChannels };
  return { youtube: true, rest: deployChannels.filter((channel) => channel.trim() !== YOUTUBE_CHANNEL) };
}

/** 채널 DB 페이지 이름. 계정에서 찾은 게시물의 기록을 만들 때 채널 관계를 이 이름으로 찾는다. */
export const METRIC_CHANNEL_LABELS: Record<MetricChannel, string> = {
  instagram: "인스타그램",
  threads: "스레드",
  youtube: "유튜브",
  naver_blog: "블로그",
};

// ---------- 네이버 블로그 ----------
// 블로그는 글쓰기 API 가 없어 발행은 사람이(또는 Aside 브라우저가) 하고, 함수는 성과만 모은다.
// 공개 모바일 목록 API 가 공감·댓글·공유 수를 준다. 조회수는 블로그 주인만 볼 수 있어 받지 않는다.

/** 블로그 주소(https://blog.naver.com/아이디, m.blog…, PostList.naver?blogId=…)에서 아이디를 꺼낸다. */
export function naverBlogIdOf(link: string): string {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return "";
  }
  if (url.hostname.toLowerCase().replace(/^(www|m)\./, "") !== "blog.naver.com") return "";
  const fromQuery = url.searchParams.get("blogId");
  if (fromQuery) return fromQuery;
  const first = url.pathname.split("/").filter((part) => part !== "")[0] ?? "";
  return /^[A-Za-z0-9_-]+$/.test(first) && !first.endsWith(".naver") ? first : "";
}

/** 모바일 목록 API 의 글 하나에서 누적 지표를 읽는다. 공감 → 좋아요. */
export function naverBlogMetrics(item: Record<string, any>): Metrics {
  const metrics: Metrics = {};
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);
  const likes = num(item.sympathyCnt);
  const comments = num(item.commentCnt);
  const shares = num(item.shareCnt);
  if (Number.isFinite(likes)) metrics["좋아요"] = likes;
  if (Number.isFinite(comments)) metrics["댓글"] = comments;
  if (Number.isFinite(shares)) metrics["공유"] = shares;
  return metrics;
}

export function naverBlogPostUrl(blogId: string, logNo: string | number): string {
  return `https://blog.naver.com/${blogId}/${logNo}`;
}

/** 계정에서 가져온 게시물의 기록 이름. 글의 첫 줄(해시태그 줄 제외)을 40자로 자르고 채널을 붙인다. */
export function importedPostTitle(text: string, channelLabel: string): string {
  return `${postHeadline(text) || "제목 없는 게시물"} · ${channelLabel}`;
}

/** 게시물 글의 첫 줄(해시태그 줄 제외)을 40자까지. 산출물 이름으로도 쓴다. */
export function postHeadline(text: string): string {
  const line = text.split("\n").map((part) => part.trim()).find((part) => part !== "" && !part.startsWith("#")) ?? "";
  return [...line].length > 40 ? `${[...line].slice(0, 40).join("")}…` : line;
}

/**
 * 계정에서 가져온 게시물로 산출물을 만들 때 쓸 형식. API 의 미디어 종류로 고르고, 모르면 빈 문자열.
 * 인스타그램은 media_product_type(REELS 등)·media_type, 스레드는 media_type(TEXT_POST 등)을 준다.
 * 유튜브 업로드 목록은 Shorts 여부를 알려주지 않아 링크가 /shorts/ 일 때만 숏폼으로 본다.
 */
export function contentFormatFor(channel: MetricChannel, mediaType: string, link = ""): string {
  const type = mediaType.toUpperCase();
  if (channel === "youtube") return /\/shorts\//.test(link) ? "숏폼(9:16)" : "";
  if (channel === "naver_blog") return "긴글";
  if (type === "REELS" || type === "VIDEO") return "숏폼(9:16)";
  if (type === "CAROUSEL_ALBUM") return "카드뉴스";
  if (type === "IMAGE") return "이미지";
  if (channel === "threads" && type === "TEXT_POST") return "짧은글";
  return "";
}

/** 게시 시각이 since(한국 시간 날짜 YYYY-MM-DD) 이후인가. since 가 비면 항상 참, 게시 시각을 모르면 거짓. */
export function publishedOnOrAfter(publishedAt: string, since: string): boolean {
  if (since === "") return true;
  const ms = Date.parse(publishedAt);
  if (!Number.isFinite(ms)) return false;
  return kstDate(ms) >= since;
}

/** 채널 페이지 이름으로 수집 채널을 찾는다. 수집하지 않는 채널(블로그 등)이면 null. */
export function metricChannelByLabel(label: string): MetricChannel | null {
  const name = label.trim();
  for (const [channel, value] of Object.entries(METRIC_CHANNEL_LABELS)) {
    if (value === name) return channel as MetricChannel;
  }
  return null;
}

/**
 * 성과 수집 결과에서 채널 페이지의 '마지막 오류'에 남길 문장을 만든다. 문제가 없으면 빈 문자열.
 * 채널 오류(토큰·권한 등)와 기록 실패 건수를 한 줄씩 적는다.
 */
export function metricsErrorSummary(body: {
  channelErrors?: Record<string, unknown>;
  failures?: unknown;
}): string {
  const lines: string[] = [];
  for (const [channel, error] of Object.entries(body.channelErrors ?? {})) {
    const label = METRIC_CHANNEL_LABELS[channel as MetricChannel] ?? channel;
    lines.push(`${label} — ${String(error)}`);
  }
  const failures = typeof body.failures === "number" ? body.failures : 0;
  if (failures > 0) lines.push(`성과 로그 기록 실패 ${failures}건 (함수 로그 확인)`);
  return lines.join("\n");
}

/** 한 번 수집할 때 갱신할 게시물 범위. null 이면 제한 없음. */
export type MetricScope = { days: number | null; latest: number | null };

/**
 * 갱신 범위를 적용한다. days 는 게시일이 오늘부터 며칠 안인 게시물만, latest 는 게시일 최신순 N개만 남긴다.
 * 둘 다 있으면 둘 다 적용한다. 범위를 걸면 게시일이 없는 게시물은 오래된 것으로 보고 뺀다.
 */
export function applyMetricScope<T extends { publishedAt: string }>(items: T[], scope: MetricScope, nowMs: number): T[] {
  const time = (item: T) => {
    const t = Date.parse(item.publishedAt);
    return Number.isNaN(t) ? -Infinity : t;
  };
  let kept = items;
  if (scope.days !== null && scope.days > 0) {
    const since = nowMs - scope.days * 24 * 60 * 60 * 1000;
    kept = kept.filter((item) => time(item) >= since);
  }
  if (scope.latest !== null && scope.latest > 0) {
    kept = [...kept].filter((item) => time(item) !== -Infinity).sort((a, b) => time(b) - time(a)).slice(0, scope.latest);
  }
  return kept;
}

/**
 * 자동 수집 시각이 됐는지. 매시 부르는 예약 실행이 쓴다.
 * 한국 시간으로 그 시각이 지났고 오늘 아직 수집하지 않았으면 true(한 번 놓쳐도 다음 시간에 따라잡는다).
 */
export function autoCollectDue(hour: number | null, lastCollected: string, nowMs: number): boolean {
  if (hour === null || hour < 0 || hour > 23) return false;
  const kstHour = new Date(nowMs + 9 * 60 * 60 * 1000).getUTCHours();
  if (kstHour < hour) return false;
  const last = Date.parse(lastCollected);
  return Number.isNaN(last) || kstDate(last) !== kstDate(nowMs);
}

/** 한국 시간 "YYYY-MM-DD HH:mm". */
export function kstDateTime(nowMs: number): string {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/**
 * 채널 페이지의 '처리 결과'에 남길 요약. 첫 줄은 시각과 범위, 둘째 줄은 건수,
 * 그 아래에 새로 가져온 게시물과 오류(있을 때만)를 적는다.
 */
export function metricsResultSummary(body: {
  targets?: unknown;
  created?: unknown;
  imported?: { count?: unknown };
  contents?: { linked?: unknown; created?: unknown };
  results?: { status?: unknown }[];
  channelErrors?: Record<string, unknown>;
  failures?: unknown;
}, nowMs: number, scope: string): string {
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  const statuses = (body.results ?? []).map((r) => r.status);
  const unchanged = statuses.filter((s) => s === "변화 없음").length;
  const deferred = statuses.filter((s) => s === "시간 초과로 다음에").length;
  const counts = [`게시물 ${num(body.targets)}건 확인`, `새 기록 ${num(body.created)}건`, `변화 없음 ${unchanged}건`];
  if (deferred > 0) counts.push(`다음으로 미룸 ${deferred}건`);
  const lines = [`${kstDateTime(nowMs)} 수집 · ${scope}`, counts.join(" · ")];
  const imported = num(body.imported?.count);
  if (imported > 0) lines.push(`계정에서 새로 가져온 게시물 ${imported}건`);
  const linked = num(body.contents?.linked);
  const madeContents = num(body.contents?.created);
  if (linked + madeContents > 0) lines.push(`산출물 연결 ${linked}건 · 새로 만든 산출물 ${madeContents}건`);
  const errors = metricsErrorSummary(body);
  if (errors !== "") lines.push(errors);
  return lines.join("\n");
}
