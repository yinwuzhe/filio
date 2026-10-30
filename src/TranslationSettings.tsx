import { useEffect, useState, type FormEvent } from "react";
import {
  Check,
  KeyRound,
  Languages,
  LoaderCircle,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  clearTranslationConfig,
  getTranslationConfig,
  saveTranslationConfig,
  type TranslationConfig,
} from "./translation";

export default function TranslationSettings() {
  const [config, setConfig] = useState<TranslationConfig | null>(null);
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com/v1");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [consent, setConsent] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    let alive = true;
    getTranslationConfig()
      .then((value) => {
        if (!alive) return;
        setConfig(value);
        setBaseUrl(value.baseUrl);
        setModel(value.model);
        setConsent(value.configured);
      })
      .catch((error) => {
        if (alive) setError(error.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (busy || !consent) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await saveTranslationConfig({
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: apiKey.trim(),
      });
      setConfig(result);
      setBaseUrl(result.baseUrl);
      setApiKey("");
      setMessage("设置已保存。关闭此窗口后，点击正文工具栏的“翻译为中文”。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "保存失败，请重试。");
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    if (!confirmClear) {
      setConfirmClear(true);
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await clearTranslationConfig();
      setConfig(result);
      setBaseUrl(result.baseUrl);
      setModel(result.model);
      setApiKey("");
      setConsent(false);
      setMessage("已清除翻译服务设置，已缓存的译文不受影响。");
    } catch (error) {
      setError(error instanceof Error ? error.message : "清除失败，请重试。");
    } finally {
      setBusy(false);
      setConfirmClear(false);
    }
  }

  const endpointChanged =
    config &&
    baseUrl.trim().replace(/\/+$/, "") !== config.baseUrl.replace(/\/+$/, "");
  return (
    <section
      className="translation-settings"
      aria-labelledby="translation-settings-title"
    >
      <div className="translation-settings-title">
        <Languages size={21} />
        <h3 id="translation-settings-title">文章翻译</h3>
        <span>EN → 简体中文</span>
      </div>
      <p className="translation-help">
        使用支持 Chat Completions 的 OpenAI 兼容服务。填写服务商提供的 API
        地址、模型 ID 和密钥，无需在聊天中提供密钥。
      </p>
      <form onSubmit={save}>
        <label className="field-label" htmlFor="translation-url">
          API Base URL
        </label>
        <div className="modal-input">
          <input
            id="translation-url"
            type="url"
            required
            value={baseUrl}
            onChange={(event) => {
              setBaseUrl(event.target.value);
              setConsent(false);
              setMessage("");
            }}
            disabled={busy}
            placeholder="https://api.openai.com/v1"
            spellCheck={false}
          />
        </div>
        <p className="translation-field-hint">
          仅支持公网 HTTPS；填写基础地址，系统会追加 /chat/completions。
        </p>
        <label className="field-label" htmlFor="translation-model">
          模型 ID
        </label>
        <div className="modal-input">
          <input
            id="translation-model"
            required
            maxLength={200}
            value={model}
            onChange={(event) => {
              setModel(event.target.value);
              setMessage("");
            }}
            disabled={busy}
            placeholder="填写你的服务商支持的模型 ID"
            spellCheck={false}
          />
        </div>
        <label className="field-label" htmlFor="translation-key">
          API Key{" "}
          {config?.hasApiKey && (
            <span className="translation-key-status">
              <ShieldCheck size={12} />
              已保存
            </span>
          )}
        </label>
        <div className="modal-input">
          <KeyRound size={16} />
          <input
            id="translation-key"
            type="password"
            autoComplete="new-password"
            required={!config?.hasApiKey || !!endpointChanged}
            maxLength={4096}
            value={apiKey}
            onChange={(event) => {
              setApiKey(event.target.value);
              setMessage("");
            }}
            disabled={busy}
            placeholder={
              config?.hasApiKey && !endpointChanged
                ? "留空保留现有密钥"
                : "仅保存在本机，不会回显"
            }
          />
        </div>
        {endpointChanged && (
          <p className="translation-field-hint">
            更换服务地址时请重新输入密钥，旧密钥不会发送给新服务。
          </p>
        )}
        <div className="translation-privacy">
          <ShieldCheck size={18} />
          <p>
            {window.folio
              ? config?.persistence === "session"
                ? "系统加密服务不可用：配置仅保留在本次会话，不会明文保存到磁盘，重启后需重新填写。"
                : window.folio?.platform === "android"
                  ? "手机版使用 Android Keystore 保护的加密存储保存配置，密钥不会写入文章库或跨设备同步。"
                  : "桌面版使用 macOS 钥匙串保护的加密存储保存配置，密钥不会写入文章库。"
              : "浏览器预览的配置仅保存在本地服务内存中，重启开发服务后需重新填写。"}
            <br />
            点击翻译时，文章标题、摘要和正文文字会发送给上方服务商，可能产生 API
            费用。图片和代码块不发送；译文仅缓存在本机。单篇最多 40,000 字符。
          </p>
        </div>
        <label className="translation-consent">
          <input
            type="checkbox"
            checked={consent}
            disabled={busy}
            onChange={(event) => setConsent(event.target.checked)}
          />
          <span>我同意在点击翻译时，将文章文字发送给所配置的服务。</span>
        </label>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="translation-success" role="status">
            <Check size={15} />
            {message}
          </p>
        )}
        <button
          className="primary-button full-width"
          type="submit"
          disabled={busy || !consent}
        >
          {busy ? (
            <LoaderCircle size={16} className="spinning" />
          ) : (
            <Check size={16} />
          )}
          保存翻译设置
        </button>
      </form>
      {(config?.hasApiKey || error) && (
        <div className="translation-clear">
          <button
            className="text-button"
            onClick={() => void clear()}
            disabled={busy}
          >
            <Trash2 size={14} />
            {confirmClear ? "确认清除密钥与设置" : "清除翻译设置"}
          </button>
          {confirmClear && (
            <button
              className="text-button"
              onClick={() => setConfirmClear(false)}
            >
              取消
            </button>
          )}
        </div>
      )}
    </section>
  );
}
