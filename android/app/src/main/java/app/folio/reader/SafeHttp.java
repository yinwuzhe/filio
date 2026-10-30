package app.folio.reader;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.InetAddress;
import java.net.Proxy;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.ConnectionPool;
import okhttp3.Dns;
import okhttp3.HttpUrl;
import okhttp3.OkHttpClient;
import okhttp3.Response;
import okhttp3.ResponseBody;

public final class SafeHttp {
    private static final long[][] BLOCKED_V4 = {
        {0x00000000L, 8}, {0x0a000000L, 8}, {0x64400000L, 10},
        {0x7f000000L, 8}, {0xa9fe0000L, 16}, {0xac100000L, 12},
        {0xc0000000L, 24}, {0xc0000200L, 24}, {0xc0586300L, 24},
        {0xc0a80000L, 16}, {0xc6120000L, 15}, {0xc6336400L, 24},
        {0xcb007100L, 24}, {0xe0000000L, 4}, {0xf0000000L, 4}
    };

    private SafeHttp() {}

    public static HttpUrl validateUrl(String value, boolean httpsOnly) throws FolioException {
        if (value == null || value.trim().isEmpty() || value.length() > 4096) {
            throw invalidUrl();
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (c <= 0x1f || c == 0x7f || c == '\\') throw invalidUrl();
        }
        String input = value.trim();
        if (!input.regionMatches(true, 0, "https://", 0, 8)
                && !input.regionMatches(true, 0, "http://", 0, 7)) throw invalidUrl();
        HttpUrl url = HttpUrl.parse(input);
        if (url == null || (httpsOnly && !url.isHttps())
                || !url.username().isEmpty() || !url.password().isEmpty()
                || (httpsOnly && (url.query() != null || url.fragment() != null))) {
            throw invalidUrl();
        }
        int authorityStart = input.indexOf("://") + 3;
        int authorityEnd = input.length();
        for (char delimiter : new char[]{'/', '?', '#'}) {
            int position = input.indexOf(delimiter, authorityStart);
            if (position >= 0) authorityEnd = Math.min(authorityEnd, position);
        }
        String authority = input.substring(authorityStart, authorityEnd);
        if (authority.contains("@")) throw invalidUrl();
        if (authority.startsWith("[")) {
            int bracket = authority.indexOf(']');
            if (bracket < 0) throw invalidUrl();
            try {
                InetAddress literal = InetAddress.getByName(authority.substring(1, bracket));
                if (literal.getAddress().length != 16 || !isPublicAddress(literal)) throw privateAddress();
            } catch (UnknownHostException e) {
                throw invalidUrl();
            }
        }
        String host = url.host().toLowerCase(Locale.ROOT);
        if (host.endsWith(".")) host = host.substring(0, host.length() - 1);
        if (host.contains(":")) {
            try {
                // Java normalizes mapped IPv6 into IPv4, so require an actual IPv6 result.
                InetAddress literal = InetAddress.getByName(host);
                if (literal.getAddress().length != 16 || !isPublicAddress(literal)) throw privateAddress();
            } catch (UnknownHostException e) {
                throw invalidUrl();
            }
        } else if (host.matches("[0-9.]+")) {
            String[] parts = host.split("\\.", -1);
            if (parts.length != 4) throw privateAddress();
            byte[] bytes = new byte[4];
            for (int i = 0; i < parts.length; i++) {
                try {
                    if (parts[i].isEmpty() || parts[i].length() > 3
                            || (parts[i].length() > 1 && parts[i].startsWith("0"))) throw privateAddress();
                    int part = Integer.parseInt(parts[i]);
                    if (part > 255) throw privateAddress();
                    bytes[i] = (byte) part;
                } catch (NumberFormatException e) {
                    throw invalidUrl();
                }
            }
            try {
                if (!isPublicAddress(InetAddress.getByAddress(bytes))) throw privateAddress();
            } catch (UnknownHostException e) {
                throw invalidUrl();
            }
        } else {
            if (!host.contains(".") || host.endsWith(".")
                    || host.matches(".*(^|\\.)(localhost|localdomain|local|internal|lan|home|arpa|invalid|test|onion)$")) {
                throw privateAddress();
            }
        }
        return url.newBuilder().fragment(null).build();
    }

