/**
 * ── Who is acting in a session right now (job 12) ────────────────────────────
 *
 * Job 07's audit ingest attributes every row to the machine's owner, derived
 * from the machine row on the Platform side. That assumption held while a
 * machine answered to exactly one human. It breaks the moment a guest can prompt:
 * a trail that attributes a guest's prompt — and every tool call that prompt
 * causes — to the machine's owner is worse than no trail, because it is
 * confidently wrong about the only question an audit is asked.
 *
 * So the sidecar remembers who started the current turn, and stamps it onto the
 * records the watcher derives from OpenCode's stream. The owner is still the
 * default: an unattributed session is the owner's own, which is what it was
 * before this feature existed.
 *
 **/

/** Bounded so a long-lived machine can't grow this without limit. Sessions are
 *  evicted oldest-first; an evicted session simply falls back to the owner. */
const MAX_TRACKED = 500

/** sessionId → the user id that last started a turn in it. In-memory on purpose:
 *  it describes who is acting NOW, and a sidecar restart genuinely ends that —
 *  falling back to the owner afterwards is the honest answer, not a lost fact. */
const actors = new Map<string, number>()

/** Record who started this turn. Called on every prompt the proxy admits — for
 *  the owner too, not only guests, so a session an owner takes back does not
 *  keep attributing to the guest who last touched it. */
export function setSessionActor(sessionId: string, userId: number): void {
  /**
   *
   * Re-insert so the Map's insertion order doubles as recency.
   *
   **/
  actors.delete(sessionId)
  actors.set(sessionId, userId)
  while (actors.size > MAX_TRACKED) {
    const oldest = actors.keys().next()
    if (oldest.done) break
    actors.delete(oldest.value)
  }
}

/** The user acting in this session, or null when nobody but the owner has. */
export function sessionActor(sessionId: string | null | undefined): number | null {
  if (!sessionId) return null
  return actors.get(sessionId) ?? null
}

/** Test seam. */
export function __resetSessionActors(): void {
  actors.clear()
}
