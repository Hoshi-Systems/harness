/** A serial queue (async mutex): runs async operations one at a time, in call
 *  order. Each caller gets its own private queue via `createSerialQueue()`, so
 *  unrelated workloads never block each other. Used to make read-modify-write
 *  file updates safe against concurrent callers without a lock file. */
export function createSerialQueue() {
  let queue: Promise<unknown> = Promise.resolve()
  return <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op)
    /**
     *
     * Keep the chain alive past a rejected op without surfacing it to the next one.
     *
     **/
    queue = next.catch(() => {})
    return next
  }
}
