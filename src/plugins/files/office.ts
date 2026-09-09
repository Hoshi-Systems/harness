import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { apiError, workspaceRoot } from '../../kernel/index.js'

const execFileAsync = promisify(execFile)

/**
 *
 * Office-document rendering: the machine converts a workspace document to PDF
 * with LibreOffice headless (baked into the machine image; see
 * infra/machine/Dockerfile) so the Hoshi Computer's file browser can preview
 * docx/pptx/xlsx the same way it already previews a plain PDF. Conversion is
 * on-demand, cached by the source file's identity+mtime, and serialized —
 * LibreOffice is a heavyweight process and a preview must never fork a herd
 * of them.
 *
 **/

/** Formats LibreOffice converts reliably in headless mode — the office suite
 *  surface. Keyed by extension (lowercase, no dot). Plain PDFs never come
 *  here (the file browser renders them directly), text formats neither. */
const OFFICE_EXTENSIONS = new Set(['doc', 'docx', 'odt', 'rtf', 'ppt', 'pptx', 'odp', 'xls', 'xlsx', 'ods'])

export function isOfficeDocument(file: string): boolean {
  return OFFICE_EXTENSIONS.has(path.extname(file).slice(1).toLowerCase())
}

/** The soffice binary: env override first (local dev), then PATH (the machine
 *  image), then the macOS app bundle (local dev with LibreOffice.app). Null
 *  when this machine simply doesn't have LibreOffice. */
function sofficeBin(): string | null {
  const override = process.env.HOSHI_SOFFICE_BIN
  if (override) return existsSync(override) ? override : null
  if (existsSync('/usr/bin/soffice')) return '/usr/bin/soffice'
  const mac = '/Applications/LibreOffice.app/Contents/MacOS/soffice'
  if (process.platform === 'darwin' && existsSync(mac)) return mac
  return 'soffice' // last resort: trust PATH, execFile fails cleanly if absent
}

/** Rendered PDFs live outside the workspace (never pollute a checkout) and
 *  outside /data (they are a derivable cache, not durable state). */
const RENDER_CACHE_DIR = path.join(tmpdir(), 'hoshi-office-render')

/** One conversion at a time. LibreOffice instances race each other on CPU and
 *  memory far more than they parallelize; a browser clicking through a folder
 *  of decks queues instead of forking. */
let conversionQueue: Promise<unknown> = Promise.resolve()

/** Resolve + validate a caller-supplied path: absolute, inside the workspace
 *  tree, an existing regular file, and an office format. Returns the resolved
 *  path and its stats (the cache key ingredients). */
export async function resolveOfficeSource(raw: string): Promise<{ file: string; mtimeMs: number; size: number }> {
  const file = path.resolve(raw)
  const root = workspaceRoot()
  if (file !== root && !file.startsWith(root + path.sep)) {
    apiError(400, 'render.outsideWorkspace', 'Only workspace documents can be rendered.')
  }
  if (!isOfficeDocument(file)) {
    apiError(415, 'render.unsupported', 'Not a renderable office document.')
  }
  let stats
  try {
    stats = await stat(file)
  } catch {
    apiError(404, 'render.notFound', 'Document not found.')
  }
  if (!stats.isFile()) {
    apiError(404, 'render.notFound', 'Document not found.')
  }
  return { file, mtimeMs: stats.mtimeMs, size: stats.size }
}

/** Convert an office document to PDF, returning the cached PDF's path. The
 *  cache key folds in mtime+size, so an agent rewriting a deck mid-session
 *  makes the next preview re-convert while stale siblings age out with /tmp. */
export async function renderOfficePdf(source: { file: string; mtimeMs: number; size: number }): Promise<string> {
  const key = createHash('sha256')
    .update(`${source.file}\n${source.mtimeMs}\n${source.size}`)
    .digest('hex')
    .slice(0, 32)
  const cached = path.join(RENDER_CACHE_DIR, `${key}.pdf`)
  if (existsSync(cached)) return cached

  const bin = sofficeBin()
  if (!bin) {
    apiError(501, 'render.unavailable', 'This machine has no office suite installed.')
  }

  const result = conversionQueue.then(() => convert(bin, source.file, key, cached))
  /**
   *
   * The queue must survive a failed conversion — chain past the error, but
   * rethrow it to THIS caller.
   *
   **/
  conversionQueue = result.catch(() => {})
  await result
  return cached
}

async function convert(bin: string, file: string, key: string, cached: string): Promise<void> {
  if (existsSync(cached)) return // a queued twin already converted it
  const workDir = path.join(RENDER_CACHE_DIR, `run-${key}`)
  await mkdir(workDir, { recursive: true })
  try {
    /**
     *
     * A private UserInstallation per run: soffice refuses to start when its
     * profile is locked by another instance (even a crashed one's leftover
     * lock), and the machine's interactive LibreOffice use (the agent
     * converting documents itself) must never contend with previews.
     *
     **/
    await execFileAsync(
      bin,
      [
        `-env:UserInstallation=file://${workDir}/profile`,
        '--headless',
        '--norestore',
        '--convert-to',
        'pdf',
        '--outdir',
        workDir,
        file,
      ],
      { timeout: 120_000 },
    )
    const produced = path.join(workDir, `${path.basename(file, path.extname(file))}.pdf`)
    if (!existsSync(produced)) {
      apiError(502, 'render.failed', 'The office suite could not convert this document.')
    }
    await rename(produced, cached)
  } catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) throw error
    /**
     *
     * The PATH fallback only proves soffice's absence at spawn time.
     *
     **/
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      apiError(501, 'render.unavailable', 'This machine has no office suite installed.')
    }
    apiError(502, 'render.failed', 'The office suite could not convert this document.')
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}
