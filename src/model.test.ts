import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import {
  isLibrary,
  mergeArticles,
  normalizeFeedInput,
  normalizeUrl,
  selectArticles,
} from "./model";

describe("feed URLs", () => {
  it("normalizes a valid public feed and strips fragments", () => {
    expect(normalizeUrl(" https://example.com/feed#items ")).toBe(
      "https://example.com/feed",
    );
  });
  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/feed",
    "not a URL",
  ])("rejects unsafe input %s", (value) => {
    expect(() => normalizeUrl(value)).toThrow();
  });
});

describe("user-entered subscription URLs", () => {
  it.each([
    ["github.blog/feed/", "https://github.blog/feed/"],
    ["https://github.blog/feed/", "https://github.blog/feed/"],
    ["HTTP://Example.com/rss", "http://example.com/rss"],
    ["https：／／github.blog/feed/", "https://github.blog/feed/"],
    ["https：//github.blog/feed/", "https://github.blog/feed/"],
    [
      " \u200b\u200ehttps://github.blog/feed/\u200b\uFEFF ",
      "https://github.blog/feed/",
    ],
    ["example.com:8443/rss", "https://example.com:8443/rss"],
    [
      "https://example.com/Path?token=A%2FB&topic=one%20two#section",
      "https://example.com/Path?token=A%2FB&topic=one%20two",
    ],
    [
      "https://example.com/ｆｅｅｄ?q=：",
      "https://example.com/%EF%BD%86%EF%BD%85%EF%BD%85%EF%BD%84?q=%EF%BC%9A",
    ],
  ])("normalizes only input conveniences in %s", (input, expected) => {
    expect(normalizeFeedInput(input)).toBe(expected);
  });

  it.each([
    "",
    "  \u200b ",
    "not a URL",
    "https://",
    "https//example.com/feed",
    "https:/example.com/feed",
    "javascript:alert(1)",
    "data:text/html,hello",
    "file:///etc/passwd",
    "ftp://example.com/feed",
    "https://user:password@example.com/feed",
    "user@example.com/feed",
    "https://@example.com/feed",
    "https://example.com/pa th",
    "https://example.com/pa\u200bth",
    "https://example.com/\nfeed",
    "https://example.com/\u202Efeed",
    "https://example.com\\@other.example/feed",
    "https://example.com/" + "x".repeat(4096),
  ])(
    "does not convert unsafe or malformed input %s to a new destination",
    (input) => {
      expect(() => normalizeFeedInput(input)).toThrow();
    },
  );

  it("leaves article links and API callers on strict URL validation", () => {
    expect(() => normalizeUrl("github.blog/feed/")).toThrow();
    expect(() => normalizeUrl("https：／／github.blog/feed/")).toThrow();
  });
});

describe("article merging", () => {
  it("deduplicates repeated refreshes and preserves reading state", () => {
    const article = createSeed().articles[0];
    const incoming = [{ ...article, title: "Updated title", sample: false }];
    const first = mergeArticles([], incoming, article.feedId);
    first[0].read = true;
    first[0].starred = true;
    const result = mergeArticles(first, incoming, article.feedId);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      read: true,
      starred: true,
      title: "Updated title",
      sample: false,
    });
  });
  it("keeps articles with identical remote IDs in different feeds", () => {
    const article = createSeed().articles[0];
    const first = mergeArticles([], [article], "first");
    const result = mergeArticles(first, [article], "second");
    expect(result).toHaveLength(2);
  });
});

describe("library filters", () => {
  const library = createSeed();
  it("finds articles by title and publication", () => {
    expect(
      selectArticles(
        library.articles,
        library.feeds,
        "all",
        "calm",
        false,
        false,
      ),
    ).toHaveLength(1);
    expect(
      selectArticles(
        library.articles,
        library.feeds,
        "all",
        "dezeen",
        false,
        false,
      ).every((article) => article.feedId === "dezeen"),
    ).toBe(true);
  });
  it("only includes unread or starred articles in their views", () => {
    expect(
      selectArticles(
        library.articles,
        library.feeds,
        "unread",
        "",
        false,
        false,
      ).every((article) => !article.read),
    ).toBe(true);
    expect(
      selectArticles(
        library.articles,
        library.feeds,
        "starred",
        "",
        false,
        false,
      ).every((article) => article.starred),
    ).toBe(true);
  });
  it("supports category selection and oldest-first ordering", () => {
    const result = selectArticles(
      library.articles,
      library.feeds,
      "category:Technology",
      "",
      false,
      true,
    );
    expect(result).toHaveLength(3);
    expect(Date.parse(result[0].publishedAt)).toBeLessThan(
      Date.parse(result.at(-1)!.publishedAt),
    );
  });
  it("validates persisted data before loading it", () => {
    expect(isLibrary(library)).toBe(true);
    expect(
      isLibrary({ ...library, settings: { interval: -1, theme: "blue" } }),
    ).toBe(false);
    expect(isLibrary({ version: 1, articles: [], feeds: [null] })).toBe(false);
  });
});
