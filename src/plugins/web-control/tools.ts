import { createRequire } from 'node:module'
import { ports } from './host.js'
import path from 'node:path'
import { defineHoshiTool, z, type HoshiToolFactories } from '../define-tool.js'
import type { Browser, Page } from 'playwright-core'

/**
 *
 * The eight tools `web-control` contributes — and it contributes them, rather
 * than the tool registry package doing it, because the browser is a system
 * dependency and a plugin that is degraded for want of one must withhold the
 * tools that need it (../index.ts, docs/STRUCTURE_REVIEW.md H-08).
 *
 * Hoshi's agent-driven browser (CYB-96): navigate/screenshot/click/type against
 * a real headless Chromium. `browser_read_page` snapshots the page as a
 * ref-tagged accessibility-style tree (a `data-hoshi-ref` attribute stamped via
 * `page.evaluate` — no new dependency); `browser_find` substring-searches that
 * snapshot; action tools take any of ref/selector/(x,y) — one tool per verb.
 * Every call returns a PNG screenshot in `metadata.hoshi.browser` that
 * ToolPanelBrowser.vue (packages/ui) renders; the text-shaped tools return
 * their dump as the tool's own `output` instead. Deliberately NOT built: a
 * live shared human+agent surface — a streaming/remote-input problem, outside
 * this discrete-screenshot model entirely.
 *
 * The node_modules problem: `playwright-core` (deliberately not the full
 * `playwright`, which bundles Firefox + WebKit this never launches) is a
 * devDependency here, not a production one — a browser binary is an image
 * concern, and making it a real dependency would drag hundreds of megabytes
 * into every consumer of this registry, including one that never opens a page.
 * So it cannot be a bare import at runtime. infra/machine/Dockerfile installs
 * it at a FIXED absolute path baked into the image (default
 * /app/browser/node_modules) and `loadPlaywright()` resolves it from there at
 * call time via createRequire — the same trick the harness's voice plugin uses
 * for `sherpa-onnx-node`. The require is lazy (never module top level) so a
 * machine without the browser bundle still loads every other tool in this file.
 *
 * Module-private is the default below for the ordinary reason. It used to be a
 * hard rule: OpenCode called every export of a plugin file at load, so a helper
 * throwing on the PluginInput it was handed aborted the whole file's
 * registration (verified live on 1.17.13).
 *
 **/

/** Where the Docker image installs playwright-core's own node_modules (see
 *  infra/machine/Dockerfile's CYB-96 block) — never this file's own
 *  directory, which has none. Overridable for the dev-host sync path
 *  (scripts/sync-machine-profile.mjs), where a developer's own machine has no
 *  such sibling either — browser tools simply degrade there unless the
 *  developer sets this themselves. */
const BROWSER_MODULE_ROOT = process.env.HOSHI_BROWSER_MODULE_ROOT ?? '/app/browser'

const NAV_TIMEOUT_MS = 20_000
const ACTION_TIMEOUT_MS = 8_000
const VIEWPORT = { width: 1280, height: 800 }

/** Only try the resolve once per process — a missing module isn't going to
 *  appear later, and a present one never needs re-resolving. */
let playwrightModule: typeof import('playwright-core') | null | undefined

function loadPlaywright(): typeof import('playwright-core') | null {
  if (playwrightModule !== undefined) return playwrightModule
  try {
    const require = createRequire(path.join(BROWSER_MODULE_ROOT, 'noop.js'))
    playwrightModule = require('playwright-core') as typeof import('playwright-core')
  } catch {
    playwrightModule = null
  }
  return playwrightModule
}

/**
 *
 * ── Shared per-session browser (globalThis-cached, like hoshi-ui.ts's widget
 * bridge) ────────────────────────────────────────────────────────────────────
 *
 * One Chromium page per OpenCode session, reused across navigate/click/type/
 * screenshot calls so a browsing sequence reads as one continuous session
 * instead of a fresh tab every call (the ticket's explicit ask). Idle
 * sessions are swept on a timer — the closest analogue to a "session end"
 * hook this plugin API exposes; `dispose` (called when OpenCode tears the
 * plugin down) is a belt-and-suspenders second cleanup path.
 *
 **/

