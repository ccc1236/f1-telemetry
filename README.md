# F1 Telemetry

An open-source real-time dashboard for Formula 1 live timing and telemetry data.

> **This is a self-hosting fork** of [matteocelani/f1-telemetry](https://github.com/matteocelani/f1-telemetry).
>
> It tracks upstream and adds what is needed to run the dashboard yourself:
>
> - **Working live feed** — migrated to F1's SignalR Core endpoint. Upstream's connection no longer negotiates after F1 changed its handshake ([PR #25](https://github.com/matteocelani/f1-telemetry/pull/25))
> - **Docker self-hosting** — `docker compose up` for backend and frontend
> - **Watch past races** — `pnpm archive` converts any completed 2026 session into a replayable file
> - **Track map fixes** — driver dots now track correctly through a full race ([PR #27](https://github.com/matteocelani/f1-telemetry/pull/27), [PR #30](https://github.com/matteocelani/f1-telemetry/pull/30))
>
> Fixes are contributed back upstream where they apply generally.

![F1 Telemetry Dashboard](apps/frontend/public/images/desktop_1.jpeg)

> More screenshots: [Desktop](apps/frontend/public/images/desktop_2.jpeg) · [Tablet](apps/frontend/public/images/tablet.jpeg) · [Mobile](apps/frontend/public/images/mobile_1.jpeg)

## Overview

F1 Telemetry connects directly to the F1 Live Timing SignalR feed — the same stream that powers the official timing screens during race weekends — decodes the payload in real time, and serves it over WebSocket to a browser-based analytics dashboard.

The goal is to give anyone a clean, fast, and accurate view into what is happening on track during any F1 session.

## Features

- **Timing Tower** — full leaderboard with positions, gaps, intervals, sector times, micro-sector segments, pit stops, tyre compounds and driver status. Multi-key sorting with tie-breaking and sequential position remapping to eliminate duplicate positions from the F1 feed
- **Track Map** — real-time driver positions on an interactive SVG circuit map with curvature-weighted segment boundaries, forward projection between micro-sector anchors, and smooth 60fps interpolation via `requestAnimationFrame` with direct DOM manipulation
- **Race Strategy** — tyre stint timeline showing compound, lap count, and mandatory stop indicator (FIA B6.3.6 compliance). Session-aware with cumulative stint positioning
- **Pace Radar** — speed trap and sector time rankings with all active drivers, position badges, tyre compound icons, and single-purple enforcement for the overall best
- **Race Control** — live feed of official messages, flags, safety car deployments, and steward decisions
- **Weather** — air and track temperature, wind, humidity, and rainfall in real time
- **Qualifying Support** — Q1/Q2/Q3 knockout detection with elimination line and separator labels between eliminated groups
- **Data Resilience** — handles F1's lossy feed gracefully: stuck `InPit` flags are cross-referenced with stint data, `Retired`/`Stopped` states are permanently latched, and lap boundaries are derived from segment resets rather than `NumberOfLaps`, which the feed increments several seconds early

## Broadcast Delay

The dashboard can be held back by up to three minutes so it stays in sync with your TV broadcast and does not spoil what you are watching. The UI pauses briefly while the delay buffer fills. Full guide in [docs/broadcast-delay.md](docs/broadcast-delay.md).

## Architecture

This is a [pnpm](https://pnpm.io) monorepo with three packages:

| Package    | Path            | Description                                                                                 |
| ---------- | --------------- | ------------------------------------------------------------------------------------------- |
| `backend`  | `apps/backend`  | Node.js service that connects to F1 SignalR, decodes payloads, and broadcasts via WebSocket |
| `frontend` | `apps/frontend` | Next.js analytics dashboard                                                                 |
| `core`     | `core`          | Shared TypeScript types and constants                                                       |

### Data flow

```
F1 SignalR (livetiming.formula1.com)
    └── backend (Node.js + ws)
          ├── /health  HTTP endpoint for frontend status polling
          └── ws://    WebSocket broadcast to frontend clients
```

The backend subscribes to all available F1 channels. Compressed channels (`CarData.z`, `Position.z`) are decoded with raw DEFLATE. All channels are batched in 50ms windows before broadcast to reduce WebSocket frame volume.

## Getting started

### Docker (recommended for self-hosting)

Requires Docker Desktop or Docker Engine with Compose.

```bash
git clone https://github.com/ccc1236/f1-telemetry.git
cd f1-telemetry
docker compose up --build -d
```

Open **http://localhost:3100**. The backend is on port **8090**, and
`http://localhost:8090/health` reports whether it is connected to F1.

```bash
docker compose logs -f backend   # follow the F1 connection
docker compose down              # stop everything
```

Rebuild after changing frontend code — `NEXT_PUBLIC_*` values are baked in at
build time:

```bash
docker compose up --build -d frontend
```

### Local development

```bash
pnpm install
pnpm dev
```

Backend serves both the WebSocket relay and `/health` on a single port,
**8090** by default. Frontend runs on `http://localhost:3000`.

Environment variables are documented in `.env.example`. All are optional and
have working defaults:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8090` | Backend WebSocket + health port |
| `NEXT_PUBLIC_API_URL` | `http://localhost:8090` | Where the frontend polls health |
| `NEXT_PUBLIC_WS_URL` | `ws://localhost:8090/ws` | Where the frontend streams data |
| `F1_BEARER_TOKEN` | unset | Optional. Sent as an `Authorization` header during SignalR negotiation. The feed currently connects without it; set it only if negotiation starts failing |

> **No live session?** F1 only streams during race weekends. Outside a session
> the dashboard connects but stays empty — use a replay below.

### Watch a completed race

Any finished 2026 session can be downloaded from F1's public archive and replayed
through the same dashboard:

```bash
pnpm --filter backend archive --list       # what is available
pnpm --filter backend archive monaco       # download and convert one race
pnpm --filter backend archive --round 10   # or select by round
pnpm --filter backend archive --all        # every Grand Prix (~220 MB)
```

Sprints are opt-in with `--sprint` for a single weekend, or `--sprints`
alongside `--all`.

Files land in `apps/backend/data/`. Play one back:

```bash
pnpm --filter backend dev:replay data/2026-06-07_monaco_race.json
```

> The path is relative to `apps/backend`, because `--filter` runs the script
> from that package directory.

Open `/live` as usual — replay feeds the same dashboard. A race is roughly 20 MB
and converts in about 15 seconds.

> Playback is real time, so a full session runs its true length and includes the
> pre-race build-up, which can approach an hour. Set `REPLAY_INTERVAL` to speed
> it up: `50` is 2x, `25` is 4x. The replay loops indefinitely.

To skip the waiting, trim the file so playback starts just before the race:

```bash
pnpm --filter backend trim data/2026-03-08_australian_race.json --to-finish --segment-mode
pnpm --filter backend dev:replay data/2026-03-08_australian_race_trimmed.json
```

The start is detected from the feed's own session-status marker, and the default
lead-in keeps the formation lap. `--to-finish` also cuts the post-race tail a
couple of laps past the chequered flag — worth doing, since some sessions carry
15+ minutes of parc fermé and dead air after the finish. `--segment-mode` drops
GPS data so the track map uses segment-based positioning, which currently renders
driver dots more reliably. See [docs/replay-mode.md](docs/replay-mode.md) for details.

Putting it together, the recommended way to watch a newly finished race with no
dead air at either end — download, trim both ends, replay:

```bash
pnpm --filter backend archive dutch                                              # 1. prints the exact file it writes
pnpm --filter backend trim data/2026-08-30_dutch_race.json --to-finish --segment-mode   # 2. formation lap to flag
docker stop f1-backend                                                           # 3. free port 8090 if live is running
pnpm --filter backend dev:replay data/2026-08-30_dutch_race_trimmed.json
```

The date prefix is not known ahead of time — step 1 prints the exact filename it
writes, which you pass to step 2. Add `--sprint` to step 1 for a sprint weekend.
Then open `/replay`.

Running a replay and the live feed at once means a port clash, since both bind
`8090`. Either stop the live backend (`docker stop f1-backend`) or give the
replay its own port with `PORT=8091` and point the frontend at it.

> **On Windows PowerShell**, the `pnpm`, `trim`, and `docker` commands run as
> shown. Only the inline environment-variable syntax differs: `VAR=value pnpm ...`
> is Bash-only. In PowerShell set the variable first, on the same line, with a
> semicolon:
>
> ```powershell
> $env:REPLAY_INTERVAL=50; pnpm --filter backend dev:replay data/2026-08-30_dutch_race_trimmed.json
> $env:PORT=8091; pnpm --filter backend dev:replay data/2026-08-30_dutch_race_trimmed.json
> ```

### Replay a bundled recording

```bash
pnpm dev:replay
```

Plays a pre-recorded session for development outside race weekends.

> **Note**: Recordings may have incomplete data depending on when recording
> started — some micro-sectors, position updates, or pit events can be missing.
> A live session is significantly more complete.

See [docs/replay-mode.md](docs/replay-mode.md) for recording your own sessions.

## Documentation

- [Broadcast delay](docs/broadcast-delay.md) — how the delay feature works, when to use it, and its current limitations
- [Replay mode](docs/replay-mode.md) — how to develop and test the live dashboard without an active F1 session
- [F1 Live Timing payload types](docs/live-timing-types.md) — field reference for all subscribed channels, 2026 regulation notes, and maintenance guide
- [Timing tower sort architecture](docs/timing-sort-architecture.md) — how the client-side classification algorithm works, FIA regulation mapping, and known stream limitations

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup instructions, code standards, and PR guidelines.

The live timing schema is reverse-engineered and may change between seasons. See [docs/live-timing-types.md](docs/live-timing-types.md) for guidance on keeping the types up to date.

Issues and pull requests are welcome.

## Disclaimer

This project is not associated with, endorsed by, or officially connected to Formula 1, the FIA, Formula One World Championship Limited, Formula One Management, or any of their subsidiaries or affiliates. F1 and related marks are trademarks of Formula One Licensing B.V.

## License

MIT
