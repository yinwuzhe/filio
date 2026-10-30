import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import {
  createFeedFetcher, feedMiddleware, isPublicAddress, MAX_FEED_BYTES,
  parseFeedXml, readResponseBody, validateFeedUrl,
} from './feeds.mjs';

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>A quieter &amp; better web</title><link>https://example.com</link><description>Thoughtful stories</description>
<item><guid isPermaLink="false">story-1</guid><title>Small things</title><link>https://example.com/stories/one</link><dc:creator>Ada Reader</dc:creator><pubDate>Wed, 16 Sep 2026 09:00:00 GMT</pubDate>
<description>A short summary</description><content:encoded><![CDATA[<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>]]></content:encoded>
<media:thumbnail url="https://images.example.com/one.jpg" /></item>
<item><guid isPermaLink="false">story-2</guid><title>Morning light</title><link>/stories/two</link><description><![CDATA[<p>Another story.</p>]]></description><enclosure url="/photos/two.webp" type="image/webp" length="500" /></item>
</channel></rss>`;

const ATOM = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Field notes</title><subtitle>A small collection</subtitle>
<link href="https://example.com/notes"/><id>urn:notes</id><updated>2026-09-16T08:30:00Z</updated>
<entry><id>urn:note:1</id><title>A slower morning</title><link rel="alternate" href="https://example.com/notes/one"/>
<link rel="enclosure" href="https://images.example.com/atom.jpg" type="image/jpeg"/>
<author><name>Robin</name></author><updated>2026-09-16T08:30:00Z</updated>
<content type="html">&lt;p&gt;Read with &lt;em&gt;intention&lt;/em&gt;.&lt;/p&gt;</content></entry></feed>`;

function createResponse(body, { statusCode = 200, headers = {} } = {}) {
  const response = new PassThrough();
  response.statusCode = statusCode;
  response.headers = headers;
  queueMicrotask(() => response.end(body));
  return response;
}

function fixtureFetcher(replies, overrides = {}) {
  const calls = [];
  const dnsCalls = [];
  const lookup = async (hostname) => {
    dnsCalls.push(hostname);
    return [{ address: '93.184.216.34', family: 4 }];
  };
  const request = (url, options, callback) => {
    calls.push({ url, options });
    const reply = replies[calls.length - 1] ?? replies.at(-1);
    const req = new EventEmitter();
    req.end = () => {
      queueMicrotask(() => {
        if (reply?.requestError) {
          req.emit('error', new Error('Internal transport details'));
          return;
        }
        if (reply?.stall) return;
        const response = new PassThrough();
        response.statusCode = reply?.statusCode ?? 200;
        response.headers = reply?.headers ?? {};
        callback(response);
        queueMicrotask(() => {
          if (!reply?.holdBody) response.end(reply?.body ?? RSS);
        });
      });
    };
    const onAbort = () => req.emit('error', options.signal.reason);
    options.signal.addEventListener('abort', onAbort, { once: true });
    return req;
  };
  return {
    fetch: createFeedFetcher({ lookup, request, ...overrides }),
    calls,
    dnsCalls,
  };
}

