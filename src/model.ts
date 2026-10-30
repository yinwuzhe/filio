import {
  isArticleTranslation,
  translationSource,
  type ArticleTranslation,
  type TranslationConfig,
  type TranslationConfigInput,
  type TranslationRequest,
  type TranslationResponse,
} from "./translation";

export interface Feed {
  id: string;
  title: string;
  url: string;
  siteUrl: string;
  category: string;
  color: string;
  icon: string;
  lastFetched?: string;
  error?: string;
}

export interface Article {
  id: string;
  feedId: string;
  title: string;
  url: string;
  author: string;
  publishedAt: string;
  content: string;
  excerpt: string;
  image?: string;
  readingTime: number;
  read: boolean;
  starred: boolean;
  sample?: boolean;
  translation?: ArticleTranslation;
}

export interface FeedResponse {
  title: string;
  url: string;
  siteUrl: string;
  description?: string;
  articles: Omit<Article, "feedId" | "read" | "starred" | "translation">[];
}

export interface Library {
  version: 1;
  feeds: Feed[];
  articles: Article[];
  settings: {
    interval: number;
    fontSize: number;
    theme: "light" | "dark" | "system";
  };
}

export type View =
  | "all"
  | "unread"
  | "starred"
  | "today"
  | `feed:${string}`
  | `category:${string}`;
export const STORAGE_KEY = "folio-library-v1";

export function normalizeUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new Error("Please enter a public HTTP or HTTPS feed URL.");
  }
  url.hash = "";
  return url.href;
}

export function normalizeFeedInput(value: string): string {
  let input = value.replace(
    /^[\s\u200B-\u200F\u2060\uFEFF]+|[\s\u200B-\u200F\u2060\uFEFF]+$/gu,
    "",
  );
  if (!input) throw new Error("请输入订阅地址，例如 github.blog/feed/。");
  if (input.length > 4096)
    throw new Error("订阅地址过长，请检查是否误粘贴了整段文字。");
  if (
    /[\s\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u206F\\]/u.test(
      input,
    )
  ) {
    throw new Error(
      "订阅地址中含有空格、隐藏字符或反斜杠，请重新粘贴完整网址。",
    );
  }
  input = input.replace(/^(https?)[：:][／/]{2}/i, "$1://");
  if (!/^https?:\/\//i.test(input)) {
    const hostWithPort =
      /^(?:[^/:?#@]+\.[^/:?#@]+|\[[0-9a-f:]+\]):\d+(?:[/?#]|$)/i.test(input);
    if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !hostWithPort) {
      throw new Error(
        "订阅地址仅支持 http:// 或 https://，也可以直接填写域名和路径。",
      );
    }
    input = `https://${input}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("订阅地址格式不正确，例如 https://github.blog/feed/。");
  }
  if (
    !url.hostname ||
    (!url.hostname.includes(".") && !url.hostname.startsWith("["))
  ) {
    throw new Error("请输入完整的订阅域名，例如 github.blog/feed/。");
  }
  if (
    url.username ||
    url.password ||
    input
      .slice(input.indexOf("://") + 3)
      .split(/[/?#]/, 1)[0]
      .includes("@")
  ) {
    throw new Error("订阅地址不能包含账号或密码。");
  }
  url.hash = "";
  if (url.href.length > 4096)
    throw new Error("订阅地址过长，请检查是否误粘贴了整段文字。");
  return url.href;
}

export function mergeArticles(
  existing: Article[],
  incoming: FeedResponse["articles"],
  feedId: string,
): Article[] {
  const byId = new Map(existing.map((article) => [article.id, article]));
  for (const item of incoming) {
    const id = `${feedId}::${item.id}`;
    const previous = byId.get(id);
    byId.set(id, {
      ...item,
      id,
      feedId,
      read: previous?.read ?? false,
      starred: previous?.starred ?? false,
      translation:
        previous?.translation?.source === translationSource(item)
          ? previous.translation
          : undefined,
      sample: false,
    });
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
  );
}

export function selectArticles(
  articles: Article[],
  feeds: Feed[],
  view: View,
  query: string,
  unreadOnly: boolean,
  oldest: boolean,
): Article[] {
  const today = new Date().toDateString();
  return articles
    .filter((article) => {
      const feed = feeds.find((item) => item.id === article.feedId);
      if (view === "unread" && article.read) return false;
      if (view === "starred" && !article.starred) return false;
      if (
        view === "today" &&
        new Date(article.publishedAt).toDateString() !== today
      )
        return false;
      if (view.startsWith("feed:") && article.feedId !== view.slice(5))
        return false;
      if (view.startsWith("category:") && feed?.category !== view.slice(9))
        return false;
      if (unreadOnly && article.read) return false;
      return `${article.title} ${article.excerpt} ${article.author} ${feed?.title ?? ""}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
    })
    .sort((a, b) =>
      oldest
        ? Date.parse(a.publishedAt) - Date.parse(b.publishedAt)
        : Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    );
}

