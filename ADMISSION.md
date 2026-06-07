# Player admission & rate control

How a guest goes from scanning the QR to drawing a tile, and exactly how fast the
server lets them in. Designed for a **20,000-player** opening storm where the whole
audience may scan within ~30 seconds — and to work identically whether they're all
behind **one venue-WiFi NAT IP** or on **20,000 separate mobile IPs**.

There are two independent layers:

1. **nginx** — accepts the TCP/WebSocket connections (so nobody is dropped).
2. **The app admission governor** — paces how fast connected players are handed
   their *first* tile.

The split matters: nginx can only rate-limit *per source IP*, which is useless when
5,000 in-hall players share one NAT IP. So nginx is told to **accept generously**,
and the **app** does the real, IP-agnostic pacing.

---

## The journey of one player

```
 phone                nginx                      Node app
   │  scan QR → GET /  │                            │
   │ ───────────────► │  (static player.html)      │
   │  open WebSocket   │                            │
   │ ───────────────► │  limit_req (per-IP, generous)
   │                   │ ─────────────────────────► │  WS accepted, added to `players`
   │                   │                            │  ── admission governor ──
   │                   │                            │  slot free now?  ── yes ─► { tile }  ✎ draw!
   │                   │                            │                  ── no ──► { wait }  (queued)
   │                   │     …admitRate/sec later…  │  drain timer ─────────────► { tile }  ✎ draw!
```

- The player page (`/`) is served **statically by nginx** — it never touches Node,
  so a reload is instant even under load.
- The WebSocket upgrade passes nginx's per-IP `limit_req` (sized so a whole venue
  behind one IP gets through — see §nginx).
- Once connected, the player enters the **admission governor**. If a slot is free
  they get a tile immediately; otherwise they wait in a queue and are admitted in
  turn at `admitRate` players/second.
- A player who has received their first tile is **admitted**; from then on their
  `next` requests (after each submission) are served immediately and are **not**
  rate-governed — so active drawing never stalls behind new arrivals.

---

## The admission governor (app)

A simple **token bucket** in `server.js`:

- `admitRate` (config, default **800**/sec) — how many *new* players are admitted
  into the game per second. Live-tunable (see §Tuning).
- Tokens refill continuously at `admitRate`/sec, capped at **1 second's worth**
  (so a brief idle period lets ~`admitRate` players in instantly, then it settles
  to the steady rate).
- A timer drains the queue 10×/second; each admitted player is handed a tile.
- Admission also respects **render backpressure**: if the render queue is deep
  (`isHotPathBusy()`, ≥ `HOT_QUEUE_SOFT_LIMIT`), admission pauses until it drains —
  so we never pour players into an overloaded pipeline. Rate-cap **and** load-cap.

**It counts connections, not IPs.** A venue of 5,000 behind one NAT IP and 5,000
people on 5,000 mobile IPs are admitted at the same `admitRate` — fully flexible,
no IP whitelist needed.

### How fast is the whole crowd in?

`time ≈ players / admitRate` (plus a ~1-second burst at the start):

| `admitRate` | 5,000 players | 10,000 | 20,000 |
|------------:|--------------:|-------:|-------:|
| 500/s       | ~10 s         | ~20 s  | ~40 s  |
| **800/s**   | ~6 s          | ~13 s  | **~25 s** |
| 1000/s      | ~5 s          | ~10 s  | ~20 s  |

Default **800/s** brings a full 20k in ~25 s — within a 30-second reveal, with margin.
Measured locally: at `admitRate=20`, 100 players are admitted at a clean ~20/s.

### Pre-slice waiting room

If players connect **before** the host slices an image (no active session yet), they
are held in the same queue showing *"Get ready! The game starts soon."* The moment
the image is sliced, the governor drains them into the game at `admitRate` — a paced
ramp, not a single dump. (Note: the session persists in the DB across restarts, so
once you've sliced, the game stays "live" and new joiners are admitted immediately —
the pre-slice lobby only appears before the first slice or after a full data wipe.)

### What the player sees

| Server message | Player screen |
|----------------|---------------|
| `waiting` | "Get ready! The game starts soon." (no session yet) |
| `wait`    | "Almost there! Finding you a piece to draw…" (queued, or render busy) |
| `tile`    | The drawing screen with their piece |

The overlay clears automatically when their `tile` arrives — the player does nothing.

---

## nginx — accept generously (venue-proof)

nginx's job is only to **not drop legitimate connections**; the app does the pacing.
Because the limit is per-IP and a venue is one IP, the burst must cover the whole
venue:

```nginx
limit_req_zone $binary_remote_addr zone=player:10m rate=1000r/s;

location /ws {
    limit_req zone=player burst=20000 nodelay;
    # …proxy_pass to the app…
}
```

- `burst=20000` → a single IP (the whole venue) can open up to 20,000 connections in
  one go; individual mobile IPs are trivially under the limit.
- `rate=1000r/s` refills the bucket (covers reconnects after the initial burst).
- `nodelay` → admit immediately, reject only beyond burst+rate (a sane anti-abuse cap).
- Keep `listen 443 ssl backlog=65535` so the SYN storm doesn't overflow the accept queue.

> **Trade-off:** with `burst=20000`, a single IP *may* open 20k connections. That's
> the event ceiling anyway and the server handles it (load test: 6k actively drawing
> ≈ 20 % CPU). It's the only IP-agnostic way to let an unknown venue IP through.

---

## Tuning

**Change the admission rate live** (no restart), via the admin/config API:

```bash
curl -X POST -H "x-admin-token: $TOKEN" -H "Content-Type: application/json" \
  -d '{"admitRate": 1000}' https://asml.mmsparty.nl/api/config
```

Lower it if the render pipeline ever struggles; raise it for a faster reveal.
`admitRate` is read live each tick, so changes take effect immediately.

> **After deploy:** the persisted config may still hold the old default (500). Set
> `admitRate` to your target (≥ 700 for a 20k-in-30s reveal) once, via the call above.

**Monitor the queue:** the admin panel shows the live admission-queue size
(`admitQueueSize` / `waitingCount`), broadcast ~once per second. A queue that grows
and then drains during the opening is exactly the governor doing its job.

---

## Summary

- **nginx** accepts everyone (per-IP burst sized for the whole venue) — no 503s.
- **The app governor** paces *new* players into the game at `admitRate`/sec,
  IP-agnostic, and pauses if the render pipeline is busy.
- **Active players** (already drawing) are never rate-limited.
- Default **800/s** ⇒ a full **20k crowd admitted in ~25 s**.
- Biggest operational lever remains a **staggered QR reveal** — it keeps arrivals
  under the cap naturally and costs nothing.
