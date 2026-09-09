import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { apiError } from './api-error.js'
import { quoteEnvValue, unquoteEnvValue, upsertEnv } from './dotenv.js'
import { publishMachineEvent } from './events.js'
import { isCheckoutDir } from './workspace.js'
import { createSerialQueue } from './serialize.js'

/**
 * ── Secret store ─────────────────────────────────────────────────────────────
 *
 * Environment-style secrets the user's sessions need (API keys, tokens). They're
 * written to the global `.env` in OpenCode's config dir; the machine image
 * delivers that file into the environment twice over (infra/machine/
 * secrets-env.sh): every non-interactive bash sources it at spawn (BASH_ENV —
 * the agent's very next shell command sees a fresh secret live), and every
 * runtime spawn sources it too, so `{env:VAR}` provider-key bindings resolve
 * on container reboots and scoped runtime restarts alike. No "the agent must
 * query an endpoint": they're just `$FOO` in the shell.
 *
 * SECURITY: values are write-only. They land in the `.env` and are never read
 * back to the client — listing returns a masked preview computed server-side and
 * a `last4` hint, never the raw value, and values are never logged.
 *
 * The `.env` is the source of truth for which keys exist; a sibling JSON registry
 * holds the per-key metadata (timestamps + masking hint) the list view needs but
 * `.env` can't carry. Both live in OpenCode's config dir so they're durable on
 * the machine's /data volume and survive image updates.
 *
 **/

/** OpenCode resolves its config under XDG_CONFIG_HOME/opencode (default
 *  ~/.config/opencode). In the machine image HOME=/data, so this lands on the
 *  durable volume; in dev it's the developer's real config dir. */
const CONFIG_DIR =
  process.env.OPENCODE_CONFIG_DIR ??
  path.join(process.env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'opencode')
const ENV_PATH = path.join(CONFIG_DIR, '.env')
const META_PATH = path.join(CONFIG_DIR, '.hoshi-secrets.json')

/** Env var names: an uppercase identifier. Keeps the `.env` shape sane and the
 *  value safe to expose to a POSIX shell without escaping surprises. */
const KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/
const MAX_KEY_LENGTH = 128
const MAX_VALUE_LENGTH = 8192

export interface SecretMeta {
  createdAt: string
  updatedAt: string
  /** Up to the last 4 chars of the value — enough to recognize a key without
   *  revealing it. Empty for very short secrets, so nothing meaningful leaks. */
  last4: string
}

/** A secret as the client sees it: the key, a fixed masked preview, and the
 *  metadata — never the value. */
export interface SecretSummary {
  key: string
  preview: string
  last4: string
  createdAt: string
  updatedAt: string
}

/**
 *
 * All mutations are read-modify-write across two files, so serialize them —
 * concurrent writes would otherwise clobber each other.
 *
 **/
const serialize = createSerialQueue()

export function isValidSecretKey(key: string): boolean {
  return key.length <= MAX_KEY_LENGTH && KEY_PATTERN.test(key)
}

export const SECRET_KEY_RULE =
  'A key must be an uppercase name like API_TOKEN (A–Z, 0–9, _; not starting with a digit).'

export function validateSecretValue(value: unknown): string {
  if (typeof value !== 'string' || !value.length) {
    apiError(400, 'secret.valueRequired', 'Enter a value.')
  }
  if (value.length > MAX_VALUE_LENGTH) {
    apiError(400, 'secret.valueLength', `A value can be at most ${MAX_VALUE_LENGTH} characters.`, {
      max: MAX_VALUE_LENGTH,
    })
  }
  /**
   *
   * A literal newline would break the single-line `.env` encoding and could smuggle
   * a second assignment into the file. Reject it rather than silently mangling.
   *
   **/
  if (/[\r\n]/.test(value)) {
    apiError(400, 'secret.valueNoLineBreaks', 'A value cannot contain line breaks.')
  }
  return value
}

function last4Of(value: string): string {
  /**
   *
   * Only hint at longer secrets; a 4-char token would be fully revealed.
   *
   **/
  return value.length > 8 ? value.slice(-4) : ''
}

function previewOf(last4: string): string {
  return last4 ? `••••${last4}` : '••••••••'
}

/**
 * ── Vault `.env` (the global store) ───────────────────────────────────────────
 *
 * The codec lives in utils/dotenv.ts (shared with per-project materialization).
 * The vault owns its whole file, so it rewrites from the Map; a project `.env`
 * merges instead (see materializeProjectEnv).
 *
 **/

async function readEnv(): Promise<Map<string, string>> {
  const entries = new Map<string, string>()
  let raw: string
  try {
    raw = await readFile(ENV_PATH, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return entries
    throw error
  }
  for (const line of raw.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!isValidSecretKey(key)) continue
    entries.set(key, unquoteEnvValue(line.slice(eq + 1)))
  }
  return entries
}

async function writeEnv(entries: Map<string, string>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  const body = [...entries].map(([key, value]) => `${key}=${quoteEnvValue(value)}`).join('\n')
  /**
   *
   * 0600: the file holds plaintext secrets; keep it owner-only.
   *
   **/
  await writeFile(ENV_PATH, body ? `${body}\n` : '', { mode: 0o600 })
}

