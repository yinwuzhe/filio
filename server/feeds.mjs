import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import Parser from 'rss-parser';
import sax from 'sax';

export const MAX_FEED_BYTES = 8 * 1024 * 1024;
export const FEED_TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const MAX_ARTICLES = 1000;
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export class FeedError extends Error {
  constructor(message, status = 400, code = 'INVALID_FEED') {
    super(message);
    this.name = 'FeedError';
    this.status = status;
    this.code = code;
  }
}

const privateIPv4Ranges = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10],
  [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12],
  [0xc0000000, 24], [0xc0000200, 24], [0xc0586300, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24],
  [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

function ipv6Number(address) {
  if (address.includes('.') || address.includes('%')) return null;
  const halves = address.toLowerCase().split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  return groups.reduce((number, group) => (number << 16n) | BigInt(`0x${group}`), 0n);
}

export function isPublicAddress(address) {
  const family = isIP(address);
  if (family === 4) {
    const number = address.split('.').reduce((value, octet) => value * 256 + Number(octet), 0);
    return !privateIPv4Ranges.some(([network, bits]) =>
      Math.floor(number / 2 ** (32 - bits)) === Math.floor(network / 2 ** (32 - bits)));
  }
  if (family !== 6) return false;
  const number = ipv6Number(address);
  if (number === null || number >> 125n !== 1n) return false;
  const blocked = [
    ['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20],
  ];
  return !blocked.some(([network, bits]) =>
    number >> BigInt(128 - bits) === ipv6Number(network) >> BigInt(128 - bits));
}

export function validateFeedUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\u0000-\u001f\u007f]/.test(input)) {
    throw new FeedError('Enter a valid RSS or Atom feed URL.', 400, 'INVALID_URL');
  }
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new FeedError('Enter a complete feed URL, including https://.', 400, 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new FeedError('Feed URLs must use HTTP or HTTPS without embedded credentials.', 400, 'INVALID_URL');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  const family = isIP(hostname);
  const localDomain = !hostname.includes('.') || /(^|\.)(localhost|localdomain|local|internal|lan|home|arpa|invalid|test|onion)$/.test(hostname);
  if ((family && !isPublicAddress(hostname)) || (!family && localDomain)) {
    throw new FeedError('Local and private network feeds are not allowed.', 400, 'PRIVATE_ADDRESS');
  }
  url.hash = '';
  return url;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason;
}

function abortable(promise, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

async function resolvePublicAddress(url, lookup, signal) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const family = isIP(hostname);
  let addresses;
  try {
    addresses = family ? [{ address: hostname, family }]
      : await abortable(Promise.resolve().then(() => lookup(hostname, { all: true, verbatim: true })), signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new FeedError('The feed hostname could not be resolved.', 502, 'DNS_ERROR');
  }
  throwIfAborted(signal);
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new FeedError('The feed resolves to a local or private network address.', 400, 'PRIVATE_ADDRESS');
  }
  return { address: addresses[0].address, family: isIP(addresses[0].address) };
}

function requestFeed(url, address, signal, request) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const transport = request ?? (url.protocol === 'https:' ? https.request : http.request);
    const req = transport(url, {
      method: 'GET',
      agent: false,
      family: address.family,
      autoSelectFamily: false,
      signal,
      lookup: (_hostname, options, callback) => {
        if (typeof options === 'function') {
          callback = options;
          options = {};
        }
        if (options?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      headers: {
        Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'User-Agent': 'Folio/1.0 (RSS Reader)',
      },
    }, resolve);
    req.once('error', (error) => reject(signal.aborted ? signal.reason : error));
    req.end();
  });
}

export function readResponseBody(response, { maxBytes = MAX_FEED_BYTES, signal } = {}) {
  return new Promise((resolve, reject) => {
    const declaredSize = Number(response.headers['content-length']);
    const tooLarge = () => new FeedError('This feed exceeds the 8 MB size limit.', 413, 'FEED_TOO_LARGE');
    if (declaredSize > maxBytes) {
      response.destroy();
      reject(tooLarge());
      return;
    }
    const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
    const decoders = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };
    if (encoding !== 'identity' && !Object.hasOwn(decoders, encoding)) {
      response.destroy();
      reject(new FeedError('The feed uses an unsupported content encoding.', 502, 'INVALID_ENCODING'));
      return;
    }
    const decoder = encoding === 'identity' ? null : decoders[encoding]();
    const source = decoder ?? response;
    const chunks = [];
    let received = 0;
    let expanded = 0;
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      response.destroy();
      decoder?.destroy();
      reject(error);
    };
    const onAbort = () => fail(signal.reason);
    response.on('error', () => fail(new FeedError('The feed connection was interrupted.', 502, 'NETWORK_ERROR')));
    response.on('aborted', () => fail(new FeedError('The feed connection was interrupted.', 502, 'NETWORK_ERROR')));
    response.on('data', (chunk) => {
      received += chunk.length;
      if (received > maxBytes) fail(tooLarge());
    });
    source.on('error', () => fail(new FeedError('The feed response could not be decoded.', 502, 'INVALID_ENCODING')));
    source.on('data', (chunk) => {
      if (settled) return;
      expanded += chunk.length;
      if (expanded > maxBytes) fail(tooLarge());
      else chunks.push(Buffer.from(chunk));
    });
    source.once('end', () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (decoder) response.pipe(decoder);
  });
}