/** One element from a `browser_read_page` snapshot — see `capturePageSnapshot`.
 *  `browser_find` searches the session's cached copy of this array rather
 *  than re-walking the DOM, so its `ref`s always match what the agent last
 *  saw (a fresh walk would renumber every ref out from under it). */
export interface PageElementInfo {
  ref: string
  depth: number
  role: string
  name: string
  tag: string
  /** An `<input>`'s type. Reported because a form reads differently when you
   *  know which field is the password, and because `formatSnapshot` redacts on
   *  it — the second of the two gates that keep a credential off the wire. */
  type?: string
  value?: string
  checked?: boolean
  disabled?: boolean
}

interface BrowserSession {
  browser: Browser
  page: Page
  lastUsedAt: number
  /** The most recent `browser_read_page` snapshot for this session, or
   *  `undefined` before the first call — see `browser_find`. Cleared on
   *  `browser_navigate` since a new page invalidates every old ref. */
  lastSnapshot?: PageElementInfo[]
}

interface BrowserBridge {
  sessions: Map<string, BrowserSession>
  sweepTimer: ReturnType<typeof setInterval> | null
}

const globals = globalThis as { __hoshiBrowserBridge?: BrowserBridge }
const bridge: BrowserBridge = (globals.__hoshiBrowserBridge ??= { sessions: new Map(), sweepTimer: null })

const IDLE_TIMEOUT_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

function ensureSweep(): void {
  if (bridge.sweepTimer) return
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [sessionID, session] of bridge.sessions) {
      if (now - session.lastUsedAt < IDLE_TIMEOUT_MS) continue
      bridge.sessions.delete(sessionID)
      void session.browser.close().catch(() => {})
    }
  }, SWEEP_INTERVAL_MS)
  timer.unref?.()
  bridge.sweepTimer = timer
}

async function closeAllSessions(): Promise<void> {
  const sessions = [...bridge.sessions.values()]
  bridge.sessions.clear()
  await Promise.all(sessions.map((session) => session.browser.close().catch(() => {})))
  if (bridge.sweepTimer) {
    clearInterval(bridge.sweepTimer)
    bridge.sweepTimer = null
  }
}

/** The active session for a running tool call, or a clear error telling the
 *  model to navigate first — never silently creates a blank-page session,
 *  since a screenshot/click/type with nothing navigated yet is a model
 *  mistake worth surfacing, not papering over. */
function requireSession(sessionID: string): BrowserSession {
  const session = bridge.sessions.get(sessionID)
  if (!session) {
    throw new Error('No active browser session for this conversation yet — call browser_navigate first.')
  }
  session.lastUsedAt = Date.now()
  return session
}

/** Launch (or reuse) this session's Chromium page. `--no-sandbox` +
 *  `--disable-setuid-sandbox`: Chromium's zygote sandbox needs setuid or an
 *  unprivileged user namespace the machine's non-root `hoshi` container user
 *  doesn't have without extra Docker capabilities this feature doesn't
 *  request — the standard, widely-documented flag pair for headless Chromium
 *  in a plain container. `--disable-dev-shm-usage`: Docker's default 64 MB
 *  /dev/shm is too small for Chromium's shared-memory usage and crashes
 *  under load without this flag. All three verified harmless on a normal
 *  (non-container) launch too — see this ticket's live sandbox verification
 *  notes. */
