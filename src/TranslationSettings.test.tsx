// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import TranslationSettings from "./TranslationSettings";

const config = {
  baseUrl: "https://api.openai.com/v1",
  model: "",
  hasApiKey: false,
  configured: false,
  persistence: "encrypted" as const,
};
beforeEach(() => {
  window.folio = {
    fetchFeed: vi.fn(),
    openExternal: vi.fn(),
    translateArticle: vi.fn(),
    cancelTranslation: vi.fn(),
    getTranslationConfig: vi.fn().mockResolvedValue(config),
    saveTranslationConfig: vi
      .fn()
      .mockImplementation(async (input) => ({
        ...config,
        baseUrl: input.baseUrl,
        model: input.model,
        hasApiKey: true,
        configured: true,
      })),
    clearTranslationConfig: vi.fn().mockResolvedValue(config),
  };
});
afterEach(() => {
  cleanup();
  delete window.folio;
});
it("requires consent, saves config only on click and clears the entered key", async () => {
  render(<TranslationSettings />);
  const key = await screen.findByLabelText("API Key");
  await waitFor(() => expect((key as HTMLInputElement).disabled).toBe(false));
  expect(
    (screen.getByRole("button", { name: "保存翻译设置" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("模型 ID"), {
    target: { value: "provider-model" },
  });
  fireEvent.change(key, { target: { value: "test-secret-not-real" } });
  fireEvent.click(screen.getByRole("checkbox"));
  fireEvent.click(screen.getByRole("button", { name: "保存翻译设置" }));
  await screen.findByText(/设置已保存/);
  expect(window.folio!.saveTranslationConfig).toHaveBeenCalledWith({
    baseUrl: config.baseUrl,
    model: "provider-model",
    apiKey: "test-secret-not-real",
  });
  expect((key as HTMLInputElement).value).toBe("");
  expect(window.folio!.translateArticle).not.toHaveBeenCalled();
});
it("does not expose stored keys and asks for consent again after an endpoint change", async () => {
  vi.mocked(window.folio!.getTranslationConfig).mockResolvedValue({
    ...config,
    model: "provider-model",
    hasApiKey: true,
    configured: true,
  });
  render(<TranslationSettings />);
  await screen.findByText("已保存");
  expect((screen.getByLabelText(/API Key/) as HTMLInputElement).value).toBe("");
  fireEvent.change(screen.getByLabelText("API Base URL"), {
    target: { value: "https://api.example.com/v1" },
  });
  expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
    false,
  );
  expect((screen.getByLabelText(/API Key/) as HTMLInputElement).required).toBe(
    true,
  );
  expect(window.folio!.saveTranslationConfig).not.toHaveBeenCalled();
});
it("confirms clearing settings and leaves cached article data alone", async () => {
  vi.mocked(window.folio!.getTranslationConfig).mockResolvedValue({
    ...config,
    model: "model",
    hasApiKey: true,
    configured: true,
  });
  render(<TranslationSettings />);
  fireEvent.click(await screen.findByRole("button", { name: "清除翻译设置" }));
  expect(window.folio!.clearTranslationConfig).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "确认清除密钥与设置" }));
  await screen.findByText(/已清除翻译服务设置/);
  expect(window.folio!.clearTranslationConfig).toHaveBeenCalledOnce();
});
