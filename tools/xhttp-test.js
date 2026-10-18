// deno test --allow-net tools/xhttp-test.js
import { handleXhttp, readInitialProxyHeader } from '../src/shims/xhttp.js';
import worker from '../src/worker.js';

const UUID = '11111111-2222-4333-8444-555555555555';
const TOKEN = 'local-xhttp-test-token';
const encode = (s) => new TextEncoder().encode(s);
const assert = (value, message = 'Assertion failed') => {
  if (!value) throw new Error(message);
};
function join(...parts) {
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { bytes.set(p, offset); offset += p.length; }
  return bytes;
}
function vless(port, address = encode('127.0.0.1'), type = 2, options = new Uint8Array(0)) {
  const id = Uint8Array.from(UUID.replaceAll('-', '').match(/../g), (s) => parseInt(s, 16));
  return join(new Uint8Array([0]), id, new Uint8Array([options.length]), options,
    new Uint8Array([1, port >> 8, port & 255, type]),
    type === 2 ? new Uint8Array([address.length]) : new Uint8Array(0), address);
}
function stream(chunks) {
  let i = 0;
  return new ReadableStream({ pull(c) { i < chunks.length ? c.enqueue(chunks[i++]) : c.close(); } });
}
function environment(extra = {}) {
  const data = new Map(Object.entries({
    'config:vless_uuid': UUID, 'config:sub_token': TOKEN,
    'config:admin_password': 'local-test-password',
    'config:jwt_secret': 'local-test-signing-key-32-characters-long',
    ...extra,
  }));
  const kv = { envOverrides: true,
    get: (k) => Promise.resolve(data.get(k) ?? null),
    put: (k, v) => { data.set(k, String(v)); return Promise.resolve(); },
    delete: (k) => Promise.resolve(data.delete(k)),
  };
  return { BK_KV: kv, WD_KV: kv };
}
const ctx = { waitUntil: (p) => p.catch(() => {}) };
function request(path, init = {}) {
  return new Request('https://panel.test' + path, init);
}

Deno.test('VLESS headers survive every split point, options and IPv4/IPv6/domain addresses', async () => {
  const headers = [vless(80), vless(443, new Uint8Array([1, 2, 3, 4]), 1),
    vless(443, new Uint8Array(16).fill(1), 3), vless(443, encode('example.com'), 2, new Uint8Array(255))];
  for (const header of headers) {
    for (let split = 1; split < header.length; split++) {
      const reader = stream([header.slice(0, split), header.slice(split)]).getReader();
      const got = await readInitialProxyHeader(reader);
      assert(got.length === header.length);
      reader.releaseLock();
    }
  }
});

Deno.test('Trojan header survives one-byte HTTP chunks', async () => {
  const header = join(encode('a'.repeat(56) + '\r\n'), new Uint8Array([1, 3, 11]),
    encode('example.com'), new Uint8Array([0, 80, 13, 10]));
  const reader = stream([...header].map((b) => new Uint8Array([b]))).getReader();
  assert((await readInitialProxyHeader(reader)).length === header.length);
  reader.releaseLock();
});

Deno.test('truncated, invalid and timed-out headers fail without waiting forever', async () => {
  for (const chunks of [[new Uint8Array([0, 1])], [new Uint8Array([255])]]) {
    const reader = stream(chunks).getReader();
    let failed = false;
    try { await readInitialProxyHeader(reader); } catch { failed = true; }
    reader.releaseLock();
    assert(failed);
  }
  const reader = new ReadableStream({}).getReader();
  let failed = false;
  try { await readInitialProxyHeader(reader, 20); } catch { failed = true; }
  await reader.cancel();
  reader.releaseLock();
  assert(failed);
});

Deno.test('real relay handles fragmented headers and coalesced payload with byte fidelity', async () => {
  const server = Deno.serve({ hostname: '127.0.0.1', port: 0, onListen() {} }, async (req) =>
    new Response(await req.arrayBuffer()));
  try {
    const port = server.addr.port;
    const payload = encode('fragmented-header-round-trip');
    const http = join(encode(`POST / HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${payload.length}\r\nConnection: close\r\n\r\n`), payload);
    const header = vless(port);
    for (const chunks of [[join(header, http)], [...header].map((b) => new Uint8Array([b])).concat([http])]) {
      const response = await worker.fetch(request('/bk-xhttp/', { method: 'POST', body: stream(chunks) }), environment(), ctx);
      assert(response.status === 200, `HTTP ${response.status}`);
      const data = new Uint8Array(await response.arrayBuffer());
      assert(data[0] === 0 && data[1] === 0, 'VLESS response header missing');
      const text = new TextDecoder().decode(data.subarray(2));
      assert(text.startsWith('HTTP/1.1 200'), text);
      assert(text.endsWith(new TextDecoder().decode(payload)), 'Payload changed');
    }
  } finally { await server.shutdown(); }
});

