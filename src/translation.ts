import DOMPurify from "dompurify";
import type { Article } from "./model";

export interface TranslationConfig {
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  configured: boolean;
  persistence: "encrypted" | "session";
}

export interface TranslationConfigInput {
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface TranslationRequest {
  requestId: string;
  segments: string[];
}

export interface TranslationResponse {
  segments: string[];
  model: string;
  provider: string;
}

export interface ArticleTranslation {
  targetLanguage: "zh-CN";
  source: string;
  title: string;
  excerpt: string;
  content: string;
  model: string;
  provider: string;
  createdAt: string;
}

export function translationSource(
  article: Pick<Article, "title" | "excerpt" | "content">,
): string {
  return JSON.stringify([article.title, article.excerpt, article.content]);
}

export function isArticleTranslation(
  value: unknown,
): value is ArticleTranslation {
  if (!value || typeof value !== "object") return false;
  const item = value as ArticleTranslation;
  return (
    item.targetLanguage === "zh-CN" &&
    [
      "source",
      "title",
      "excerpt",
      "content",
      "model",
      "provider",
      "createdAt",
    ].every(
      (key) => typeof item[key as keyof ArticleTranslation] === "string",
    ) &&
    item.source.length <= 524288 &&
    item.content.length <= 1048576 &&
    item.title.length <= 40000 &&
    item.excerpt.length <= 40000 &&
    Number.isFinite(Date.parse(item.createdAt))
  );
}

export function getCachedTranslation(
  article?: Article,
): ArticleTranslation | undefined {
  return article?.translation?.source ===
    (article ? translationSource(article) : "")
    ? article.translation
    : undefined;
}

export function attachTranslation(
  articles: Article[],
  id: string,
  translation: ArticleTranslation,
): Article[] {
  return articles.map((article) =>
    article.id === id && translationSource(article) === translation.source
      ? { ...article, translation }
      : article,
  );
}

function splitText(text: string): string[] {
  const parts: string[] = [];
  let remaining = text;
  while (remaining.length > 4000) {
    let end = remaining.lastIndexOf(" ", 4000);
    if (end < 2000) end = 4000;
    if (/[\uD800-\uDBFF]/.test(remaining[end - 1])) end--;
    parts.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function prepareTranslation(
  article: Pick<Article, "title" | "excerpt" | "content">,
) {
  const source = translationSource(article);
  if (source.length > 524288)
    throw new Error("这篇文章过长，暂不支持全文翻译。原文仍可正常阅读。");
  const fragment = DOMPurify.sanitize(article.content, {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "style",
      "form",
      "input",
      "button",
      "video",
      "audio",
      "iframe",
    ],
    FORBID_ATTR: ["style", "srcset", "id"],
  });
  const segments: string[] = [];
  const addText = (text: string) => {
    const start = segments.length;
    if (text.trim()) segments.push(...splitText(text));
    return { start, count: segments.length - start, original: text };
  };
  const title = addText(article.title);
  const excerpt = addText(article.excerpt);
  const nodes: {
    node: Text;
    start: number;
    count: number;
    original: string;
  }[] = [];
  const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.parentElement?.closest('pre, code, kbd, samp, [translate="no"]'))
      continue;
    const range = addText(node.data);
    if (range.count) nodes.push({ node, ...range });
  }
  if (!segments.length) throw new Error("这篇文章没有可翻译的文字。");
  if (
    segments.length > 1000 ||
    segments.reduce((sum, text) => sum + text.length, 0) > 40000
  ) {
    throw new Error(
      "这篇文章的文字超过 40,000 字符或段落过多，暂不支持全文翻译。",
    );
  }
  return {
    segments,
    finish(result: TranslationResponse): ArticleTranslation {
      if (
        !Array.isArray(result.segments) ||
        result.segments.length !== segments.length ||
        result.segments.some(
          (text) =>
            typeof text !== "string" || !text.trim() || text.length > 40000,
        ) ||
        typeof result.model !== "string" ||
        typeof result.provider !== "string"
      ) {
        throw new Error("翻译服务返回了不完整的内容，请重试。原文已保留。");
      }
      const translatedText = (range: {
        start: number;
        count: number;
        original: string;
      }) => {
        if (!range.count) return range.original;
        const leading = range.original.match(/^\s*/)?.[0] || "";
        const trailing = range.original.match(/\s*$/)?.[0] || "";
        return (
          leading +
          result.segments
            .slice(range.start, range.start + range.count)
            .map((text) => text.trim())
            .join("") +
          trailing
        );
      };
      for (const range of nodes) range.node.data = translatedText(range);
      const container = document.createElement("div");
      container.append(fragment);
      const translation: ArticleTranslation = {
        targetLanguage: "zh-CN",
        source,
        title: translatedText(title),
        excerpt: translatedText(excerpt),
        content: container.innerHTML,
        model: result.model,
        provider: result.provider,
        createdAt: new Date().toISOString(),
      };
      if (!isArticleTranslation(translation))
        throw new Error("译文过长，无法保存。原文已保留。");
      return translation;
    },
  };
}

async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", "X-Folio-Request": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal || AbortSignal.timeout(10000),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "翻译请求失败，请稍后重试。");
    Object.assign(error, { code: result.code });
    throw error;
  }
  return result;
}

export const getTranslationConfig = () =>
  window.folio
    ? window.folio.getTranslationConfig()
    : api<TranslationConfig>("/api/translation/config");
export const saveTranslationConfig = (config: TranslationConfigInput) =>
  window.folio
    ? window.folio.saveTranslationConfig(config)
    : api<TranslationConfig>("/api/translation/config", "POST", config);
export const clearTranslationConfig = () =>
  window.folio
    ? window.folio.clearTranslationConfig()
    : api<TranslationConfig>("/api/translation/config", "DELETE");
export const requestTranslation = (request: TranslationRequest) =>
  window.folio
    ? window.folio.translateArticle(request)
    : api<TranslationResponse>(
        "/api/translation",
        "POST",
        request,
        AbortSignal.timeout(190000),
      );
export const cancelTranslation = (requestId: string) =>
  window.folio
    ? window.folio.cancelTranslation(requestId)
    : api<void>("/api/translation/cancel", "POST", { requestId });
