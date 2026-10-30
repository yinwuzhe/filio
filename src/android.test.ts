// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const native = vi.hoisted(() => ({
  isNative: false,
  platform: "web",
  plugin: {
    fetchFeed: vi.fn(),
    openExternal: vi.fn(),
    getTranslationConfig: vi.fn(),
    saveTranslationConfig: vi.fn(),
    clearTranslationConfig: vi.fn(),
    translateArticle: vi.fn(),
    cancelTranslation: vi.fn(),
    shareText: vi.fn(),
  },
  listeners: new Map<string, (value?: unknown) => void>(),
  minimize: vi.fn(),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => native.isNative,
    getPlatform: () => native.platform,
  },
  registerPlugin: () => native.plugin,
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn(async (event, listener) => {
      native.listeners.set(event, listener);
      return { remove: vi.fn() };
    }),
    minimizeApp: () => native.minimize(),
  },
}));
import { initializeAndroid } from "./android";

beforeEach(() => {
  native.isNative = true;
  native.platform = "android";
  native.listeners.clear();
  vi.clearAllMocks();
});
afterEach(() => {
  delete window.folio;
  delete document.documentElement.dataset.platform;
});

describe("Android bridge", () => {
  it("does not replace the desktop bridge or add native behavior on the web", () => {
    native.isNative = false;
    const existing = { platform: undefined } as unknown as Window["folio"];
    window.folio = existing;
    initializeAndroid();
    expect(window.folio).toBe(existing);
    expect(native.listeners.size).toBe(0);
  });
  it("registers all seven app capabilities and native sharing before UI use", async () => {
    initializeAndroid();
    expect(window.folio?.platform).toBe("android");
    expect(Object.isFrozen(window.folio)).toBe(true);
    expect(document.documentElement.dataset.platform).toBe("android");
    await window.folio!.fetchFeed("https://github.blog/feed/");
    expect(native.plugin.fetchFeed).toHaveBeenCalledWith({
      url: "https://github.blog/feed/",
    });
    await window.folio!.cancelTranslation("job-1");
    expect(native.plugin.cancelTranslation).toHaveBeenCalledWith({
      requestId: "job-1",
    });
    const config = {
      baseUrl: "https://api.example.com/v1",
      model: "model",
      apiKey: "test-only",
    };
    await window.folio!.saveTranslationConfig(config);
    expect(native.plugin.saveTranslationConfig).toHaveBeenCalledWith(config);
    await window.folio!.shareText!("Story", "Article text");
    expect(native.plugin.shareText).toHaveBeenCalledWith({
      title: "Story",
      text: "Article text",
    });
  });
  it("does not minimize when the reader handles a back action", () => {
    initializeAndroid();
    const handle = (event: Event) => event.preventDefault();
    window.addEventListener("folio:back", handle);
    native.listeners.get("backButton")?.();
    expect(native.minimize).not.toHaveBeenCalled();
    window.removeEventListener("folio:back", handle);
    native.listeners.get("backButton")?.();
    expect(native.minimize).toHaveBeenCalledOnce();
  });
  it("notifies overdue feed scheduling on foreground without starting work on background", () => {
    const listener = vi.fn();
    document.addEventListener("visibilitychange", listener);
    initializeAndroid();
    native.listeners.get("appStateChange")?.({ isActive: false });
    expect(listener).not.toHaveBeenCalled();
    native.listeners.get("appStateChange")?.({ isActive: true });
    expect(listener).toHaveBeenCalledOnce();
    document.removeEventListener("visibilitychange", listener);
  });
});
