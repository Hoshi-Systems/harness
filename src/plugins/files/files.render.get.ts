import { createReadStream } from 'node:fs'
import { defineEventHandler, getQuery, sendStream, setHeader } from 'h3'
import { apiError, requireAuth } from '../../kernel/index.js'
import { renderOfficePdf, resolveOfficeSource } from './office.js'

/** Office-document preview: convert a workspace docx/pptx/xlsx (and friends)
 *  to PDF with the machine's own office suite and stream it back — the Hoshi
 *  Computer's file browser fetches this as a blob and shows it in its PDF
 *  viewer. `path` is the document's absolute path (the file tree's `absolute`),
 *  validated to stay inside the workspace. Conversions are cached by
 *  path+mtime+size, so re-previewing an unchanged document is a disk read. */
export default defineEventHandler(async (event) => {
  await requireAuth(event)
  const raw = getQuery(event).path
  if (typeof raw !== 'string' || raw.length === 0) {
    apiError(400, 'render.missingPath', 'A document path is required.')
  }
  const source = await resolveOfficeSource(raw)
  const pdf = await renderOfficePdf(source)
  setHeader(event, 'content-type', 'application/pdf')
  setHeader(event, 'cache-control', 'private, no-store')
  return sendStream(event, createReadStream(pdf))
})
