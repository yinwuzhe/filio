package app.folio.reader;

import static org.junit.Assert.*;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

public class FeedServiceTest {
    private static final String SOURCE = "https://example.com/feed.xml";
    private static final String RSS = """
            <rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"
                 xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
              <channel><title>A quieter &amp; better web</title><link>https://example.com/</link><description>Thoughtful stories</description>
                <item><guid isPermaLink="false">story-1</guid><title>Small things</title><link>/stories/one</link>
                  <dc:creator>Ada Reader</dc:creator><pubDate>Wed, 16 Sep 2026 09:00:00 GMT</pubDate>
                  <description>A short summary</description><content:encoded><![CDATA[<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>]]></content:encoded>
                  <media:thumbnail url="/one.jpg"/>
                </item>
                <item><guid>story-2</guid><title>Morning light</title><link>/stories/two</link>
                  <description><![CDATA[<p>Another story.</p>]]></description><enclosure url="/two.webp" type="image/webp"/>
                </item>
              </channel>
            </rss>
            """;

    @Test public void normalizesRssAndStableIdsDatesAuthorsAndImages() throws Exception {
        JSONObject feed = FeedService.parse(RSS, SOURCE);
        assertEquals("A quieter & better web", feed.getString("title"));
        assertEquals("Thoughtful stories", feed.getString("description"));
        JSONArray articles = feed.getJSONArray("articles");
        assertEquals(2, articles.length());
        JSONObject article = articles.getJSONObject(0);
        assertEquals("https://example.com/stories/one", article.getString("url"));
        assertEquals("Ada Reader", article.getString("author"));
        assertEquals("2026-09-16T09:00:00.000Z", article.getString("publishedAt"));
        assertEquals("A long-form story & a quiet moment.", article.getString("excerpt"));
        assertTrue(article.getString("content").contains("<strong>story</strong>"));
        assertEquals("https://example.com/one.jpg", article.getString("image"));
        assertEquals(expectedId(SOURCE, "story-1"), article.getString("id"));
        assertEquals(article.getString("id"), FeedService.parse(RSS, SOURCE).getJSONArray("articles").getJSONObject(0).getString("id"));
        assertEquals("1970-01-01T00:00:00.000Z", articles.getJSONObject(1).getString("publishedAt"));
        assertEquals("https://example.com/two.webp", articles.getJSONObject(1).getString("image"));
        assertEquals(1, FeedService.parse(RSS.replace("story-2", "story-1"), SOURCE).getJSONArray("articles").length());
    }

    @Test public void parsesAtomAlternateLinksAndXhtmlContent() throws Exception {
        String atom = """
                <feed xmlns="http://www.w3.org/2005/Atom"><title>Field notes</title><subtitle>A collection</subtitle>
                  <link rel="self" href="https://example.com/atom.xml"/><link href="https://example.com/notes/"/>
                  <entry><id>urn:note:1</id><title>A slower morning</title><link rel="alternate" href="one"/>
                    <link rel="enclosure" href="/atom.jpg" type="image/jpeg"/><author><name>Robin</name></author>
                    <updated>2026-09-16T10:30:00+02:00</updated><content type="html">&lt;p&gt;Read with &lt;em&gt;intention&lt;/em&gt;.&lt;/p&gt;</content>
                  </entry>
                  <entry><id>urn:note:2</id><title>XHTML</title><content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml"><p>A <b>bold</b> note.</p></div></content></entry>
                </feed>
                """;
        JSONObject feed = FeedService.parse(atom, SOURCE);
        JSONObject first = feed.getJSONArray("articles").getJSONObject(0);
        assertEquals("A collection", feed.getString("description"));
        assertEquals("https://example.com/notes/one", first.getString("url"));
        assertEquals("Robin", first.getString("author"));
        assertEquals("2026-09-16T08:30:00.000Z", first.getString("publishedAt"));
        assertEquals("<p>Read with <em>intention</em>.</p>", first.getString("content"));
        assertEquals("https://example.com/atom.jpg", first.getString("image"));
        assertTrue(feed.getJSONArray("articles").getJSONObject(1).getString("content").contains("<b>bold</b>"));
    }

