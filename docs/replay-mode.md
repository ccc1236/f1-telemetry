# Replay Mode (Dev Mode)

During a live F1 session, the backend connects to the official SignalR feed and relays data to the frontend via WebSocket. Outside of race weekends there is no live data available, which makes frontend development impossible.

**Replay mode** solves this by feeding session data through the same WebSocket server. The frontend connects normally and cannot tell the difference — every store, component, and animation behaves exactly as it would during a real session.

There are two ways to get a session to replay:

- **[Download a completed race](#watching-a-completed-race)** from F1's public archive with `pnpm archive`. Any 2026 session that has already run.
- **[Record a live session](#recording-sessions)** yourself with `pnpm record`, which requires being at the keyboard while it happens.

## Quick start

```bash
pnpm dev:replay
```

This starts the replay backend on `ws://localhost:8090` and the Next.js frontend on `http://localhost:3000`. Open the browser and navigate to `/live` — the dashboard will populate with real timing data from the recording.

## How it works

The replay server (`apps/backend/src/replay.ts`) does three things:

1. Reads a JSON file of frames into memory
2. Starts the same `SocketServer` used in production, which serves the WebSocket relay and the `/health` endpoint on a single port
3. Iterates through the frames at a fixed interval, broadcasting each one to connected clients

When it reaches the end of the file, it loops back to the beginning and clears cached state. The server runs until you stop it. There is no seek or pause.

Payloads on the compressed channels (`CarData.z`, `Position.z`) may arrive either already decoded or still compressed, depending on which tool produced the file. The replay server inflates them when needed, so both work.

## Watching a completed race

F1 publishes every finished session to a public archive. `pnpm archive` converts one into a replayable file — no recording required, and it works long after the race.

```bash
pnpm --filter backend archive --list       # what is available this season
pnpm --filter backend archive monaco       # match on name, case-insensitive
pnpm --filter backend archive --round 10   # or by round number
pnpm --filter backend archive --all        # every Grand Prix (~220 MB)
```

Rounds are counted in calendar order over sessions that actually ran, which will not always match the published round numbers — the 2026 season had two rounds cancelled. Use `--list` to confirm.

Sprints are opt-in, since four weekends have both a sprint and a Grand Prix:

```bash
pnpm --filter backend archive chinese --sprint    # the sprint, not the GP
pnpm --filter backend archive --all --sprints     # all 14 sessions
```

Files are written to `apps/backend/data/` as `{date}_{meeting}_{session}.json`. A race is roughly 20 MB and converts in about 15 seconds.

```bash
pnpm --filter backend dev:replay data/2026-06-07_monaco_race.json
```

Playback is real time, so a full session runs its true length — including the pre-race build-up, which can approach an hour before lights out. Use `REPLAY_INTERVAL` to speed it up, or trim the build-up away.

> Converted files are gitignored. They are large and regenerate in seconds.

### Trimming the build-up

`pnpm trim` cuts the waiting so playback starts near the race:

```bash
pnpm --filter backend trim data/2026-03-08_australian_race.json
```

Writes `..._trimmed.json` alongside the input, or pass an explicit output path.

| Flag | Default | Description |
| --- | --- | --- |
| `--lead-in <seconds>` | `420` | How far ahead of the start to begin. The default keeps the formation lap |
| `--segment-mode` | off | Drop `Position.z`, forcing the segment-based track map |

The start is found from the `SessionStatus: "Started"` marker in
`SessionData.StatusSeries`, which is exact. Inferring it from lap counters does
not generalise: median race laps run about 79s at Monaco and 112s at Spa, so no
fixed frame offset means the same thing at every circuit.

Everything before the cut is folded into a single snapshot frame, so accumulated
state survives. A plain slice would drop `DriverList`, `SessionInfo` and stint
history, leaving the timing tower with empty rows.

> `--segment-mode` is worth knowing about: with GPS data present the dashboard
> switches to GPS positioning, which currently does not render driver dots.
> Dropping the channel falls back to segment-based positioning, which works.

## Data quality in replay mode

Replay recordings capture the raw F1 feed as-is. Depending on when the recording started (mid-session vs. from the beginning), some data may be incomplete:

- **Micro-sector segments** may be missing for some drivers, causing track map dots to update less frequently
- **`InPit` flags** may get stuck if the recording missed the corresponding `false` transition
- **`NumberOfLaps`** may skip values if the F1 feed dropped those updates
- **`Position` values** may temporarily show duplicates during asynchronous overtake updates

During a **live session**, the data feed is significantly more complete and the dashboard behaves more accurately. These artifacts are a property of the sparse F1 delta protocol, not bugs in the application.

## Recording sessions

Use the built-in recorder to capture live sessions:

```bash
pnpm --filter backend record data/your-session.json
```

The recorder connects to the F1 SignalR feed, subscribes to all available channels, and saves every frame with its server timestamp. Press `Ctrl+C` to stop and save — the recording is written atomically on shutdown.

> **Important:** Always stop the recorder with `Ctrl+C` (SIGINT). Killing the process without SIGINT will lose all data, as frames are held in memory until the graceful shutdown handler writes them to disk.

Place recording files in `apps/backend/data/`. To replay a specific file:

```bash
pnpm --filter backend dev:replay data/your-session.json
```

The path is relative to `apps/backend`, because `--filter` runs the script from that package directory. Do **not** insert a `--` separator; pnpm forwards it as the first argument and the server will try to open a file literally named `--`.

If no file path is provided, the server uses the default recording configured in `replay.ts`.

## Recording format

A recording file is a JSON array of frame objects. Each frame has a `timestamp` (ISO 8601 from the F1 server) and an `updates` object containing one or more channel payloads:

```json
[
  {
    "timestamp": "2026-03-29T05:14:10.233Z",
    "updates": {
      "TimingDataF1": {
        "Lines": {
          "12": {
            "Sectors": { "0": { "Segments": { "1": { "Status": 2049 } } } }
          }
        }
      }
    }
  },
  {
    "timestamp": "2026-03-29T05:14:12.456Z",
    "updates": {
      "WeatherData": {
        "AirTemp": "28.3",
        "TrackTemp": "42.1",
        "Humidity": "55"
      }
    }
  }
]
```

A single frame can contain updates for multiple channels simultaneously. The available channels are defined in `core/src/constants.ts` and documented in [live-timing-types.md](live-timing-types.md).

Two optional details:

- A frame may carry `"snapshot": true`, meaning its `updates` replace server state wholesale rather than merging into it. Used to establish a baseline, typically as the first frame.
- `timestamp` is informational. Playback pacing comes from `REPLAY_INTERVAL` and the number of frames, not from these values. Files produced by `pnpm archive` omit the field entirely, encoding timing as frame position instead.

## Configuration

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `REPLAY_INTERVAL` | `100` | Milliseconds between each frame. `50` is 2x speed, `25` is 4x |
| `PORT` | `8090` | Port for both the WebSocket relay and `/health` |

Examples:

```bash
# Faster playback (50ms per frame = 2x)
REPLAY_INTERVAL=50 pnpm --filter backend dev:replay data/your-session.json

# Custom port
PORT=9090 pnpm --filter backend dev:replay data/your-session.json
```

The replay server binds the same default port as the live backend, so running both at once fails with `EADDRINUSE`. Either stop the live backend first, or give the replay its own port and point the frontend at it with `NEXT_PUBLIC_WS_URL`.

## Contributing recordings

`apps/backend/data/*.json` is gitignored, since converted sessions run to tens of megabytes and regenerate from the archive in seconds. The bundled `suzuka-*.json` fixtures are tracked and stay that way.

If you captured something genuinely worth sharing — an unusual session the archive does not cover well — force-add it and open a PR:

```bash
git add -f apps/backend/data/your-session.json
```

Keep the name descriptive (e.g. `monaco-2026-qualifying.json`) and the file under 5 MB. For anything that simply mirrors a completed session, prefer pointing people at `pnpm archive` rather than committing the data.
