/**
 * Bind-host policy for the HTTP server(s).
 *
 * Default: loopback only (`127.0.0.1`). This closes the previously-default
 * `0.0.0.0` exposure where unauthenticated brain / execute / management
 * endpoints were reachable from any LAN/VPN/tailscale peer when
 * `KYBERBOT_API_TOKEN` was unset (the documented "loopback-only" claim
 * was untrue — see SYSTEM-HEALTH.md C-2).
 *
 * Opt-in to wider exposure via `KYBERBOT_BIND_HOST=0.0.0.0` (or any other
 * interface). Intended use: VPS deployment behind a real reverse proxy,
 * or fleet mode across hosts. Always pair with `KYBERBOT_API_TOKEN` —
 * the server will warn loudly if you don't.
 */

export const DEFAULT_BIND_HOST = '127.0.0.1';

export interface ResolvedBindHost {
  host: string;
  /** True when the operator explicitly overrode the default. */
  overridden: boolean;
  /** True when the resolved host accepts non-loopback connections. */
  exposed: boolean;
}

export function resolveBindHost(): ResolvedBindHost {
  const raw = process.env.KYBERBOT_BIND_HOST?.trim();
  const host = raw && raw.length > 0 ? raw : DEFAULT_BIND_HOST;
  const overridden = host !== DEFAULT_BIND_HOST;
  const exposed = host !== '127.0.0.1' && host !== '::1' && host !== 'localhost';
  return { host, overridden, exposed };
}