    @Test public void parsesRdfAndKeepsInvalidDatesStable() throws Exception {
        String rdf = """
                <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
                  <channel rdf:about="https://example.com/feed"><title>Archive</title><link>https://example.com/</link></channel>
                  <item rdf:about="https://example.com/a"><title>Note</title><link>/a</link><dc:date>invalid date</dc:date><description><![CDATA[<p>Text <img src="/inline.png"></p>]]></description></item>
                </rdf:RDF>
                """;
        JSONObject article = FeedService.parse(rdf, SOURCE).getJSONArray("articles").getJSONObject(0);
        assertEquals("1970-01-01T00:00:00.000Z", article.getString("publishedAt"));
        assertEquals("https://example.com/inline.png", article.getString("image"));
        assertEquals(expectedId(SOURCE, "/a"), article.getString("id"));
        String unsafe = rdf.replace("/inline.png", "javascript:alert(1)").replace("<link>/a</link>", "<link>javascript:alert(1)</link>");
        JSONObject unsafeArticle = FeedService.parse(unsafe, SOURCE).getJSONArray("articles").getJSONObject(0);
        assertEquals("", unsafeArticle.getString("image"));
        assertEquals("https://example.com/", unsafeArticle.getString("url"));
    }

    @Test public void preservesCdataDoctypeButRejectsTrueDtdAndExternalEntities() throws Exception {
        String cdata = RSS.replace("<p>A long-form", "<!DOCTYPE html><p>A long-form");
        assertTrue(FeedService.parse(cdata, SOURCE).getJSONArray("articles").getJSONObject(0).getString("content").startsWith("<!DOCTYPE html>"));
        for (String xml : new String[]{
                "<!DOCTYPE rss [<!ENTITY xxe SYSTEM 'file:///not-to-be-read'>]><rss><channel><title>&xxe;</title></channel></rss>",
                "<!DOCTYPE rss SYSTEM 'https://example.com/never-fetch.dtd'><rss><channel/></rss>",
                "<!DOCTYPE rss [<!ENTITY text 'expanded'>]><rss><channel><title>&text;</title></channel></rss>",
                "<rss><channel><title>broken</channel></rss>"}) {
            FolioException failure = assertThrows(FolioException.class, () -> FeedService.parse(xml, SOURCE));
            assertEquals("INVALID_XML", failure.code);
            assertFalse(failure.getMessage().contains("not-to-be-read"));
        }
        assertEquals("NOT_A_FEED", assertThrows(FolioException.class, () -> FeedService.parse("<html><body>Page</body></html>", SOURCE)).code);
    }

    @Test public void limitsArticlesAndInputSizeAndDerivesReadingTime() throws Exception {
        StringBuilder rss = new StringBuilder("<rss><channel><title>Many</title>");
        for (int i = 0; i < 1002; i++) rss.append("<item><guid>").append(i).append("</guid><description>word ").append("word ".repeat(500)).append("</description></item>");
        rss.append("</channel></rss>");
        JSONArray articles = FeedService.parse(rss.toString(), SOURCE).getJSONArray("articles");
        assertEquals(1000, articles.length());
        assertEquals(3, articles.getJSONObject(0).getInt("readingTime"));
        assertTrue(articles.getJSONObject(0).getString("excerpt").length() <= 240);
        assertEquals("FEED_TOO_LARGE", assertThrows(FolioException.class,
                () -> FeedService.parse("x".repeat(8 * 1024 * 1024 + 1), SOURCE)).code);
    }

    private static String expectedId(String source, String identity) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest((source + "\0" + identity).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder();
        for (byte value : digest) hex.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return hex.substring(0, 24);
    }
}