    public static boolean isPublicAddress(InetAddress address) {
        if (address == null || address.isAnyLocalAddress() || address.isLoopbackAddress()
                || address.isLinkLocalAddress() || address.isSiteLocalAddress() || address.isMulticastAddress()) {
            return false;
        }
        byte[] bytes = address.getAddress();
        if (bytes.length == 4) {
            long value = 0;
            for (byte b : bytes) value = (value << 8) | (b & 0xffL);
            for (long[] range : BLOCKED_V4) {
                long mask = (0xffffffffL << (32 - range[1])) & 0xffffffffL;
                if ((value & mask) == (range[0] & mask)) return false;
            }
            return true;
        }
        if (bytes.length != 16 || (bytes[0] & 0xe0) != 0x20) return false;
        int first = ((bytes[0] & 0xff) << 8) | (bytes[1] & 0xff);
        if (first == 0x2002) return false;
        if (first == 0x2001 && (bytes[2] & 0xfe) == 0) return false;
        if (first == 0x2001 && (bytes[2] & 0xff) == 0x0d && (bytes[3] & 0xff) == 0xb8) return false;
        return first != 0x3fff || (bytes[2] & 0xf0) != 0;
    }

    public static OkHttpClient client(long timeoutMillis) {
        if (timeoutMillis <= 0) throw new IllegalArgumentException("timeoutMillis must be positive");
        return new OkHttpClient.Builder()
                .callTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .connectTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .readTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .writeTimeout(timeoutMillis, TimeUnit.MILLISECONDS)
                .followRedirects(false)
                .followSslRedirects(false)
                .retryOnConnectionFailure(false)
                .proxy(Proxy.NO_PROXY)
                .connectionPool(new ConnectionPool(0, 1, TimeUnit.SECONDS))
                .dns(hostname -> {
                    List<InetAddress> addresses = Dns.SYSTEM.lookup(hostname);
                    if (addresses.isEmpty()) throw new UnknownHostException("DNS_ERROR");
                    for (InetAddress address : addresses) {
                        if (!isPublicAddress(address)) throw new UnknownHostException("PRIVATE_ADDRESS");
                    }
                    return addresses;
                })
                .addInterceptor(chain -> {
                    try {
                        validateUrl(chain.request().url().toString(), false);
                    } catch (FolioException e) {
                        throw new IOException(e.code, e);
                    }
                    // Explicit identity disables OkHttp's transparent gzip before its bridge interceptor.
                    return chain.proceed(chain.request().newBuilder().header("Accept-Encoding", "identity").build());
                })
                .addNetworkInterceptor(chain -> {
                    Response response = chain.proceed(chain.request());
                    // OkHttp can follow up a 503/Retry-After: 0 even when connection retries are disabled.
                    return response.code() == 503
                            ? response.newBuilder().removeHeader("Retry-After").build()
                            : response;
                })
                .build();
    }

    public static String readBody(Response response, int maxBytes) throws IOException, FolioException {
        if (maxBytes <= 0) throw new IllegalArgumentException("maxBytes must be positive");
        rejectEncoding(response);
        if (response.networkResponse() != null) rejectEncoding(response.networkResponse());
        ResponseBody body = response.body();
        if (body == null) throw new FolioException("订阅源返回了空响应。", "INVALID_FEED");
        for (String size : response.headers("Content-Length")) {
            try {
                long declared = Long.parseLong(size.trim());
                if (declared < 0) throw new NumberFormatException();
                if (declared > maxBytes) throw tooLarge();
            } catch (NumberFormatException e) {
                throw new FolioException("订阅源返回了无效响应。", "INVALID_FEED");
            }
        }
        if (body.contentLength() > maxBytes) throw tooLarge();
        try (InputStream input = body.byteStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int total = 0;
            int count;
            while ((count = input.read(buffer, 0, (int) Math.min(buffer.length, (long) maxBytes - total + 1))) != -1) {
                if (count > maxBytes - total) throw tooLarge();
                output.write(buffer, 0, count);
                total += count;
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private static void rejectEncoding(Response response) throws FolioException {
        for (String encoding : response.headers("Content-Encoding")) {
            if (!"identity".equalsIgnoreCase(encoding.trim())) {
                throw new FolioException("订阅源未返回受支持的未压缩内容。", "INVALID_ENCODING");
            }
        }
    }

    private static FolioException invalidUrl() {
        return new FolioException("请输入有效且不含账号密码的订阅地址。", "INVALID_URL");
    }

    private static FolioException privateAddress() {
        return new FolioException("不允许访问本地、内网或保留网络地址。", "PRIVATE_ADDRESS");
    }

    private static FolioException tooLarge() {
        return new FolioException("订阅内容超过允许的大小限制。", "FEED_TOO_LARGE");
    }
}
