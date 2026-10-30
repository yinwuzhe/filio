package app.folio.reader;

import static org.junit.Assert.*;

import java.io.IOException;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Protocol;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;
import okio.Buffer;
import okio.BufferedSource;
import org.junit.Test;

public class SafeHttpTest {
    @Test public void rejectsUnsafeUrlsAndReservedAddresses() throws Exception {
        for (String url : new String[]{"file:///etc/passwd", "ftp://example.com/feed", "https://user:pass@example.com/",
                "http://@example.com/", "http://localhost/feed", "http://printer.local/feed", "http://127.0.0.1/",
                "http://10.0.0.1/", "http://100.64.0.1/", "http://192.0.2.1/", "http://198.18.0.1/",
                "http://2130706433/", "http://127.1/", "http://[::1]/", "http://[::ffff:8.8.8.8]/",
                "http://[2002:0808:0808::1]/", "http://[2001:db8::1]/", "http://[3fff::1]/",
                "http://example.com/\n", "http://example.com\\@localhost/"}) {
            assertThrows(url, FolioException.class, () -> SafeHttp.validateUrl(url, false));
        }
        assertEquals("https://example.com/rss?key=value", SafeHttp.validateUrl("https://example.com/rss?key=value#anchor", false).toString());
        for (String url : new String[]{"http://example.com", "https://example.com/?key=value", "https://example.com/#fragment"}) {
            assertThrows(FolioException.class, () -> SafeHttp.validateUrl(url, true));
        }
        assertTrue(SafeHttp.isPublicAddress(InetAddress.getByName("8.8.8.8")));
        assertTrue(SafeHttp.isPublicAddress(InetAddress.getByName("2606:4700:4700::1111")));
        assertFalse(SafeHttp.isPublicAddress(InetAddress.getByName("169.254.169.254")));
        byte[] mapped = new byte[16];
        mapped[10] = mapped[11] = (byte) 0xff;
        mapped[12] = mapped[13] = mapped[14] = mapped[15] = 8;
        assertFalse(SafeHttp.isPublicAddress(Inet6Address.getByAddress(null, mapped, -1)));
    }

    @Test public void enforcesStreamingDeclaredSizeAndEncodingLimits() throws Exception {
        try (Response response = response("1234", -1).build()) {
            assertEquals("1234", SafeHttp.readBody(response, 4));
        }
        try (Response response = response("12345", -1).build()) {
            assertEquals("FEED_TOO_LARGE", assertThrows(FolioException.class, () -> SafeHttp.readBody(response, 4)).code);
        }
        try (Response response = response("x", 1).header("Content-Length", "99").build()) {
            assertEquals("FEED_TOO_LARGE", assertThrows(FolioException.class, () -> SafeHttp.readBody(response, 4)).code);
        }
        try (Response response = response("compressed payload", -1).header("Content-Encoding", "gzip").build()) {
            assertEquals("INVALID_ENCODING", assertThrows(FolioException.class, () -> SafeHttp.readBody(response, 64)).code);
        }
        Response network = new Response.Builder().request(request()).protocol(Protocol.HTTP_1_1).code(200).message("OK")
                .header("Content-Encoding", "gzip").build();
        try (Response response = response("transparent decompressed payload", -1).networkResponse(network).build()) {
            assertEquals("INVALID_ENCODING", assertThrows(FolioException.class, () -> SafeHttp.readBody(response, 64)).code);
        }
    }

    @Test public void clientDisablesImplicitRedirectsRetriesAndTransparentGzip() throws Exception {
        OkHttpClient client = SafeHttp.client(1234).newBuilder().addInterceptor(chain -> {
            assertEquals("identity", chain.request().header("Accept-Encoding"));
            return response("ok", 2).request(chain.request()).build();
        }).build();
        assertEquals(1234, client.callTimeoutMillis());
        assertFalse(client.followRedirects());
        assertFalse(client.followSslRedirects());
        assertFalse(client.retryOnConnectionFailure());
        assertThrows(UnknownHostException.class, () -> client.dns().lookup("127.0.0.1"));
        try (Response response = client.newCall(request().newBuilder().header("Accept-Encoding", "gzip").build()).execute()) {
            assertEquals("ok", SafeHttp.readBody(response, 2));
        }
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }

    @Test public void doesNotFollowUp503WithRetryAfterZero() throws Exception {
        try (okhttp3.mockwebserver.MockWebServer server = new okhttp3.mockwebserver.MockWebServer()) {
            server.start();
            server.enqueue(new okhttp3.mockwebserver.MockResponse().setResponseCode(503).setHeader("Retry-After", "0").setBody("Unavailable"));
            server.enqueue(new okhttp3.mockwebserver.MockResponse().setResponseCode(200).setBody("Must not be requested"));
            // Only the test replaces DNS; production continues to reject loopback addresses.
            OkHttpClient client = SafeHttp.client(2000).newBuilder()
                    .dns(host -> java.util.Collections.singletonList(InetAddress.getByName("127.0.0.1")))
                    .build();
            try {
                Request request = new Request.Builder()
                        .url(server.url("/chat/completions").newBuilder().host("provider.example.org").build())
                        .post(okhttp3.RequestBody.create("{}", MediaType.get("application/json"))).build();
                try (Response response = client.newCall(request).execute()) {
                    assertEquals(503, response.code());
                    assertEquals("Unavailable", response.body().string());
                }
                assertEquals("There must be no implicit second request", 1, server.getRequestCount());
            } finally {
                client.connectionPool().evictAll();
                client.dispatcher().executorService().shutdownNow();
            }
        }
    }

    private static Request request() { return new Request.Builder().url("https://example.com/feed").build(); }

    private static Response.Builder response(String value, long declaredLength) {
        byte[] data = value.getBytes(StandardCharsets.UTF_8);
        ResponseBody body = new ResponseBody() {
            final Buffer buffer = new Buffer().write(data);
            @Override public MediaType contentType() { return MediaType.parse("application/xml"); }
            @Override public long contentLength() { return declaredLength; }
            @Override public BufferedSource source() { return buffer; }
        };
        return new Response.Builder().request(request()).protocol(Protocol.HTTP_1_1).code(200).message("OK").body(body);
    }
}
