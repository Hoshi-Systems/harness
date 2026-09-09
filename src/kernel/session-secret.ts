/**
 *
 * The machine verifies platform-issued JWTs against SESSION_SECRET by signature
 * alone (see utils/session.ts) — mirrors apps/api/utils/secrets.ts's fail-closed
 * pattern. In production this MUST be the same strong value the platform signs
 * with; otherwise the sidecar, which is publicly addressable, would silently
 * verify against a value that ships in this repo. Dev/test fall back to the
 * insecure constant so local `pnpm dev:machine` needs no setup.
 *
 **/

const DEV_SESSION_SECRET = 'dev-only-insecure-secret-change-me'

export function sessionSecret(): string {
  const value = process.env.SESSION_SECRET
  if (process.env.NODE_ENV === 'production') {
    if (!value || value === DEV_SESSION_SECRET) {
      throw new Error(
        'SESSION_SECRET must be set to a strong, non-default value in production — it must match ' +
          "the platform API's SESSION_SECRET. Generate one with `openssl rand -hex 32` " +
          '(infra/install.sh does this for you).',
      )
    }
    return value
  }
  return value || DEV_SESSION_SECRET
}

/** Eagerly validate at startup so a misconfigured production machine fails
 *  immediately with a clear message, not at the first request that needs it. */
export function assertSessionSecretConfigured(): void {
  sessionSecret()
}