/**
 * ── metadata sidecar ──────────────────────────────────────────────────────────
 *
 **/

async function readMeta(): Promise<Record<string, SecretMeta>> {
  try {
    const parsed = JSON.parse(await readFile(META_PATH, 'utf8')) as Record<string, SecretMeta>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

async function writeMeta(meta: Record<string, SecretMeta>): Promise<void> {
  await mkdir(CONFIG_DIR, { recursive: true })
  await writeFile(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

function toSummary(key: string, meta: SecretMeta): SecretSummary {
  return {
    key,
    preview: previewOf(meta.last4),
    last4: meta.last4,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  }
}

/**
 * ── public API ────────────────────────────────────────────────────────────────
 *
 **/

/** Every secret on the machine, masked. The `.env` is authoritative for which
 *  keys exist; metadata is reconciled against it so a hand-edited `.env` still
 *  lists. Sorted by key for a stable UI. Never returns raw values. */
export function listSecrets(): Promise<SecretSummary[]> {
  return serialize(async () => {
    const [env, meta] = await Promise.all([readEnv(), readMeta()])
    const now = new Date().toISOString()
    return [...env.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((key) => {
        const existing = meta[key]
        if (existing) return toSummary(key, existing)
        /**
         *
         * A key present in .env but not in our metadata (foreign edit): synthesize
         * a preview from the live value without persisting or exposing it.
         *
         **/
        return toSummary(key, { createdAt: now, updatedAt: now, last4: last4Of(env.get(key)!) })
      })
  })
}

export function secretExists(key: string): Promise<boolean> {
  return serialize(async () => (await readEnv()).has(key))
}

/** Resolve a secret's plaintext for machine-local use only — a clone credential
 *  during provisioning, or materializing a project `.env`. NEVER returned to a
 *  client: the public API is write-only/masked. Null when the key is absent. */
export function readSecretValue(key: string): Promise<string | null> {
  return serialize(async () => (await readEnv()).get(key) ?? null)
}

/** The vault-style key names already present in a checkout's `.env` — so the edit
 *  UI can pre-check which secrets are materialized. Names only; values never
 *  leave the machine. Empty when there's no `.env`. */
export function listProjectEnvKeys(directory: string): Promise<string[]> {
  return serialize(async () => {
    if (!isCheckoutDir(directory)) {
      apiError(400, 'project.env.directoryInvalid', 'directory must be a checkout under the workspace root.')
    }
    let raw: string
    try {
      raw = await readFile(path.join(directory, '.env'), 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const keys: string[] = []
    for (const line of raw.split('\n')) {
      const eq = line.indexOf('=')
      if (eq <= 0) continue
      const key = line.slice(0, eq).trim()
      if (isValidSecretKey(key)) keys.push(key)
    }
    return keys
  })
}

/** Copy selected vault keys into a checkout's own `.env` (`<directory>/.env`),
 *  merging — a key already in the file is updated in place, everything else
 *  (comments, the repo's own keys) is preserved. Keys absent from the vault are
 *  skipped. Returns how many were written. Machine-local: values never leave the
 *  box; the caller passes key NAMES, not values. */
export function materializeProjectEnv(directory: string, keys: string[]): Promise<number> {
  return serialize(async () => {
    if (!isCheckoutDir(directory)) {
      apiError(400, 'project.env.directoryInvalid', 'directory must be a checkout under the workspace root.')
    }
    const vault = await readEnv()
    const entries = new Map<string, string>()
    for (const key of keys) {
      const value = vault.get(key)
      if (value !== undefined) entries.set(key, value)
    }
    if (entries.size === 0) return 0
    const target = path.join(directory, '.env')
    let existing = ''
    try {
      existing = await readFile(target, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await writeFile(target, upsertEnv(existing, entries), { mode: 0o600 })
    return entries.size
  })
}

/** Create or replace a secret. Returns the masked summary — never the value.
 *  The write is live: every non-interactive bash on the machine sources the
 *  `.env` at spawn (the image's BASH_ENV bridge), so the agent's next shell
 *  command already sees the new value. The event carries the key NAME only. */
export function setSecret(key: string, value: string): Promise<SecretSummary> {
  return serialize(async () => {
    const [env, meta] = await Promise.all([readEnv(), readMeta()])
    const now = new Date().toISOString()
    env.set(key, value)
    const next: SecretMeta = {
      createdAt: meta[key]?.createdAt ?? now,
      updatedAt: now,
      last4: last4Of(value),
    }
    meta[key] = next
    await writeEnv(env)
    await writeMeta(meta)
    publishMachineEvent('secrets.changed', { key, action: 'set' })
    return toSummary(key, next)
  })
}

export function deleteSecret(key: string): Promise<boolean> {
  return serialize(async () => {
    const [env, meta] = await Promise.all([readEnv(), readMeta()])
    if (!env.delete(key)) return false
    delete meta[key]
    await writeEnv(env)
    await writeMeta(meta)
    publishMachineEvent('secrets.changed', { key, action: 'deleted' })
    return true
  })
}
