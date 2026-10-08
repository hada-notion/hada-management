import {
  IG_CAROUSEL_MAX,
  THREADS_CAROUSEL_MAX,
  assertCarouselSize,
  buildCaption,
  expiresAtFrom,
  extensionFor,
  extractImageUrls,
  isImageUrl,
  needsRefresh,
  normalizeChannels,
  parsePageId,
  resolveRedirectUri,
  shouldPublish,
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

Deno.test("normalizeChannels: 비면 두 채널, 지정하면 지정한 채널만", () => {
  assertEquals(normalizeChannels(undefined), ["인스타그램", "스레드"]);
  assertEquals(normalizeChannels([]), ["인스타그램", "스레드"]);
  assertEquals(normalizeChannels(["스레드"]), ["스레드"]);
  assertEquals(normalizeChannels(["스레드", "인스타그램"]), ["인스타그램", "스레드"]);
  assertEquals(normalizeChannels(["알 수 없음"]), ["인스타그램", "스레드"]);
});

Deno.test("shouldPublish: '발행 대기'일 때만 발행한다", () => {
  assertEquals(shouldPublish("발행 대기"), true);
  assertEquals(shouldPublish(" 발행 대기 "), true);
  assertEquals(shouldPublish("미발행"), false);
  assertEquals(shouldPublish("발행 중"), false);
  assertEquals(shouldPublish("발행 완료"), false);
  assertEquals(shouldPublish("발행 실패"), false);
  assertEquals(shouldPublish(""), false);
  assertEquals(shouldPublish(undefined), false);
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
