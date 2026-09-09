import { defineEventHandler, getQuery } from 'h3'
import { requireAuth, listModels } from '../kernel/index.js'

/** Models this machine can be asked to run with.
 *
 *  Only the ones it can actually run TODAY, unless asked otherwise. The open
 *  catalogue describes every hosted provider that exists — six thousand models
 *  on a machine with three usable ones — and a composer that lists all of them
 *  is not a picker, it is a phone book. Discovery belongs where connecting
 *  happens.
 *
 *  `?all=1` returns everything, each entry carrying `needsKey`. That is for the
 *  surfaces whose subject IS what could be connected: the providers screen, and
 *  the composer's own "needs a key" group, which is fetched only when someone
 *  asks to see it rather than on every chat open.
 *
 *  `locked` says how many were withheld, which is the completion of that
 *  answer: a client that wants to TELL somebody models are waiting for a
 *  credential should not have to download the whole catalogue to count them.
 *  Measured on a real machine, `?all=1` is 2.2MB for 7483 models — a price no
 *  client should pay for an integer, and the reason the TUI's footer counted
 *  the filtered list instead and therefore always read zero. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const all = getQuery(event).all
  const models = await listModels()
  const locked = models.filter((model) => model.needsKey).length
  return { models: all === '1' || all === 'true' ? models : models.filter((model) => !model.needsKey), locked }
})
