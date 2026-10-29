/**
 * Multiplayer server address. Defaults to the same host that served the page
 * on port 2567, so phones on the same Wi-Fi reach the server automatically.
 * Override with VITE_SERVER_URL (full URL) or VITE_SERVER_PORT.
 */
export function serverHttpUrl(): string {
  const explicit = import.meta.env.VITE_SERVER_URL;
  if (explicit) return explicit.replace(/\/$/, '');
  const port = import.meta.env.VITE_SERVER_PORT ?? '2567';
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:${port}`;
}
