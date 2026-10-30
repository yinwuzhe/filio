// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { createSeed } from "./seed";
import { isLibrary, mergeArticles } from "./model";
import {
  attachTranslation,
  getCachedTranslation,
  prepareTranslation,
  translationSource,
} from "./translation";

const article = {
  ...createSeed().articles[0],
  title: "Hello",
  excerpt: "Summary",
  content:
    '<h2>Heading</h2><p>Some <strong>important</strong> text with <a href="https://example.com/story">a link</a>.</p><img src="https://example.com/image.jpg"><pre><code>const hello = 1;</code></pre><p><code>variable</code> is a name.</p><p translate="no">Do not translate</p>',
};
const translate = (value = article) => {
  const prepared = prepareTranslation(value);
  return prepared.finish({
    segments: prepared.segments.map((_, i) => `中文${i}`),
    model: "test-model",
    provider: "https://api.example.com",
  });
};

describe("translation text extraction", () => {
  it("translates title, excerpt and text while retaining links, images, formatting and code", () => {
    const prepared = prepareTranslation(article);
    expect(prepared.segments).toContain("Hello");
    expect(prepared.segments).toContain("Some ");
    expect(prepared.segments).not.toContain("const hello = 1;");
    expect(prepared.segments).not.toContain("variable");
    expect(prepared.segments).not.toContain("Do not translate");
    expect(prepared.segments.join("")).not.toContain("https://");
    const translated = translate();
    const doc = document.createElement("div");
    doc.innerHTML = translated.content;
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/story",
    );
    expect(doc.querySelector("strong")?.textContent).toMatch(/中文/);
    expect(doc.querySelector("img")?.src).toBe("https://example.com/image.jpg");
    expect(doc.querySelector("pre")?.textContent).toBe("const hello = 1;");
    expect(doc.querySelector("[translate=no]")?.textContent).toBe(
      "Do not translate",
    );
    expect(translated.title).toBe("中文0");
    expect(article.title).toBe("Hello");
  });
  it("treats model-provided HTML as inert text and sanitizes source markup", () => {
    const prepared = prepareTranslation({
      ...article,
      content:
        '<p onclick="alert(1)">Hello</p><script>alert(1)</script><iframe src="https://bad.example"></iframe>',
    });
    const result = prepared.finish({
      segments: prepared.segments.map(() => '<img src=x onerror="alert(1)">'),
      model: "test",
      provider: "test",
    });
    const doc = document.createElement("div");
    doc.innerHTML = result.content;
    expect(
      doc.querySelector("img,script,iframe,[onclick],[onerror]"),
    ).toBeNull();
    expect(doc.textContent).toContain('<img src=x onerror="alert(1)">');
  });
  it("splits large text nodes without silently discarding content", () => {
    const value = {
      ...article,
      content: `<p>${"A long sentence. ".repeat(600)}</p>`,
    };
    const prepared = prepareTranslation(value);
    expect(prepared.segments.every((text) => text.length <= 4000)).toBe(true);
    const result = prepared.finish({
      segments: prepared.segments,
      model: "test",
      provider: "test",
    });
    expect(result.content.replace(/\s+/g, " ")).toContain("A long sentence.");
    expect(prepared.segments.slice(2).join("")).toBe(
      "A long sentence. ".repeat(600),
    );
  });
  it("rejects oversized input and partial results instead of caching incomplete translations", () => {
    expect(() =>
      prepareTranslation({ ...article, content: "x".repeat(40001) }),
    ).toThrow(/40,000/);
    const prepared = prepareTranslation(article);
    expect(() =>
      prepared.finish({ segments: ["中文"], model: "test", provider: "test" }),
    ).toThrow(/不完整/);
    expect(() =>
      prepared.finish({
        segments: prepared.segments.map(() => ""),
        model: "test",
        provider: "test",
      }),
    ).toThrow(/不完整/);
  });
});

describe("offline translation cache", () => {
  it("preserves original text and read/starred state through save and restore", () => {
    const library = createSeed();
    library.articles[0] = {
      ...article,
      translation: translate(),
      read: true,
      starred: true,
    };
    const restored = JSON.parse(JSON.stringify(library));
    expect(isLibrary(restored)).toBe(true);
    expect(getCachedTranslation(restored.articles[0])?.title).toBe("中文0");
    expect(restored.articles[0]).toMatchObject({
      title: "Hello",
      read: true,
      starred: true,
    });
    expect(isLibrary(createSeed())).toBe(true);
  });
  it("keeps matching cached translations on refresh and invalidates changed source", () => {
    const existing = mergeArticles([], [article], article.feedId);
    existing[0].translation = translate();
    const unchanged = mergeArticles(existing, [article], article.feedId);
    expect(getCachedTranslation(unchanged[0])).toEqual(existing[0].translation);
    for (const field of ["title", "excerpt", "content"] as const) {
      const changed = mergeArticles(
        existing,
        [{ ...article, [field]: "Updated" }],
        article.feedId,
      );
      expect(changed[0].translation).toBeUndefined();
    }
  });
  it("ignores late responses for updated/deleted articles and keeps other feeds isolated", () => {
    const translation = translate();
    const other = { ...article, id: "other", feedId: "other-feed" };
    const updated = { ...article, content: "New content" };
    expect(
      attachTranslation([updated, other], article.id, translation),
    ).toEqual([updated, other]);
    expect(attachTranslation([], article.id, translation)).toEqual([]);
    expect(
      attachTranslation([article, other], article.id, translation)[1]
        .translation,
    ).toBeUndefined();
    expect(translation.source).toBe(translationSource(article));
  });
  it("rejects invalid persisted translations", () => {
    const library = createSeed();
    library.articles[0].translation = { ...translate(), createdAt: "invalid" };
    expect(isLibrary(library)).toBe(false);
  });
});
