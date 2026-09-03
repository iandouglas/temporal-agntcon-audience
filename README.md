# Audience Switchboard

A page a few hundred people scan into from a QR code. Five labelled switches:
the agent ↔ MCP connection on top, then the four APIs the MCP server calls.
Anyone can flip any switch, every phone in the room sees it move, and each flip
makes a POST to that service's private URL from the server.

## How it works

```
  phone ──tap──> WebSocket ──> replica ──POST {base}/on|/off──> service
                                  │
                                  ├── SET  switchboard:state
                                  └── PUBLISH switchboard:events
                                          │
                        every replica ────┴──── fans out to its own sockets
```

Redis is the serialization point. A tap writes state and publishes; every
replica, including the one that handled the tap, applies the event when it
comes back around. Because Redis delivers to all subscribers in publish order,
replicas cannot end up disagreeing about which tap landed last.

Next.js runs behind a custom Node server (`server/index.ts`) so this process
owns the HTTP upgrade path and can hold the WebSocket connections itself. The
admin endpoints live in that server rather than in a Next route handler,
because Next bundles route handlers into a separate module registry — a `Hub`
imported there would be a different instance from the one holding the sockets.

### Decisions worth knowing

**The audience gate.** The five switches are inert until the operator opens
the floor from `/control`. A cold start defaults to locked, so a phone that
scans the QR code early can never drive anything before you are ready. The gate
is enforced on the server, not just by disabling the buttons — a greyed-out
switch stops an honest phone, but only the server stops a console. It lives in
Redis (`switchboard:armed`), so it survives a redeploy: if the floor was open
when a replica restarted, it comes back open.

**Redis is not a single point of failure.** If it goes down mid-demo, every
write falls back to serving this replica's own clients, so the room keeps
working — switches move, POSTs fire, the gate still holds. Only cross-replica
agreement is lost, and `/control` shows the bus as DEGRADED so you know. When
Redis returns, local state is pushed back into it, because local state absorbed
every tap during the outage while the stored copy was frozen.

**One POST per tap, unthrottled.** The live crowd load is part of the demo, so
taps are not coalesced. Fifty people tapping in a second is fifty calls.

**A per-socket rate cap of 5/sec, burst 10.** A person mashing a switch never
reaches it; a scripted loop in devtools gets its excess dropped. Throttled taps
still move the shared state — only the outbound POST is suppressed, so a
throttled client still sees a responsive UI.

**Boot reads `/health`; after that, the audience is the truth.** A cold start
with no state in Redis probes every service's `/health` and seeds from what it
finds. Once state exists, a booting replica adopts it and does not touch
`/health` — otherwise a restarting replica would drag every switch back to
whatever the services report and discard the crowd's work. `/health` is not
polled after boot.

**The health parser is deliberately permissive.** `true`, `"on"`, `1`,
`{"on":true}`, `{"state":"enabled"}` and similar all read correctly, so the five
services do not have to agree on a response shape.

**Service URLs never reach the browser.** Only ids, names and kinds are sent.
The page renders per request (`force-dynamic`) so names come from the runtime
environment rather than being baked in at build time.

## Environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `mcp_url` | yes | Base URL for the agent ↔ MCP connection. Server-side only. |
| `mcp_name` | no | Label above the top switch. Defaults to `AGENT ↔ MCP SERVER`. |
| `service_1_url` … `service_4_url` | yes | Base URLs for the four APIs. Server-side only. |
| `service_1_name` … `service_4_name` | no | Labels. Default to `SERVICE 1` … `SERVICE 4`. |
| `admin_token` | yes | Gates `/control` and the admin endpoints. Both are disabled without it. |
| `REDIS_URL` | for >1 replica | Railway's Redis plugin sets this. Without it the app uses an in-process bus: correct for one replica, but replicas will not sync. |
| `page_title`, `page_subtitle` | no | Page copy. |

Names are read case-insensitively, so `SERVICE_1_URL` works too. Base URLs are
stored with any trailing slash stripped; the app appends `/on`, `/off` and
`/health`.

A switch whose `*_url` is missing still appears and still toggles — it just
calls nothing, and `/control` shows it as unconfigured. A missing switch is
harder to diagnose on stage than an inert one.

### Railway private networking

Internal URLs need the scheme, the `.railway.internal` host **and the port**:
`http://payments.railway.internal:8080`. They are plain `http`, not `https`.
Railway's private DNS is IPv6-only, which the dispatcher handles via
`autoSelectFamily`.

## Deploying

1. Create a Railway service from this directory. `railway.json` sets the build
   and start commands and points the healthcheck at `/healthz`.
2. Add the Redis plugin if you plan to run more than one replica. It provides
   `REDIS_URL` automatically.
3. Set the variables above.
4. Deploy, then open `/control?token=…` to confirm all five services report
   `configured` and the connected count moves when you open the page on a phone.

## Operator runbook

`/control?token=<admin_token>` shows connected clients across all replicas,
per-service state, tap counts, and the status and latency of the last POST to
each service. It can force any switch on or off individually or in bulk, all
bypassing the rate cap and the audience gate.

### Opening and closing the floor

The **AUDIENCE CONTROLS** switch at the top of `/control` is the run of the
demo. Everything below it works whether the floor is open or closed, so you
never lose the ability to drive the services yourself.

| | audience phones | your controls |
| --- | --- | --- |
| Locked (the default) | switches dimmed and disabled, footer reads *waiting for the demo to start* | fully working |
| Open | all five switches live | fully working |

Flipping it takes effect on every connected phone immediately, with no reload,
in both directions. At the end of the demo: close the floor, then **ALL OFF**.

### Resetting between rehearsal and the keynote

Use **ALL ON** / **ALL OFF** on `/control`, or just set the five switches by
hand. That is the authoritative reset: forcing a switch into a position it
already holds still fires its POST, so this drives the services to a known state
rather than assuming they are already in one.

This matters more than it sounds. If a service drifted — restarted, or was
toggled by something other than this app — the two reset paths do opposite
things:

| | board ends up | service ends up |
| --- | --- | --- |
| ALL ON / ALL OFF | the position you chose | **driven to that position** |
| Reseed from /health | matching the drifted service | unchanged |

So reseed is only the right tool when you want the board to agree with services
you are not driving. For a demo where you control everything, the bulk buttons
are what you want, and `/control` says so next to the reseed button.

```bash
# Read current state without changing anything
curl -H 'authorization: Bearer <admin_token>' https://<host>/api/admin/state

# Reseed, if you ever do want the services to win
curl -XPOST -H 'authorization: Bearer <admin_token>' https://<host>/api/admin/reseed
```

If a service shows a red last-POST line on `/control`, the problem is between
this app and that service, not between the phones and this app — the connected
count and tap counts will still be climbing. The **Bus** tile tells you the
other half: `OK` means replicas are in step, `DEGRADED` means Redis is
unreachable and each replica is serving its own clients in isolation.

A redeploy mid-demo is safe: state lives in Redis, and phones reconnect on their
own with exponential backoff and resync. The page shows `reconnecting…` while
it is out and `live` when it is back.

## Local development

```bash
npm install
cp .env.example .env    # point the URLs at something local
npm run dev             # tsx, with the custom server and hot reload
```

`npm run build && npm start` runs the production path. Without `REDIS_URL` the
app uses an in-process bus and logs a warning.

```bash
npm run typecheck       # app and server tsconfigs
```