test('normalizes RSS, encoded HTML, author, date, images, and relative URLs', async () => {
  const feed = await parseFeedXml(RSS, 'https://example.com/rss.xml');
  assert.equal(feed.title, 'A quieter & better web');
  assert.equal(feed.url, 'https://example.com/rss.xml');
  assert.equal(feed.description, 'Thoughtful stories');
  assert.equal(feed.articles.length, 2);
  const article = feed.articles[0];
  assert.match(article.content, /<strong>story<\/strong>/);
  assert.equal(article.excerpt, 'A long-form story & a quiet moment.');
  assert.equal(article.author, 'Ada Reader');
  assert.equal(article.publishedAt, '2026-09-16T09:00:00.000Z');
  assert.equal(article.image, 'https://images.example.com/one.jpg');
  assert.equal(article.readingTime, 1);
  assert.equal(feed.articles[1].publishedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(feed.articles[1].url, 'https://example.com/stories/two');
  assert.equal(feed.articles[1].image, 'https://example.com/photos/two.webp');
  assert.equal((await parseFeedXml(RSS, feed.url)).articles[0].id, article.id);
});

test('normalizes Atom content, subtitle, author, enclosure, and date', async () => {
  const feed = await parseFeedXml(ATOM, 'https://example.com/atom.xml');
  assert.equal(feed.title, 'Field notes');
  assert.equal(feed.description, 'A small collection');
  assert.equal(feed.articles.length, 1);
  assert.equal(feed.articles[0].author, 'Robin');
  assert.equal(feed.articles[0].url, 'https://example.com/notes/one');
  assert.equal(feed.articles[0].content, '<p>Read with <em>intention</em>.</p>');
  assert.equal(feed.articles[0].image, 'https://images.example.com/atom.jpg');
  assert.equal(feed.articles[0].publishedAt, '2026-09-16T08:30:00.000Z');
});

test('uses media groups or inline images and excludes non-web image URLs', async () => {
  const media = RSS.replace('<media:thumbnail url="https://images.example.com/one.jpg" />', '<media:group><media:content medium="image" url="/group.jpg" /></media:group>');
  assert.equal((await parseFeedXml(media, 'https://example.com/feed')).articles[0].image, 'https://example.com/group.jpg');
  const inline = RSS.replace('<media:thumbnail url="https://images.example.com/one.jpg" />', '').replace('<strong>story</strong>', '<img src="/inline.jpg"><strong>story</strong>');
  assert.equal((await parseFeedXml(inline, 'https://example.com/feed')).articles[0].image, 'https://example.com/inline.jpg');
  const invalid = RSS.replace('https://images.example.com/one.jpg', 'javascript:alert(1)');
  assert.equal((await parseFeedXml(invalid, 'https://example.com/feed')).articles[0].image, '');
});

test('deduplicates stable IDs and does not share IDs between different feeds', async () => {
  const duplicate = RSS.replace('story-2', 'story-1');
  const feed = await parseFeedXml(duplicate, 'https://example.com/feed');
  assert.equal(feed.articles.length, 1);
  const other = await parseFeedXml(duplicate, 'https://another.example.com/feed');
  assert.notEqual(feed.articles[0].id, other.articles[0].id);
});

test('handles invalid dates and derives a reading duration from content', async () => {
  const xml = RSS.replace('Wed, 16 Sep 2026 09:00:00 GMT', 'not a date').replace('A long-form', 'word '.repeat(500));
  const feed = await parseFeedXml(xml, 'https://example.com/feed');
  assert.equal(feed.articles[0].publishedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(feed.articles[0].readingTime, 3);
  assert.ok(feed.articles[0].excerpt.length <= 240);
});

test('keeps missing and invalid dates stable across parsing and JSON persistence', async () => {
  const xml = RSS.replace('Wed, 16 Sep 2026 09:00:00 GMT', 'not a date');
  const first = await parseFeedXml(xml, 'https://example.com/feed');
  const restored = JSON.parse(JSON.stringify(first));
  const refreshed = await parseFeedXml(xml, 'https://example.com/feed');
  assert.deepEqual(restored, first);
  assert.deepEqual(refreshed, restored);
  for (const article of restored.articles) {
    assert.equal(typeof article.publishedAt, 'string');
    assert.equal(article.publishedAt, '1970-01-01T00:00:00.000Z');
    assert.equal(Date.parse(article.publishedAt), 0);
  }
});

test('rejects malformed XML, DTDs, and oversized XML', async () => {
  for (const xml of ['<rss><channel>', '<!DOCTYPE rss><rss version="2.0"><channel /></rss>']) {
    await assert.rejects(parseFeedXml(xml, 'https://example.com/feed'), { code: 'INVALID_XML' });
  }
  await assert.rejects(parseFeedXml('a'.repeat(MAX_FEED_BYTES + 1), 'https://example.com/feed'), { code: 'FEED_TOO_LARGE' });
});

test('distinguishes HTML pages from malformed RSS without depending on content type', async () => {
  for (const body of [
    '<html><body>Not a feed</body></html>',
    '<!doctype html><html><head><meta charset="utf-8"></head><body>Not a feed</body></html>',
    '\uFEFF<!-- Page --><HTML><BODY>Not a feed</BODY></HTML>',
    '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body>Not a feed</body></html>',
  ]) {
    await assert.rejects(parseFeedXml(body, 'https://example.com/feed'), { code: 'NOT_A_FEED', status: 422 });
    const fixture = fixtureFetcher([{ body, headers: { 'content-type': 'application/rss+xml' } }]);
    await assert.rejects(fixture.fetch('https://example.com/feed'), { code: 'NOT_A_FEED' });
  }
});

test('reports security verification HTML rather than an XML declaration error', async () => {
  for (const message of ['正在进行安全检测...', '安全验证', 'Checking your browser', 'Verify you are human']) {
    for (const prefix of ['', '<!DOCTYPE html>']) {
      const body = `${prefix}<html><body><h1>${message}</h1></body></html>`;
      await assert.rejects(parseFeedXml(body, 'https://example.com/feed'), {
        code: 'FEED_ACCESS_BLOCKED', status: 403,
        message: 'The site returned a security verification page instead of a feed. Try another official feed URL or retry later.',
      });
    }
  }
  const body = '<!DOCTYPE html><html><body>正在进行安全检测...</body></html>';
  const fixture = fixtureFetcher([{ body: gzipSync(Buffer.from(body)), headers: { 'content-encoding': 'gzip', 'content-type': 'text/html' } }]);
  await assert.rejects(fixture.fetch('https://36kr.com/feed'), { code: 'FEED_ACCESS_BLOCKED' });
  assert.equal(fixture.calls.length, 1);
});

test('bounds HTML inspection and handles long runs of unclosed tags', async () => {
  for (const body of [
    `<html>${'<'.repeat(1_000_000)}`,
    `<!DOCTYPE html><html>${'<'.repeat(1_000_000)}`,
    `<html>${' '.repeat(64 * 1024)}<p>正在进行安全检测...</p></html>`,
  ]) {
    await assert.rejects(parseFeedXml(body, 'https://example.com/feed'), { code: 'NOT_A_FEED' });
  }
});

test('does not classify security-check articles or HTML in feed content as blocked pages', async () => {
  const content = '<!DOCTYPE html><html><body><p>正在进行安全检测... Checking your browser</p></body></html>';
  const rss = RSS.replace('<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>', content);
  const atom = ATOM.replace('&lt;p&gt;Read with &lt;em&gt;intention&lt;/em&gt;.&lt;/p&gt;', `<![CDATA[${content}]]>`);
  for (const xml of [rss, atom]) {
    assert.equal((await parseFeedXml(xml, 'https://example.com/feed')).articles[0].content, content);
    const fixture = fixtureFetcher([{ body: xml, headers: { 'content-type': 'text/html' } }]);
    assert.equal((await fixture.fetch('https://example.com/feed')).articles[0].content, content);
  }
});

test('preserves GitHub Blog-style HTML doctype inside RSS CDATA', async () => {
  const content = '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN" "http://www.w3.org/TR/REC-html40/loose.dtd"><html><body><p>GitHub Blog article.</p></body></html>';
  const xml = RSS.replace('<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>', content);
  const feed = await parseFeedXml(xml, 'https://github.blog/feed/');
  assert.equal(feed.articles.length, 2);
  assert.equal(feed.articles[0].content, content);
  assert.equal(feed.articles[0].excerpt, 'GitHub Blog article.');
});

test('preserves entity declaration examples as literal CDATA and escaped Atom text', async () => {
  const content = '<!DOCTYPE html><p>Example: <!ENTITY greeting "hello"> &greeting;</p>';
  const xml = RSS.replace('<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>', content);
  assert.equal((await parseFeedXml(xml, 'https://example.com/feed')).articles[0].content, content);
  const atom = ATOM.replace('&lt;p&gt;Read with &lt;em&gt;intention&lt;/em&gt;.&lt;/p&gt;', `<![CDATA[${content}]]>`);
  assert.equal((await parseFeedXml(atom, 'https://example.com/feed')).articles[0].content, content);
  const escaped = ATOM.replace('&lt;p&gt;Read with &lt;em&gt;intention&lt;/em&gt;.&lt;/p&gt;', '&lt;!DOCTYPE html&gt;&lt;p&gt;Text&lt;/p&gt;');
  assert.equal((await parseFeedXml(escaped, 'https://example.com/feed')).articles[0].content, '<!DOCTYPE html><p>Text</p>');
});

test('ignores declaration-like text in XML comments and processing instructions', async () => {
  for (const prefix of [
    '<!-- <!DOCTYPE rss> <!ENTITY example "text"> -->',
    '<?example value="<!DOCTYPE rss> <!ENTITY example text>"?>',
  ]) {
    const xml = RSS.replace('<rss version=', `${prefix}<rss version=`);
    assert.equal((await parseFeedXml(xml, 'https://example.com/feed')).articles.length, 2);
  }
});

test('still rejects real XML DTDs and entity declarations around literal content', async () => {
  for (const declaration of [
    '<!DOCTYPE rss>',
    '<!DOCTYPE rss SYSTEM "https://example.com/external.dtd">',
    '<!DOCTYPE rss [<!ENTITY greeting "hello">]>',
    '<!DOCTYPE rss [<!ENTITY external SYSTEM "file:///folio-test-must-not-read">]>',
    '<!DOCTYPE rss [<!ENTITY % external SYSTEM "https://example.com/external.dtd">%external;]>',
    '<!ENTITY greeting "hello">',
  ]) {
    for (const prefix of ['', '<!-- <![CDATA[ not a CDATA section -->', '<?example value="<![CDATA["?>']) {
      const xml = RSS.replace('<rss version=', `${prefix}${declaration}<rss version=`);
      await assert.rejects(parseFeedXml(xml, 'https://example.com/feed'), { code: 'INVALID_XML' });
    }
  }
  const afterCdata = RSS.replace('</content:encoded>', '</content:encoded><!ENTITY greeting "hello">');
  await assert.rejects(parseFeedXml(afterCdata, 'https://example.com/feed'), { code: 'INVALID_XML' });
});

test('rejects unterminated literal sections instead of hiding invalid XML', async () => {
  for (const xml of [RSS.replace(']]></content:encoded>', '</content:encoded>'), `${RSS}<!-- <!DOCTYPE rss>`, `${RSS}<?example <!ENTITY greeting "hello">`]) {
    await assert.rejects(parseFeedXml(xml, 'https://example.com/feed'), { code: 'INVALID_XML' });
  }
});

test('fetches compressed feeds containing HTML doctypes without modifying article content', async () => {
  const content = '<!DOCTYPE html><html><body><p>Offline-ready story.</p></body></html>';
  const xml = RSS.replace('<p>A long-form <strong>story</strong> &amp; a quiet moment.</p>', content);
  const fixture = fixtureFetcher([{ body: gzipSync(Buffer.from(xml)), headers: { 'content-encoding': 'gzip' } }]);
  const feed = await fixture.fetch('https://example.com/feed');
  assert.equal(feed.articles[0].content, content);
  assert.equal(feed.articles.length, 2);
  assert.equal(fixture.calls.length, 1);
});

test('accepts public HTTP(S) URLs and strips fragments', () => {
  assert.equal(validateFeedUrl(' https://example.com/feed#section ').href, 'https://example.com/feed');
  assert.equal(validateFeedUrl('http://8.8.8.8/feed').hostname, '8.8.8.8');
  assert.equal(validateFeedUrl('https://[2606:4700:4700::1111]/feed').protocol, 'https:');
});

test('rejects unsupported protocols, credentials, malformed URLs, and excessive length', () => {
  for (const input of [null, '', 'example.com/feed', 'file:///etc/passwd', 'ftp://example.com/feed', 'javascript:alert(1)', 'https://user:secret@example.com', 'https://example.com/\nfeed', `https://example.com/${'a'.repeat(4096)}`]) {
    assert.throws(() => validateFeedUrl(input), { code: 'INVALID_URL' });
  }
});

test('rejects loopback, private, reserved, obfuscated, mapped, and local domain URLs', () => {
  for (const input of [
    'http://localhost/feed', 'http://localhost./feed', 'http://sub.localhost/feed',
    'http://printer/feed', 'http://host.local/feed', 'http://host.localdomain/feed',
    'http://metadata.google.internal/feed', 'http://foo.lan/feed',
    'http://127.0.0.1/feed', 'http://127.1/feed', 'http://2130706433/feed',
    'http://0x7f000001/feed', 'http://0177.0.0.1/feed', 'http://10.1.2.3/feed',
    'http://192.168.1.1/feed', 'http://172.16.1.1/feed', 'http://169.254.169.254/feed',
    'http://100.64.0.1/feed', 'http://0.0.0.0/feed', 'http://224.0.0.1/feed',
    'http://[::1]/feed', 'http://[::]/feed', 'http://[fe80::1]/feed',
    'http://[fd00::1]/feed', 'http://[::ffff:127.0.0.1]/feed',
    'http://[::ffff:8.8.8.8]/feed', 'http://[2002:7f00:1::]/feed',
  ]) assert.throws(() => validateFeedUrl(input), { code: 'PRIVATE_ADDRESS' }, input);
});

test('recognizes public IP space and rejects documentation and transition ranges', () => {
  for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPublicAddress(address), true, address);
  }
  for (const address of ['not-an-ip', '192.0.2.1', '198.51.100.1', '203.0.113.1', '198.18.0.1', '240.0.0.1', '2001:db8::1', '2001::1', '2002::1', '3fff::1', '64:ff9b::a00:1', '::ffff:5db8:d822']) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test('pins the validated DNS address while retaining the original TLS/HTTP hostname', async () => {
  const fixture = fixtureFetcher([{ body: RSS }]);
  const feed = await fixture.fetch('https://example.com/feed');
  assert.equal(feed.articles.length, 2);
  assert.deepEqual(fixture.dnsCalls, ['example.com']);
  const { options, url } = fixture.calls[0];
  assert.equal(url.hostname, 'example.com');
  assert.equal(options.agent, false);
  assert.equal(options.autoSelectFamily, false);
  options.lookup('example.com', {}, (error, address, family) => {
    assert.equal(error, null);
    assert.equal(address, '93.184.216.34');
    assert.equal(family, 4);
  });
  options.lookup('example.com', { all: true }, (error, addresses) => {
    assert.equal(error, null);
    assert.deepEqual(addresses, [{ address: '93.184.216.34', family: 4 }]);
  });
});

test('fetches 36kr aliases through the official www endpoint while retaining subscription identity', async () => {
  for (const input of [
    'https://36kr.com/feed', 'https://36kr.com/feed/', 'https://www.36kr.com/feed/',
    'http://36kr.com/feed', 'http://36kr.com/feed/', 'http://www.36kr.com/feed',
    'http://www.36kr.com/feed/', 'https://www.36kr.com/feed',
  ]) {
    const fixture = fixtureFetcher([{ body: RSS }]);
    const feed = await fixture.fetch(input);
    assert.equal(feed.articles.length, 2);
    assert.equal(feed.url, input);
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].url.href, 'https://www.36kr.com/feed');
    assert.deepEqual(fixture.dnsCalls, ['www.36kr.com']);
    const previous = await parseFeedXml(RSS, input);
    assert.deepEqual(feed.articles.map((article) => article.id), previous.articles.map((article) => article.id));
    assert.deepEqual(await fixture.fetch(input), feed);
  }
});

