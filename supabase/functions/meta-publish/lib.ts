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

/** 발행 채널을 정한다. 비어 있으면 두 채널 모두 발행한다. */
export function normalizeChannels(values: string[] | undefined): string[] {
  const list = values ?? [];
  const picked = ["인스타그램", "스레드"].filter((c) => list.includes(c));
  return picked.length > 0 ? picked : ["인스타그램", "스레드"];
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

export function extensionFor(contentType: string, url: string): string {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("png")) return "png";
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  const match = url.toLowerCase().split("?")[0].match(/\.(png|jpe?g|webp|gif)$/);
  return match ? match[1].replace("jpeg", "jpg") : "png";
}
