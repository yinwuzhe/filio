package app.folio.reader;

import java.io.IOException;
import java.io.InterruptedIOException;
import java.io.StringReader;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

import javax.xml.XMLConstants;
import javax.xml.parsers.SAXParserFactory;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import org.jsoup.Jsoup;
import org.jsoup.nodes.Element;
import org.xml.sax.Attributes;
import org.xml.sax.InputSource;
import org.xml.sax.SAXException;
import org.xml.sax.SAXParseException;
import org.xml.sax.XMLReader;
import org.xml.sax.ext.DefaultHandler2;

public final class FeedService {
    private static final int MAX_BYTES = 8 * 1024 * 1024;
    private static final int MAX_ARTICLES = 1000;
    private static final String EPOCH = "1970-01-01T00:00:00.000Z";
    private static final String CONTENT_NS = "http://purl.org/rss/1.0/modules/content/";
    private static final String MEDIA_NS = "http://search.yahoo.com/mrss/";
    private static final DateTimeFormatter ISO_DATE = new DateTimeFormatterBuilder().appendInstant(3).toFormatter();

    public JSONObject fetch(String input) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        HttpUrl current = SafeHttp.validateUrl(input, false);
        OkHttpClient client = SafeHttp.client(20_000);
        try {
            for (int redirects = 0; redirects <= 5; redirects++) {
                current = SafeHttp.validateUrl(current.toString(), false);
                long remaining = remaining(deadline);
                Request request = new Request.Builder().url(current)
                        .header("Accept", "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5")
                        .header("User-Agent", "Folio/1.0 (RSS Reader)")
                        .header("Accept-Encoding", "identity").build();
                Call call = client.newCall(request);
                call.timeout().timeout(remaining, TimeUnit.NANOSECONDS);
                try (Response response = await(call, deadline)) {
                    int status = response.code();
                    if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
                        if (redirects == 5) throw new FolioException("订阅地址重定向次数过多。", "TOO_MANY_REDIRECTS");
                        String location = response.header("Location");
                        if (location == null || location.trim().isEmpty()) {
                            throw new FolioException("订阅源返回了无效重定向。", "INVALID_REDIRECT");
                        }
                        String next;
                        try {
                            next = current.uri().resolve(location).toString();
                        } catch (IllegalArgumentException e) {
                            throw new FolioException("订阅源返回了无效重定向。", "INVALID_REDIRECT");
                        }
                        current = SafeHttp.validateUrl(next, false);
                        continue;
                    }
                    if (!response.isSuccessful()) throw new FolioException("订阅源服务器暂时无法提供内容。", "UPSTREAM_ERROR");
                    String xml = SafeHttp.readBody(response, MAX_BYTES);
                    remaining(deadline);
                    JSONObject feed = parse(xml, current.toString());
                    remaining(deadline);
                    return feed;
                }
            }
            throw new FolioException("无法加载订阅源。", "NETWORK_ERROR");
        } catch (FolioException e) {
            throw e;
        } catch (Exception e) {
            if (System.nanoTime() >= deadline || e instanceof InterruptedIOException || e instanceof TimeoutException) {
                throw new FolioException("订阅源响应超时，请稍后重试。", "FEED_TIMEOUT");
            }
            if (e instanceof UnknownHostException) {
                if ("PRIVATE_ADDRESS".equals(e.getMessage())) {
                    throw new FolioException("不允许访问本地、内网或保留网络地址。", "PRIVATE_ADDRESS");
                }
                throw new FolioException("无法解析订阅源地址。", "DNS_ERROR");
            }
            throw new FolioException("无法连接订阅源，请检查地址后重试。", "NETWORK_ERROR");
        } finally {
            client.connectionPool().evictAll();
            client.dispatcher().executorService().shutdown();
        }
    }

    private static long remaining(long deadline) throws FolioException {
        long remaining = deadline - System.nanoTime();
        if (remaining <= 0) throw new FolioException("订阅源响应超时，请稍后重试。", "FEED_TIMEOUT");
        return remaining;
    }

    private static Response await(Call call, long deadline) throws Exception {
        CompletableFuture<Response> future = new CompletableFuture<>();
        call.enqueue(new Callback() {
            @Override public void onFailure(Call ignored, IOException failure) {
                future.completeExceptionally(failure);
            }
            @Override public void onResponse(Call ignored, Response response) {
                if (!future.complete(response)) response.close();
            }
        });
        try {
            return future.get(remaining(deadline), TimeUnit.NANOSECONDS);
        } catch (ExecutionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof Exception) throw (Exception) cause;
            throw new IOException("NETWORK_ERROR");
        } catch (Exception e) {
            future.cancel(false);
            call.cancel();
            Response response = future.isCompletedExceptionally() ? null : future.getNow(null);
            if (response != null) response.close();
            if (e instanceof InterruptedException) Thread.currentThread().interrupt();
            throw e;
        }
    }

    public static JSONObject parse(String xml, String sourceUrl) throws Exception {
        HttpUrl source = SafeHttp.validateUrl(sourceUrl, false);
        if (xml == null || xml.length() > MAX_BYTES || xml.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) {
            throw new FolioException("订阅内容超过8 MB大小限制。", "FEED_TOO_LARGE");
        }
        Node root;
        try {
            SAXParserFactory factory = SAXParserFactory.newInstance();
            factory.setNamespaceAware(true);
            factory.setValidating(false);
            XMLReader reader = factory.newSAXParser().getXMLReader();
            optionalFeature(reader, XMLConstants.FEATURE_SECURE_PROCESSING, true);
            optionalFeature(reader, "http://xml.org/sax/features/external-general-entities", false);
            optionalFeature(reader, "http://xml.org/sax/features/external-parameter-entities", false);
            optionalFeature(reader, "http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
            TreeHandler handler = new TreeHandler();
            reader.setContentHandler(handler);
            reader.setErrorHandler(handler);
            reader.setEntityResolver(handler);
            // Required on Android and JVM: fail closed if real DTD events cannot be observed.
            reader.setProperty("http://xml.org/sax/properties/lexical-handler", handler);
            reader.parse(new InputSource(new StringReader(xml)));
            root = handler.root;
        } catch (Exception e) {
            throw new FolioException("该地址没有返回有效的RSS或Atom内容，或包含不受支持的XML声明。", "INVALID_XML");
        }
        if (root == null) throw new FolioException("订阅源内容为空。", "INVALID_XML");
        boolean atom = root.name.equals("feed");
        boolean rdf = root.name.equalsIgnoreCase("RDF");
        Node channel = atom ? root : first(root, "channel");
        if ((!atom && !rdf && !root.name.equals("rss")) || channel == null) {
            throw new FolioException("该地址返回的不是RSS或Atom订阅源。", "NOT_A_FEED");
        }
        String rawSite = link(channel, atom);
        String site = safeWebUrl(rawSite, source.toString());
        if (site.isEmpty()) site = source.newBuilder().encodedPath("/").query(null).fragment(null).build().toString();
        String title = plain(text(first(channel, "title")));
        if (title.isEmpty()) title = source.host();
        JSONArray articles = new JSONArray();
        Set<String> ids = new HashSet<>();
        int count = 0;
        for (Node item : (rdf ? root : channel).children()) {
            if (!item.name.equals(atom ? "entry" : "item")) continue;
            if (count++ >= MAX_ARTICLES) break;
            Node encoded = firstNs(item, CONTENT_NS, "encoded");
            Node contentNode = firstNonempty(encoded, first(item, "content"), first(item, "summary"), first(item, "description"));
            String content = markup(contentNode);
            String text = plain(content);
            String articleTitle = plain(text(first(item, "title")));
            if (articleTitle.isEmpty()) articleTitle = "Untitled article";
            String rawLink = link(item, atom);
            String articleUrl = safeWebUrl(rawLink, site);
            String guid = text(first(item, "guid"));
            String entryId = text(first(item, "id"));
            if (articleUrl.isEmpty()) articleUrl = safeWebUrl(guid, "");
            if (articleUrl.isEmpty()) articleUrl = site;
            String publishedAt = date(firstNonempty(first(item, "isoDate"), first(item, "pubDate"),
                    first(item, "published"), first(item, "updated"), first(item, "date")));
            String identity = !guid.isEmpty() ? guid : !entryId.isEmpty() ? entryId : rawLink;
            if (identity.isEmpty()) identity = articleTitle + "\0" + publishedAt + "\0" + text.substring(0, Math.min(200, text.length()));
            String id = id(source.toString(), identity);
            if (!ids.add(id)) continue;
            Node authorNode = firstNonempty(first(item, "creator"), first(item, "author"));
            Node authorName = authorNode == null ? null : first(authorNode, "name");
            String author = plain(text(authorName == null ? authorNode : authorName));
            int words = text.isEmpty() ? 0 : text.split("\\s+").length;
            long cjk = text.chars().filter(c -> c >= 0x3400 && c <= 0x9fff).count();
            String excerpt = text.length() > 240 ? text.substring(0, 237).trim() + "…" : text;
            articles.put(new JSONObject().put("id", id).put("title", articleTitle).put("url", articleUrl)
                    .put("author", author).put("publishedAt", publishedAt).put("content", content)
                    .put("excerpt", excerpt).put("image", image(item, content, articleUrl))
                    .put("readingTime", Math.max(1, (int) Math.ceil(words / 230.0 + cjk / 450.0))));
        }
        return new JSONObject().put("title", title).put("url", source.toString()).put("siteUrl", site)
                .put("description", plain(text(firstNonempty(first(channel, "description"), first(channel, "subtitle")))))
                .put("articles", articles);
    }

    private static void optionalFeature(XMLReader reader, String name, boolean value) {
        try {
            reader.setFeature(name, value);
        } catch (SAXException ignored) {
            // LexicalHandler rejects all DTDs and EntityResolver rejects all external I/O independently.
        }
    }

    private static String link(Node node, boolean atom) {
        String fallback = "";
        for (Node child : node.children()) {
            if (!child.name.equals("link")) continue;
            String href = child.attr("href");
            if (!atom && href.isEmpty() && !text(child).isEmpty()) return text(child).trim();
            String rel = child.attr("rel");
            if (!href.isEmpty() && (rel.isEmpty() || rel.equals("alternate"))) {
                if (fallback.isEmpty()) fallback = href;
                String type = child.attr("type");
                if (type.isEmpty() || type.equals("text/html") || type.equals("application/xhtml+xml")) return href;
            }
        }
        return fallback;
    }

    private static String image(Node item, String content, String base) {
        List<Node> media = new ArrayList<>(item.children());
        for (Node node : item.children()) {
            if (node.namespace.equals(MEDIA_NS) && node.name.equals("group")) media.addAll(node.children());
        }
        for (int category = 0; category < 3; category++) {
            for (Node node : media) {
                String candidate = node.attr("url");
                if (candidate.isEmpty()) candidate = node.attr("href");
                boolean imageType = node.attr("type").toLowerCase(Locale.ROOT).startsWith("image/")
                        || candidate.toLowerCase(Locale.ROOT).matches(".*\\.(png|jpe?g|webp|gif|avif)([?#].*)?$");
                boolean accepted = category == 0 && node.namespace.equals(MEDIA_NS) && node.name.equals("thumbnail")
                        || category == 1 && node.namespace.equals(MEDIA_NS) && node.name.equals("content")
                        && (node.attr("medium").equals("image") || imageType)
                        || category == 2 && imageType && (node.name.equals("enclosure")
                        || node.name.equals("link") && node.attr("rel").equals("enclosure"));
                if (accepted) {
                    String url = safeWebUrl(candidate, base);
                    if (!url.isEmpty()) return url;
                }
            }
        }
        Element image = Jsoup.parseBodyFragment(content).selectFirst("img[src]");
        return image == null ? "" : safeWebUrl(image.attr("src"), base);
    }

    private static String safeWebUrl(String value, String base) {
        if (value == null || value.trim().isEmpty()) return "";
        HttpUrl baseUrl = HttpUrl.parse(base);
        HttpUrl url = baseUrl == null ? HttpUrl.parse(value.trim()) : baseUrl.resolve(value.trim());
        if (url == null || !url.username().isEmpty() || !url.password().isEmpty()) return "";
        return url.toString();
    }

    private static String date(Node node) {
        String raw = text(node).trim();
        if (raw.isEmpty()) return EPOCH;
        try { return ISO_DATE.format(Instant.parse(raw)); } catch (DateTimeParseException ignored) {}
        try { return ISO_DATE.format(OffsetDateTime.parse(raw).toInstant()); } catch (DateTimeParseException ignored) {}
        try { return ISO_DATE.format(ZonedDateTime.parse(raw, DateTimeFormatter.RFC_1123_DATE_TIME).toInstant()); } catch (DateTimeParseException ignored) {}
        try { return ISO_DATE.format(LocalDateTime.parse(raw).toInstant(ZoneOffset.UTC)); } catch (DateTimeParseException ignored) {}
        try { return ISO_DATE.format(LocalDate.parse(raw).atStartOfDay().toInstant(ZoneOffset.UTC)); } catch (DateTimeParseException ignored) {}
        return EPOCH;
    }

    private static String id(String sourceUrl, String identity) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest((sourceUrl + "\0" + identity).getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(24);
        for (int i = 0; i < 12; i++) hex.append(String.format(Locale.ROOT, "%02x", digest[i] & 0xff));
        return hex.toString();
    }

    private static String plain(String value) {
        return Jsoup.parseBodyFragment(value).text().replaceAll("\\s+", " ").trim();
    }

    private static Node first(Node parent, String name) {
        if (parent == null) return null;
        for (Node node : parent.children()) if (node.name.equals(name)) return node;
        return null;
    }

    private static Node firstNs(Node parent, String namespace, String name) {
        for (Node node : parent.children()) if (node.name.equals(name) && node.namespace.equals(namespace)) return node;
        return null;
    }

    private static Node firstNonempty(Node... nodes) {
        for (Node node : nodes) if (node != null && (!text(node).isEmpty() || !node.children().isEmpty())) return node;
        return null;
    }

    private static String text(Node node) {
        if (node == null) return "";
        StringBuilder result = new StringBuilder();
        appendText(node, result);
        return result.toString();
    }

    private static void appendText(Node node, StringBuilder output) {
        for (Object part : node.parts) {
            if (part instanceof Node) appendText((Node) part, output);
            else output.append(part);
        }
    }

    private static String markup(Node node) {
        if (node == null) return "";
        if (node.children().isEmpty()) return text(node);
        StringBuilder output = new StringBuilder();
        for (Object part : node.parts) {
            if (part instanceof Node) serialize((Node) part, output);
            else output.append(escape(part.toString()));
        }
        return output.toString();
    }

    private static void serialize(Node node, StringBuilder output) {
        output.append('<').append(node.name);
        for (Map.Entry<String, String> attribute : node.attributes.entrySet()) {
            output.append(' ').append(attribute.getKey()).append("=\"").append(escape(attribute.getValue())).append('"');
        }
        output.append('>');
        for (Object part : node.parts) {
            if (part instanceof Node) serialize((Node) part, output);
            else output.append(escape(part.toString()));
        }
        output.append("</").append(node.name).append('>');
    }

    private static String escape(String value) {
        return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }

    private static final class Node {
        final String name;
        final String namespace;
        final Map<String, String> attributes = new LinkedHashMap<>();
        final List<Object> parts = new ArrayList<>();

        Node(String namespace, String name, Attributes attributes) {
            this.namespace = namespace;
            this.name = name;
            for (int i = 0; i < attributes.getLength(); i++) {
                String key = attributes.getQName(i);
                if (key.isEmpty()) key = attributes.getLocalName(i);
                this.attributes.put(key, attributes.getValue(i));
            }
        }
        String attr(String name) { return attributes.getOrDefault(name, ""); }
        List<Node> children() {
            List<Node> children = new ArrayList<>();
            for (Object part : parts) if (part instanceof Node) children.add((Node) part);
            return children;
        }
    }

    private static final class TreeHandler extends DefaultHandler2 {
        final Deque<Node> stack = new ArrayDeque<>();
        Node root;
        int nodes;

        @Override public void startElement(String uri, String local, String qualified, Attributes attributes) throws SAXException {
            if (stack.size() >= 128 || ++nodes > 200_000) throw new SAXException("XML_LIMIT");
            Node node = new Node(uri, local.isEmpty() ? qualified : local, attributes);
            if (stack.isEmpty()) root = node;
            else stack.peek().parts.add(node);
            stack.push(node);
        }
        @Override public void endElement(String uri, String local, String qualified) { stack.pop(); }
        @Override public void characters(char[] chars, int start, int length) {
            if (stack.isEmpty() || length == 0) return;
            List<Object> parts = stack.peek().parts;
            if (parts.isEmpty() || !(parts.get(parts.size() - 1) instanceof StringBuilder)) parts.add(new StringBuilder());
            ((StringBuilder) parts.get(parts.size() - 1)).append(chars, start, length);
        }
        @Override public void startDTD(String name, String publicId, String systemId) throws SAXException {
            throw new SAXException("DTD_FORBIDDEN");
        }
        @Override public InputSource resolveEntity(String publicId, String systemId) throws SAXException {
            throw new SAXException("EXTERNAL_ENTITY_FORBIDDEN");
        }
        @Override public InputSource resolveEntity(String name, String publicId, String baseUri, String systemId) throws SAXException {
            throw new SAXException("EXTERNAL_ENTITY_FORBIDDEN");
        }
        @Override public InputSource getExternalSubset(String name, String baseUri) throws SAXException {
            throw new SAXException("EXTERNAL_ENTITY_FORBIDDEN");
        }
        @Override public void skippedEntity(String name) throws SAXException { throw new SAXException("ENTITY_FORBIDDEN"); }
        @Override public void error(SAXParseException e) throws SAXException { throw e; }
        @Override public void fatalError(SAXParseException e) throws SAXException { throw e; }
    }
}
