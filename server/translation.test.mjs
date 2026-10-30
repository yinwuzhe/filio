import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import { createTranslationService, createTranslationMiddleware, DEFAULT_BASE_URL } from './translation.mjs';

const { createConfigStore } = createRequire(import.meta.url)('../electron/translation.cjs');
const CONFIG = { baseUrl: DEFAULT_BASE_URL, model: 'fixture-model', apiKey: 'fixture-secret-not-a-real-key' };
const replyBody = (segments, changes = {}) => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ translations: segments }) }, ...changes }] });

function fixture(replies = [], overrides = {}) {
  const calls = [];
  const request = (url, options, callback) => {
    const req = new EventEmitter();
    req.end = (text) => {
      const payload = JSON.parse(text);
      calls.push({ url, options, payload });
      const reply = replies[calls.length - 1] ?? {};
      queueMicrotask(() => {
        if (reply.stall) return;
        if (reply.error) { req.emit('error', new Error(CONFIG.apiKey)); return; }
        const response = new PassThrough();
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        callback(response);
        queueMicrotask(() => {
          if (!reply.holdBody) response.end(reply.body ?? replyBody(JSON.parse(payload.messages[1].content).map((text) => `中:${text}`)));
        });
      });
    };
    options.signal.addEventListener('abort', () => req.emit('error', options.signal.reason), { once: true });
    return req;
  };
  return { calls, service: createTranslationService({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }], ...overrides }) };
}

async function configured(replies, overrides) {
  const result = fixture(replies, overrides);
  await result.service.saveConfig(CONFIG);
  return result;
}

const article = (requestId = 'article-1', segments = ['Hello world']) => ({ requestId, segments });

test('configuration is lazy, redacted, explicit-model, and never inherits a key across a changed URL', async () => {
  let loads = 0;
  let stored;
  const service = createTranslationService({
    loadConfig: async () => { loads += 1; return { config: CONFIG, persistence: 'encrypted' }; },
    saveConfig: async (config) => { stored = config; return 'encrypted'; },
  });
  assert.equal(loads, 0);
  const config = await service.getConfig();
  assert.deepEqual(config, { baseUrl: DEFAULT_BASE_URL, model: 'fixture-model', hasApiKey: true, configured: true, persistence: 'encrypted' });
  assert.equal(JSON.stringify(config).includes(CONFIG.apiKey), false);
  await service.saveConfig({ ...CONFIG, model: 'other-model', apiKey: '' });
  assert.equal(stored.apiKey, CONFIG.apiKey);
  await service.saveConfig({ ...CONFIG, baseUrl: `${DEFAULT_BASE_URL}/`, apiKey: '' });
  assert.equal(stored.apiKey, CONFIG.apiKey);
  assert.equal(stored.baseUrl, DEFAULT_BASE_URL);
  for (const baseUrl of ['https://other.example.com/v1', 'https://api.openai.com/v2']) {
    await assert.rejects(service.saveConfig({ ...CONFIG, baseUrl, apiKey: '' }), { code: 'API_KEY_REQUIRED' });
  }
  assert.equal((await service.clearConfig()).configured, false);
  assert.equal(stored, null);
  assert.equal(loads, 1);
  await assert.rejects(service.saveConfig({ ...CONFIG, model: '' }), { code: 'INVALID_CONFIG' });
  await assert.rejects(service.translate(article()), { code: 'NOT_CONFIGURED' });
});

test('failed decryption is not overwritten by save; clear can recover without decrypting', async () => {
  let writes = 0;
  const service = createTranslationService({ loadConfig: async () => { throw new Error(CONFIG.apiKey); }, saveConfig: async () => { writes += 1; } });
  await assert.rejects(service.getConfig(), { code: 'CONFIG_READ_FAILED' });
  await assert.rejects(service.saveConfig(CONFIG), { code: 'CONFIG_READ_FAILED' });
  assert.equal(writes, 0);
  assert.equal((await service.clearConfig()).hasApiKey, false);
  await service.saveConfig(CONFIG);
  assert.equal(writes, 2);
});

test('configuration writes serialize and a failed write never changes active configuration', async () => {
  const saved = [];
  const service = createTranslationService({ saveConfig: async (config) => {
    await new Promise((resolve) => setImmediate(resolve));
    if (config?.model === 'fail') throw new Error(CONFIG.apiKey);
    saved.push(config?.model);
  } });
  await Promise.all([service.saveConfig(CONFIG), service.saveConfig({ ...CONFIG, model: 'second', apiKey: '' })]);
  assert.deepEqual(saved, ['fixture-model', 'second']);
  await assert.rejects(service.saveConfig({ ...CONFIG, model: 'fail' }), { code: 'CONFIG_WRITE_FAILED' });
  assert.equal((await service.getConfig()).model, 'second');
});