Deno.test('wrong UUID rejected, empty and truncated requests rejected', async () => {
  const wrong = vless(80); wrong[1] ^= 255;
  for (const [body, status] of [[wrong, 403], [new Uint8Array(0), 400], [new Uint8Array([0, 1]), 400]]) {
    const response = await worker.fetch(request('/bk-xhttp', { method: 'POST', body }), environment(), ctx);
    assert(response.status === status, `Expected ${status}, got ${response.status}`);
    await response.text();
  }
});

Deno.test('XHTTP appears in VLESS, base64 v2rayN and Xray JSON subscriptions; WS retained', async () => {
  const env = environment();
  const sub = async (type) => {
    const response = await worker.fetch(request(`/sub/${type}?token=${TOKEN}`), env, ctx);
    assert(response.status === 200);
    return response.text();
  };
  const vlessText = await sub('vless');
  assert(vlessText.includes('type=ws'));
  const link = vlessText.split('\n').find((l) => l.includes('type=xhttp'));
  assert(link, 'XHTTP URI missing');
  const params = new URL(link).searchParams;
  assert(params.get('mode') === 'stream-one' && params.get('alpn') === 'h2');
  assert(params.get('security') === 'tls' && params.get('path') === '/bk-xhttp');
  assert(atob(await sub('xray')).includes('type=xhttp'));
  const config = JSON.parse(await sub('xray-json'));
  const node = config.outbounds.find((o) => o.streamSettings?.network === 'xhttp');
  assert(node?.streamSettings.xhttpSettings.mode === 'stream-one');
  assert(node.streamSettings.tlsSettings.alpn.join(',') === 'h2');
  assert(!(await sub('trojan')).includes('type=xhttp'));
});

Deno.test('disabling XHTTP removes its subscription nodes and refuses its endpoint', async () => {
  // Each deployed instance caches settings; use a fresh instance for this case.
  const { default: worker } = await import('../src/worker.js?test=disabled');
  const env = environment({ 'config:xhttp_enabled': 'false' });
  for (const type of ['vless', 'xray', 'xray-json']) {
    const response = await worker.fetch(request(`/sub/${type}?token=${TOKEN}`), env, ctx);
    let text = await response.text();
    if (type === 'xray') text = atob(text);
    assert(!text.includes('type=xhttp') && !text.includes('"network": "xhttp"'));
  }
  const response = await worker.fetch(request('/bk-xhttp', { method: 'POST', body: 'test' }), env, ctx);
  assert(response.status === 404);
  await response.text();
});

Deno.test('custom XHTTP path is used in links and JSON settings', async () => {
  const { default: worker } = await import('../src/worker.js?test=custom-path');
  const env = environment({ 'config:xhttp_path': '/custom-stream' });
  const response = await worker.fetch(request(`/sub/vless?token=${TOKEN}`), env, ctx);
  const text = await response.text();
  const link = text.split('\n').find((l) => l.includes('type=xhttp'));
  assert(new URL(link).searchParams.get('path') === '/custom-stream');
});

Deno.test('cancelling the download or aborting the request closes the upstream and upload', async () => {
  for (const abort of [false, true]) {
    let closeCount = 0;
    let uploadCancelled = false;
    let download;
    const controller = new AbortController();
    const body = new ReadableStream({
      start(c) { c.enqueue(vless(80)); },
      cancel() { uploadCancelled = true; },
    });
    const pending = [];
    const response = await handleXhttp(request('/bk-xhttp', {
      method: 'POST', body, signal: controller.signal,
    }), { waitUntil: (p) => pending.push(p) }, { vlessUuid: UUID }, {
      isTrojan: () => false,
      parseVless: () => ({ isValidUser: true, command: 1, targetAddress: 'example.com',
        targetPort: 80, payload: new Uint8Array(0), version: 0 }),
      responseHeader: () => new Uint8Array([0, 0]),
      connect: () => ({
        readable: new ReadableStream({ start(c) { download = c; } }),
        writable: new WritableStream(),
        close: () => { closeCount++; download.close(); },
      }),
    });
    if (abort) controller.abort();
    await response.body.cancel();
    await Promise.all(pending);
    assert(closeCount === 1 && uploadCancelled, 'Connection was not cleaned up');
  }
});