async function ensureSession(sessionID: string): Promise<BrowserSession> {
  const existing = bridge.sessions.get(sessionID)
  if (existing) {
    existing.lastUsedAt = Date.now()
    return existing
  }
  const playwright = loadPlaywright()
  if (!playwright) {
    throw new Error(
      "Browser automation isn't available on this machine — this machine image doesn't have the Chromium automation bundle installed. Use webfetch to read a page's content instead.",
    )
  }
  /**
   *
   * Headful WHEN there is somewhere to draw, so a person can watch this session
   * and take it over. The display comes from the
   * kernel port the `desktop` plugin provides — never an import, because these
   * are two plugins and neither may reach for the other
   * (docs/decisions/0002-own-harness.md).
   *
   * Read at LAUNCH rather than cached at boot: a browser is spawned per
   * session, and a machine whose display came up after the first one should
   * still be visible for the next. Headless stays the answer everywhere else —
   * which is every machine whose image predates the desktop.
   *
   **/
  const display = ports().display?.() ?? null
  const browser = await playwright.chromium.launch({
    headless: display === null,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    ...(display ? { env: { ...process.env, DISPLAY: display } } : {}),
  })
  const page = await browser.newPage({ viewport: VIEWPORT })
  const session: BrowserSession = { browser, page, lastUsedAt: Date.now() }
  bridge.sessions.set(sessionID, session)
  ensureSweep()
  return session
}

/**
 * ── Loopback-only navigation ─────────────────────────────────────────────────
 *
 * This tool exists to drive the machine's OWN locally-running dev servers —
 * the same target the port-listening notification and /proxy/{port} already
 * reach (packages/harness/src/plugins/services/preview-proxy.ts forwards to
 * `http://127.0.0.1:{port}`) — not to give the agent a general-purpose
 * browser onto the open internet (webfetch already covers read-only fetches
 * of external pages; a real interactive browser that can click/type
 * anywhere is meaningfully more capable, and out of scope for what this
 * ticket asked for).
 *
 **/

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

function parseLoopbackUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`"${raw}" is not a valid URL.`)
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `browser_navigate only reaches this machine's own local ports (127.0.0.1/localhost) — "${url.hostname}" is an external host. Use webfetch to read an external page instead.`,
    )
  }
  return url
}

async function screenshotDataUrl(page: Page): Promise<string> {
  const buffer = await page.screenshot({ type: 'png' })
  return `data:image/png;base64,${buffer.toString('base64')}`
}

/** The shared result shape every browser_* tool returns: a short text summary
 *  for the model plus the actual screenshot for the human, in the same
 *  `metadata.hoshi.*` slot the generative-UI tools use (ToolPanelBrowser.vue
 *  reads this — see packages/ui/app/lib/tool-call.ts's ToolCallView.metadata). */
async function browserResult(page: Page, summary: string) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const screenshot = await screenshotDataUrl(page)
  return {
    title: url,
    output: `${summary} The current page is shown to the user as a screenshot — don't re-describe its visual layout in text.`,
    metadata: { hoshi: { browser: { url, title, screenshot, width: VIEWPORT.width, height: VIEWPORT.height } } },
  }
}

/** Like {@link browserResult}, but for the text-shaped tools (`browser_read_page`,
 *  `browser_find`, `browser_get_page_text`): `text` IS the model-facing output
 *  (no "shown as a screenshot" framing — there's no visual summary to give,
 *  the dump itself is the content), while the screenshot still rides along in
 *  metadata so ToolPanelBrowser.vue has a fallback if it ever needs one. */
async function browserTextResult(page: Page, text: string) {
  const url = page.url()
  const title = await page.title().catch(() => '')
  const screenshot = await screenshotDataUrl(page)
  return {
    title: url,
    output: text,
    metadata: { hoshi: { browser: { url, title, screenshot, width: VIEWPORT.width, height: VIEWPORT.height } } },
  }
}

/**
 * ── Ref-tagged page snapshot (browser_read_page/browser_find) ──────────────
 *
 * A lightweight, hand-rolled stand-in for a real accessibility-tree API: walk
 * the page's interactive + headline elements in DOM order, stamp each one
 * with a `data-hoshi-ref` attribute, and hand back a flat list carrying that
 * ref plus enough context (role, name, current value/checked state) for the
 * model to act on. `browser_click`/`browser_type`/`browser_form_input` then
 * resolve a `ref` back to its element via `[data-hoshi-ref="ref_N"]` — an
 * ordinary Playwright selector, so every existing action helper (`.click`,
 * `.fill`, `.selectOption`, `.setChecked`) just works unmodified. Refs are
 * renumbered from `ref_1` on every snapshot (stale attributes from the
 * previous call are stripped first), so a ref only ever means "what
 * browser_read_page most recently labeled this" — acting on a stale one fails
 * with a clear error instead of silently hitting the wrong element.
 *
 **/