test('rejects unsafe URL shapes before transport and private answers before authorization leaves the process', async () => {
  const { service, calls } = fixture();
  for (const baseUrl of ['http://example.com/v1', 'https://user:key@example.com', 'https://example.com/?x=1', 'https://example.com/#x', 'https://example.com/?', 'https://127.1', 'https://[::1]', 'https://service.local', 'file:///tmp']) {
    await assert.rejects(service.saveConfig({ ...CONFIG, baseUrl }), { code: 'INVALID_URL' });
  }
  assert.equal(calls.length, 0);
  const privateFixture = await configured([], { lookup: async () => [{ address: '8.8.8.8' }, { address: '10.0.0.1' }] });
  await assert.rejects(privateFixture.service.translate(article()), { code: 'PRIVATE_ADDRESS' });
  assert.equal(privateFixture.calls.length, 0);
});

test('batches by both text length and segment count, preserving order and pinned DNS', async () => {
  const { service, calls } = await configured();
  const segments = ['a'.repeat(4000), 'b'.repeat(3000), ...Array.from({ length: 81 }, (_, index) => `piece-${index}`)];
  const result = await service.translate(article('batches', segments));
  assert.deepEqual(result.segments, segments.map((text) => `中:${text}`));
  assert.equal(result.model, CONFIG.model);
  assert.equal(result.provider, 'api.openai.com');
  assert.equal(calls.length, 3);
  for (const { url, options, payload } of calls) {
    assert.equal(url.href, `${DEFAULT_BASE_URL}/chat/completions`);
    assert.equal(options.headers.Authorization, `Bearer ${CONFIG.apiKey}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.agent, false);
    assert.equal(options.autoSelectFamily, false);
    const batch = JSON.parse(payload.messages[1].content);
    assert.ok(batch.length <= 80);
    assert.ok(batch.join('').length <= 6000);
    assert.equal(payload.stream, false);
    options.lookup(url.hostname, { all: true }, (error, addresses) => {
      assert.equal(error, null);
      assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]);
    });
    options.lookup(url.hostname, {}, (error, address, family) => {
      assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4);
    });
  }
});

test('rejects malformed or excessive article inputs without sending requests', async () => {
  const { service, calls } = await configured();
  for (const input of [null, {}, article('', ['text']), article('id', []), article('id', ['']), article('id', [1]), article('id', ['x'.repeat(4001)]), article('id', Array(1001).fill('x')), article('id', Array(11).fill('x'.repeat(4000)))]) {
    await assert.rejects(service.translate(input));
  }
  assert.equal(calls.length, 0);
});

test('rejects redirects, auth, quota and transport errors without leaking provider details or retrying', async () => {
  for (const [reply, code] of [[{ status: 302, headers: { location: 'https://other.example.com' } }, 'REDIRECT_BLOCKED'], [{ status: 401 }, 'AUTH_ERROR'], [{ status: 403 }, 'AUTH_ERROR'], [{ status: 429 }, 'RATE_LIMITED'], [{ status: 500 }, 'UPSTREAM_ERROR'], [{ error: true }, 'NETWORK_ERROR']]) {
    const { service, calls } = await configured([reply]);
    await assert.rejects(service.translate(article()), (error) => error.code === code && !error.message.includes(CONFIG.apiKey));
    assert.equal(calls.length, 1);
  }
});

test('rejects malformed JSON, truncation, refusals, tools, missing or non-string translations', async () => {
  const invalid = ['{', '{}', replyBody(['中'], { finish_reason: 'length' }), replyBody(['中'], { message: { role: 'assistant', content: '{', refusal: null } }), replyBody(['中'], { message: { role: 'assistant', content: '{"translations":["中"]}', refusal: 'no' } }), replyBody(['中'], { message: { role: 'assistant', content: '{"translations":["中"]}', tool_calls: [] } }), ...[[], [''], [1], ['中', '文']].map((values) => replyBody(values))];
  for (const body of invalid) {
    const { service } = await configured([{ body }]);
    await assert.rejects(service.translate(article()), { code: 'INCOMPLETE_RESPONSE' });
  }
  const { service, calls } = await configured([{}, { body: '{}' }]);
  await assert.rejects(service.translate(article('partial', ['a'.repeat(4000), 'b'.repeat(4000)])), (error) => error.code === 'INCOMPLETE_RESPONSE' && !('segments' in error));
  assert.equal(calls.length, 2);
});

test('response size limits apply to headers and streamed bodies', async () => {
  for (const reply of [{ headers: { 'content-length': String(1024 * 1024 + 1) } }, { body: 'x'.repeat(1024 * 1024 + 1) }]) {
    const { service } = await configured([reply]);
    await assert.rejects(service.translate(article()), { code: 'RESPONSE_TOO_LARGE' });
  }
});

test('one deadline covers DNS, waiting for headers and stalled response bodies', async () => {
  for (const [replies, overrides] of [[[], { lookup: () => new Promise(() => {}) }], [[{ stall: true }], {}], [[{ holdBody: true }], {}]]) {
    const { service } = await configured(replies, { ...overrides, timeoutMs: 15 });
    await assert.rejects(service.translate(article()), { code: 'TIMEOUT' });
  }
});

test('only matching IDs cancel; concurrency and request replay never incur extra calls', async () => {
  const { service, calls } = await configured([{ stall: true }]);
  const pending = service.translate(article('active'));
  const rejection = assert.rejects(pending, { code: 'CANCELLED' });
  service.cancel('someone-else');
  await assert.rejects(service.translate(article('other')), { code: 'BUSY' });
  await new Promise((resolve) => setImmediate(resolve));
  service.cancel('active');
  await rejection;
  assert.equal(calls.length, 1);
  await assert.rejects(service.translate(article('active')), { code: 'CANCELLED' });
  await service.translate(article('completed'));
  await assert.rejects(service.translate(article('completed')), { code: 'DUPLICATE_REQUEST' });
});

test('early cancellation blocks a not-yet-registered article without loading config or requesting translation', async () => {
  let loaded = false;
  const { service, calls } = fixture([], { loadConfig: async () => { loaded = true; return { config: CONFIG }; } });
  service.cancel('early');
  await assert.rejects(service.translate(article('early')), { code: 'CANCELLED' });
  assert.equal(loaded, false);
  assert.equal(calls.length, 0);
  await service.translate(article('fresh'));
  assert.equal(calls.length, 1);
});

test('cancellation during configuration loading never sends article text after loading completes', async () => {
  let finishLoading;
  const { service, calls } = fixture([], { loadConfig: () => new Promise((resolve) => { finishLoading = resolve; }) });
  const pending = assert.rejects(service.translate(article('loading')), { code: 'CANCELLED' });
  await new Promise((resolve) => setImmediate(resolve));
  service.cancel('loading');
  await pending;
  finishLoading({ config: CONFIG });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test('early HTTP cancellation is remembered when translation submission arrives later', async (t) => {
  const { service, calls } = await configured();
  const origin = await localServer(t, service);
  const cancelled = await fetch(`${origin}/api/translation/cancel`, { method: 'POST', headers: requestHeaders(origin), body: JSON.stringify({ requestId: 'late-http' }) });
  assert.equal(cancelled.status, 200);
  const translated = await fetch(`${origin}/api/translation`, { method: 'POST', headers: requestHeaders(origin), body: JSON.stringify(article('late-http')) });
  assert.equal((await translated.json()).code, 'CANCELLED');
  assert.equal(calls.length, 0);
});

test('early cancellation tombstones expire and have a bounded capacity', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const { service, calls } = await configured();
  service.cancel('expires');
  await assert.rejects(service.translate(article('expires')), { code: 'CANCELLED' });
  t.mock.timers.tick(300_001);
  await service.translate(article('expires'));
  for (let index = 0; index < 1025; index += 1) service.cancel(`bounded-${index}`);
  await assert.rejects(service.translate(article('bounded-1024')), { code: 'CANCELLED' });
  await service.translate(article('bounded-0'));
  assert.equal(calls.length, 2);
});

test('clear aborts an in-flight article and never returns partial results', async () => {
  const { service } = await configured([{ holdBody: true }]);
  const pending = assert.rejects(service.translate(article()), { code: 'CANCELLED' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await service.clearConfig()).configured, false);
  await pending;
});

function memoryFilesystem(initial) {
  let bytes = initial;
  const calls = [];
  let pending;
  const fs = {
    async stat() { if (!bytes) throw Object.assign(new Error(), { code: 'ENOENT' }); return { size: bytes.length }; },
    async readFile() { return bytes; },
    async mkdir(...args) { calls.push(['mkdir', ...args]); },
    async open(file, flags, mode) {
      calls.push(['open', file, flags, mode]);
      return { async writeFile(value) { pending = value; }, async sync() { calls.push(['sync']); }, async close() {} };
    },
    async rename(from, to) { calls.push(['rename', from, to]); bytes = pending; },
    async unlink(file) { calls.push(['unlink', file]); if (!file.endsWith('.tmp')) bytes = undefined; },
  };
  return { fs, calls, bytes: () => bytes };
}

test('desktop encryption is lazy, atomic, mode 0600 and encrypts the entire config', async () => {
  const memory = memoryFilesystem();
  let plaintext;
  let availability = 0;
  const safeStorage = { isEncryptionAvailable() { availability += 1; return true; }, encryptString(text) { plaintext = text; return Buffer.from('ciphertext-only'); }, decryptString() { return JSON.stringify(CONFIG); } };
  const store = createConfigStore({ app: { getPath: () => '/fixture-user-data' }, safeStorage }, memory.fs);
  assert.equal(availability, 0);
  await store.saveConfig(CONFIG);
  assert.deepEqual(JSON.parse(plaintext), CONFIG);
  assert.equal(memory.bytes().toString(), 'ciphertext-only');
  assert.equal(memory.calls.find(([operation]) => operation === 'open')[3], 0o600);
  assert.ok(memory.calls.some(([operation]) => operation === 'sync'));
  assert.ok(memory.calls.some(([operation]) => operation === 'rename'));
  assert.deepEqual((await store.loadConfig()).config, CONFIG);
});

test('desktop falls back to session-only without encryption and can delete unreadable ciphertext', async () => {
  for (const safeStorage of [{ isEncryptionAvailable: () => false }, { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text' }]) {
    const memory = memoryFilesystem();
    const store = createConfigStore({ app: { getPath: () => '/fixture-user-data' }, safeStorage }, memory.fs);
    assert.equal((await store.loadConfig()).persistence, 'session');
    assert.equal(await store.saveConfig(CONFIG), 'session');
    assert.equal(memory.calls.length, 0);
    assert.equal(memory.bytes(), undefined);
  }
  const memory = memoryFilesystem(Buffer.from('unreadable-ciphertext'));
  const store = createConfigStore({ app: { getPath: () => '/fixture-user-data' }, safeStorage: { isEncryptionAvailable: () => false } }, memory.fs);
  await assert.rejects(store.loadConfig());
  assert.equal(await store.saveConfig(null), 'session');
  assert.equal(memory.bytes(), undefined);
});

async function localServer(t, service) {
  const middleware = createTranslationMiddleware({ service });
  const server = createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const requestHeaders = (origin) => ({ Origin: origin, 'X-Folio-Request': '1', 'Content-Type': 'application/json' });

test('local HTTP config and translation work with same-origin guards and no secret disclosure', async (t) => {
  const { service, calls } = fixture();
  const origin = await localServer(t, service);
  const initial = await fetch(`${origin}/api/translation/config`);
  assert.equal((await initial.json()).configured, false);
  assert.equal(initial.headers.get('access-control-allow-origin'), null);
  const saved = await fetch(`${origin}/api/translation/config`, { method: 'POST', headers: requestHeaders(origin), body: JSON.stringify(CONFIG) });
  assert.equal(saved.status, 200);
  assert.equal((await saved.text()).includes(CONFIG.apiKey), false);
  const translated = await fetch(`${origin}/api/translation`, { method: 'POST', headers: requestHeaders(origin), body: JSON.stringify(article()) });
  assert.deepEqual((await translated.json()).segments, ['中:Hello world']);
  assert.equal(calls.length, 1);
  const cleared = await fetch(`${origin}/api/translation/config`, { method: 'DELETE', headers: requestHeaders(origin) });
  assert.equal((await cleared.json()).configured, false);
});

test('local HTTP blocks forged host, remote origin, cross-site metadata, missing header and invalid bodies', async (t) => {
  const { service } = fixture();
  const origin = await localServer(t, service);
  const headers = requestHeaders(origin);
  for (const changed of [{ ...headers, Host: 'evil.example.com' }, { ...headers, Origin: 'https://evil.example.com' }, { ...headers, 'Sec-Fetch-Site': 'cross-site' }, { ...headers, 'X-Folio-Request': '' }]) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${origin}/api/translation/config`, { method: 'POST', headers: changed }, (response) => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end(JSON.stringify(CONFIG));
    });
    assert.equal(status, 403, JSON.stringify(changed));
  }
  for (const [body, type, code] of [['{}', 'text/plain', 'UNSUPPORTED_MEDIA_TYPE'], ['{', 'application/json', 'INVALID_REQUEST'], ['x'.repeat(256 * 1024 + 1), 'application/json', 'REQUEST_TOO_LARGE']]) {
    const response = await fetch(`${origin}/api/translation/config`, { method: 'POST', headers: { ...headers, 'Content-Type': type }, body });
    assert.equal((await response.json()).code, code);
  }
  const options = await fetch(`${origin}/api/translation`, { method: 'OPTIONS', headers });
  assert.equal(options.status, 405);
});

test('closing an HTTP translation connection cancels its upstream request', async (t) => {
  const { service, calls } = await configured([{ stall: true }]);
  const origin = await localServer(t, service);
  const req = httpRequest(`${origin}/api/translation`, { method: 'POST', headers: requestHeaders(origin) });
  req.on('error', () => {});
  req.end(JSON.stringify(article('disconnect')));
  while (!calls.length) await new Promise((resolve) => setTimeout(resolve, 2));
  req.destroy();
  for (let attempt = 0; attempt < 100 && !calls[0].options.signal.aborted; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(calls[0].options.signal.reason.code, 'CANCELLED');
});