export function isLibrary(value: unknown): value is Library {
  if (!value || typeof value !== "object") return false;
  const data = value as Library;
  return (
    data.version === 1 &&
    Array.isArray(data.feeds) &&
    Array.isArray(data.articles) &&
    data.feeds.every(
      (feed) =>
        !!feed &&
        typeof feed === "object" &&
        typeof feed.id === "string" &&
        typeof feed.title === "string" &&
        typeof feed.url === "string" &&
        typeof feed.siteUrl === "string" &&
        typeof feed.category === "string" &&
        typeof feed.icon === "string" &&
        typeof feed.color === "string",
    ) &&
    data.articles.every(
      (article) =>
        !!article &&
        typeof article === "object" &&
        [
          "id",
          "feedId",
          "title",
          "url",
          "content",
          "excerpt",
          "publishedAt",
          "author",
        ].every((key) => typeof article[key as keyof Article] === "string") &&
        Number.isFinite(Date.parse(article.publishedAt)) &&
        typeof article.read === "boolean" &&
        typeof article.starred === "boolean" &&
        Number.isFinite(article.readingTime) &&
        (article.translation === undefined ||
          isArticleTranslation(article.translation)),
    ) &&
    !!data.settings &&
    [0, 5, 15, 30, 60].includes(data.settings.interval) &&
    [16, 18, 20, 22].includes(data.settings.fontSize) &&
    ["light", "dark", "system"].includes(data.settings.theme)
  );
}

export async function fetchFeed(url: string): Promise<FeedResponse> {
  const normalized = normalizeUrl(url);
  if (window.folio) return window.folio.fetchFeed(normalized);
  const response = await fetch(
    `/api/feed?url=${encodeURIComponent(normalized)}`,
    { signal: AbortSignal.timeout(35000) },
  );
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      result.error || "The feed could not be loaded. Please try again.",
    );
  return result;
}

export function openExternal(url: string) {
  try {
    const safe = normalizeUrl(url);
    if (window.folio) void window.folio.openExternal(safe);
    else window.open(safe, "_blank", "noopener,noreferrer");
  } catch {
    /* Invalid links in feeds are intentionally ignored. */
  }
}

declare global {
  interface Window {
    folio?: {
      platform?: "android";
      shareText?: (title: string, text: string) => Promise<void>;
      fetchFeed: (url: string) => Promise<FeedResponse>;
      openExternal: (url: string) => Promise<void>;
      getTranslationConfig: () => Promise<TranslationConfig>;
      saveTranslationConfig: (
        config: TranslationConfigInput,
      ) => Promise<TranslationConfig>;
      clearTranslationConfig: () => Promise<TranslationConfig>;
      translateArticle: (
        request: TranslationRequest,
      ) => Promise<TranslationResponse>;
      cancelTranslation: (requestId: string) => Promise<void>;
    };
  }
}
