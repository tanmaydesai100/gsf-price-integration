/**
 * Mirrors laravel/app/Services/Gsf/Exceptions/.
 *
 * The distinction that matters is GsfAuthError vs GsfBlockedError:
 * one is recoverable in code, the other is not.
 */

export class GsfError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GsfError';
  }
}

/** 401, or a rejected login. The session is dead; re-authenticating is correct. */
export class GsfAuthError extends GsfError {
  constructor(message) {
    super(message);
    this.name = 'GsfAuthError';
  }
}

/**
 * 403 - DataDome or a WAF. NEVER retry this: retrying escalates the block.
 * A human needs to capture fresh cookies from a real browser on this server's
 * egress IP, or raise it with GSF.
 */
export class GsfBlockedError extends GsfError {
  constructor(message) {
    super(message);
    this.name = 'GsfBlockedError';
  }
}