const parser = new Parser({
  customFields: {
    feed: [['subtitle', 'subtitle']],
    item: [
      ['content:encoded', 'contentEncoded'],
      ['media:content', 'mediaContent', { keepArray: true }],
      ['media:thumbnail', 'mediaThumbnail', { keepArray: true }],
      ['media:group', 'mediaGroup', { keepArray: true }],
      ['enclosure', 'enclosures', { keepArray: true }],
      ['link', 'rawLinks', { keepArray: true }],
    ],
  },
});

function stringValue(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return stringValue(value[0]);
  return value && typeof value === 'object' ? stringValue(value._ ?? value.name) : '';
}

function plainText(value) {
  return stringValue(value)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
    })[entity])
    .replace(/&#(x[\da-f]+|\d+);/gi, (_entity, code) => {
      const point = /^x/i.test(code) ? Number.parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : '';
    })
    .replace(/\s+/g, ' ').trim();
}

function safeWebUrl(value, base) {
  const text = stringValue(value).trim();
  if (!text) return '';
  try {
    const url = new URL(text, base);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
}

function imageFromItem(item, content, base) {
  const groups = item.mediaGroup ?? [];
  const thumbnails = [...(item.mediaThumbnail ?? []), ...groups.flatMap((group) => group['media:thumbnail'] ?? [])];
  const media = [...(item.mediaContent ?? []), ...groups.flatMap((group) => group['media:content'] ?? [])];
  const enclosures = [item.enclosure, ...(item.enclosures ?? []), ...(item.rawLinks ?? []).filter((link) => link.$?.rel === 'enclosure')];
  const candidates = [
    ...thumbnails.map((node) => node.$?.url ?? node.url),
    ...media.filter((node) => {
      const attributes = node.$ ?? node;
      return attributes.medium === 'image' || /^image\//i.test(attributes.type ?? '') || /\.(?:png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(attributes.url ?? '');
    }).map((node) => node.$?.url ?? node.url),
    ...enclosures.filter(Boolean).filter((node) => {
      const attributes = node.$ ?? node;
      return /^image\//i.test(attributes.type ?? '') || /\.(?:png|jpe?g|webp|gif|avif)(?:\?|$)/i.test(attributes.url ?? attributes.href ?? '');
    }).map((node) => (node.$ ?? node).url ?? (node.$ ?? node).href),
  ];
  const match = content.match(/<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  if (match) candidates.push(match[1] ?? match[2] ?? match[3]);
  return candidates.map((candidate) => safeWebUrl(candidate, base)).find(Boolean) ?? '';
}

export async function parseFeedXml(xml, feedUrl) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) {
    throw new FeedError('This feed exceeds the 8 MB size limit.', 413, 'FEED_TOO_LARGE');
  }
  let feed;
  try {
    const validator = sax.parser(true);
    const rejectHtml = () => {
      const preview = xml.slice(0, 64 * 1024).replace(/<[^<>]*>/g, ' ');
      if (/正在进行安全检测|安全验证|checking your browser|verify (?:that )?you are (?:a )?human|enable javascript and cookies/i.test(preview)) {
        throw new FeedError('The site returned a security verification page instead of a feed. Try another official feed URL or retry later.', 403, 'FEED_ACCESS_BLOCKED');
      }
      throw new FeedError('This address returned a web page, not an RSS or Atom feed. Please use the feed URL.', 422, 'NOT_A_FEED');
    };
    const rejectDeclaration = () => {
      throw new FeedError('Feeds with document type or entity declarations are not supported.', 422, 'INVALID_XML');
    };
    validator.ondoctype = (declaration) => {
      if (/^\s*html(?:\s|$)/i.test(declaration)) rejectHtml();
      rejectDeclaration();
    };
    let hasRoot = false;
    validator.onopentag = (node) => {
      if (!hasRoot && node.name.toLowerCase() === 'html') rejectHtml();
      hasRoot = true;
    };
    validator.onsgmldeclaration = rejectDeclaration;
    validator.onerror = (error) => { throw error; };
    validator.write(xml).close();
    feed = await parser.parseString(xml);
  } catch (error) {
    if (error instanceof FeedError) throw error;
    throw new FeedError('This address does not contain a valid RSS or Atom feed.', 422, 'INVALID_XML');
  }
  const siteUrl = safeWebUrl(feed.link, feedUrl) || new URL(feedUrl).origin;
  const ids = new Set();
  const articles = (feed.items ?? []).slice(0, MAX_ARTICLES).map((item) => {
    const content = stringValue(item.contentEncoded || item['content:encoded'] || item.content || item.summary || item.description);
    const text = plainText(content || item.contentSnippet || item.summary);
    const title = plainText(item.title) || 'Untitled article';
    const url = safeWebUrl(item.link, siteUrl) || safeWebUrl(item.guid) || siteUrl;
    const rawDate = item.isoDate || item.pubDate || item.published || item.updated;
    const date = rawDate ? new Date(rawDate) : null;
    const publishedAt = date && Number.isFinite(date.getTime()) ? date.toISOString() : '1970-01-01T00:00:00.000Z';
    const identity = stringValue(item.guid || item.id || item.link) || `${title}\0${publishedAt}\0${text.slice(0, 200)}`;
    const id = createHash('sha256').update(`${feedUrl}\0${identity}`).digest('hex').slice(0, 24);
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    const cjkCount = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
    return {
      id, title, url,
      author: plainText(item.creator || item.author || item['dc:creator']) || '',
      publishedAt,
      content,
      excerpt: text.length > 240 ? `${text.slice(0, 237).trimEnd()}…` : text,
      image: imageFromItem(item, content, url),
      readingTime: Math.max(1, Math.ceil(wordCount / 230 + cjkCount / 450)),
    };
  }).filter((item) => {
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    return true;
  });
  return {
    title: plainText(feed.title) || new URL(feedUrl).hostname,
    url: feedUrl,
    siteUrl,
    description: plainText(feed.description || feed.subtitle),
    articles,
  };
}

