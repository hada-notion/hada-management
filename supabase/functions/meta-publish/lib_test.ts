import {
  IG_CAROUSEL_MAX,
  THREADS_CAROUSEL_MAX,
  assertCarouselSize,
  buildCaption,
  captionLimitError,
  contentTypeFor,
  detectImageType,
  expiresAtFrom,
  hexPreview,
  extensionFor,
  extractImageUrls,
  isImageUrl,
  needsRefresh,
  channelHint,
  collectPageCandidates,
  parsePageId,
  readTarget,
  resolveRedirectUri,
  sortCuts,
  threadsAuthorizeUrl,
  truncate,
} from "./lib.ts";

function assertEquals(actual: unknown, expected: unknown, label = "값이 다릅니다") {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: 실제 ${a}, 기대 ${e}`);
}

function assertThrows(fn: () => unknown, label = "예외가 발생해야 합니다") {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(label);
}

Deno.test("parsePageId: 주소·슬러그·ID 모두 처리", () => {
  const id = "3f3ba040586b8002b4d2d10e9982d12f";
  assertEquals(parsePageId(`https://app.notion.com/p/${id}`), id);
  assertEquals(parsePageId(`https://www.notion.so/제목-${id}?pvs=4`), id);
  assertEquals(parsePageId("3f3ba040-586b-8002-b4d2-d10e9982d12f"), id);
  assertEquals(parsePageId(`  ${id}  `), id);
  assertThrows(() => parsePageId(""));
  assertThrows(() => parsePageId("https://app.notion.com/p/없음"));
});

Deno.test("sortCuts: 컷 순서 오름차순, 동률은 페이지 ID로 안정 정렬", () => {
  const sorted = sortCuts([
    { pageId: "b", order: 3, imageUrls: [] },
    { pageId: "a", order: 1, imageUrls: [] },
    { pageId: "c", order: 3, imageUrls: [] },
  ]);
  assertEquals(sorted.map((c) => c.pageId), ["a", "b", "c"]);
});

Deno.test("buildCaption: 캡션 우선, 비면 대본, 고정 멘트는 뒤에 한 줄 띄우고 붙임", () => {
  assertEquals(buildCaption("캡션 본문", "대본 본문", "고정 멘트"), "캡션 본문\n\n고정 멘트");
  assertEquals(buildCaption("  ", "대본 본문", "고정 멘트"), "대본 본문\n\n고정 멘트");
  assertEquals(buildCaption("캡션 본문", "대본 본문", ""), "캡션 본문");
  assertEquals(buildCaption("캡션 본문", "대본 본문", "   "), "캡션 본문");
  assertEquals(buildCaption("", "대본 본문", ""), "대본 본문");
  assertEquals(buildCaption("", "", "고정 멘트"), "고정 멘트");
  assertEquals(buildCaption("", "", ""), "");
});

Deno.test("assertCarouselSize: 장수 경계에서 막는다", () => {
  assertCarouselSize(2, 2, IG_CAROUSEL_MAX, "인스타그램");
  assertCarouselSize(10, 2, IG_CAROUSEL_MAX, "인스타그램");
  assertCarouselSize(20, 2, THREADS_CAROUSEL_MAX, "스레드");
  assertThrows(() => assertCarouselSize(1, 2, IG_CAROUSEL_MAX, "인스타그램"));
  assertThrows(() => assertCarouselSize(11, 2, IG_CAROUSEL_MAX, "인스타그램"));
  assertThrows(() => assertCarouselSize(21, 2, THREADS_CAROUSEL_MAX, "스레드"));
});

Deno.test("truncate: 한도 안이면 그대로, 넘으면 말줄임", () => {
  assertEquals(truncate("가나다", 5), "가나다");
  assertEquals(truncate("가나다라마", 5), "가나다라마");
  assertEquals(truncate("가나다라마바", 5), "가나다라…");
});

Deno.test("extractImageUrls: 업로드 파일과 외부 링크를 모두 읽고 영상은 제외", () => {
  const urls = extractImageUrls([
    { type: "file", file: { url: "https://s3.example.com/a.png?sig=1" } },
    { type: "external", external: { url: "https://example.com/b.jpg" }, name: "b.jpg" },
    { type: "file", file: { url: "https://s3.example.com/c.mp4" }, name: "c.mp4" },
    { type: "file", file: {} },
  ]);
  assertEquals(urls, ["https://s3.example.com/a.png?sig=1", "https://example.com/b.jpg"]);
  assertEquals(isImageUrl("https://s3.example.com/x.mp4"), false);
  assertEquals(isImageUrl("https://s3.example.com/x"), true);
});

