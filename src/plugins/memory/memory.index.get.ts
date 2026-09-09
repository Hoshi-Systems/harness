import { defineEventHandler, getQuery } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { knownProjectSlugs, listAllEntries, listEntries, memoryId, type MemoryScope } from './store.js'

/** List memory entries. `?scope=user|project|org` narrows to one scope;
 *  `?project=<slug>` additionally narrows a project-scope list to one
 *  project (required when `scope=project`). No query params returns
 *  everything (user + org mirror + all projects) — what the Customize → Memory
 *  panel loads on open, since it renders one memory surface with the org group
 *  simply read-only. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const query = getQuery(event)
  const scope = typeof query.scope === 'string' ? (query.scope as MemoryScope) : undefined
  const project = typeof query.project === 'string' ? query.project : undefined

  let records
  if (scope === 'user') {
    records = await listEntries('user', null)
  } else if (scope === 'org') {
    records = await listEntries('org', null)
  } else if (scope === 'project') {
    if (!project) apiError(400, 'memory.projectRequired', 'A project slug is required when scope=project.')
    records = await listEntries('project', project)
  } else {
    records = await listAllEntries()
  }

  return {
    entries: records.map((record) => ({ id: memoryId(record), ...record })),
    projects: await knownProjectSlugs(),
  }
})
