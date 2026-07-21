import { readFileSync } from 'fs';
import { resolve } from 'path';
import { decompressPayload } from '@services/payload-parser';
import { SocketServer } from '@services/socket-server';
import { Logger } from '@utils/logger';

const PORT = parseInt(process.env.PORT ?? '8090', 10);
const REPLAY_INTERVAL_MS = parseInt(process.env.REPLAY_INTERVAL ?? '100', 10);

interface ReplayFrame {
  snapshot?: boolean;
  updates: Record<string, unknown>;
}

function loadReplayData(): ReplayFrame[] {
  const filePath =
    process.argv[2] ?? resolve(__dirname, '../data/suzuka-race-dev.json');
  Logger.info(`Loading replay data from ${filePath}`);

  const raw = readFileSync(filePath, 'utf-8');
  const frames = JSON.parse(raw) as ReplayFrame[];

  Logger.info(`Loaded ${frames.length} frames`);
  return frames;
}

// Recordings made before the .z naming fix stored these channels without the
// suffix, which the frontend never matches. Remap them on the way through.
const LEGACY_CHANNEL_ALIASES: Record<string, string> = {
  CarData: 'CarData.z',
  Position: 'Position.z',
};

// Archive-sourced frames keep .z payloads compressed; recordings store them
// already decompressed. Normalise both to decompressed objects.
function normalizeUpdates(
  updates: Record<string, unknown>
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [rawChannel, data] of Object.entries(updates)) {
    const channel = LEGACY_CHANNEL_ALIASES[rawChannel] ?? rawChannel;

    if (channel.endsWith('.z') && typeof data === 'string') {
      const decompressed = decompressPayload(data);
      if (decompressed === null) {
        Logger.warn(`Decompression failed for ${channel} — entry dropped`);
        continue;
      }
      normalized[channel] = decompressed;
      continue;
    }

    normalized[channel] = data;
  }

  return normalized;
}

function startReplay(socketServer: SocketServer, frames: ReplayFrame[]): void {
  let index = 0;

  const tick = () => {
    const frame = frames[index];

    if (frame?.updates) {
      const updates = normalizeUpdates(frame.updates);

      // Snapshot frames replace the entire server state atomically
      if (frame.snapshot) {
        socketServer.replaceState(updates);
      } else {
        for (const [channel, data] of Object.entries(updates)) {
          socketServer.broadcast(channel, data);
        }
      }
    }

    index = (index + 1) % frames.length;

    if (index === 0) {
      Logger.info('Replay loop restarting from beginning');
      socketServer.clearCache();
    }
  };

  setInterval(tick, REPLAY_INTERVAL_MS);
  Logger.info(
    `Replaying at ${REPLAY_INTERVAL_MS}ms per frame (${frames.length} frames, loops forever)`
  );
}

const socketServer = new SocketServer(PORT);
socketServer.setHealthChecks(() => true);
socketServer.start();

const frames = loadReplayData();
startReplay(socketServer, frames);

const shutdown = (signal: string) => {
  Logger.info(`Received ${signal}. Shutting down...`);
  socketServer.stop();
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
