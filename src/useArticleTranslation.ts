import { useCallback, useEffect, useRef, useState } from "react";
import type { Article, Library } from "./model";
import {
  attachTranslation,
  cancelTranslation,
  getCachedTranslation,
  getTranslationConfig,
  prepareTranslation,
  requestTranslation,
  translationSource,
} from "./translation";
import type { Dispatch, SetStateAction } from "react";

interface Job {
  requestId: string;
  articleId: string;
  source: string;
}

export function useArticleTranslation(
  article: Article | undefined,
  setLibrary: Dispatch<SetStateAction<Library>>,
  openSettings: () => void,
) {
  const [shown, setShown] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const active = useRef<Job | null>(null);
  const generation = useRef(0);
  const selected = useRef(article);
  selected.current = article;
  const source = article ? translationSource(article) : "";
  const key = article ? `${article.id}\n${source}` : "";
  const cache = getCachedTranslation(article);
  const translated = shown === key && cache ? cache : undefined;

  const cancel = useCallback(() => {
    generation.current++;
    const current = active.current;
    active.current = null;
    setJob(null);
    if (current) void cancelTranslation(current.requestId).catch(() => {});
  }, []);

  useEffect(() => {
    setShown(null);
    setFailure(null);
    return cancel;
  }, [key, cancel]);

  async function toggle() {
    if (!article) return;
    if (translated) {
      setShown(null);
      return;
    }
    if (cache) {
      setShown(key);
      return;
    }
    if (active.current) return;
    if (!navigator.onLine) {
      setFailure({
        key,
        message: "首次翻译需要联网，已缓存的译文仍可离线阅读。",
      });
      return;
    }
    const current: Job = {
      articleId: article.id,
      source,
      requestId: crypto.randomUUID(),
    };
    const version = ++generation.current;
    active.current = current;
    setJob(current);
    setFailure(null);
    const isCurrent = () =>
      active.current === current && generation.current === version;
    try {
      const config = await getTranslationConfig();
      if (!isCurrent()) return;
      if (!config.configured) {
        openSettings();
        return;
      }
      const prepared = prepareTranslation(article);
      const result = await requestTranslation({
        requestId: current.requestId,
        segments: prepared.segments,
      });
      if (!isCurrent()) return;
      const translation = prepared.finish(result);
      if (
        selected.current?.id !== current.articleId ||
        translationSource(selected.current) !== current.source
      )
        return;
      setLibrary((library) => ({
        ...library,
        articles: attachTranslation(
          library.articles,
          current.articleId,
          translation,
        ),
      }));
      setShown(key);
    } catch (error) {
      if (!isCurrent()) return;
      if ((error as { code?: string }).code === "NOT_CONFIGURED")
        openSettings();
      else if ((error as { code?: string }).code !== "CANCELLED") {
        setFailure({
          key,
          message:
            error instanceof Error ? error.message : "翻译失败，请稍后重试。",
        });
      }
    } finally {
      if (active.current === current) {
        active.current = null;
        setJob(null);
      }
    }
  }

  return {
    translated,
    busy: job?.articleId === article?.id && job?.source === source,
    error: failure?.key === key ? failure.message : "",
    toggle,
    cancel,
  };
}
