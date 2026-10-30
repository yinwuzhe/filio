// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { createSeed } from "./seed";
import type { Article, Library } from "./model";
import { useArticleTranslation } from "./useArticleTranslation";
import { prepareTranslation } from "./translation";

const configured = {
  baseUrl: "https://api.example.com/v1",
  model: "test-model",
  configured: true,
  hasApiKey: true,
  persistence: "encrypted" as const,
};
function bridge() {
  return {
    fetchFeed: vi.fn(),
    openExternal: vi.fn(),
    getTranslationConfig: vi.fn().mockResolvedValue(configured),
    saveTranslationConfig: vi.fn(),
    clearTranslationConfig: vi.fn(),
    translateArticle: vi
      .fn()
      .mockImplementation(async (request) => ({
        segments: request.segments.map(() => "中文译文"),
        model: "test-model",
        provider: "https://api.example.com",
      })),
    cancelTranslation: vi.fn().mockResolvedValue(undefined),
  };
}

function render(initial = createSeed()) {
  const openSettings = vi.fn();
  const hook = renderHook(
    ({ id }: { id: string }) => {
      const [library, setLibrary] = useState<Library>(initial);
      return {
        library,
        setLibrary,
        ...useArticleTranslation(
          library.articles.find((article) => article.id === id),
          setLibrary,
          openSettings,
        ),
      };
    },
    { initialProps: { id: initial.articles[0].id } },
  );
  return { ...hook, openSettings };
}

beforeEach(() => {
  window.folio = bridge();
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
});
afterEach(() => {
  cleanup();
  delete window.folio;
  vi.restoreAllMocks();
});

describe("in-app article translation", () => {
  it("does not submit any content before an explicit click and opens settings when unconfigured", async () => {
    vi.mocked(window.folio!.getTranslationConfig).mockResolvedValue({
      ...configured,
      configured: false,
      hasApiKey: false,
    });
    const { result, openSettings } = render();
    expect(window.folio!.translateArticle).not.toHaveBeenCalled();
    await act(async () => result.current.toggle());
    expect(openSettings).toHaveBeenCalledOnce();
    expect(window.folio!.translateArticle).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });
  it("translates the article, persists a separate cache, and toggles offline without a second request", async () => {
    const { result } = render();
    const original = result.current.library.articles[0].content;
    await act(async () => result.current.toggle());
    expect(result.current.translated?.title).toBe("中文译文");
    expect(result.current.library.articles[0].content).toBe(original);
    expect(result.current.library.articles[0].translation?.title).toBe(
      "中文译文",
    );
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await act(async () => result.current.toggle());
    expect(result.current.translated).toBeUndefined();
    await act(async () => result.current.toggle());
    expect(result.current.translated?.title).toBe("中文译文");
    expect(window.folio!.translateArticle).toHaveBeenCalledOnce();
  });
  it("uses cached translations after restoring the library without needing API settings", async () => {
    const library = createSeed();
    const prepared = prepareTranslation(library.articles[0]);
    library.articles[0].translation = prepared.finish({
      segments: prepared.segments.map(() => "离线译文"),
      model: "test",
      provider: "test",
    });
    const { result } = render(JSON.parse(JSON.stringify(library)));
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await act(async () => result.current.toggle());
    expect(result.current.translated?.title).toBe("离线译文");
    expect(window.folio!.getTranslationConfig).not.toHaveBeenCalled();
    expect(window.folio!.translateArticle).not.toHaveBeenCalled();
  });
  it("rejects offline first-time translation without sending a request", async () => {
    const { result } = render();
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    await act(async () => result.current.toggle());
    expect(result.current.error).toContain("需要联网");
    expect(window.folio!.translateArticle).not.toHaveBeenCalled();
  });
  it("keeps the original on failure and allows explicit retry", async () => {
    const { result } = render();
    vi.mocked(window.folio!.translateArticle).mockRejectedValueOnce(
      new Error("额度不足"),
    );
    await act(async () => result.current.toggle());
    expect(result.current.error).toBe("额度不足");
    expect(result.current.translated).toBeUndefined();
    expect(result.current.library.articles[0].translation).toBeUndefined();
    await act(async () => result.current.toggle());
    expect(result.current.error).toBe("");
    expect(result.current.translated).toBeDefined();
  });
  it("blocks repeated clicks and ignores a late response after article navigation", async () => {
    let resolve!: (value: {
      segments: string[];
      model: string;
      provider: string;
    }) => void;
    let sent: string[] = [];
    vi.mocked(window.folio!.translateArticle).mockImplementation((request) => {
      sent = request.segments;
      return new Promise((done) => {
        resolve = done;
      });
    });
    const { result, rerender } = render();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.toggle();
    });
    await waitFor(() =>
      expect(window.folio!.translateArticle).toHaveBeenCalledOnce(),
    );
    await act(async () => result.current.toggle());
    expect(window.folio!.translateArticle).toHaveBeenCalledOnce();
    rerender({ id: "sample-1" });
    await act(async () => {
      resolve({
        segments: sent.map(() => "迟到的译文"),
        model: "test",
        provider: "test",
      });
      await pending;
    });
    expect(window.folio!.cancelTranslation).toHaveBeenCalledOnce();
    expect(result.current.translated).toBeUndefined();
    expect(
      result.current.library.articles.every((article) => !article.translation),
    ).toBe(true);
  });
  it("cancels work when source content changes during a request", async () => {
    vi.mocked(window.folio!.translateArticle).mockImplementation(
      () => new Promise(() => {}),
    );
    const { result } = render();
    act(() => {
      void result.current.toggle();
    });
    await waitFor(() =>
      expect(window.folio!.translateArticle).toHaveBeenCalledOnce(),
    );
    act(() =>
      result.current.setLibrary((current) => ({
        ...current,
        articles: current.articles.map((article: Article, index) =>
          index ? article : { ...article, content: "Updated content" },
        ),
      })),
    );
    expect(window.folio!.cancelTranslation).toHaveBeenCalledOnce();
    expect(result.current.busy).toBe(false);
  });
  it("can cancel while loading settings without ever submitting article content", async () => {
    let resolve!: (value: typeof configured) => void;
    vi.mocked(window.folio!.getTranslationConfig).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = render();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.toggle();
    });
    act(() => result.current.cancel());
    await act(async () => {
      resolve(configured);
      await pending;
    });
    expect(window.folio!.translateArticle).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });
});
