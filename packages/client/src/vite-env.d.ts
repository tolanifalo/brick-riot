/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_E2E?: string;
  /** Full multiplayer server URL, e.g. https://riot.example.com */
  readonly VITE_SERVER_URL?: string;
  /** Multiplayer server port on the page's host (default 2567). */
  readonly VITE_SERVER_PORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
