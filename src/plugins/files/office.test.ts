import { describe, expect, it } from 'vitest'
import { isOfficeDocument } from './office.js'

/**
 * ── Which files get sent through LibreOffice ─────────────────────────────────
 *
 * The gate in front of a headless conversion: a false positive queues a
 * subprocess that will fail on a file the browser could have rendered itself,
 * and a false negative shows a person a wall of binary where a document should
 * be. Neither raises anything.
 *
 * The `files` plugin had no tests at all (docs/STRUCTURE_REVIEW.md H-06).
 *
 **/

describe('isOfficeDocument', () => {
  it('recognises the office suite', () => {
    for (const ext of ['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods']) {
      expect(isOfficeDocument(`/w/report.${ext}`)).toBe(true)
    }
  })

  it('ignores case, because a file from Windows arrives shouting', () => {
    expect(isOfficeDocument('/w/REPORT.DOCX')).toBe(true)
    expect(isOfficeDocument('/w/Report.Xlsx')).toBe(true)
  })

  it('leaves alone what the file browser already renders', () => {
    /** A PDF goes straight to the viewer; text formats are text. */
    for (const file of ['/w/a.pdf', '/w/a.md', '/w/a.txt', '/w/a.csv', '/w/a.png']) {
      expect(isOfficeDocument(file)).toBe(false)
    }
  })

  it('is not fooled by a name that merely contains one', () => {
    expect(isOfficeDocument('/w/docx')).toBe(false)
    expect(isOfficeDocument('/w/notes.docx.bak')).toBe(false)
    expect(isOfficeDocument('/w/.docx')).toBe(false)
  })

  it('says no for a file with no extension at all', () => {
    expect(isOfficeDocument('/w/Makefile')).toBe(false)
    expect(isOfficeDocument('')).toBe(false)
  })
})
