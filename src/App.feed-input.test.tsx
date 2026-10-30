// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { createSeed } from "./seed";
import { loadLibrary, saveLibrary } from "./storage";

vi.mock("./storage", () => ({ loadLibrary: vi.fn(), saveLibrary: vi.fn() }));
vi.mock("./useArticleTranslation", () => ({
  useArticleTranslation: () => ({
    translated: undefined,
    busy: false,
    error: "",
    toggle: vi.fn(),
    cancel: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.mocked(loadLibrary).mockResolvedValue(createSeed());
  vi.mocked(saveLibrary).mockResolvedValue(undefined);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  window.folio = {
    platform: "android",
    fetchFeed: vi
      .fn()
      .mockResolvedValue({
        title: "Input regression feed",
        url: "https://example.com/feed",
        siteUrl: "https://example.com",
        articles: [],
      }),
    openExternal: vi.fn(),
    getTranslationConfig: vi.fn(),
    saveTranslationConfig: vi.fn(),
    clearTranslationConfig: vi.fn(),
    translateArticle: vi.fn(),
    cancelTranslation: vi.fn(),
  };
});
afterEach(() => {
  cleanup();
  delete window.folio;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function openForm() {
  render(<App />);
  await waitFor(() => expect(saveLibrary).toHaveBeenCalled());
  fireEvent.click(screen.getByRole("button", { name: /^Add a feed/ }));
  return screen.getByLabelText("RSS or Atom feed URL") as HTMLInputElement;
}

function submit(input: HTMLInputElement) {
  fireEvent.submit(input.form!);
}

describe("mobile feed input", () => {
  it("adds a standard HTTPS feed through the native bridge", async () => {
    const input = await openForm();
    fireEvent.change(input, { target: { value: "https://example.com/feed" } });
    submit(input);
    await waitFor(() =>
      expect(window.folio!.fetchFeed).toHaveBeenCalledWith(
        "https://example.com/feed",
      ),
    );
    await screen.findByText("Welcome to your library, Input regression feed.");
  });

  it("submits the visible field even when mobile autofill has not fired a React change event", async () => {
    const input = await openForm();
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(input, "https://example.com/feed");
    submit(input);
    await waitFor(() =>
      expect(window.folio!.fetchFeed).toHaveBeenCalledWith(
        "https://example.com/feed",
      ),
    );
  });

  it.each([
    ["example.com/feed", "https://example.com/feed"],
    ["https：／／example.com/feed", "https://example.com/feed"],
    ["\u200bhttps://example.com/feed\u200b", "https://example.com/feed"],
  ])(
    "accepts mobile input %s and displays its normalized value while loading",
    async (value, expected) => {
      vi.mocked(window.folio!.fetchFeed).mockImplementation(
        () => new Promise(() => {}),
      );
      const input = await openForm();
      fireEvent.change(input, { target: { value } });
      submit(input);
      await waitFor(() =>
        expect(window.folio!.fetchFeed).toHaveBeenCalledWith(expected),
      );
      expect(input.value).toBe(expected);
      expect(input.type).toBe("text");
      expect(input.getAttribute("inputmode")).toBe("url");
      expect(input.getAttribute("autocapitalize")).toBe("none");
      expect(input.getAttribute("autocorrect")).toBe("off");
    },
  );

  it("gives a specific local validation error and sends no request for an empty field", async () => {
    const input = await openForm();
    submit(input);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "请输入订阅地址",
    );
    expect(window.folio!.fetchFeed).not.toHaveBeenCalled();
  });

  it("keeps native network errors distinct from URL format errors and supports retry", async () => {
    vi.mocked(window.folio!.fetchFeed).mockRejectedValueOnce(
      new Error("无法解析订阅源地址。"),
    );
    const input = await openForm();
    fireEvent.change(input, { target: { value: "https://example.com/feed" } });
    submit(input);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "无法解析订阅源地址。",
    );
    expect(input.value).toBe("https://example.com/feed");
    submit(input);
    await screen.findByText("Welcome to your library, Input regression feed.");
    expect(window.folio!.fetchFeed).toHaveBeenCalledTimes(2);
  });

  it("still detects an existing subscription after normalizing user input", async () => {
    const input = await openForm();
    fireEvent.change(input, { target: { value: "design-milk.com/feed/" } });
    submit(input);
    expect((await screen.findByRole("alert")).textContent).toBe(
      "This feed is already in your library.",
    );
    expect(window.folio!.fetchFeed).not.toHaveBeenCalled();
  });
});
