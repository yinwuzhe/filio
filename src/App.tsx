import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  ArrowDownWideNarrow,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Coffee,
  Download,
  ExternalLink,
  FolderOpen,
  Inbox,
  Languages,
  Leaf,
  LoaderCircle,
  Maximize2,
  Menu,
  Minimize2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Rss,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Star,
  Sun,
  Trash2,
  Type,
  WifiOff,
  X,
} from "lucide-react";
import DOMPurify from "dompurify";
import {
  fetchFeed,
  mergeArticles,
  normalizeFeedInput,
  normalizeUrl,
  openExternal,
  selectArticles,
  type Article,
  type Feed,
  type Library,
  type View,
} from "./model";
import { createSeed } from "./seed";
import { loadLibrary, saveLibrary } from "./storage";
import TranslationSettings from "./TranslationSettings";
import { useArticleTranslation } from "./useArticleTranslation";
import "./translation.css";

function IconButton({
  children,
  label,
  onClick,
  active,
  disabled,
  className = "",
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "active" : ""} ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function FeedIcon({ feed, small = false }: { feed?: Feed; small?: boolean }) {
  return (
    <span
      className={`feed-icon ${small ? "small" : ""} ${feed?.id === "design-milk" ? "milk-icon" : ""}`}
      style={{ background: feed?.color || "#648670" }}
      aria-hidden="true"
    >
      {feed?.icon || <Rss size={12} />}
    </span>
  );
}

function relativeTime(date: string) {
  const hours = Math.max(
    0,
    Math.floor((Date.now() - Date.parse(date)) / 3600000),
  );
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  if (hours < 48) return "Yesterday";
  return new Date(date).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function Modal({
  title,
  subtitle,
  children,
  onClose,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() =>
      ref.current?.querySelector<HTMLElement>("input, select, button")?.focus(),
    );
    function keydown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const controls = ref.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input, select, a[href]",
      );
      if (!controls?.length) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={ref}
      >
        <div className="modal-heading">
          <div className="modal-symbol">
            <Leaf size={23} />
          </div>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={19} />
          </IconButton>
        </div>
        <h2 id="modal-title">{title}</h2>
        <p className="modal-subtitle">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export default function App() {
  const [library, setLibrary] = useState<Library>(createSeed);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [storageError, setStorageError] = useState("");
  const [view, setView] = useState<View>("all");
  const [selectedId, setSelectedId] = useState("sample-0");
  const [query, setQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [oldest, setOldest] = useState(false);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [modal, setModal] = useState<
    "add" | "settings" | "manage" | "remove" | "translation" | null
  >(null);
  const [removeId, setRemoveId] = useState("");
  const [feedUrl, setFeedUrl] = useState("");
  const [feedCategory, setFeedCategory] = useState("Design & inspiration");
  const [addError, setAddError] = useState("");
  const [adding, setAdding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [toast, setToast] = useState("");
  const [focus, setFocus] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileReader, setMobileReader] = useState(false);
  const [readerMenu, setReaderMenu] = useState<"more" | "type" | null>(null);
  const [progress, setProgress] = useState(0);
  const libraryRef = useRef(library);
  const refreshLock = useRef(false);
  const addLock = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  libraryRef.current = library;
  const closeModal = useCallback(() => setModal(null), []);

  useEffect(() => {
    if (window.folio?.platform !== "android") return;
    const onBack = (event: Event) => {
      if (modal) {
        event.preventDefault();
        setModal(null);
      } else if (readerMenu) {
        event.preventDefault();
        setReaderMenu(null);
      } else if (sidebarOpen) {
        event.preventDefault();
        setSidebarOpen(false);
      } else if (focus) {
        event.preventDefault();
        setFocus(false);
      } else if (mobileReader) {
        event.preventDefault();
        setMobileReader(false);
      }
    };
    const onExternalError = () => setToast("没有可用的应用来打开此内容。");
    window.addEventListener("folio:back", onBack);
    window.addEventListener("folio:external-error", onExternalError);
    return () => {
      window.removeEventListener("folio:back", onBack);
      window.removeEventListener("folio:external-error", onExternalError);
    };
  }, [modal, readerMenu, sidebarOpen, focus, mobileReader]);

  useEffect(() => {
    let alive = true;
    loadLibrary()
      .then((stored) => {
        if (alive) {
          if (stored) setLibrary(stored);
          setReady(true);
        }
      })
      .catch((error) => {
        if (alive) setStorageError(error.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setSaved(false);
    saveLibrary(library)
      .then(() => {
        if (alive) {
          setSaved(true);
          setStorageError("");
        }
      })
      .catch((error) => {
        if (alive) setStorageError(error.message);
      });
    return () => {
      alive = false;
    };
  }, [library, ready]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => {
      document.documentElement.dataset.theme =
        library.settings.theme === "system"
          ? media.matches
            ? "dark"
            : "light"
          : library.settings.theme;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [library.settings.theme]);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(""), 4200);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const categories = [...new Set(library.feeds.map((feed) => feed.category))];
  const unread = library.articles.filter((article) => !article.read).length;
  const starred = library.articles.filter((article) => article.starred).length;
  const today = library.articles.filter(
    (article) =>
      new Date(article.publishedAt).toDateString() ===
      new Date().toDateString(),
  ).length;
  const visible = useMemo(
    () =>
      selectArticles(
        library.articles,
        library.feeds,
        view,
        query,
        unreadOnly,
        oldest,
      ),
    [library.articles, library.feeds, view, query, unreadOnly, oldest],
  );
  const selected =
    library.articles.find((article) => article.id === selectedId) || visible[0];
  const activeFeed = library.feeds.find((feed) => feed.id === selected?.feedId);
  const viewFeed = view.startsWith("feed:")
    ? library.feeds.find((feed) => feed.id === view.slice(5))
    : undefined;
  const viewTitle =
    viewFeed?.title ||
    (view.startsWith("category:")
      ? view.slice(9)
      : (
          {
            all: "All articles",
            unread: "Unread",
            starred: "Starred",
            today: "Today",
          } as Record<string, string>
        )[view]);
  const translation = useArticleTranslation(selected, setLibrary, () =>
    setModal("translation"),
  );
  const displayed = translation.translated || selected;
  const safeContent = useMemo(() => {
    const fragment = DOMPurify.sanitize(displayed?.content || "", {
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
    fragment.querySelectorAll("img").forEach((image) => {
      try {
        image.src = normalizeUrl(
          new URL(image.getAttribute("src") || "", selected?.url).href,
        );
        image.loading = "lazy";
        image.referrerPolicy = "no-referrer";
      } catch {
        image.remove();
      }
    });
    const container = document.createElement("div");
    container.append(fragment);
    return container.innerHTML;
  }, [displayed?.content, selected?.url]);

  useEffect(() => {
    readerRef.current?.scrollTo({ top: 0 });
    setProgress(0);
    setReaderMenu(null);
  }, [selected?.id]);

  useEffect(() => {
    if (
      !ready ||
      !selected ||
      selected.read ||
      (!mobileReader &&
        window.innerWidth <= (window.folio?.platform === "android" ? 899 : 680))
    )
      return;
    const id = selected.id;
    const timer = setTimeout(() => {
      setSelectedId(id);
      setLibrary((current) => {
        if (current.articles.find((article) => article.id === id)?.read)
          return current;
        return {
          ...current,
          articles: current.articles.map((article) =>
            article.id === id ? { ...article, read: true } : article,
          ),
        };
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [selected?.id, ready, mobileReader]);

  function updateQuery(value: string) {
    setQuery(value);
    setSelectedId("");
  }

  function patchArticle(id: string, patch: Partial<Article>) {
    setLibrary((current) => ({
      ...current,
      articles: current.articles.map((article) =>
        article.id === id ? { ...article, ...patch } : article,
      ),
    }));
  }
  function chooseArticle(article: Article) {
    setSelectedId(article.id);
    patchArticle(article.id, { read: true });
    setMobileReader(true);
  }
  function navigate(next: View) {
    setView(next);
    setQuery("");
    setUnreadOnly(false);
    setSelectedId("");
    setSidebarOpen(false);
    setMobileReader(false);
  }
  function setSetting<K extends keyof Library["settings"]>(
    key: K,
    value: Library["settings"][K],
  ) {
    setLibrary((current) => ({
      ...current,
      settings: { ...current.settings, [key]: value },
    }));
  }

  const refresh = useCallback(async (onlyId?: string, silent = false) => {
    if (refreshLock.current) return;
    if (!navigator.onLine) {
      if (!silent)
        setToast("You’re offline. Your saved articles are still here.");
      return;
    }
    const feeds = libraryRef.current.feeds.filter(
      (feed) => !onlyId || feed.id === onlyId,
    );
    if (!feeds.length) {
      if (!silent) setToast("Add a feed to start your reading collection.");
      return;
    }
    refreshLock.current = true;
    setRefreshing(true);
    let success = 0;
    let failed = 0;
    try {
      for (let i = 0; i < feeds.length; i += 3) {
        await Promise.all(
          feeds.slice(i, i + 3).map(async (feed) => {
            try {
              const result = await fetchFeed(feed.url);
              success++;
              setLibrary((current) => {
                if (!current.feeds.some((item) => item.id === feed.id))
                  return current;
                const existing = result.articles.length
                  ? current.articles.filter(
                      (article) =>
                        article.feedId !== feed.id ||
                        !article.sample ||
                        article.starred,
                    )
                  : current.articles;
                return {
                  ...current,
                  feeds: current.feeds.map((item) =>
                    item.id === feed.id
                      ? {
                          ...item,
                          lastFetched: new Date().toISOString(),
                          error: undefined,
                        }
                      : item,
                  ),
                  articles: mergeArticles(existing, result.articles, feed.id),
                };
              });
            } catch (error) {
              failed++;
              setLibrary((current) => ({
                ...current,
                feeds: current.feeds.map((item) =>
                  item.id === feed.id
                    ? {
                        ...item,
                        error:
                          error instanceof Error
                            ? error.message
                            : "Could not refresh feed.",
                      }
                    : item,
                ),
              }));
            }
          }),
        );
      }
      if (!silent || failed)
        setToast(
          failed
            ? `${success} ${success === 1 ? "feed" : "feeds"} updated · ${failed} couldn’t connect. Details in Manage feeds.`
            : `All caught up. ${success} ${success === 1 ? "feed" : "feeds"} refreshed.`,
        );
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || !library.settings.interval) return;
    const timer = setInterval(() => {
      if (
        window.folio?.platform === "android" &&
        (document.visibilityState !== "visible" ||
          document.documentElement.dataset.appActive === "false")
      )
        return;
      void refresh(undefined, true);
    }, library.settings.interval * 60000);
    const onWake = () => {
      const feeds = libraryRef.current.feeds;
      const overdue = feeds.some(
        (feed) =>
          feed.lastFetched &&
          Date.now() - Date.parse(feed.lastFetched) >
            libraryRef.current.settings.interval * 60000,
      );
      if (document.visibilityState === "visible" && overdue)
        void refresh(undefined, true);
    };
    document.addEventListener("visibilitychange", onWake);
    window.addEventListener("online", onWake);
    onWake();
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onWake);
      window.removeEventListener("online", onWake);
    };
  }, [library.settings.interval, ready, refresh]);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (
        !ready ||
        modal ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "r") {
        event.preventDefault();
        void refresh();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "n") {
        event.preventDefault();
        setAddError("");
        setModal("add");
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        setFocus(false);
        setReaderMenu(null);
        setMobileReader(false);
      }
      if (event.key === "s" && selected) {
        event.preventDefault();
        patchArticle(selected.id, { starred: !selected.starred });
      }
      if (event.key === "m" && selected) {
        event.preventDefault();
        patchArticle(selected.id, { read: !selected.read });
      }
      if (event.key === "j" || event.key === "k") {
        const index = visible.findIndex(
          (article) => article.id === selected?.id,
        );
        const next = visible[index + (event.key === "j" ? 1 : -1)];
        if (next) {
          event.preventDefault();
          chooseArticle(next);
        }
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  async function addFeed(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (addLock.current) return;
    const submitted = new FormData(event.currentTarget).get("feedUrl");
    const input = typeof submitted === "string" ? submitted : "";
    setFeedUrl(input);
    setAddError("");
    let url: string;
    try {
      url = normalizeFeedInput(input);
    } catch (error) {
      setAddError(
        error instanceof Error
          ? error.message
          : "订阅地址格式不正确，请重新输入。",
      );
      return;
    }
    setFeedUrl(url);
    if (libraryRef.current.feeds.some((feed) => feed.url === url)) {
      setAddError("This feed is already in your library.");
      return;
    }
    if (!navigator.onLine) {
      setAddError("Connect to the internet to add a new feed.");
      return;
    }
    addLock.current = true;
    setAdding(true);
    try {
      const result = await fetchFeed(url);
      const id = crypto.randomUUID();
      const feed: Feed = {
        id,
        title: result.title || new URL(url).hostname,
        url,
        siteUrl: result.siteUrl,
        category: feedCategory,
        color: "#54775f",
        icon: (result.title || new URL(url).hostname).slice(0, 1).toUpperCase(),
        lastFetched: new Date().toISOString(),
      };
      setLibrary((current) => ({
        ...current,
        feeds: [...current.feeds, feed],
        articles: mergeArticles(current.articles, result.articles, id),
      }));
      setModal(null);
      setFeedUrl("");
      navigate(`feed:${id}`);
      setToast(`Welcome to your library, ${feed.title}.`);
    } catch (error) {
      setAddError(
        error instanceof Error
          ? error.message
          : "This feed couldn’t be loaded. Please check the URL.",
      );
    } finally {
      addLock.current = false;
      setAdding(false);
    }
  }

  function markVisibleRead() {
    const ids = new Set(visible.map((article) => article.id));
    setLibrary((current) => ({
      ...current,
      articles: current.articles.map((article) =>
        ids.has(article.id) ? { ...article, read: true } : article,
      ),
    }));
    setToast("A clean slate. These articles are marked as read.");
  }

  function removeFeed() {
    const title = library.feeds.find((feed) => feed.id === removeId)?.title;
    setLibrary((current) => ({
      ...current,
      feeds: current.feeds.filter((feed) => feed.id !== removeId),
      articles: current.articles.filter(
        (article) => article.feedId !== removeId,
      ),
    }));
    setModal("manage");
    navigate("all");
    setToast(`${title} was removed from your library.`);
  }

  function exportArticle() {
    if (!selected) return;
    const text = `${selected.title}\n${selected.author}\n${selected.url}\n\n${DOMPurify.sanitize(selected.content, { ALLOWED_TAGS: [], ALLOWED_ATTR: [] })}`;
    if (window.folio?.shareText) {
      void window.folio
        .shareText(selected.title, text)
        .catch(() => setToast("文章分享失败，请稍后重试。"));
      setReaderMenu(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${selected.title.replace(/[^a-zA-Z0-9 -]/g, "").slice(0, 80) || "article"}.txt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setReaderMenu(null);
    setToast("Your article has been exported.");
  }

  const lastFetched = library.feeds
    .map((feed) => feed.lastFetched)
    .filter(Boolean)
    .sort()
    .at(-1);
  const selectedIndex = visible.findIndex(
    (article) => article.id === selected?.id,
  );
  return (
    <div
      inert={!ready}
      aria-busy={!ready}
      className={`app ${focus ? "focus-mode" : ""} ${sidebarOpen ? "sidebar-open" : ""} ${mobileReader ? "mobile-reading" : ""} ${window.folio?.platform === "android" ? "android-app" : window.folio ? "desktop-app" : ""}`}
    >
      <aside className="sidebar">
        <div className="window-bar">
          <span className="traffic-light red" />
          <span className="traffic-light yellow" />
          <span className="traffic-light green" />
          <span className="window-grip" />
        </div>
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate("all");
          }}
        >
          <span className="brand-icon">
            <BookOpen size={23} strokeWidth={1.6} />
            <span />
          </span>
          <span>
            folio<span className="brand-dot">.</span>
          </span>
        </a>
        <p className="brand-tagline">A little room for curiosity.</p>
        <nav className="main-nav" aria-label="Library">
          {(
            [
              {
                id: "all",
                label: "All articles",
                icon: Inbox,
                count: library.articles.length,
              },
              { id: "unread", label: "Unread", icon: Circle, count: unread },
              { id: "starred", label: "Starred", icon: Star, count: starred },
              { id: "today", label: "Today", icon: Sun, count: today },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              className={`nav-item ${view === item.id ? "selected" : ""}`}
              onClick={() => navigate(item.id)}
            >
              <item.icon size={18} strokeWidth={1.65} />
              <span>{item.label}</span>
              <span className="nav-count">{item.count}</span>
            </button>
          ))}
        </nav>
        <div className="feeds-section">
          <div className="section-label">
            <span>YOUR FEEDS</span>
            <IconButton label="Manage feeds" onClick={() => setModal("manage")}>
              <SlidersHorizontal size={14} />
            </IconButton>
          </div>
          <div className="feed-groups">
            {categories.map((category) => (
              <div className="feed-group" key={category}>
                <div className="group-heading">
                  <button
                    aria-label={`${collapsed.includes(category) ? "Expand" : "Collapse"} ${category}`}
                    aria-expanded={!collapsed.includes(category)}
                    onClick={() =>
                      setCollapsed((current) =>
                        current.includes(category)
                          ? current.filter((item) => item !== category)
                          : [...current, category],
                      )
                    }
                  >
                    <ChevronDown
                      size={13}
                      className={
                        collapsed.includes(category) ? "collapsed" : ""
                      }
                    />
                  </button>
                  <button
                    className={
                      view === `category:${category}` ? "category-active" : ""
                    }
                    onClick={() => navigate(`category:${category}`)}
                  >
                    {category}
                  </button>
                </div>
                {!collapsed.includes(category) &&
                  library.feeds
                    .filter((feed) => feed.category === category)
                    .map((feed) => (
                      <button
                        className={`feed-item ${view === `feed:${feed.id}` ? "selected" : ""}`}
                        key={feed.id}
                        onClick={() => navigate(`feed:${feed.id}`)}
                        title={feed.error || feed.title}
                      >
                        <FeedIcon feed={feed} />
                        <span>{feed.title}</span>
                        {feed.error ? (
                          <span
                            className="feed-error-dot"
                            aria-label="Feed update failed"
                          />
                        ) : (
                          <span className="feed-count">
                            {library.articles.filter(
                              (article) =>
                                article.feedId === feed.id && !article.read,
                            ).length || ""}
                          </span>
                        )}
                      </button>
                    ))}
              </div>
            ))}
          </div>
        </div>
        <button
          className="add-feed-button"
          onClick={() => {
            setAddError("");
            setModal("add");
          }}
        >
          <Plus size={17} />
          <span>Add a feed</span>
          <kbd>⌘ N</kbd>
        </button>
        <div className="sidebar-bottom">
          <div className="offline-note">
            <span className={`status-dot ${storageError ? "warning" : ""}`} />
            <span>
              {storageError
                ? "Cache unavailable"
                : saved
                  ? "Your reads, ready offline"
                  : "Saving your library…"}
            </span>
            <Leaf size={13} />
          </div>
          <div className="sidebar-bottom-row">
            <button
              className="sync-status"
              onClick={() => void refresh()}
              disabled={refreshing}
            >
              <RefreshCw size={13} className={refreshing ? "spinning" : ""} />
              <span>
                {refreshing
                  ? "Refreshing feeds…"
                  : !online
                    ? "Reading offline"
                    : lastFetched
                      ? `Updated ${relativeTime(lastFetched).toLowerCase()}`
                      : "Ready when you are"}
              </span>
            </button>
            <IconButton label="Settings" onClick={() => setModal("settings")}>
              <Settings2 size={17} />
            </IconButton>
          </div>
        </div>
      </aside>
      {sidebarOpen && (
        <button
          className="sidebar-overlay"
          aria-label="Close sidebar"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <section className="article-panel" aria-label="Article list">
        <header className="list-header">
          <div className="list-heading">
            <IconButton
              label="Toggle sidebar"
              className="mobile-menu"
              onClick={() => setSidebarOpen(!sidebarOpen)}
            >
              <Menu size={19} />
            </IconButton>
            <h1>{viewTitle}</h1>
            <span className="total-badge">{visible.length}</span>
            <IconButton
              label="Refresh feeds"
              onClick={() => void refresh(viewFeed?.id)}
              disabled={refreshing}
            >
              <RefreshCw size={17} className={refreshing ? "spinning" : ""} />
            </IconButton>
          </div>
          <p>Your favorite corners of the internet.</p>
          <div className="search-field">
            <Search size={16} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => updateQuery(event.target.value)}
              placeholder="Search articles…"
              aria-label="Search articles"
            />
            {query ? (
              <button aria-label="Clear search" onClick={() => updateQuery("")}>
                <X size={14} />
              </button>
            ) : (
              <kbd>⌘ K</kbd>
            )}
          </div>
          <div className="list-controls">
            <div className="segmented-control">
              <button
                className={!unreadOnly ? "selected" : ""}
                onClick={() => setUnreadOnly(false)}
              >
                All
              </button>
              <button
                className={unreadOnly ? "selected" : ""}
                onClick={() => setUnreadOnly(true)}
              >
                Unread
                <span>
                  {
                    selectArticles(
                      library.articles,
                      library.feeds,
                      view,
                      query,
                      true,
                      oldest,
                    ).length
                  }
                </span>
              </button>
            </div>
            <div className="list-control-actions">
              <IconButton
                label={oldest ? "Sort newest first" : "Sort oldest first"}
                active={oldest}
                onClick={() => setOldest(!oldest)}
              >
                <ArrowDownWideNarrow size={17} />
              </IconButton>
              <IconButton
                label="Mark all listed articles as read"
                disabled={!visible.some((article) => !article.read)}
                onClick={markVisibleRead}
              >
                <CheckCheck size={17} />
              </IconButton>
            </div>
          </div>
        </header>
        <div className="articles-scroll">
          {visible.length > 0 ? (
            <>
              <div className="date-divider">
                <span>
                  {query
                    ? "SEARCH RESULTS"
                    : oldest
                      ? "OLDEST FIRST"
                      : view === "starred"
                        ? "SAVED FOR A MOMENT LIKE THIS"
                        : "THE LATEST"}
                </span>
                <span>
                  {new Date().toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
              {visible.map((article) => {
                const feed = library.feeds.find(
                  (item) => item.id === article.feedId,
                );
                return (
                  <button
                    key={`${article.feedId}:${article.id}`}
                    className={`article-card ${selected?.id === article.id ? "selected" : ""} ${article.read ? "is-read" : ""}`}
                    onClick={() => chooseArticle(article)}
                    aria-current={
                      selected?.id === article.id ? "true" : undefined
                    }
                  >
                    <div className="article-source">
                      <FeedIcon feed={feed} small />
                      <span>{feed?.title}</span>
                      <span className="article-time">
                        {relativeTime(article.publishedAt)}
                      </span>
                      {!article.read && <span className="unread-dot" />}
                    </div>
                    <div className="article-card-content">
                      <div>
                        <h2>{article.title}</h2>
                        <p>{article.excerpt}</p>
                      </div>
                      {article.image && (
                        <img
                          src={article.image}
                          alt=""
                          loading="lazy"
                          onError={(event) => {
                            event.currentTarget.style.display = "none";
                          }}
                        />
                      )}
                    </div>
                    <div className="article-card-footer">
                      <span>{article.readingTime} min read</span>
                      {article.starred && (
                        <Star size={12} fill="currentColor" />
                      )}{" "}
                      {selected?.id === article.id && (
                        <span className="reading-label">
                          Reading now <BookOpen size={11} />
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
              <div className="list-end">
                <Leaf size={16} />
                <span>You’ve found a little breathing room.</span>
              </div>
            </>
          ) : (
            <div className="empty-state">
              <div className="empty-icon">
                {query ? (
                  <Search />
                ) : view === "starred" ? (
                  <Star />
                ) : (
                  <Coffee />
                )}
              </div>
              <h3>
                {query
                  ? "No stories found"
                  : view === "starred"
                    ? "Keep the good ones"
                    : "A little breathing room"}
              </h3>
              <p>
                {query
                  ? "Try a different title, topic, or publication."
                  : view === "starred"
                    ? "Star an article to save it for another moment."
                    : "You’re all caught up. Find something new or enjoy the quiet."}
              </p>
              <button
                className="secondary-button"
                onClick={() => {
                  if (query) setQuery("");
                  else navigate("all");
                }}
              >
                {query ? "Clear search" : "Explore all articles"}
                <ArrowRight size={15} />
              </button>
            </div>
          )}
        </div>
        <footer className="list-footer">
          <span>
            <span className="status-dot" />
            {visible.filter((article) => !article.read).length} unread articles
          </span>
          <span>Make time for a good read.</span>
        </footer>
      </section>
      <main className="reader-panel">
        <header className="reader-toolbar">
          <div className="reader-toolbar-left">
            <IconButton
              label="Back to articles"
              className="reader-back"
              onClick={() => {
                setFocus(false);
                setMobileReader(false);
              }}
            >
              <ArrowLeft size={18} />
            </IconButton>
            {activeFeed ? (
              <>
                <FeedIcon feed={activeFeed} small />
                <button
                  className="reader-source"
                  onClick={() => navigate(`feed:${activeFeed.id}`)}
                >
                  {activeFeed.title}
                </button>
                <ChevronRight size={12} className="muted" />
                <span className="reader-context">
                  {selected?.sample ? "Sample edition" : "Article"}
                </span>
              </>
            ) : (
              <span className="reader-context">Your reading space</span>
            )}
          </div>
          <div className="reader-actions">
            <button
              className={`translate-button ${translation.translated ? "active" : ""}`}
              disabled={!selected || translation.busy}
              onClick={() => void translation.toggle()}
              aria-label={
                translation.busy
                  ? "正在翻译"
                  : translation.translated
                    ? "显示原文"
                    : "翻译为中文"
              }
              aria-pressed={!!translation.translated}
              title={
                translation.translated
                  ? "显示英文原文"
                  : "将标题与正文翻译为简体中文"
              }
            >
              {translation.busy ? (
                <LoaderCircle size={16} className="spinning" />
              ) : (
                <Languages size={17} />
              )}
              <span>
                {translation.busy
                  ? "翻译中…"
                  : translation.translated
                    ? "显示原文"
                    : "翻译为中文"}
              </span>
            </button>
            <div className="popover-anchor">
              <IconButton
                label="Reading appearance"
                active={readerMenu === "type"}
                onClick={() =>
                  setReaderMenu(readerMenu === "type" ? null : "type")
                }
              >
                <Type size={19} />
              </IconButton>
              {readerMenu === "type" && (
                <div className="popover appearance-popover">
                  <span className="popover-label">TEXT SIZE</span>
                  <div className="font-sizes">
                    {[16, 18, 20, 22].map((size) => (
                      <button
                        key={size}
                        className={
                          library.settings.fontSize === size ? "selected" : ""
                        }
                        style={{ fontSize: size }}
                        onClick={() => setSetting("fontSize", size)}
                      >
                        A
                      </button>
                    ))}
                  </div>
                  <span className="popover-label">APPEARANCE</span>
                  <select
                    aria-label="Color theme"
                    value={library.settings.theme}
                    onChange={(event) =>
                      setSetting(
                        "theme",
                        event.target.value as Library["settings"]["theme"],
                      )
                    }
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="system">System</option>
                  </select>
                </div>
              )}
            </div>
            <IconButton
              label={
                selected?.starred ? "Unstar article (S)" : "Star article (S)"
              }
              active={selected?.starred}
              disabled={!selected}
              onClick={() =>
                selected &&
                patchArticle(selected.id, { starred: !selected.starred })
              }
            >
              <Star
                size={18}
                fill={selected?.starred ? "currentColor" : "none"}
              />
            </IconButton>
            <IconButton
              label={selected?.read ? "Mark as unread (M)" : "Mark as read (M)"}
              active={selected?.read}
              disabled={!selected}
              onClick={() =>
                selected && patchArticle(selected.id, { read: !selected.read })
              }
            >
              {selected?.read ? <CheckCheck size={19} /> : <Check size={19} />}
            </IconButton>
            <span className="toolbar-divider" />
            <IconButton
              label="Open original in browser"
              disabled={!selected}
              onClick={() => selected && openExternal(selected.url)}
            >
              <ExternalLink size={17} />
            </IconButton>
            <div className="popover-anchor">
              <IconButton
                label="More article actions"
                active={readerMenu === "more"}
                onClick={() =>
                  setReaderMenu(readerMenu === "more" ? null : "more")
                }
              >
                <MoreHorizontal size={20} />
              </IconButton>
              {readerMenu === "more" && (
                <div className="popover action-popover">
                  <button
                    onClick={() => {
                      setFocus(!focus);
                      setReaderMenu(null);
                    }}
                  >
                    {focus ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
                    {focus ? "Exit focus mode" : "Focus mode"}
                  </button>
                  <button disabled={!selected} onClick={exportArticle}>
                    <Download size={16} />
                    Export article as text
                  </button>
                  <button
                    onClick={() => {
                      setModal("settings");
                      setReaderMenu(null);
                    }}
                  >
                    <Settings2 size={16} />
                    Reader settings
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>
        {selected &&
          (translation.busy || translation.error || translation.translated) && (
            <div
              className={`translation-banner ${translation.error ? "is-error" : ""}`}
              role={translation.error ? "alert" : "status"}
            >
              {translation.busy ? (
                <LoaderCircle size={15} className="spinning" />
              ) : (
                <Languages size={15} />
              )}
              <span>
                {translation.busy
                  ? "正在翻译标题与正文… 原文仍可阅读，切换文章将取消翻译。"
                  : translation.error ||
                    `简体中文 · 机器翻译仅供参考 · ${saved ? "已缓存，可离线阅读" : "正在保存译文"}`}
              </span>
              {translation.busy ? (
                <button onClick={translation.cancel}>取消</button>
              ) : translation.error ? (
                <button onClick={() => void translation.toggle()}>重试</button>
              ) : (
                <button onClick={() => void translation.toggle()}>
                  显示原文
                </button>
              )}
              {!translation.busy && (
                <button onClick={() => setModal("translation")}>
                  翻译设置
                </button>
              )}
            </div>
          )}
        {storageError && (
          <div className="connection-banner error-banner">
            <WifiOff size={14} />
            {storageError}
          </div>
        )}
        {!online && !storageError && (
          <div className="connection-banner">
            <WifiOff size={14} />
            You’re offline. Settle in with your saved articles.
          </div>
        )}
        {selected ? (
          <>
            <div
              className="reader-scroll"
              ref={readerRef}
              onScroll={(event) => {
                const el = event.currentTarget;
                const total = el.scrollHeight - el.clientHeight;
                setProgress(
                  total > 0 ? Math.round((el.scrollTop / total) * 100) : 100,
                );
              }}
            >
              <article
                className="reading-content"
                lang={translation.translated ? "zh-CN" : undefined}
                style={
                  {
                    "--reading-font-size": `${library.settings.fontSize}px`,
                  } as React.CSSProperties
                }
              >
                <div className="article-eyebrow">
                  <span />
                  {activeFeed?.category === "Design & inspiration"
                    ? "DESIGN & LIVING"
                    : (
                        activeFeed?.category || "FROM YOUR LIBRARY"
                      ).toUpperCase()}
                </div>
                <h1>{displayed?.title}</h1>
                <p className="article-deck">{displayed?.excerpt}</p>
                <div className="author-row">
                  <span className="author-avatar">
                    {selected.author.slice(0, 1).toUpperCase() || "F"}
                  </span>
                  <div>
                    <span className="author-name">
                      {selected.author || activeFeed?.title}
                    </span>
                    <div className="article-meta">
                      <time>
                        {new Date(selected.publishedAt).toLocaleDateString(
                          "en-US",
                          { month: "long", day: "numeric", year: "numeric" },
                        )}
                      </time>
                      <span>·</span>
                      <span>{selected.readingTime} min read</span>
                    </div>
                  </div>
                  <span
                    className="reader-saved"
                    title={
                      saved
                        ? "Article text is saved on this device"
                        : "Saving article text"
                    }
                  >
                    <span className="status-dot" />
                    {saved ? "Saved offline" : "Saving…"}
                  </span>
                </div>
                {selected.image && (
                  <figure className="hero-figure">
                    <img
                      className="article-hero"
                      src={selected.image}
                      alt={
                        selected.sample
                          ? "An editorial photograph accompanying this sample story"
                          : ""
                      }
                      onError={(event) => {
                        event.currentTarget.closest("figure")!.style.display =
                          "none";
                      }}
                    />
                    {selected.id === "sample-0" && (
                      <figcaption>
                        A little space. A little light. A different pace.
                      </figcaption>
                    )}
                  </figure>
                )}
                <div
                  className="article-body"
                  dangerouslySetInnerHTML={{ __html: safeContent }}
                  onClick={(event) => {
                    const anchor = (event.target as HTMLElement).closest("a");
                    if (anchor) {
                      event.preventDefault();
                      try {
                        openExternal(
                          new URL(
                            anchor.getAttribute("href") || "",
                            selected.url,
                          ).href,
                        );
                      } catch {
                        setToast("This article link is not valid.");
                      }
                    }
                  }}
                />
                {selected.sample && (
                  <div className="sample-note">
                    <Sparkles size={16} />
                    <p>
                      A little taste of Folio. This is an original sample
                      article, not a published story from {activeFeed?.title}.
                      Refresh your feeds to read the latest.
                    </p>
                  </div>
                )}
                <div className="article-ending">
                  <Leaf size={23} strokeWidth={1.3} />
                  <span>A moment well spent.</span>
                </div>
                <div className="article-end-actions">
                  <button
                    className="secondary-button"
                    onClick={() =>
                      patchArticle(selected.id, { starred: !selected.starred })
                    }
                  >
                    <Star
                      size={16}
                      fill={selected.starred ? "currentColor" : "none"}
                    />
                    {selected.starred ? "Saved to starred" : "Keep this story"}
                  </button>
                  <button
                    className="text-button"
                    onClick={() => openExternal(selected.url)}
                  >
                    Visit {activeFeed?.title}
                    <ArrowUpRight size={16} />
                  </button>
                </div>
              </article>
            </div>
            <footer className="reader-footer">
              <div>
                <span className="keyboard-hint">
                  <kbd>J</kbd>
                  <kbd>K</kbd> to navigate
                </span>
                <span className="footer-dot">·</span>
                <span>
                  {progress < 5
                    ? "Enjoy a moment of focus."
                    : `${progress}% read`}
                </span>
              </div>
              <div className="reader-pagination">
                <span>
                  {selectedIndex >= 0
                    ? `${selectedIndex + 1} of ${visible.length}`
                    : `${visible.length} remaining`}
                </span>
                <IconButton
                  label="Previous article (K)"
                  disabled={selectedIndex <= 0}
                  onClick={() =>
                    visible[selectedIndex - 1] &&
                    chooseArticle(visible[selectedIndex - 1])
                  }
                >
                  <ChevronLeft size={17} />
                </IconButton>
                <IconButton
                  label="Next article (J)"
                  disabled={selectedIndex >= visible.length - 1}
                  onClick={() =>
                    visible[selectedIndex + 1] &&
                    chooseArticle(visible[selectedIndex + 1])
                  }
                >
                  <ChevronRight size={17} />
                </IconButton>
              </div>
              <div
                className="reading-progress"
                style={{ width: `${progress}%` }}
              />
            </footer>
          </>
        ) : (
          <div className="reader-empty">
            <div className="empty-icon">
              <BookOpen size={31} />
            </div>
            <h2>A little room for curiosity.</h2>
            <p>Pick a story, settle in, and make yourself at home.</p>
            <button
              className="secondary-button"
              onClick={() => {
                setAddError("");
                setModal("add");
              }}
            >
              <Plus size={16} />
              Find your next favorite feed
            </button>
          </div>
        )}
      </main>
      {modal === "add" && (
        <Modal
          title="A new corner of the internet."
          subtitle="Bring your favorite publications, blogs, and ideas together."
          onClose={closeModal}
        >
          <form onSubmit={addFeed} noValidate>
            <label className="field-label" htmlFor="feed-url">
              RSS or Atom feed URL
            </label>
            <div className="modal-input">
              <Rss size={17} />
              <input
                id="feed-url"
                name="feedUrl"
                type="text"
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="go"
                required
                aria-describedby="feed-url-hint"
                aria-invalid={!!addError}
                placeholder="github.blog/feed/ 或 https://…"
                value={feedUrl}
                onChange={(event) => setFeedUrl(event.target.value)}
                disabled={adding}
              />
            </div>
            <p id="feed-url-hint" className="feed-input-hint">
              可直接粘贴订阅网址；未填写协议时自动使用 https://。
            </p>
            <label className="field-label" htmlFor="feed-folder">
              Add to collection
            </label>
            <select
              id="feed-folder"
              value={feedCategory}
              onChange={(event) => setFeedCategory(event.target.value)}
            >
              {[
                ...new Set([
                  "Design & inspiration",
                  "Technology",
                  "Slow living",
                  ...categories,
                ]),
              ].map((category) => (
                <option key={category}>{category}</option>
              ))}
            </select>
            {addError && (
              <p className="form-error" role="alert">
                {addError}
              </p>
            )}
            <button
              className="primary-button full-width"
              type="submit"
              disabled={adding}
            >
              {adding ? (
                <LoaderCircle size={17} className="spinning" />
              ) : (
                <Plus size={17} />
              )}
              {adding ? "Finding your next good read…" : "Add to my feeds"}
            </button>
          </form>
          <div className="modal-footnote">
            <BookOpen size={16} />
            <p>
              No algorithms. No distractions.
              <br />
              Just the things you choose to follow.
            </p>
          </div>
        </Modal>
      )}
      {modal === "translation" && (
        <Modal
          title="读懂每一个好故事。"
          subtitle="在阅读器内将英文文章翻译成简体中文，随时切回原文。"
          onClose={closeModal}
        >
          <TranslationSettings />
        </Modal>
      )}
      {modal === "settings" && (
        <Modal
          title="Make yourself at home."
          subtitle="A reading space that feels just right for you."
          onClose={closeModal}
        >
          <button
            className="settings-manage"
            onClick={() => setModal("translation")}
          >
            <Languages size={18} />
            文章翻译 · 配置 API
            <ChevronRight size={17} />
          </button>
          <div className="setting-row">
            <div>
              <label htmlFor="refresh-interval">Refresh feeds</label>
              <p>While Folio is open</p>
            </div>
            <select
              id="refresh-interval"
              value={library.settings.interval}
              onChange={(event) =>
                setSetting("interval", Number(event.target.value))
              }
            >
              {[5, 15, 30, 60].map((minutes) => (
                <option value={minutes} key={minutes}>
                  Every {minutes} minutes
                </option>
              ))}
              <option value={0}>Manually</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <label htmlFor="theme">Appearance</label>
              <p>Set the mood for your reading</p>
            </div>
            <select
              id="theme"
              value={library.settings.theme}
              onChange={(event) =>
                setSetting(
                  "theme",
                  event.target.value as Library["settings"]["theme"],
                )
              }
            >
              <option value="light">Light</option>
              <option value="dark">Dark</option>
              <option value="system">Follow system</option>
            </select>
          </div>
          <div className="setting-row">
            <div>
              <span>Article text size</span>
              <p>A little easier on the eyes</p>
            </div>
            <div className="font-sizes">
              {[16, 18, 20, 22].map((size) => (
                <button
                  key={size}
                  aria-label={`${size} pixel text`}
                  className={
                    library.settings.fontSize === size ? "selected" : ""
                  }
                  style={{ fontSize: size }}
                  onClick={() => setSetting("fontSize", size)}
                >
                  A
                </button>
              ))}
            </div>
          </div>
          <div className="cache-card">
            <Download size={21} />
            <div>
              <strong>{library.articles.length} articles, ready to go.</strong>
              <p>
                Article text and reading progress stay on this device. Remote
                images need a connection.
              </p>
            </div>
          </div>
          <button
            className="settings-manage"
            onClick={() => setModal("manage")}
          >
            <FolderOpen size={17} />
            Manage your feeds
            <ChevronRight size={17} />
          </button>
          <div className="shortcut-grid">
            <span>
              Search <kbd>⌘ K</kbd>
            </span>
            <span>
              Refresh <kbd>⌘ R</kbd>
            </span>
            <span>
              Star article <kbd>S</kbd>
            </span>
            <span>
              Toggle read <kbd>M</kbd>
            </span>
          </div>
          <div className="settings-about">
            <BookOpen size={16} />
            Folio 1.0<span>Made for a more mindful internet.</span>
          </div>
        </Modal>
      )}
      {modal === "manage" && (
        <Modal
          title="Your own little world."
          subtitle={`${library.feeds.length} feeds. An internet that’s entirely yours.`}
          onClose={closeModal}
        >
          <div className="manage-feeds">
            {library.feeds.length ? (
              library.feeds.map((feed) => (
                <div className="manage-feed" key={feed.id}>
                  <FeedIcon feed={feed} />
                  <div>
                    <strong>{feed.title}</strong>
                    <span>{feed.category}</span>
                    {feed.error && <p className="form-error">{feed.error}</p>}
                  </div>
                  <IconButton
                    label={`Refresh ${feed.title}`}
                    disabled={refreshing}
                    onClick={() => void refresh(feed.id)}
                  >
                    <RefreshCw size={16} />
                  </IconButton>
                  <IconButton
                    label={`Remove ${feed.title}`}
                    onClick={() => {
                      setRemoveId(feed.id);
                      setModal("remove");
                    }}
                  >
                    <Trash2 size={16} />
                  </IconButton>
                </div>
              ))
            ) : (
              <div className="empty-state">
                <Rss />
                <p>Your collection is waiting to begin.</p>
              </div>
            )}
          </div>
          <button
            className="primary-button full-width"
            onClick={() => {
              setAddError("");
              setModal("add");
            }}
          >
            <Plus size={17} />
            Add a new feed
          </button>
        </Modal>
      )}
      {modal === "remove" && (
        <Modal
          title="Make a little space?"
          subtitle={`Remove ${library.feeds.find((feed) => feed.id === removeId)?.title} and its cached articles from your library? This also removes its starred articles and cannot be undone.`}
          onClose={closeModal}
        >
          <div className="confirmation-actions">
            <button
              className="secondary-button"
              onClick={() => setModal("manage")}
            >
              Keep this feed
            </button>
            <button className="danger-button" onClick={removeFeed}>
              <Trash2 size={16} />
              Remove feed
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <span className="toast-icon">
            <Check size={15} />
          </span>
          {toast}
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast("")}
          >
            <X size={15} />
          </button>
        </div>
      )}
    </div>
  );
}
