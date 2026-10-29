import { networkInterfaces } from 'node:os';
import { createGameServer } from './app';
import { loadConfig } from './config';

const config = loadConfig();
const server = await createGameServer(config);

const lan = Object.values(networkInterfaces())
  .flat()
  .filter((n) => n && n.family === 'IPv4' && !n.internal)
  .map((n) => n?.address);

console.log(`BRICK RIOT server listening on port ${server.port}`);
console.log(`  local:  ws://localhost:${server.port}`);
for (const ip of lan) console.log(`  LAN:    ws://${ip}:${server.port}`);
console.log(
  `  match ${config.matchSeconds}s | reconnect ${config.reconnectSeconds}s | dev rooms ${config.allowDevRooms ? 'on' : 'off'}` +
    (config.clockScale !== 1 ? ` | CLOCK x${config.clockScale} (TEST ONLY)` : ''),
);
console.log(
  config.databaseUrl
    ? '  accounts on (PostgreSQL)'
    : '  accounts OFF: no DATABASE_URL (guest play and private rooms only; run `npm run db:start`)',
);

const shutdown = () => {
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
