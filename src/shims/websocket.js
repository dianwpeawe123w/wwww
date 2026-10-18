/**
 * Cloudflare's `WebSocketPair` / 101-with-`webSocket` Response, ported to Deno.
 *
 * The BlueKnight worker answers a proxy upgrade with
 *   new Response(null, { status: 101, webSocket })
 * which is a workerd-only extension: the Fetch spec forbids status 101, so
 * Deno's native Response throws on it and `WebSocketPair` does not exist at all.
 *
 * Two pieces fix that:
 *   1. `WebSocketPair` — a plain in-process pair of endpoints. The worker relays
 *      on one end and hands the other back in the response; nothing here ever
 *      touches a real socket.
 *   2. `bridgeDenoSocket` — the actual handshake is Deno's job, via
 *      `Deno.upgradeWebSocket`. This wires Deno's real socket to the pair
 *      endpoint the worker kept, so bytes flow both ways.
 *
 * Same shape as `lib/ws-node.mjs`, minus the hand-rolled RFC 6455 framing that
 * Deno already implements.
 */

const LISTENER_TYPES = ['open', 'message', 'close', 'error'];

/**
 * One end of a WebSocketPair. Mirrors the Cloudflare surface the worker uses:
 * accept / send / close / addEventListener.
 */
class PairSocket {
  constructor() {
    this.readyState = 1; // OPEN
    this.peer = null;
    this._listeners = new Map(LISTENER_TYPES.map((t) => [t, new Set()]));
  }

  /** workerd requires this call before sending; there is nothing to do here. */
  accept() {}

  send(data) {
    if (this.readyState !== 1) return;
    const peer = this.peer;
    if (!peer || peer.readyState !== 1) return;
    peer._emit('message', { data });
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const peer = this.peer;
    if (peer && peer.readyState !== 3) {
      peer.readyState = 3;
      peer._emit('close', { code, reason });
    }
    this._emit('close', { code, reason });
  }

  addEventListener(type, fn) {
    this._listeners.get(type)?.add(fn);
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn);
  }

  _emit(type, event) {
    const set = this._listeners.get(type);
    if (!set || set.size === 0) return;
    // Copy first: a listener may remove itself or its siblings mid-dispatch.
    for (const fn of [...set]) {
      try {
        fn(event);
      } catch (err) {
        console.error(`[BlueKnight WS ${type} listener]`, err);
      }
    }
  }
}

export class WebSocketPair {
  constructor() {
    const client = new PairSocket();
    const server = new PairSocket();
    client.peer = server;
    server.peer = client;
    // Integer-like keys, so Object.values(pair) yields [client, server] in order
    // — which is what the worker destructures.
    this[0] = client;
    this[1] = server;
  }
}

/**
 * Cloudflare returns status 101 with a `webSocket` property. The Fetch spec
 * allows neither, so the real status is stashed over the top of a 200.
 */
export class WorkerResponse extends Response {
  constructor(body, init = {}) {
    if (init && init.status === 101) {
      super(null, { ...init, status: 200, statusText: undefined });
      Object.defineProperty(this, 'status', { value: 101, enumerable: true });
      Object.defineProperty(this, 'webSocket', { value: init.webSocket, enumerable: true });
    } else {
      super(body, init);
      Object.defineProperty(this, 'webSocket', { value: init?.webSocket ?? null, enumerable: true });
    }
  }
}

/** Deno rejects client close codes outside 1000 and 3000-4999. */
function safeCloseCode(code) {
  return code === 1000 || (code >= 3000 && code <= 4999) ? code : 1000;
}

/**
 * Wire Deno's upgraded socket to `clientSocket`, the pair endpoint the worker
 * returned in its 101 response.
 *
 * Client -> worker: socket.onmessage -> clientSocket.send() (the worker reads
 *   from the other end of the pair).
 * Worker -> client: clientSocket 'message' -> socket.send().
 */
export function bridgeDenoSocket(denoSocket, clientSocket) {
  // ArrayBuffer, not Blob: the worker's frame decoder expects bytes, not a
  // Blob it would have to await.
  try {
    denoSocket.binaryType = 'arraybuffer';
  } catch {}

  // The handshake completes only after this response is returned, so the socket
  // is still CONNECTING here. Buffer whatever the worker sends in the meantime
  // (early-data packets, typically) instead of throwing it away.
  let open = denoSocket.readyState === 1;
  const pending = [];

  const sendNow = (data) => {
    try {
      denoSocket.send(data);
    } catch (err) {
      console.warn('[BlueKnight WS send]', err?.message || err);
    }
  };

  denoSocket.onopen = () => {
    open = true;
    while (pending.length) sendNow(pending.shift());
  };
  // send() delivers to the opposite endpoint, where the worker listens.
  // Emitting on clientSocket would feed the outbound listener below and echo
  // the client's bytes straight back without invoking the protocol handler.
  denoSocket.onmessage = (event) => clientSocket.send(event.data);
  denoSocket.onclose = (event) => clientSocket.close(event.code, event.reason);
  denoSocket.onerror = () => clientSocket.close(1006, 'Socket error');

  clientSocket.addEventListener('message', (event) => {
    if (open) sendNow(event.data);
    else pending.push(event.data);
  });

  clientSocket.addEventListener('close', (event) => {
    const code = safeCloseCode(Number(event?.code) || 1000);
    // Close reasons are capped at 123 bytes on the wire.
    const reason = String(event?.reason ?? '').slice(0, 123);
    try {
      denoSocket.close(code, reason);
    } catch {
      try {
        denoSocket.close();
      } catch {}
    }
  });
}
