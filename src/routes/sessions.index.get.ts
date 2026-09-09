import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, listSessions, getSpendBySession } from '../kernel/index.js'

/** The machine's sessions, each carrying its own directory.
 *
 *  `?directory=` narrows to one project (or the personal space). It is a filter
 *  over the machine-wide list, not a separate list — which is the whole
 *  difference from the runtime this replaced. There, the scope was an optional
 *  parameter over PARTITIONED storage: omitting it did not mean "everything",
 *  it meant "the process root", so an unscoped read returned a slice while
 *  looking like the whole truth, and a project's sessions were simply invisible
 *  from anywhere else. Here, omitting it means everything, and asking for a
 *  directory means exactly that directory — neither answer can be mistaken for
 *  the other.
 *
 *  The filter exists because a client should not be shipped every session on
 *  the machine to render one project's list. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const directory = getQuery(event).directory
  const sessions = await listSessions()
  const spend = await getSpendBySession()
  /**
   *
   * What each conversation has cost, folded in here rather than left to the
   * client to add up: the transcript a client holds is only the part it has
   * loaded, so a total computed there would drop every turn scrolled past.
   *
   **/
  const priced = sessions.map((session) => ({ ...session, spend: spend[session.id] ?? { cost: 0, unpricedTurns: 0 } }))
  if (typeof directory !== 'string' || !directory) return { sessions: priced }
  return { sessions: priced.filter((session) => session.directory === directory) }
})
