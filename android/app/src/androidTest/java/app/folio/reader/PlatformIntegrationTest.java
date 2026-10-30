package app.folio.reader;

import android.content.Context;
import android.content.ContextWrapper;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.File;
import java.io.FileInputStream;
import java.nio.charset.StandardCharsets;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class PlatformIntegrationTest {
    @Test
    public void androidXmlParserAcceptsCdataHtmlButRejectsRealDtd() throws Exception {
        String xml = "<rss version=\"2.0\" xmlns:content=\"http://purl.org/rss/1.0/modules/content/\"><channel><title>Test feed</title><link>https://example.com</link><item><guid>story</guid><title>Hello</title><pubDate>Mon, 28 Sep 2026 08:00:00 GMT</pubDate><content:encoded><![CDATA[<!DOCTYPE html><html><body><p>Hello from RSS</p></body></html>]]></content:encoded></item></channel></rss>";
        JSONObject feed = FeedService.parse(xml, "https://example.com/feed");
        assertEquals(1, feed.getJSONArray("articles").length());
        JSONObject item = feed.getJSONArray("articles").getJSONObject(0);
        assertTrue(item.getString("content").contains("<!DOCTYPE html>"));
        assertTrue(item.getString("publishedAt").startsWith("2026-09-28"));
        try {
            FeedService.parse("<!DOCTYPE rss [<!ENTITY secret SYSTEM 'file:///not-allowed'>]>" + xml, "https://example.com/feed");
            fail("A real XML doctype must be rejected");
        } catch (FolioException expected) {
            assertEquals("INVALID_XML", expected.code);
        }
    }

    @Test
    public void androidKeystoreRoundTripDoesNotWritePlaintextOrExposeKey() throws Exception {
        Context target = InstrumentationRegistry.getInstrumentation().getTargetContext();
        File directory = new File(target.getNoBackupFilesDir(), "integration-test");
        assertTrue(directory.isDirectory() || directory.mkdirs());
        Context isolated = new ContextWrapper(target) {
            @Override public Context getApplicationContext() { return this; }
            @Override public File getNoBackupFilesDir() { return directory; }
            @Override public String getPackageName() { return "app.folio.reader.integration"; }
        };
        TranslationStore store = new TranslationStore(isolated);
        try {
            store.clear();
            JSONObject config = new JSONObject().put("baseUrl", "https://api.openai.com/v1").put("model", "test-model").put("apiKey", "test-only-not-a-real-key");
            store.save(config);
            TranslationStore reopened = new TranslationStore(isolated);
            assertEquals(config.toString(), reopened.load().toString());
            File encrypted = new File(directory, "translation-config.enc");
            try (FileInputStream stream = new FileInputStream(encrypted)) {
                byte[] bytes = new byte[(int) encrypted.length()];
                assertEquals(bytes.length, stream.read(bytes));
                assertFalse(new String(bytes, StandardCharsets.UTF_8).contains("test-only-not-a-real-key"));
            }
            JSONObject publicConfig = new TranslationService(reopened).getConfig();
            assertTrue(publicConfig.getBoolean("configured"));
            assertFalse(publicConfig.has("apiKey"));
            assertEquals("encrypted", publicConfig.getString("persistence"));
        } finally {
            store.clear();
            assertTrue(directory.delete());
        }
    }
}
