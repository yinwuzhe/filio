package app.folio.reader;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONObject;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.RejectedExecutionException;

@CapacitorPlugin(name = "FolioNative")
public class FolioPlugin extends Plugin {
    private final ThreadPoolExecutor workers = new ThreadPoolExecutor(4, 4, 30, TimeUnit.SECONDS, new ArrayBlockingQueue<>(12));
    private TranslationService translation;
    private volatile boolean destroyed;

    @Override
    public void load() {
        translation = new TranslationService(new TranslationStore(getContext()));
    }

    private interface Operation { JSONObject run() throws Exception; }

    private boolean trusted(PluginCall call) {
        String url = getBridge().getWebView().getUrl();
        Uri uri = url == null ? null : Uri.parse(url);
        if (destroyed || uri == null || !"https".equals(uri.getScheme()) || !"localhost".equals(uri.getHost()) || uri.getPort() != -1) {
            call.reject("此页面无权访问本机阅读数据。", "FORBIDDEN");
            return false;
        }
        return true;
    }

    private void execute(PluginCall call, Operation operation) {
        getActivity().runOnUiThread(() -> {
            if (!trusted(call)) return;
            try {
                workers.execute(() -> {
                    try {
                        if (destroyed) { call.reject("操作已取消。", "CANCELLED"); return; }
                        JSONObject value = operation.run();
                        call.resolve(value == null ? new JSObject() : new JSObject(value.toString()));
                    } catch (FolioException error) {
                        call.reject(error.getMessage(), error.code);
                    } catch (Exception error) {
                        call.reject("操作失败，请检查网络或设备存储后重试。", "OPERATION_FAILED");
                    }
                });
            } catch (RejectedExecutionException error) {
                call.reject("请求过多，请稍后重试。", "BUSY");
            }
        });
    }

    @PluginMethod
    public void fetchFeed(PluginCall call) {
        execute(call, () -> new FeedService().fetch(call.getString("url")));
    }

    @PluginMethod
    public void getTranslationConfig(PluginCall call) {
        execute(call, () -> translation.getConfig());
    }

    @PluginMethod
    public void saveTranslationConfig(PluginCall call) {
        execute(call, () -> translation.saveConfig(call.getData()));
    }

    @PluginMethod
    public void clearTranslationConfig(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!trusted(call)) return;
            translation.cancelAll();
            execute(call, () -> translation.clearConfig());
        });
    }

    @PluginMethod
    public void translateArticle(PluginCall call) {
        execute(call, () -> translation.translate(call.getString("requestId"), call.getArray("segments")));
    }

    @PluginMethod
    public void cancelTranslation(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!trusted(call)) return;
            try {
                translation.cancel(call.getString("requestId"));
                call.resolve();
            } catch (FolioException error) {
                call.reject(error.getMessage(), error.code);
            }
        });
    }

    @PluginMethod
    public void openExternal(PluginCall call) {
        execute(call, () -> {
            String value = call.getString("url");
            if (value == null || value.length() > 4096) throw new FolioException("网页地址无效。", "INVALID_URL");
            java.net.URI uri;
            try { uri = new java.net.URI(value); }
            catch (Exception error) { throw new FolioException("网页地址无效。", "INVALID_URL"); }
            if (!("https".equals(uri.getScheme()) || "http".equals(uri.getScheme())) || uri.getHost() == null || uri.getUserInfo() != null) {
                throw new FolioException("只允许打开 HTTP 或 HTTPS 网页。", "INVALID_URL");
            }
            getActivity().runOnUiThread(() -> {
                try {
                    Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(value));
                    intent.addCategory(Intent.CATEGORY_BROWSABLE);
                    getActivity().startActivity(intent);
                } catch (ActivityNotFoundException error) {
                    getBridge().triggerWindowJSEvent("folio:external-error");
                }
            });
            return null;
        });
    }

    @PluginMethod
    public void shareText(PluginCall call) {
        execute(call, () -> {
            String text = call.getString("text");
            String title = call.getString("title", "Folio article");
            if (text == null || text.length() > 200000 || title.length() > 1000) throw new FolioException("文章过长，无法分享。", "TOO_LARGE");
            getActivity().runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_SEND);
                intent.setType("text/plain");
                intent.putExtra(Intent.EXTRA_SUBJECT, title);
                intent.putExtra(Intent.EXTRA_TEXT, text);
                try { getActivity().startActivity(Intent.createChooser(intent, "分享文章")); }
                catch (ActivityNotFoundException error) { getBridge().triggerWindowJSEvent("folio:external-error"); }
            });
            return null;
        });
    }

    @Override
    protected void handleOnStop() {
        if (translation != null) translation.cancelAll();
        super.handleOnStop();
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        if (translation != null) translation.cancelAll();
        workers.shutdownNow();
        super.handleOnDestroy();
    }
}
