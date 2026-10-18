/** Xray XHTTP stream-one relay. Other XHTTP modes are not implemented. */
export async function readInitialProxyHeader(reader, timeoutMs = 10000) {
  let bytes = new Uint8Array(0);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Proxy header timed out')), timeoutMs);
  });
  // Read only until a complete header exists; preserve any coalesced payload.
  // HTTP body chunk boundaries do not match protocol packet boundaries.
  try {
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), timeout]);
      if (done) throw new Error('Incomplete proxy header');
      if (!value?.length) continue;
      const joined = new Uint8Array(bytes.length + value.length);
      joined.set(bytes);
      joined.set(value, bytes.length);
      bytes = joined;
      let end;
      if (bytes[0] === 0) {
        if (bytes.length < 18) continue;
        const offset = 18 + bytes[17];
        if (bytes.length < offset + 4) continue;
        const type = bytes[offset + 3];
        if (type === 1) end = offset + 8;
        else if (type === 3) end = offset + 20;
        else if (type === 2) {
          if (bytes.length < offset + 5) continue;
          if (!bytes[offset + 4]) throw new Error('Empty destination');
          end = offset + 5 + bytes[offset + 4];
        } else throw new Error('Invalid VLESS address type');
      } else {
        // Standard Trojan SHA224 credential + CRLF + SOCKS-style destination.
        const prefix = bytes.subarray(0, Math.min(bytes.length, 56));
        if (!prefix.every((b) => b >= 48 && b <= 57 || b >= 65 && b <= 70 || b >= 97 && b <= 102)) {
          throw new Error('Unsupported proxy header');
        }
        if (bytes.length < 60) continue;
        if (bytes[56] !== 13 || bytes[57] !== 10) throw new Error('Invalid Trojan header');
        const type = bytes[59];
        if (type === 1) end = 68;
        else if (type === 4) end = 80;
        else if (type === 3) {
          if (bytes.length < 61) continue;
          if (!bytes[60]) throw new Error('Empty destination');
          end = 65 + bytes[60];
        } else throw new Error('Invalid Trojan address type');
        if (bytes.length >= end && (bytes[end - 2] !== 13 || bytes[end - 1] !== 10)) {
          throw new Error('Invalid Trojan terminator');
        }
      }
      if (bytes.length >= end) return bytes;
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function handleXhttp(request, ctx, settings, protocol) {
  const reader = request.body?.getReader();
  if (!reader) return new Response('Missing XHTTP request body', { status: 400 });
  const reject = async (message, status) => {
    try { await reader.cancel(); } catch { /* Already disconnected. */ }
    reader.releaseLock();
    return new Response(message, { status });
  };
  let initial;
  try {
    initial = await readInitialProxyHeader(reader);
  } catch (error) {
    return reject(error.message, 400);
  }
  const trojan = protocol.isTrojan(initial);
  const parsed = trojan
    ? protocol.parseTrojan(initial, settings.trojanPassword)
    : protocol.parseVless(initial, settings.vlessUuid);
  if (!parsed?.isValidUser) return reject('Proxy authentication failed', 403);
  if (parsed.command !== 1 || !parsed.targetPort) return reject('Only TCP destinations are supported', 400);

  let upstream;
  let writer;
  let upstreamReader;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    request.signal.removeEventListener('abort', stop);
    try { upstream?.close(); } catch { /* Already closed. */ }
    reader.cancel().catch(() => {});
  };
  try {
    upstream = await protocol.connect(parsed.targetAddress, parsed.targetPort);
    request.signal.addEventListener('abort', stop, { once: true });
    if (request.signal.aborted) throw new Error('Client disconnected');
    writer = upstream.writable.getWriter();
    upstreamReader = upstream.readable.getReader();
    if (parsed.payload.length) await writer.write(parsed.payload);
  } catch (error) {
    stop();
    writer?.releaseLock();
    upstreamReader?.releaseLock();
    return reject('XHTTP upstream connection failed', 502);
  }

  const upload = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) await writer.write(value);
      }
      if (!stopped) await writer.close();
    } catch {
      stop();
    } finally {
      writer.releaseLock();
      reader.releaseLock();
    }
  })();
  ctx?.waitUntil?.(upload);

  const body = new ReadableStream({
    start(controller) {
      if (!trojan) controller.enqueue(protocol.responseHeader(parsed.version));
    },
    async pull(controller) {
      try {
        const { value, done } = await upstreamReader.read();
        if (done) {
          controller.close();
          upstreamReader.releaseLock();
          stop();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        upstreamReader.releaseLock();
        stop();
      }
    },
    async cancel() {
      stop();
      try { await upstreamReader.cancel(); } catch { /* Already closed. */ }
      upstreamReader.releaseLock();
    },
  });
  return new Response(body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Accel-Buffering': 'no',
    },
  });
}