const REF_PATTERN = /^ref_\d+$/
const MAX_SNAPSHOT_ELEMENTS = 200

function refSelector(ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`"${ref}" doesn't look like a ref from browser_read_page/browser_find (expected e.g. ref_3).`)
  }
  return `[data-hoshi-ref="${ref}"]`
}

/** Runs entirely inside the page via `page.evaluate` — everything referenced
 *  here (`document`, `HTMLInputElement`, …) is the BROWSER's own global
 *  scope, not Node's; see this package's tsconfig "dom" lib, carried purely so
 *  `tsc` can type-check this callback. */
async function capturePageSnapshot(page: Page, limit = MAX_SNAPSHOT_ELEMENTS): Promise<PageElementInfo[]> {
  return page.evaluate((maxElements) => {
    const SELECTOR =
      'a[href], button, input, textarea, select, [role], [contenteditable=""], [contenteditable="true"], summary, h1, h2, h3, h4, h5, h6'

    function isVisible(el: Element): boolean {
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }

    function accessibleName(el: Element): string {
      const aria = el.getAttribute('aria-label')
      if (aria?.trim()) return aria.trim()
      const labelledby = el.getAttribute('aria-labelledby')
      if (labelledby) {
        const text = labelledby
          .split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
          .filter(Boolean)
          .join(' ')
        if (text) return text
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
        const id = el.getAttribute('id')
        /**
         *
         * A labeled field can be associated either way — an explicit
         * `for="id"` pointing at it, or an ancestor `<label>` wrapping it
         * with no `for` at all — so try both rather than picking one based
         * on whether `id` happens to be set.
         *
         **/
        const label = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) || el.closest('label')
        if (label?.textContent?.trim()) return label.textContent.trim()
        const placeholder = el.getAttribute('placeholder')
        if (placeholder?.trim()) return placeholder.trim()
      }
      const alt = el.getAttribute('alt')
      if (alt?.trim()) return alt.trim()
      const title = el.getAttribute('title')
      if (title?.trim()) return title.trim()
      return (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
    }

    function roleOf(el: Element): string {
      const explicit = el.getAttribute('role')
      if (explicit) return explicit
      const tag = el.tagName.toLowerCase()
      if (tag === 'a') return 'link'
      if (tag === 'button' || tag === 'summary') return 'button'
      if (tag === 'select') return 'combobox'
      if (tag === 'textarea') return 'textbox'
      if (/^h[1-6]$/.test(tag)) return 'heading'
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type
        if (type === 'checkbox') return 'checkbox'
        if (type === 'radio') return 'radio'
        if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
        return 'textbox'
      }
      if (el.hasAttribute('contenteditable')) return 'textbox'
      return tag
    }

    document.querySelectorAll('[data-hoshi-ref]').forEach((el) => el.removeAttribute('data-hoshi-ref'))
    const included = Array.from(document.querySelectorAll(SELECTOR)).filter(isVisible).slice(0, maxElements)

    const depthOf = (el: Element): number => {
      let depth = 0
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        if (included.includes(parent)) depth++
      }
      return depth
    }

    return included.map((el, index) => {
      const ref = `ref_${index + 1}`
      el.setAttribute('data-hoshi-ref', ref)
      const info: {
        ref: string
        depth: number
        role: string
        name: string
        tag: string
        type?: string
        value?: string
        checked?: boolean
        disabled?: boolean
      } = { ref, depth: depthOf(el), role: roleOf(el), name: accessibleName(el), tag: el.tagName.toLowerCase() }
      if (el instanceof HTMLInputElement) {
        info.type = el.type
        if (el.type === 'checkbox' || el.type === 'radio') info.checked = el.checked
        /**
         *
         * A password field's VALUE never leaves the page. This snapshot is the
         * model-facing output of `browser_read_page`/`browser_find`, so before
         * this line a credential typed into a form — by the agent from the
         * vault, or by a person taking the session over — was sent verbatim to
         * the provider and written into the transcript.
         *
         * Redacted rather than dropped: the agent still needs to know the field
         * is filled, which is most of what it reads a form back for. `type` is
         * the page's own declaration that this is secret, which makes it a
         * better rule than any list of field names.
         *
         **/
        else if (el.type === 'password') info.value = el.value ? '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022' : ''
        else info.value = el.value
        if (el.disabled) info.disabled = true
      } else if (el instanceof HTMLTextAreaElement) {
        info.value = el.value
        if (el.disabled) info.disabled = true
      } else if (el instanceof HTMLSelectElement) {
        info.value = el.options[el.selectedIndex]?.text ?? el.value
        if (el.disabled) info.disabled = true
      }
      return info
    })
  }, limit)
}