Deno.test("extensionFor: content-type 우선, 없으면 주소 확장자", () => {
  assertEquals(extensionFor("image/jpeg", "https://x/a.png"), "jpg");
  assertEquals(extensionFor("", "https://x/a.PNG?sig=1"), "png");
  assertEquals(extensionFor("", "https://x/a"), "png");
});

Deno.test("threadsAuthorizeUrl: 승인 주소를 만든다", () => {
  const url = threadsAuthorizeUrl(
    "1798018584846325",
    "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish",
    ["threads_basic", "threads_content_publish"],
  );
  const parsed = new URL(url);
  assertEquals(parsed.origin + parsed.pathname, "https://threads.com/oauth/authorize");
  assertEquals(parsed.searchParams.get("client_id"), "1798018584846325");
  assertEquals(parsed.searchParams.get("scope"), "threads_basic,threads_content_publish");
  assertEquals(parsed.searchParams.get("response_type"), "code");
  assertEquals(
    parsed.searchParams.get("redirect_uri"),
    "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish",
  );
});

Deno.test("needsRefresh: 30일이 지나면 true, 그 전에는 false", () => {
  const day = 24 * 60 * 60 * 1000;
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  assertEquals(needsRefresh(now - 29 * day, now, 30), false);
  assertEquals(needsRefresh(now - 30 * day, now, 30), true);
  assertEquals(needsRefresh(now - 45 * day, now, 30), true);
  assertEquals(needsRefresh(now + day, now, 30), false);
  assertEquals(needsRefresh(Number.NaN, now, 30), false);
});

Deno.test("expiresAtFrom: expires_in 초를 만료 시각으로 바꾼다", () => {
  const now = Date.parse("2026-08-01T00:00:00.000Z");
  assertEquals(expiresAtFrom(now, 60 * 60 * 24 * 60), "2026-09-30T00:00:00.000Z");
  assertEquals(expiresAtFrom(now, "3600"), "2026-08-01T01:00:00.000Z");
  assertEquals(expiresAtFrom(now, undefined), null);
  assertEquals(expiresAtFrom(now, 0), null);
});

Deno.test("resolveRedirectUri: 내부 주소를 공개 주소로 바꾼다", () => {
  const base = "https://fkqassnvyakenoslhfgn.supabase.co";
  // Supabase 함수가 넘겨주는 내부 주소
  assertEquals(
    resolveRedirectUri("http://fkqassnvyakenoslhfgn.supabase.co/meta-publish?code=x", base, ""),
    "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish",
  );
  // 이미 공개 주소로 들어온 경우
  assertEquals(
    resolveRedirectUri(`${base}/functions/v1/meta-publish?code=x`, base, ""),
    "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish",
  );
  // 환경값이 있으면 그 값을 그대로 쓴다 (끝 슬래시만 정리)
  assertEquals(resolveRedirectUri("http://x/meta-publish", base, `${base}/functions/v1/meta-publish/`),
    "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish");
  // 공개 주소를 모르면 호스트만 https 로 살린다
  assertEquals(resolveRedirectUri("http://x/meta-publish", "", ""), "https://x/meta-publish");
});

Deno.test("detectImageType: 앞바이트로 실제 형식을 판별한다", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
  const webp = new Uint8Array([
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, 0x00,
  ]);
  const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x00]);
  assertEquals(detectImageType(png), "png");
  assertEquals(detectImageType(jpg), "jpg");
  assertEquals(detectImageType(webp), "webp");
  assertEquals(detectImageType(gif), "gif");
  // 이미지가 아니거나 너무 짧으면 null
  assertEquals(detectImageType(new Uint8Array([0x3c, 0x21, 0x64, 0x6f])), null);
  assertEquals(detectImageType(new Uint8Array([0x89, 0x50])), null);
  assertEquals(detectImageType(new Uint8Array([])), null);
});

Deno.test("contentTypeFor: 확장자를 메타가 아는 content-type 으로 바꾼다", () => {
  assertEquals(contentTypeFor("png"), "image/png");
  assertEquals(contentTypeFor("jpg"), "image/jpeg");
  assertEquals(contentTypeFor("webp"), "image/webp");
  assertEquals(contentTypeFor("gif"), "image/gif");
  assertEquals(contentTypeFor("bin"), "application/octet-stream");
});

Deno.test("hexPreview: 앞바이트를 16진수로 보여준다", () => {
  assertEquals(hexPreview(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), "89 50 4e 47");
  assertEquals(hexPreview(new Uint8Array([0x01, 0x0a]), 8), "01 0a");
  assertEquals(hexPreview(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 3), "01 02 03");
});

