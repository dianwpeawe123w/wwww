# BlueKnight Panel — Deno Deploy

The BlueKnight Panel running on [deno.com](https://console.deno.com) (the new Deno
Deploy, not the sunsetting Deploy Classic).

The panel UI, encrypted DNS resolver and subscription links run here exactly as
they do on Cloudflare Workers. The VLESS/Trojan/Shadowsocks WebSocket relay also
runs, because the new Deno Deploy is a full Deno runtime in a Linux microVM
rather than a V8-isolate edge sandbox.

---

## Why the old `index.js` never started

The previous file in this folder was the **Replit monolith** — the single-file
Node build that uses Express, `require()`, and spawns `sing-box` / `xray` /
`argo` binaries with `child_process`. Deno is ESM-only, so the very first line
died:

```
ReferenceError: require is not defined
    at file:///app/src/index.js:92:12
const fs = require('fs');
```

Renaming it to `.cjs` or adding `"type": "commonjs"` only moves the failure
later. That build cannot work on any serverless host, because it needs to:

- spawn long-lived proxy daemons from binaries on disk,
- accept inbound TCP on a dozen arbitrary ports,
- keep a writable data directory across requests.

None of that exists on Deno Deploy. So this folder now ships the **worker
build** of the same panel — the one written against the Worker API, which does
the relay in-process instead of shelling out to a daemon. It is the same code
that powers the Cloudflare deployment, plus a small Deno adapter.

---

## Layout

```
deno.json                  tasks + the `cloudflare:sockets` import map
src/index.js               entrypoint — Deno.serve, KV wiring, WebSocket bridge
src/worker.js              the panel itself (Cloudflare Worker bundle, unmodified)
src/shims/websocket.js     WebSocketPair + status-101 Response + Deno socket bridge
src/shims/sockets.js       cloudflare:sockets -> node:net / node:tls
src/shims/kv.js            env.BK_KV / env.WD_KV -> Deno KV
src/shims/dns-fetch.js     env.DNS_FETCH
tools/smoke.js             end-to-end test against a running server
tools/dns-local.js         hermetic DoH test (no internet needed)
tools/reset.js             wipes the local KV file
```

Only the four files in `src/shims/` and `src/index.js` are Deno-specific.
`src/worker.js` is copied verbatim from the project's `dist/worker-standalone.js`
and is never edited — regenerate it with `npm run build:standalone` in
`Blue knight Worker` and copy it over.

---

## Run it locally

```sh
deno task start        # http://localhost:8000/panel
deno task dev          # same, with --watch
```

Deno was not installed on this machine, so a portable copy lives at
`D:\Webprogram\BlueKnightPanel\.deno-runtime\deno.exe` (Deno 2.9.7). Either put
that folder on `PATH`, or call the binary directly:

```sh
..\.deno-runtime\deno.exe task start
```

The first request redirects you to `/panel/setup` to choose a password. State is
kept in `data/blueknight_kv.sqlite3`; `deno task reset` wipes it.

Verify it works:

```sh
deno task smoke        # end-to-end: setup, panel, 11 subscription formats, relay, DoH
deno task dns          # DoH round trip against a local mock upstream
```

`deno task smoke` prints a hint if a proxy is configured in your shell — the
WebSocket check cannot reach `localhost` through one, so re-run it with
`NO_PROXY=localhost,127.0.0.1`.

---

## Deploy to Deno Deploy

Deno Deploy apps are created from a GitHub repository, and **mono-repos are not
supported** — the repository root must be this folder. Push it as its own repo
(or use a repo whose root is this directory).

