import {
  IG_CAROUSEL_MAX,
  THREADS_CAROUSEL_MAX,
  assertCarouselSize,
  buildCaption,
  extensionFor,
  extractImageUrls,
  isImageUrl,
  normalizeChannels,
  parsePageId,
  shouldPublish,
  sortCuts,
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
