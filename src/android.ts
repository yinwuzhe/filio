import { Capacitor, registerPlugin } from "@capacitor/core";
import { App as NativeApp } from "@capacitor/app";
import type { FeedResponse } from "./model";
import type {
  TranslationConfig,
  TranslationConfigInput,
  TranslationRequest,
  TranslationResponse,
} from "./translation";

interface FolioNativePlugin {
  fetchFeed(options: { url: string }): Promise<FeedResponse>;
  openExternal(options: { url: string }): Promise<void>;
  getTranslationConfig(): Promise<TranslationConfig>;
  saveTranslationConfig(
    options: TranslationConfigInput,
  ): Promise<TranslationConfig>;
  clearTranslationConfig(): Promise<TranslationConfig>;
  translateArticle(options: TranslationRequest): Promise<TranslationResponse>;
  cancelTranslation(options: { requestId: string }): Promise<void>;
  shareText(options: { title: string; text: string }): Promise<void>;
}

export function initializeAndroid() {
  if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== "android")
    return;
  const plugin = registerPlugin<FolioNativePlugin>("FolioNative");
  window.folio = Object.freeze({
    platform: "android" as const,
    fetchFeed: (url: string) => plugin.fetchFeed({ url }),
    openExternal: (url: string) => plugin.openExternal({ url }),
    getTranslationConfig: () => plugin.getTranslationConfig(),
    saveTranslationConfig: (options: TranslationConfigInput) =>
      plugin.saveTranslationConfig(options),
    clearTranslationConfig: () => plugin.clearTranslationConfig(),
    translateArticle: (options: TranslationRequest) =>
      plugin.translateArticle(options),
    cancelTranslation: (requestId: string) =>
      plugin.cancelTranslation({ requestId }),
    shareText: (title: string, text: string) =>
      plugin.shareText({ title, text }),
  });
  document.documentElement.dataset.platform = "android";
  void NativeApp.addListener("backButton", () => {
    const event = new Event("folio:back", { cancelable: true });
    if (window.dispatchEvent(event)) void NativeApp.minimizeApp();
  });
  void NativeApp.addListener("appStateChange", ({ isActive }) => {
    document.documentElement.dataset.appActive = String(isActive);
    if (isActive) document.dispatchEvent(new Event("visibilitychange"));
  });
}
