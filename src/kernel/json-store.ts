import { hoshiFile, readHoshiJson, writeHoshiJson } from './store.js'

/**
 *
 * A ~/.hoshi JSON file held as an in-memory store: loaded once at first use,
 * mutated in place by domain code, pushed back to disk fire-and-forget. The
 * in-memory cache is the runtime source of truth; the file is best-effort
 * durable backing. Backs schedules.json (utils/triggers.ts), goals.json
 * (utils/goals.ts), and tasks.json (utils/task-queue.ts).
 *
 **/

export interface CachedJsonStore<T> {
  /** Absolute path of the backing file. */
  readonly file: string
  /** The in-memory store, loaded (and revived) from disk on first use. */
  load(): Promise<T>
  /** Push the whole store back to disk. Fire-and-forget: the in-memory cache
   *  already reflects the change, so a write hiccup never blocks the request. */
  persist(): void
  /** Resolve once every write queued so far has landed. Nothing in a request
   *  path wants this — the whole point of `persist` is not waiting — but a TEST
   *  that tears down the scratch HOME its store writes into does: without it,
   *  the last write races the teardown and either recreates the directory or
   *  logs a failure after the run has ended. */
  flush(): Promise<void>
}

/** A load-once, persist-serialized store over one ~/.hoshi JSON file.
 *  `revive` turns whatever the file held (or null when missing/unreadable)
 *  into a valid store — the place for shape checks, brownfield normalization,
 *  and one-time migrations. */
export function createCachedStore<T extends object>(
  fileName: string,
  revive: (stored: unknown) => T | Promise<T>,
): CachedJsonStore<T> {
  const file = hoshiFile(fileName)
  let cache: T | null = null
  let loading: Promise<T> | null = null

  /**
   *
   * Persists are chained so overlapping fire-and-forget writes can't interleave
   * on the same tmp file; each write serializes the cache as it is *then*, so
   * the last write always lands the newest state.
   *
   **/
  let persistQueue: Promise<void> = Promise.resolve()

  return {
    file,
    load() {
      loading ??= (async () => (cache = await revive(await readHoshiJson<unknown>(file))))().catch((error) => {
        loading = null
        throw error
      })
      return loading
    },
    persist() {
      const snapshot = cache
      if (!snapshot) return
      persistQueue = persistQueue
        .then(() => writeHoshiJson(file, snapshot))
        .catch((error) => console.error(`[json-store] failed to persist ${fileName}:`, error))
    },
    flush() {
      return persistQueue
    },
  }
}

/** The newest `max` entries of a push-ordered history list — keeps a persisted
 *  history from growing unbounded while never dropping recent pushes. */
export function keepLatest<T>(items: T[], max: number): T[] {
  return items.length > max ? items.slice(items.length - max) : items
}