test('does not rewrite unrelated URLs, query variants, or custom ports as 36kr feeds', async () => {
  for (const input of [
    'https://example.com/feed', 'https://36kr.com/news', 'https://36kr.com/feed/other',
    'https://36kr.com/feed?category=tech', 'https://36kr.com:8443/feed',
    'https://36kr.com.evil.example.com/feed', 'https://sub.36kr.com/feed',
  ]) {
    const fixture = fixtureFetcher([{ body: RSS }]);
    await fixture.fetch(input);
    assert.equal(fixture.calls[0].url.href, input);
  }
});

test('keeps URL, DNS, and redirect safety checks for the official 36kr endpoint', async () => {
  const credentials = fixtureFetcher([]);
  await assert.rejects(credentials.fetch('https://user:secret@36kr.com/feed'), { code: 'INVALID_URL' });
  assert.equal(credentials.calls.length, 0);
  const privateDns = fixtureFetcher([], {
    lookup: async (hostname) => {
      assert.equal(hostname, 'www.36kr.com');
      return [{ address: '127.0.0.1', family: 4 }];
    },
  });
  await assert.rejects(privateDns.fetch('https://36kr.com/feed'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(privateDns.calls.length, 0);
  const redirect = fixtureFetcher([{ statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }]);
  await assert.rejects(redirect.fetch('https://36kr.com/feed'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(redirect.calls.length, 1);
});

test('retains 36kr subscription identity after a public redirect without skipping DNS validation', async () => {
  const fixture = fixtureFetcher([
    { statusCode: 302, headers: { location: '/rss.xml' } }, { body: RSS },
  ]);
  const feed = await fixture.fetch('https://36kr.com/feed');
  assert.equal(feed.url, 'https://36kr.com/feed');
  assert.equal(fixture.calls[1].url.href, 'https://www.36kr.com/rss.xml');
  assert.deepEqual(fixture.dnsCalls, ['www.36kr.com', 'www.36kr.com']);
  assert.deepEqual(feed.articles, (await parseFeedXml(RSS, 'https://36kr.com/feed')).articles);
});

test('keeps concurrent feed requests and parsed content isolated', async () => {
  const fixtures = Array.from({ length: 12 }, (_value, index) => fixtureFetcher([
    { body: RSS.replace('A quieter &amp; better web', `Feed ${index}`) },
  ]));
  const feeds = await Promise.all(fixtures.map((fixture, index) => fixture.fetch(`https://example.com/feed-${index}`)));
  assert.deepEqual(feeds.map((feed) => feed.title), Array.from({ length: 12 }, (_value, index) => `Feed ${index}`));
  assert.equal(new Set(feeds.map((feed) => feed.articles[0].id)).size, 12);
});

test('rejects a domain with any private DNS answer before making a request', async () => {
  const fixture = fixtureFetcher([], {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }],
  });
  await assert.rejects(fixture.fetch('https://example.com/feed'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(fixture.calls.length, 0);
});

test('rejects DNS failures without leaking internal error details', async () => {
  const fixture = fixtureFetcher([], { lookup: async () => { throw new Error('Private resolver configuration'); } });
  await assert.rejects(fixture.fetch('https://example.com/feed'), {
    code: 'DNS_ERROR', message: 'The feed hostname could not be resolved.',
  });
});

test('revalidates every redirect and resolves relative locations', async () => {
  const fixture = fixtureFetcher([
    { statusCode: 302, headers: { location: '/moved.xml' } }, { body: ATOM },
  ]);
  const feed = await fixture.fetch('https://example.com/feed');
  assert.equal(feed.url, 'https://example.com/moved.xml');
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.dnsCalls, ['example.com', 'example.com']);
});

test('prevents a public feed redirecting into a private URL', async () => {
  const fixture = fixtureFetcher([{ statusCode: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } }]);
  await assert.rejects(fixture.fetch('https://example.com/feed'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(fixture.calls.length, 1);
});

test('prevents redirect DNS rebinding even when the hostname stays the same', async () => {
  let lookups = 0;
  const fixture = fixtureFetcher([{ statusCode: 302, headers: { location: '/next' } }], {
    lookup: async () => [{ address: lookups++ === 0 ? '8.8.8.8' : '10.0.0.1', family: 4 }],
  });
  await assert.rejects(fixture.fetch('https://example.com/feed'), { code: 'PRIVATE_ADDRESS' });
  assert.equal(fixture.calls.length, 1);
});

test('allows at most five redirects', async () => {
  const fixture = fixtureFetcher([{ statusCode: 301, headers: { location: '/again' } }]);
  await assert.rejects(fixture.fetch('https://example.com/feed'), { code: 'TOO_MANY_REDIRECTS' });
  assert.equal(fixture.calls.length, 6);
});

test('rejects invalid redirects, upstream failures, and transport failures', async () => {
  await assert.rejects(fixtureFetcher([{ statusCode: 302 }]).fetch('https://example.com/feed'), { code: 'INVALID_REDIRECT' });
  await assert.rejects(fixtureFetcher([{ statusCode: 503 }]).fetch('https://example.com/feed'), { code: 'UPSTREAM_ERROR' });
  await assert.rejects(fixtureFetcher([{ requestError: true }]).fetch('https://example.com/feed'), { code: 'NETWORK_ERROR' });
});

test('bounds DNS, request, and body waiting with a total timeout', async () => {
  const options = { timeoutMs: 15 };
  await assert.rejects(fixtureFetcher([], { ...options, lookup: () => new Promise(() => {}) }).fetch('https://example.com/feed'), { code: 'FEED_TIMEOUT' });
  await assert.rejects(fixtureFetcher([{ stall: true }], options).fetch('https://example.com/feed'), { code: 'FEED_TIMEOUT' });
  await assert.rejects(fixtureFetcher([{ holdBody: true }], options).fetch('https://example.com/feed'), { code: 'FEED_TIMEOUT' });
});

test('limits declared and streamed response size', async () => {
  await assert.rejects(readResponseBody(createResponse('small', { headers: { 'content-length': '101' } }), { maxBytes: 100 }), { code: 'FEED_TOO_LARGE' });
  await assert.rejects(readResponseBody(createResponse('a'.repeat(101)), { maxBytes: 100 }), { code: 'FEED_TOO_LARGE' });
  assert.equal(await readResponseBody(createResponse('a'.repeat(100)), { maxBytes: 100 }), 'a'.repeat(100));
});

test('supports gzip, deflate, and Brotli and limits decompressed size', async () => {
  for (const [encoding, compress] of [['gzip', gzipSync], ['deflate', deflateSync], ['br', brotliCompressSync]]) {
    const response = createResponse(compress(Buffer.from(RSS)), { headers: { 'content-encoding': encoding } });
    assert.equal(await readResponseBody(response), RSS);
    const oversized = createResponse(compress(Buffer.from('a'.repeat(1001))), { headers: { 'content-encoding': encoding } });
    await assert.rejects(readResponseBody(oversized, { maxBytes: 1000 }), { code: 'FEED_TOO_LARGE' });
  }
});

test('rejects unsupported encodings and damaged compressed payloads', async () => {
  await assert.rejects(readResponseBody(createResponse('data', { headers: { 'content-encoding': 'compress' } })), { code: 'INVALID_ENCODING' });
  await assert.rejects(readResponseBody(createResponse('not gzip', { headers: { 'content-encoding': 'gzip' } })), { code: 'INVALID_ENCODING' });
});

function middlewareResponse() {
  return {
    headers: {}, statusCode: 0, body: '',
    setHeader(key, value) { this.headers[key] = value; },
    end(value) { this.body = value; },
  };
}

test('API passes unrelated routes through and rejects unsupported methods', async () => {
  let passed = false;
  await feedMiddleware({ url: '/other', method: 'GET' }, middlewareResponse(), () => { passed = true; });
  assert.equal(passed, true);
  const response = middlewareResponse();
  await feedMiddleware({ url: '/api/feed?url=https://example.com', method: 'POST' }, response, () => {});
  assert.equal(response.statusCode, 405);
  assert.equal(response.headers.Allow, 'GET');
  assert.equal(response.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(response.body).code, 'METHOD_NOT_ALLOWED');
});

test('API returns explicit JSON errors for missing, repeated, and forbidden URLs', async () => {
  for (const url of ['/api/feed', '/api/feed?url=', '/api/feed?url=https://example.com&url=https://other.example.com', '/api/feed?url=http://localhost/feed']) {
    const response = middlewareResponse();
    await feedMiddleware({ url, method: 'GET' }, response, () => assert.fail('API must not fall through'));
    assert.equal(response.statusCode, 400);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(typeof JSON.parse(response.body).error, 'string');
  }
});

function desktopFixture({ rendererUrl, packaged = false, primaryInstance = true, translationStub } = {}) {
  const windows = [];
  const ipc = new Map();
  const errors = [];
  const externalLinks = [];
  const app = new EventEmitter();
  app.isPackaged = packaged;
  app.setName = (name) => { app.name = name; };
  app.quit = () => { app.quitting = true; };
  app.requestSingleInstanceLock = () => primaryInstance;
  app.isReady = () => true;
  app.whenReady = () => ({ then(callback) { callback(); } });
  class Window extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      const contents = new EventEmitter();
      contents.mainFrame = { url: '' };
      contents.isDestroyed = () => false;
      contents.setWindowOpenHandler = (handler) => { contents.openWindow = handler; };
      contents.session = {
        setPermissionRequestHandler(handler) { this.request = handler; },
        setPermissionCheckHandler(handler) { this.check = handler; },
      };
      this.webContents = contents;
      windows.push(this);
    }
    isDestroyed() { return false; }
    show() { this.shown = true; }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    loadFile(file) { return this.loadURL(pathToFileURL(file).href); }
    static getAllWindows() { return windows; }
  }
  const electron = {
    app,
    BrowserWindow: Window,
    ipcMain: { handle(channel, callback) { ipc.set(channel, callback); } },
    shell: { async openExternal(url) { externalLinks.push(url); } },
    dialog: { showErrorBox(title, message) { errors.push({ title, message }); } },
  };
  const require = createRequire(import.meta.url);
  runInNewContext(`${readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8')}\nif (translationStub) translationService = Promise.resolve(translationStub);`, {
    require: (name) => name === 'electron' ? electron : require(name),
    __dirname: fileURLToPath(new URL('../electron', import.meta.url)),
    process: { platform: 'darwin', env: rendererUrl ? { ELECTRON_RENDERER_URL: rendererUrl } : {} },
    URL, translationStub,
  });
  return { app, windows, ipc, errors, externalLinks };
}

test('desktop starts an isolated, sandboxed Folio window and denies new windows and permissions', () => {
  const fixture = desktopFixture();
  assert.equal(fixture.app.name, 'Folio');
  assert.equal(fixture.errors.length, 0);
  const window = fixture.windows[0];
  assert.equal(window.options.width, 1440);
  assert.equal(window.options.height, 940);
  assert.equal(window.options.minWidth, 1000);
  assert.equal(window.options.minHeight, 660);
  assert.equal(window.options.titleBarStyle, 'hidden');
  assert.equal(window.options.webPreferences.contextIsolation, true);
  assert.equal(window.options.webPreferences.sandbox, true);
  assert.equal(window.options.webPreferences.nodeIntegration, false);
  assert.match(window.webContents.mainFrame.url, /\/dist\/index\.html$/);
  assert.equal(window.webContents.openWindow({ url: 'https://example.com' }).action, 'deny');
  assert.equal(window.webContents.session.check(), false);
  window.webContents.session.request(null, 'camera', (allowed) => assert.equal(allowed, false));
});

test('desktop rejects a second process before registering IPC or creating a window', () => {
  const fixture = desktopFixture({ primaryInstance: false });
  assert.equal(fixture.app.quitting, true);
  assert.equal(fixture.windows.length, 0);
  assert.equal(fixture.ipc.size, 0);
});

test('desktop restores and focuses the existing window when another instance starts', () => {
  const fixture = desktopFixture();
  const window = fixture.windows[0];
  let restored = false;
  let focused = false;
  window.isMinimized = () => true;
  window.restore = () => { restored = true; };
  window.focus = () => { focused = true; };
  fixture.app.emit('second-instance');
  assert.equal(restored, true);
  assert.equal(focused, true);
  assert.equal(window.shown, true);
  assert.equal(fixture.windows.length, 1);
  window.emit('closed');
  fixture.app.emit('second-instance');
  assert.equal(fixture.windows.length, 2);
});

test('desktop limits development renderer URLs to loopback and ignores overrides in packaged apps', () => {
  for (const url of ['https://example.com', 'http://localhost.evil.example.com', 'file:///tmp/index.html', 'http://user:secret@localhost:5173']) {
    const fixture = desktopFixture({ rendererUrl: url });
    assert.equal(fixture.windows.length, 0);
    assert.equal(fixture.errors.length, 1);
    assert.equal(fixture.app.quitting, true);
  }
  const local = desktopFixture({ rendererUrl: 'http://127.0.0.1:5173/' });
  assert.equal(local.windows[0].webContents.mainFrame.url, 'http://127.0.0.1:5173/');
  const packaged = desktopFixture({ rendererUrl: 'https://example.com', packaged: true });
  assert.match(packaged.windows[0].webContents.mainFrame.url, /\/dist\/index\.html$/);
});

test('desktop blocks unexpected document and subframe navigations', () => {
  const { windows } = desktopFixture();
  const contents = windows[0].webContents;
  let prevented = 0;
  const event = { preventDefault() { prevented += 1; } };
  contents.emit('will-navigate', event, 'https://example.com');
  contents.emit('will-redirect', event, 'file:///etc/passwd');
  contents.emit('will-frame-navigate', { ...event, url: contents.mainFrame.url, isMainFrame: false });
  contents.emit('will-attach-webview', event);
  assert.equal(prevented, 4);
  contents.emit('will-navigate', event, `${contents.mainFrame.url}#saved`);
  assert.equal(prevented, 4);
});

test('desktop IPC accepts only its trusted main frame and safe external HTTP(S) URLs', async () => {
  const fixture = desktopFixture();
  const contents = fixture.windows[0].webContents;
  const trusted = { sender: contents, senderFrame: contents.mainFrame };
  const openExternal = fixture.ipc.get('folio:open-external');
  await openExternal(trusted, 'https://example.com/story');
  assert.deepEqual(fixture.externalLinks, ['https://example.com/story']);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.com', 'data:text/html,x']) {
    await assert.rejects(openExternal(trusted, url));
  }
  for (const event of [
    { sender: contents, senderFrame: null },
    { sender: contents, senderFrame: { url: contents.mainFrame.url } },
    { sender: {}, senderFrame: contents.mainFrame },
  ]) {
    await assert.rejects(openExternal(event, 'https://example.com'), /not authorized/);
    await assert.rejects(fixture.ipc.get('folio:fetch-feed')(event, 'https://example.com'), /not authorized/);
    for (const channel of ['folio:translation-config-get', 'folio:translation-config-save', 'folio:translation-config-clear', 'folio:translate', 'folio:translation-cancel']) {
      await assert.rejects(fixture.ipc.get(channel)(event, {}), /not authorized/);
    }
  }
  contents.mainFrame.url = 'https://example.com';
  await assert.rejects(openExternal(trusted, 'https://example.com'), /not authorized/);
  assert.equal(fixture.externalLinks.length, 1);
});

test('desktop translation IPC routes trusted calls, hides unknown errors, and cancels when the window closes', async () => {
  let cancelled = 0;
  const input = { requestId: 'fixture', segments: ['English'] };
  const translationStub = {
    async getConfig() { return { hasApiKey: false, configured: false }; },
    async translate(value) { assert.equal(value, input); return { segments: ['中文'] }; },
    async saveConfig() { throw new Error('fixture-secret-must-not-escape'); },
    async clearConfig() { throw Object.assign(new Error('清除配置失败。'), { name: 'TranslationError', code: 'CONFIG_WRITE_FAILED' }); },
    cancelAll() { cancelled += 1; },
  };
  const fixture = desktopFixture({ translationStub });
  const window = fixture.windows[0];
  const trusted = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  assert.equal((await fixture.ipc.get('folio:translation-config-get')(trusted)).value.configured, false);
  assert.deepEqual((await fixture.ipc.get('folio:translate')(trusted, input)).value.segments, ['中文']);
  const unknown = await fixture.ipc.get('folio:translation-config-save')(trusted, {});
  assert.equal(unknown.code, 'INTERNAL_ERROR');
  assert.equal(unknown.error.includes('fixture-secret'), false);
  const known = await fixture.ipc.get('folio:translation-config-clear')(trusted);
  assert.equal(known.code, 'CONFIG_WRITE_FAILED');
  assert.equal(known.error, '清除配置失败。');
  window.emit('closed');
  await Promise.resolve();
  assert.equal(cancelled, 1);
});

test('preload exposes only feed, external-link, and translation capabilities and unwraps useful errors', async () => {
  let bridge;
  let fail = false;
  runInNewContext(readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, 'folio'); bridge = value; } },
      ipcRenderer: {
        async invoke(channel, url) {
          if (channel === 'folio:fetch-feed') return fail ? { ok: false, error: 'Invalid feed' } : { ok: true, feed: { url } };
          if (channel.startsWith('folio:translation') || channel === 'folio:translate') {
            return fail ? { ok: false, error: '翻译已取消。', code: 'CANCELLED' } : { ok: true, value: { channel, input: url } };
          }
          assert.equal(channel, 'folio:open-external');
          return undefined;
        },
      },
    }),
  });
  assert.deepEqual(Object.keys(bridge).sort(), ['cancelTranslation', 'clearTranslationConfig', 'fetchFeed', 'getTranslationConfig', 'openExternal', 'saveTranslationConfig', 'translateArticle']);
  assert.equal(Object.isFrozen(bridge), true);
  assert.equal((await bridge.fetchFeed('https://example.com/feed')).url, 'https://example.com/feed');
  await bridge.openExternal('https://example.com');
  for (const [method, channel] of Object.entries({ getTranslationConfig: 'folio:translation-config-get', saveTranslationConfig: 'folio:translation-config-save', clearTranslationConfig: 'folio:translation-config-clear', translateArticle: 'folio:translate', cancelTranslation: 'folio:translation-cancel' })) {
    assert.equal((await bridge[method]('fixture')).channel, channel);
  }
  fail = true;
  await assert.rejects(bridge.fetchFeed('bad'), /Invalid feed/);
  await assert.rejects(bridge.translateArticle({}), { message: '翻译已取消。', code: 'CANCELLED' });
});