/** What a password field's value reads as. Never the value. */
const MASK = '••••••••'

/** Render a snapshot (or a `browser_find` subset of one) as an indented,
 *  YAML-style text tree — `- role "name" [ref_N] extra=state`, one line per
 *  element, indented by its depth among the OTHER included elements (not raw
 *  DOM depth, which would be far noisier). */
export function formatSnapshot(elements: PageElementInfo[]): string {
  if (elements.length === 0) return 'No interactive elements found on the current page.'
  return elements
    .map((el) => {
      const bits = [`${el.role} "${el.name}" [${el.ref}]`]
      /**
       *
       * The second gate. The snapshot above already redacts a password field's
       * value in the PAGE, which is the right place — the secret never leaves
       * the browser. This one exists because that code runs inside
       * `page.evaluate` and cannot be unit-tested from here, so a regression in
       * it would be silent; this half runs in node, is covered by a test, and
       * catches the same leak one step later.
       *
       **/
      if (el.value) bits.push(`value="${el.type === 'password' ? MASK : el.value}"`)
      if (el.checked !== undefined) bits.push(`checked=${el.checked}`)
      if (el.disabled) bits.push('disabled')
      return `${'  '.repeat(el.depth)}- ${bits.join(' ')}`
    })
    .join('\n')
}

/**
 * ── Tools ────────────────────────────────────────────────────────────────────
 *
 **/

const browserNavigate = defineHoshiTool({
  description: [
    "Navigate this machine's agent-driven headless browser to a URL on this machine's OWN loopback (127.0.0.1/localhost) — a locally running dev server, e.g. one the port-listening notification just surfaced.",
    'Launches a browser for this conversation on first use and keeps reusing the same page across later browser_* calls, so a sequence of navigate/click/type reads as one continuous session.',
    'Returns a screenshot of the resulting page. NOT for external sites — use webfetch for those.',
  ].join(' '),
  args: {
    url: z.string().describe('A loopback URL, e.g. http://127.0.0.1:5173/dashboard'),
  },
  async execute(args, context) {
    const url = parseLoopbackUrl(args.url)
    const session = await ensureSession(context.sessionId)
    await session.page.goto(url.toString(), { waitUntil: 'load', timeout: NAV_TIMEOUT_MS })
    session.lastSnapshot = undefined // the old snapshot's refs no longer point at anything real
    return browserResult(session.page, `Navigated to ${url.toString()}.`)
  },
})

const browserScreenshot = defineHoshiTool({
  description:
    "Capture a screenshot of the current page in this conversation's browser session (see browser_navigate). Use this to check on the page's current state without taking any action.",
  args: {},
  async execute(_args, context) {
    const session = requireSession(context.sessionId)
    return browserResult(session.page, 'Screenshotted the current page.')
  },
})