Deno.test("captionLimitError: 채널 한도를 넘으면 발행 전에 막는다", () => {
  assertEquals(captionLimitError("가".repeat(500), ["스레드"]), null);
  assertEquals(
    captionLimitError("가".repeat(501), ["스레드"]),
    "스레드 한도(500자)를 넘었습니다. 현재 501자, 1자를 줄여야 합니다.",
  );
  assertEquals(captionLimitError("가".repeat(2200), ["인스타그램"]), null);
  assertEquals(
    captionLimitError("가".repeat(2201), ["인스타그램"]),
    "인스타그램 한도(2200자)를 넘었습니다. 현재 2201자, 1자를 줄여야 합니다.",
  );
  // 스레드가 대상이 아니면 500자를 넘어도 통과한다.
  assertEquals(captionLimitError("가".repeat(900), ["인스타그램"]), null);
  // 두 채널 모두 대상이면 먼저 걸리는 채널에서 멈춘다.
  assertEquals(
    captionLimitError("가".repeat(600), ["인스타그램", "스레드"]),
    "스레드 한도(500자)를 넘었습니다. 현재 600자, 100자를 줄여야 합니다.",
  );
  // 한도가 정의되지 않은 채널은 검사하지 않는다.
  assertEquals(captionLimitError("가".repeat(900), ["기타"]), null);
});

Deno.test("readTarget: 페이지 지정이 있으면 그 값을 쓴다", () => {
  const base = "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish";
  assertEquals(readTarget({ pageUrl: "https://app.notion.com/p/abc" }, base), "https://app.notion.com/p/abc");
  assertEquals(readTarget({ pageId: "abc" }, base), "abc");
  assertEquals(readTarget({ url: "https://app.notion.com/p/abc" }, base), "https://app.notion.com/p/abc");
  assertEquals(readTarget({ id: "abc" }, base), "abc");
  assertEquals(readTarget({ page: { url: "https://app.notion.com/p/abc" } }, base), "https://app.notion.com/p/abc");
  assertEquals(readTarget({}, `${base}?pageUrl=https%3A%2F%2Fapp.notion.com%2Fp%2Fabc`), "https://app.notion.com/p/abc");
  assertEquals(readTarget({}, `${base}?pageId=abc`), "abc");
});

Deno.test("readTarget: 페이지 지정이 없으면 빈 값이 되어 큐 모드로 넘어간다", () => {
  const base = "https://fkqassnvyakenoslhfgn.supabase.co/functions/v1/meta-publish";
  // 노션 버튼 웹훅은 DB 속성만 보낸다. 페이지 URL 이 없으므로 큐 모드다.
  assertEquals(readTarget({ "발행 상태": "발행 대기" }, base), "");
  assertEquals(readTarget({}, base), "");
  assertEquals(readTarget({ pageUrl: "   " }, base), "");
  // 주소가 망가져도 예외로 죽지 않고 큐 모드로 넘어간다.
  assertEquals(readTarget({}, "not-a-url"), "");
});

Deno.test("collectPageCandidates: 본문 어디에 있든 노션 주소를 찾는다", () => {
  assertEquals(
    collectPageCandidates({ "페이지 URL": "https://app.notion.com/p/3f1ba040586b80fd91f0efa3c32b37c2" }),
    ["https://app.notion.com/p/3f1ba040586b80fd91f0efa3c32b37c2"],
  );
  // 키 이름이 달라도, 깊이 묻혀 있어도 찾는다.
  assertEquals(collectPageCandidates({ data: { properties: { link: "https://www.notion.so/x-3f1ba040586b80fd91f0efa3c32b37c2" } } }), [
    "https://www.notion.so/x-3f1ba040586b80fd91f0efa3c32b37c2",
  ]);
  // 관계 속성처럼 주소가 여러 개면 전부 모은다. 어느 것이 컨텐츠 페이지인지는 호출부가 확인한다.
  assertEquals(collectPageCandidates({ relation: ["3f1ba040586b80fd91f0efa3c32b37c2", "9d42bac3eece4995acda607590ae1728"] }), [
    "3f1ba040586b80fd91f0efa3c32b37c2",
    "9d42bac3eece4995acda607590ae1728",
  ]);
  // 주소가 아니면 담지 않는다.
  assertEquals(collectPageCandidates({ "발행 상태": "발행 대기", "이름": "수업 중 상담 전화" }), []);
  assertEquals(collectPageCandidates({ "인스타그램 링크": "https://www.instagram.com/p/abc" }), []);
});

Deno.test("channelHint: 주소의 channel 값으로 채널을 알아낸다", () => {
  assertEquals(channelHint("instagram"), "인스타그램");
  assertEquals(channelHint("IG"), "인스타그램");
  assertEquals(channelHint("인스타그램"), "인스타그램");
  assertEquals(channelHint("threads"), "스레드");
  assertEquals(channelHint("스레드"), "스레드");
  assertEquals(channelHint(null), null);
  assertEquals(channelHint(""), null);
  assertEquals(channelHint("youtube"), null);
});
