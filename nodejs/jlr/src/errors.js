/**
 * Typed errors, so the server and CLI can tell "JLR said no" apart from "our
 * input was wrong" and from a bug.
 */

export class JlrError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'JlrError';
  }
}

/** The session is missing, expired, or needs a human (MFA/CAPTCHA). */
export class JlrAuthError extends JlrError {
  constructor(message, options) {
    super(message, options);
    this.name = 'JlrAuthError';
  }
}

/** JLR answered with an HTTP error or a payload we cannot read. */
export class JlrUpstreamError extends JlrError {
  constructor(message, { status = null, path = null, ...options } = {}) {
    super(message, options);
    this.name = 'JlrUpstreamError';
    this.status = status;
    this.path = path;
  }
}