const browserClick = defineHoshiTool({
  description: [
    "Click an element in the current page (see browser_navigate). Provide EXACTLY ONE of: 'ref' (from browser_read_page/browser_find), a CSS 'selector', or both 'x' and 'y' viewport coordinates.",
    "Prefer 'ref' right after browser_read_page/browser_find; a 'selector' when the element has an obviously stable one of its own (id, data-testid); fall back to coordinates for canvas-drawn UI neither can reach.",
  ].join(' '),
  args: {
    ref: z.string().optional().describe('A ref id from browser_read_page/browser_find, e.g. ref_4'),
    selector: z.string().optional().describe('CSS selector of the element to click'),
    x: z.number().optional().describe("Viewport x coordinate (with 'y', instead of 'ref'/'selector')"),
    y: z.number().optional().describe("Viewport y coordinate (with 'x', instead of 'ref'/'selector')"),
  },
  async execute(args, context) {
    const session = requireSession(context.sessionId)
    if (args.ref) {
      await session.page.click(refSelector(args.ref), { timeout: ACTION_TIMEOUT_MS })
      return browserResult(session.page, `Clicked ${args.ref}.`)
    }
    if (args.selector) {
      await session.page.click(args.selector, { timeout: ACTION_TIMEOUT_MS })
      return browserResult(session.page, `Clicked "${args.selector}".`)
    }
    if (typeof args.x === 'number' && typeof args.y === 'number') {
      await session.page.mouse.click(args.x, args.y)
      return browserResult(session.page, `Clicked at (${args.x}, ${args.y}).`)
    }
    throw new Error("Provide 'ref', 'selector', or both 'x' and 'y'.")
  },
})

const browserType = defineHoshiTool({
  description: [
    "Type text into the current page (see browser_navigate). With 'ref' (from browser_read_page/browser_find) or 'selector', clears and fills that field; without either, types into whatever element currently has focus (e.g. right after a browser_click).",
    "Set 'submit' to press Enter afterward — for search boxes and single-field forms.",
  ].join(' '),
  args: {
    text: z.string().describe('The text to type'),
    ref: z.string().optional().describe('A ref id from browser_read_page/browser_find, e.g. ref_4'),
    selector: z.string().optional().describe('CSS selector of the input/textarea to fill'),
    submit: z.boolean().optional().describe('Press Enter after typing (default false)'),
  },
  async execute(args, context) {
    const session = requireSession(context.sessionId)
    const target = args.ref ? refSelector(args.ref) : args.selector
    if (target) {
      await session.page.fill(target, args.text, { timeout: ACTION_TIMEOUT_MS })
      if (args.submit) await session.page.press(target, 'Enter', { timeout: ACTION_TIMEOUT_MS })
    } else {
      await session.page.keyboard.type(args.text)
      if (args.submit) await session.page.keyboard.press('Enter')
    }
    return browserResult(session.page, `Typed "${args.text}"${args.submit ? ' and submitted' : ''}.`)
  },
})

const browserReadPage = defineHoshiTool({
  description: [
    'Snapshot the current page (see browser_navigate) as a flat, indented tree of its interactive elements and headings — links, buttons, inputs, textareas, selects, checkboxes/radios, and h1-h6.',
    'Each line is tagged with a stable ref (e.g. [ref_4]) you can pass to browser_click/browser_type/browser_form_input instead of a CSS selector or coordinates.',
    'Call this again after any navigation or DOM-changing action — refs are renumbered every time and a stale one will fail.',
  ].join(' '),
  args: {},
  async execute(_args, context) {
    const session = requireSession(context.sessionId)
    const snapshot = await capturePageSnapshot(session.page)
    session.lastSnapshot = snapshot
    return browserTextResult(session.page, formatSnapshot(snapshot))
  },
})

const browserFind = defineHoshiTool({
  description: [
    "Search the MOST RECENT browser_read_page snapshot for elements whose role, tag, or visible name/label contains 'query' (plain substring matching, case-insensitive — not a semantic search).",
    "Returns up to 15 matches in the same ref-tagged format as browser_read_page. Call browser_read_page first; there's nothing to search until then.",
  ].join(' '),
  args: {
    query: z.string().describe('Text to look for, e.g. submit or email'),
  },
  async execute(args, context) {
    const session = requireSession(context.sessionId)
    if (!session.lastSnapshot || session.lastSnapshot.length === 0) {
      throw new Error('No page snapshot to search yet — call browser_read_page first.')
    }
    const needle = args.query.trim().toLowerCase()
    const matches = session.lastSnapshot
      .filter(
        (el) =>
          el.name.toLowerCase().includes(needle) ||
          el.role.toLowerCase().includes(needle) ||
          el.tag.toLowerCase().includes(needle),
      )
      .slice(0, 15)
    const text =
      matches.length > 0
        ? formatSnapshot(matches)
        : `No elements matching "${args.query}" in the last browser_read_page snapshot. Try a different word, or call browser_read_page again if the page has changed since.`
    return browserTextResult(session.page, text)
  },
})