export function createFeedFetcher({ lookup = dnsLookup, request, timeoutMs = FEED_TIMEOUT_MS, maxBytes = MAX_FEED_BYTES } = {}) {
  return async function fetchFeedWithOptions(input) {
    const sourceUrl = validateFeedUrl(input);
    const is36krFeed = ['36kr.com', 'www.36kr.com'].includes(sourceUrl.hostname)
      && /^\/feed\/?$/.test(sourceUrl.pathname) && !sourceUrl.search && !sourceUrl.port;
    let url = is36krFeed ? validateFeedUrl('https://www.36kr.com/feed') : sourceUrl;
    const identityUrl = url.href !== sourceUrl.href ? sourceUrl.href : undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const timer = setTimeout(() => controller.abort(new FeedError('The feed took too long to respond. Please try again.', 504, 'FEED_TIMEOUT')), timeoutMs);
    try {
      for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
        const address = await resolvePublicAddress(url, lookup, signal);
        const response = await requestFeed(url, address, signal, request);
        throwIfAborted(signal);
        if (REDIRECT_CODES.has(response.statusCode)) {
          response.destroy();
          if (redirects === MAX_REDIRECTS) throw new FeedError('The feed redirected too many times.', 502, 'TOO_MANY_REDIRECTS');
          if (!response.headers.location) throw new FeedError('The feed returned an invalid redirect.', 502, 'INVALID_REDIRECT');
          let redirect;
          try {
            redirect = new URL(response.headers.location, url).href;
          } catch {
            throw new FeedError('The feed returned an invalid redirect.', 502, 'INVALID_REDIRECT');
          }
          url = validateFeedUrl(redirect);
          continue;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          response.destroy();
          throw new FeedError(`The feed server returned HTTP ${response.statusCode}.`, 502, 'UPSTREAM_ERROR');
        }
        const xml = await readResponseBody(response, { maxBytes, signal });
        const feed = await abortable(parseFeedXml(xml, identityUrl ?? url.href), signal);
        return feed;
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof FeedError) throw error;
      throw new FeedError('Unable to connect to this feed. Check the address and try again.', 502, 'NETWORK_ERROR');
    } finally {
      clearTimeout(timer);
    }
  };
}

export const fetchFeed = createFeedFetcher();

export async function feedMiddleware(req, res, next) {
  let requestUrl;
  try {
    requestUrl = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    next();
    return;
  }
  if (requestUrl.pathname !== '/api/feed') {
    next();
    return;
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      throw new FeedError('Only GET requests are supported.', 405, 'METHOD_NOT_ALLOWED');
    }
    if (requestUrl.searchParams.getAll('url').length !== 1) {
      throw new FeedError('Provide exactly one feed URL.', 400, 'INVALID_URL');
    }
    const feed = await fetchFeed(requestUrl.searchParams.get('url'));
    res.statusCode = 200;
    res.end(JSON.stringify(feed));
  } catch (error) {
    const failure = error instanceof FeedError ? error : new FeedError('The feed could not be loaded.', 500, 'INTERNAL_ERROR');
    res.statusCode = failure.status;
    res.end(JSON.stringify({ error: failure.message, code: failure.code }));
  }
}
