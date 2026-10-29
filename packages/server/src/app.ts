import { matchMaker, Server } from '@colyseus/core';
import { isAllowedOrigin } from './config';
import { ROOM_NAME } from '@brick-riot/shared';
import { WebSocketTransport } from '@colyseus/ws-transport';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ServerConfig } from './config';
import { installApi } from './http/api';
import { MatchRoom } from './rooms/MatchRoom';
import { QUEUE_ROOM, QueueRoom } from './rooms/QueueRoom';
import { createServices, setServices, type Services } from './services';

export interface GameServer {
  port: number;
  services: Services;
  close(): Promise<void>;
}

/** Boots the HTTP API + Colyseus WebSocket server on one port. */
/**
 * Colyseus answers every HTTP request (including /api and CORS preflights)
 * with its own CORS headers, by default reflecting ANY origin together with
 * Access-Control-Allow-Credentials. With cookie sessions that would let any
 * website read a signed-in player's data, so only allowed origins get CORS.
 */
function lockDownColyseusCors(config: ServerConfig): void {
  const defaults = matchMaker.controller.DEFAULT_CORS_HEADERS as Record<string, string>;
  // No wildcard origin and no credentials by default...
  Reflect.deleteProperty(defaults, 'Access-Control-Allow-Origin');
  Reflect.deleteProperty(defaults, 'Access-Control-Allow-Credentials');
  Object.assign(defaults, {
    'Access-Control-Allow-Headers': 'Content-Type, Idempotency-Key, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
  // ...only allowed origins are granted (credentialed) access.
  matchMaker.controller.getCorsHeaders = (headers: Headers): Record<string, string> => {
    const origin = headers.get('origin') ?? undefined;
    return origin && isAllowedOrigin(config, origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Credentials': 'true' }
      : {};
  };
}

export async function createGameServer(config: ServerConfig, overrides: Partial<Services> = {}): Promise<GameServer> {
  const services = createServices(config, overrides);
  setServices(services);
  lockDownColyseusCors(config);
  const httpServer = http.createServer();
  const gameServer = new Server({
    transport: new WebSocketTransport({ server: httpServer }),
    express: (app) => installApi(app, services),
    gracefullyShutdown: false,
  });
  gameServer.define(ROOM_NAME, MatchRoom);
  gameServer.define(QUEUE_ROOM, QueueRoom);
  await gameServer.listen(config.port, config.host);
  const port = (httpServer.address() as AddressInfo).port;
  return {
    port,
    services,
    close: async () => {
      await gameServer.gracefullyShutdown(false);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