1. **Create the app** — [console.deno.com](https://console.deno.com) → `+ New App`
   → pick the repository.

2. **Build config** — `deno.json` already declares this in source, which takes
   precedence over the dashboard, so the fields below should be greyed out:

   ```json
   "deploy": {
     "runtime": { "type": "dynamic", "entrypoint": "./src/index.js" }
   }
   ```

   If the dashboard is editable (i.e. the source config was not picked up), set
   it by hand:

   | Field | Value |
   | --- | --- |
   | **App directory** | *(empty — the repository root)* |
   | Framework preset | `No Preset` |
   | Install command | *(empty)* |
   | Build command | *(empty)* |
   | Runtime configuration | `Dynamic` |
   | **Entrypoint** | **`src/index.js`** |
   | Arguments / Runtime working directory | *(empty)* |

   `src/index.js` is deliberate: it is the path the original failed build was
   already pointing at, so nothing changes if you are updating an existing app.

   **App directory is the one setting `deno.json` cannot control** — it decides
   where `deno.json` itself is read from. If it is not empty, the entrypoint is
   resolved from inside that subdirectory and the build fails with
   `Entrypoint at '/tmp/build/src/index.js' not found` even though the file is
   plainly in the repository.

3. **Provision KV** — the panel needs somewhere to keep the admin password, the
   VLESS UUID and the subscription token. Without it the panel still boots, but
   every restart regenerates the UUID and silently breaks every subscription
   link already handed to a client.

   `Databases` → `Provision Database` → engine **Deno KV** → name it → then
   `Assign` it to this app. Nothing to configure in code — `Deno.openKv()`
   connects to whichever database is assigned to the running timeline.

4. **Environment variables** (optional, but strongly recommended on a serverless
   host). Setting these pins the identity values so they survive any restart,
   redeploy or lost KV:

   | Variable | Purpose |
   | --- | --- |
   | `VLESS_UUID` | pins the VLESS UUID |
   | `SUB_TOKEN` | pins the subscription token |
   | `TROJAN_PASSWORD` | pins the Trojan password |
   | `PANEL_PASSWORD` | sets the admin password without first-run setup |
   | `JWT_SECRET` | pins the session signing key (32+ chars) |
   | `DENO_KV_PATH` | *local only* — overrides the SQLite path |

   Mark the secrets as **secret** in the console.

5. **Deploy**, then open `https://<app>.deno.deno.net/panel`.

### Verifying a deployment

```sh
BK_BASE=https://<app>.deno.deno.net deno task smoke
```

The relay check needs the client machine to reach the app over WebSocket; the
DoH check needs that app to reach the internet, which it can.

---

## What works on Deno Deploy

| | |
| --- | --- |
| Panel UI, login, settings | Yes |
| Subscription links (11 formats) | Yes — `/sub/vless`, `/sub/clash`, `/sub/singbox`, `/sub/xray`, `/sub/xray-json`, `/sub/all`, `/sub/ss`, `/sub/trojan`, … |
| Encrypted DNS (DoH) | Yes — `/dns-query` |
| VLESS / Trojan / Shadowsocks over WebSocket | Yes — verified with a live TCP round trip |
| Warp / AmneziaWG profiles | After generating credentials in Panel Settings |
| OpenVPN, ShadowTLS, QUIC, raw TCP inbounds | No — these need the native engine host (`deploy-native.mjs`). `/sub/openvpn` answers `503`, as it does on Cloudflare Workers and every other serverless target. |

---

## Known limitations

- **One instance, many regions.** Deno Deploy runs several isolates; they share
  the assigned Deno KV database, so panel state is consistent, but nothing is
  pinned to a single machine.
- **Cold starts.** Deno Deploy stops idle apps and restarts them on the next
  request. Keep `src/worker.js` as-is rather than re-bundling with extra
  dependencies, which is what keeps startup fast.
- **The panel cannot update itself.** Cloudflare's "Panel Update" button uses
  the Cloudflare API to replace the running script. There is no equivalent here
  — to update, replace `src/worker.js` from a newer `dist/worker-standalone.js`
  and push.

---

## Troubleshooting

### `Entrypoint at '/tmp/build/src/index.js' not found`

The file is in the repository — verified with
`raw.githubusercontent.com/<owner>/<repo>/main/src/index.js`. The build is
looking somewhere else. In order of likelihood:

1. **App directory is not empty.** It defaults to the repository root; anything
   else shifts where the entrypoint is resolved from. This is the one field
   `deno.json` cannot override. Clear it.
2. **The build is stale.** A build that ran before the first push only ever saw
   the repository's auto-generated `README.md` commit, and its failure message
   stays on the page. Press **Deploy Default Branch** on the builds page to
   build the current `main` rather than reading the old log.
3. **The app is linked to a different repository.** Check the app settings page;
   you can unlink and relink without recreating the app.

### Deploying without GitHub

`deno deploy` can push a local directory, bypassing the GitHub integration
entirely — useful for isolating whether a failure is in the repo or the build
config:

```sh
deno deploy create --org <org> --app <app> --source local
```



## VLESS XHTTP over TLS (stream-one)

The XHTTP setting now adds `BlueKnight-VLESS-XHTTP-*` nodes to `/sub/vless`,
`/sub/xray` (base64 v2rayN feed), and `/sub/xray-json`. Existing WS nodes stay
available. The panel's VLESS subscription badge reflects whether XHTTP is enabled.
Clash, Sing-box, Trojan and Shadowsocks feeds retain their existing transports.

Use an XHTTP-capable v2rayN version with the Xray core. Refresh the VLESS or Xray
subscription, then select a node whose name contains `VLESS-XHTTP`. The generated
node uses TLS on the existing configured port, ALPN `h2`, `mode=stream-one`, and
the configured XHTTP path (default `/bk-xhttp`). `auto`, `packet-up` and `stream-up`
are not implemented. XHTTP nodes deliberately do not inherit WS-specific fragment,
ECH or final-mask URI options; these combinations have not been validated.

The relay buffers incomplete VLESS/Trojan headers across HTTP chunks, rejects
incomplete or invalid headers, limits the initial header wait to 10 seconds, and
closes upstream connections when the response is cancelled or the client aborts.

Validation: Xray 26.3.27 connected to the live Deno endpoint using TLS + HTTP/2
stream-one and loaded an HTTPS page. The patched relay was tested locally over
TLS + HTTP/2 using a node from the generated Xray JSON subscription: 1 MiB binary
upload/download and eight concurrent requests passed. The complete generated
Xray JSON passed Xray's configuration validation. The v2rayN desktop UI itself
was not run, and the patched version still needs deployment to your Deno app.

Run the regression tests:

```sh
deno task test:xhttp
```

For direct Deno use, connect to your Deno hostname. The earlier WebSocket-only
Cloudflare relay does not forward XHTTP POST requests; using it for XHTTP would
require a separate streaming HTTP proxy implementation and testing.