const browserFormInput = defineHoshiTool({
  description: [
    "Set a form element's value by 'ref' (from browser_read_page/browser_find) — the ref-based counterpart to browser_type for the cases plain typing doesn't cover.",
    "Pass 'value' for a text input/textarea (fills, like browser_type) or a <select> (chooses the option whose value or visible text matches); pass 'checked' for a checkbox/radio instead.",
  ].join(' '),
  args: {
    ref: z.string().describe('A ref id from browser_read_page/browser_find, e.g. ref_4'),
    value: z.string().optional().describe('Text to fill, or the option to select'),
    checked: z.boolean().optional().describe('Checked state to set on a checkbox/radio'),
  },
  async execute(args, context) {
    const session = requireSession(context.sessionId)
    const selector = refSelector(args.ref)
    const handle = await session.page.$(selector)
    if (!handle) {
      throw new Error(
        `No element with ref "${args.ref}" on the current page — call browser_read_page again to get fresh refs.`,
      )
    }
    if (typeof args.checked === 'boolean') {
      await session.page.setChecked(selector, args.checked, { timeout: ACTION_TIMEOUT_MS })
      return browserResult(session.page, `Set ${args.ref} checked=${args.checked}.`)
    }
    if (typeof args.value === 'string') {
      const tag = await handle.evaluate((el) => el.tagName.toLowerCase())
      if (tag === 'select') {
        await session.page.selectOption(selector, args.value, { timeout: ACTION_TIMEOUT_MS })
      } else {
        await session.page.fill(selector, args.value, { timeout: ACTION_TIMEOUT_MS })
      }
      return browserResult(session.page, `Set ${args.ref} to "${args.value}".`)
    }
    throw new Error("Provide either 'value' (text input/textarea/select) or 'checked' (checkbox/radio).")
  },
})

const browserGetPageText = defineHoshiTool({
  description:
    "Extract the current page's visible text (see browser_navigate) — its rendered <article>/<main>, or the whole <body> if neither is present. Cheaper than browser_read_page when you just need to read content, not act on it.",
  args: {
    maxChars: z.number().optional().describe('Truncate to this many characters (default 20000)'),
  },
  async execute(args, context) {
    const session = requireSession(context.sessionId)
    const raw = await session.page.evaluate(() => {
      const main = document.querySelector('article') ?? document.querySelector('main') ?? document.body
      return main?.innerText ?? ''
    })
    const limit = args.maxChars && args.maxChars > 0 ? args.maxChars : 20_000
    const text = raw.length > limit ? `${raw.slice(0, limit)}\n… (truncated, ${raw.length} characters total)` : raw
    return browserTextResult(session.page, text.trim() || 'The current page has no visible text.')
  },
})

export const browserTools: HoshiToolFactories = {
  browser_navigate: browserNavigate,
  browser_screenshot: browserScreenshot,
  browser_click: browserClick,
  browser_type: browserType,
  browser_read_page: browserReadPage,
  browser_find: browserFind,
  browser_form_input: browserFormInput,
  browser_get_page_text: browserGetPageText,
}

/**
 *
 * Extra safety net alongside the idle sweep above — releases every open
 * Chromium instance when the machine goes down, rather than leaving them to
 * the sweep's next tick. This was the plugin host's `dispose`; in-process the
 * equivalent is the process's own exit, and a leaked headless Chromium is real
 * memory on a machine somebody is paying for.
 *
 **/
for (const signal of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) {
  process.once(signal, () => void closeAllSessions())
}
