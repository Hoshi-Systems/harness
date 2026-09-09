import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  defineHoshiTool,
  z,
  type HoshiToolFactories,
  type HoshiToolResult,
  type MachineCapabilities,
} from '../define-tool.js'

/**
 *
 * Hoshi's image generation tool: `image_generate` drives whichever connected
 * AI provider on this machine has an image-output-capable model (OpenCode's
 * own `/provider` catalog is the source of truth — models.dev modalities), so
 * "can this machine make images?" is answered by the same credentials the
 * chat already runs on. OpenCode itself DROPS model-emitted image stream
 * parts (verified against 1.17.13 and current: `case "file"` → [] in
 * session/llm/ai-sdk.ts), so picking an image model as the session model can
 * never work — a tool call that hits the provider's API directly is the
 * supported path, and its result rides the sanctioned tool-attachment channel
 * (ToolStateCompleted.attachments, the same FilePart pipeline MCP image
 * content uses), which every Hoshi client renders in the chat.
 *
 * The generated file is also written into the workspace, so the Hoshi
 * Computer's Files view can open it, the user can download it, and follow-up
 * edits can feed it back in via `sourceImages`.
 *
 * The "no repo-internal imports — ever" rule these files carried is retired
 * with the package that justified it: they ran inside another process, and now
 * they are ordinary in-process modules contributed by the plugin that owns this
 * domain. That rule is what produced the duplication docs/STRUCTURE_REVIEW.md
 * H-08 records — a private copy of the memory store, and a second background
 * process registry — so: import what you need.
 *
 * Nor does exporting more than one thing abort anything any more; that was
 * OpenCode calling every export of a plugin file at load. Module-private is
 * still the default here, but for the ordinary reason.
 *
 **/

const CATALOG_TIMEOUT_MS = 10_000
const GENERATE_TIMEOUT_MS = 120_000
const MAX_SOURCE_IMAGES = 4
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
/** Above this raw size an image is still saved to disk but not inlined into
 *  the chat message — a multi-megabyte data URL is real weight on the message
 *  store and the live event stream (the card falls back to its file link). */
const MAX_INLINE_BYTES = 4 * 1024 * 1024
const MAX_RESULT_IMAGES = 4
const DEFAULT_DIR = 'generated-images'

/**
 * ── OpenCode's provider catalog (`/provider`) ────────────────────────────────
 *
 **/

interface CatalogModel {
  id: string
  name?: string
  release_date?: string
  status?: string
  /** models.dev raw shape (what the SDK types promise). */
  modalities?: { input?: string[]; output?: string[] }
  /** What `/provider` actually serves (verified live on 1.17.13): the
   *  normalized v2 model with boolean capability flags. */
  capabilities?: { output?: { image?: boolean } }
}

function outputsImage(model: CatalogModel): boolean {
  return model.capabilities?.output?.image === true || model.modalities?.output?.includes('image') === true
}

interface CatalogProvider {
  id: string
  name?: string
  env?: string[]
  models?: Record<string, CatalogModel>
}

interface ProviderCatalog {
  all: CatalogProvider[]
  connected?: string[]
}

/** The machine's provider catalogue, reshaped into the structure the model
 *  selection below already speaks. It used to be an HTTP GET against the
 *  runtime; the catalogue is the machine's own now (engine/providers.ts), so
 *  this is a call through the tool's context and the mapping is the only thing
 *  left of the old wire. */
async function fetchCatalog(machine: MachineCapabilities): Promise<ProviderCatalog> {
  const providers = await machine.providers()
  return {
    all: providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      models: Object.fromEntries(
        provider.models.map((model) => [
          model.id,
          {
            id: model.id,
            name: model.name,
            release_date: model.releaseDate ?? undefined,
            status: model.status ?? undefined,
            modalities: { output: model.outputModalities },
          },
        ]),
      ),
    })),
    connected: providers.filter((provider) => provider.connected).map((provider) => provider.id),
  }
}

/** Providers this tool knows how to call directly. Catalog order is not a
 *  preference — this list is (Google's Gemini image models first). */
const DRIVER_ORDER = ['google', 'openrouter'] as const
type DriverId = (typeof DRIVER_ORDER)[number]

function imageModels(provider: CatalogProvider): CatalogModel[] {
  return Object.values(provider.models ?? {})
    .filter(outputsImage)
    .filter((model) => model.status !== 'deprecated')
    .sort((a, b) => {
      const byDate = (b.release_date ?? '').localeCompare(a.release_date ?? '')
      if (byDate !== 0) return byDate
      /**
       *
       * Same-day tie: prefer the stable id over its -preview twin.
       *
       **/
      return Number(a.id.includes('preview')) - Number(b.id.includes('preview'))
    })
}

/**
 * ── Credentials ──────────────────────────────────────────────────────────────
 *
 * An API key is required — this tool speaks the providers' plain REST APIs.
 * Resolution mirrors what the machine's own surfaces recognize: the provider's
 * env var (the Hoshi vault lands there), then OpenCode's auth stores
 * (account.json current, auth.json legacy). OAuth subscriptions are real
 * credentials for chat but unusable here, so they resolve to null.
 *
 **/

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8')) as T
  } catch {
    return null
  }
}

async function resolveApiKey(provider: CatalogProvider, machine: MachineCapabilities): Promise<string | null> {
  /**
   *
   * The machine's own vault first, and it has to be first: the key a user
   * connects in Customize lives there under the provider's env var, and that
   * env var is NOT in this process's environment. Reading `process.env` alone
   * is why this tool reported "no API key is set" on a machine that plainly had
   * one — invisible to the census and the evals, since neither connects a
   * provider.
   *
   **/
  const vaulted = (await machine.providerKey(provider.id))?.trim()
  if (vaulted) return vaulted
  for (const name of provider.env ?? []) {
    const value = process.env[name]?.trim()
    if (value) return value
  }
  const dataDir = path.join(process.env.XDG_DATA_HOME ?? path.join(homedir(), '.local', 'share'), 'opencode')
  const account = await readJsonFile<{
    accounts?: Record<string, { credential?: { type?: string; key?: string } }>
    active?: Record<string, string>
  }>(path.join(dataDir, 'account.json'))
  const activeId = account?.active?.[provider.id]
  const activeCredential = activeId ? account?.accounts?.[activeId]?.credential : undefined
  if (activeCredential?.type === 'api' && activeCredential.key) return activeCredential.key
  const legacy = await readJsonFile<Record<string, { type?: string; key?: string }>>(path.join(dataDir, 'auth.json'))
  const legacyCredential = legacy?.[provider.id]
  if (legacyCredential?.type === 'api' && legacyCredential.key) return legacyCredential.key
  return null
}

/**
 * ── Model selection ──────────────────────────────────────────────────────────
 *
 **/

interface Selection {
  provider: CatalogProvider
  model: CatalogModel
  key: string
}

/** Pick the model to generate with: the explicit `provider/model` override
 *  when given, else the newest image-capable model of the first supported
 *  provider that has a usable API key. Throws a user-actionable error when
 *  nothing qualifies. */
async function selectModel(wanted: string | undefined, machine: MachineCapabilities): Promise<Selection> {
  const catalog = await fetchCatalog(machine)
  const supported = DRIVER_ORDER.map((id) => catalog.all.find((p) => p.id === id)).filter(
    (p): p is CatalogProvider => !!p,
  )

  if (wanted) {
    const slash = wanted.indexOf('/')
    if (slash === -1) throw new Error(`Invalid model "${wanted}" — pass it as "provider/model".`)
    const providerId = wanted.slice(0, slash)
    const modelId = wanted.slice(slash + 1)
    const provider = catalog.all.find((p) => p.id === providerId)
    if (!provider) throw new Error(`Unknown provider "${providerId}" on this machine.`)
    if (!DRIVER_ORDER.includes(providerId as DriverId)) {
      throw new Error(
        `Provider "${providerId}" isn't supported for direct image generation yet — supported: ${DRIVER_ORDER.join(', ')}.`,
      )
    }
    const model = provider.models?.[modelId] ?? Object.values(provider.models ?? {}).find((m) => m.id === modelId)
    if (!model) throw new Error(`Provider "${providerId}" has no model "${modelId}".`)
    if (!outputsImage(model)) {
      throw new Error(`Model "${wanted}" can't output images — pick one whose output modalities include "image".`)
    }
    const key = await resolveApiKey(provider, machine)
    if (!key) throw new Error(missingKeyMessage([provider]))
    return { provider, model, key }
  }

  const withModels = supported
    .map((provider) => ({ provider, models: imageModels(provider) }))
    .filter((entry) => entry.models.length > 0)
  if (withModels.length === 0) {
    throw new Error(
      'No image-generation-capable model is available on this machine. Connect a provider with an image-output model (e.g. Google — Gemini image models, or OpenRouter) in Customize → AI providers, then try again.',
    )
  }
  for (const entry of withModels) {
    const key = await resolveApiKey(entry.provider, machine)
    if (key) return { provider: entry.provider, model: entry.models[0]!, key }
  }
  throw new Error(missingKeyMessage(withModels.map((entry) => entry.provider)))
}

function missingKeyMessage(providers: CatalogProvider[]): string {
  const hints = providers
    .map((p) => `${p.name ?? p.id}${p.env?.[0] ? ` (API key env var ${p.env[0]})` : ''}`)
    .join(', or ')
  return `Image generation needs a plain API key, and none is set for: ${hints}. An OAuth subscription login isn't usable for the direct image API — ask the user to add an API key in Customize → AI providers.`
}

/**
 * ── Provider calls ───────────────────────────────────────────────────────────
 *
 **/

interface SourceImage {
  mime: string
  base64: string
}

interface GenerateRequest {
  model: string
  key: string
  prompt: string
  sources: SourceImage[]
  aspectRatio?: string
  signal: AbortSignal
}

interface GeneratedImage {
  mime: string
  bytes: Uint8Array
}

interface GenerateResult {
  images: GeneratedImage[]
  /** The model's own accompanying text, when it said anything. */
  note: string
}

async function readErrorDetail(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    if (parsed.error?.message) return parsed.error.message
  } catch {
    /**
     *
     * Not JSON — fall through to the raw body.
     *
     **/
  }
  return body.slice(0, 300)
}

/** Google's Gemini API (generativelanguage.googleapis.com) — the native home
 *  of the Gemini image models ("Nano Banana"). */
async function generateGoogle(req: GenerateRequest): Promise<GenerateResult> {
  const parts: unknown[] = [
    { text: req.prompt },
    ...req.sources.map((source) => ({ inlineData: { mimeType: source.mime, data: source.base64 } })),
  ]
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(req.model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': req.key },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(req.aspectRatio ? { imageConfig: { aspectRatio: req.aspectRatio } } : {}),
        },
      }),
      signal: req.signal,
    },
  )
  if (!res.ok) throw new Error(`Gemini image request failed (${res.status}): ${await readErrorDetail(res)}`)
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }> }
      finishReason?: string
    }>
    promptFeedback?: { blockReason?: string }
  }
  const candidate = data.candidates?.[0]
  const images: GeneratedImage[] = []
  const notes: string[] = []
  for (const part of candidate?.content?.parts ?? []) {
    if (part.inlineData?.data) {
      images.push({ mime: part.inlineData.mimeType ?? 'image/png', bytes: base64Bytes(part.inlineData.data) })
    } else if (part.text) {
      notes.push(part.text)
    }
  }
  if (images.length === 0) {
    const reason = data.promptFeedback?.blockReason ?? candidate?.finishReason ?? 'no image in the response'
    const note = notes.join(' ').trim()
    throw new Error(`The model returned no image (${reason}).${note ? ` Model said: ${note.slice(0, 300)}` : ''}`)
  }
  return { images, note: notes.join('\n').trim() }
}

/** OpenRouter's chat completions with output modalities — serves the same
 *  Gemini image models (and future image-output models) behind one key. */
async function generateOpenrouter(req: GenerateRequest): Promise<GenerateResult> {
  const content: unknown[] = [
    { type: 'text', text: req.prompt },
    ...req.sources.map((source) => ({
      type: 'image_url',
      image_url: { url: `data:${source.mime};base64,${source.base64}` },
    })),
  ]
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.key}` },
    body: JSON.stringify({
      model: req.model,
      messages: [{ role: 'user', content }],
      modalities: ['image', 'text'],
      /**
       *
       * Without a cap OpenRouter pre-authorizes the model's FULL output limit
       * (32k tokens at image-model prices) and 402s small credit balances.
       * One image is ~1.3k output tokens — 8k covers several plus text.
       *
       **/
      max_tokens: 8192,
    }),
    signal: req.signal,
  })
  if (!res.ok) throw new Error(`OpenRouter image request failed (${res.status}): ${await readErrorDetail(res)}`)
  const data = (await res.json()) as {
    choices?: Array<{
      message?: { content?: string; images?: Array<{ image_url?: { url?: string } }> }
    }>
  }
  const message = data.choices?.[0]?.message
  const images: GeneratedImage[] = []
  for (const image of message?.images ?? []) {
    const parsed = parseDataUrl(image.image_url?.url)
    if (parsed) images.push(parsed)
  }
  if (images.length === 0) {
    const note = message?.content?.trim()
    throw new Error(`The model returned no image.${note ? ` Model said: ${note.slice(0, 300)}` : ''}`)
  }
  return { images, note: message?.content?.trim() ?? '' }
}

const DRIVERS: Record<DriverId, (req: GenerateRequest) => Promise<GenerateResult>> = {
  google: generateGoogle,
  openrouter: generateOpenrouter,
}

/**
 * ── Bytes / files ────────────────────────────────────────────────────────────
 *
 **/

function base64Bytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

function parseDataUrl(url: string | undefined): GeneratedImage | null {
  const match = /^data:([^;,]+);base64,(.+)$/.exec(url ?? '')
  if (!match) return null
  return { mime: match[1]!, bytes: base64Bytes(match[2]!) }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

function slugify(prompt: string): string {
  const slug = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'image'
}

function timestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Resolve a user/model-supplied path against the session directory and
 *  require it to stay inside the workspace (the worktree root, or the session
 *  directory itself for directory-scoped sessions outside a worktree). */
function resolveWorkspacePath(raw: string, directory: string, worktree: string): string {
  const abs = path.resolve(directory, raw)
  const inside = (root: string) =>
    root && (abs === root || abs.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
  if (!inside(worktree) && !inside(directory)) {
    throw new Error(`Path "${raw}" resolves outside the workspace — keep generated images inside the project.`)
  }
  return abs
}

async function loadSourceImages(
  raws: string[] | undefined,
  directory: string,
  worktree: string,
): Promise<SourceImage[]> {
  if (!raws || raws.length === 0) return []
  if (raws.length > MAX_SOURCE_IMAGES) {
    throw new Error(`Too many source images (${raws.length}) — pass at most ${MAX_SOURCE_IMAGES}.`)
  }
  const sources: SourceImage[] = []
  for (const raw of raws) {
    const abs = resolveWorkspacePath(raw, directory, worktree)
    const ext = path.extname(abs).slice(1).toLowerCase()
    const mime = EXT_MIME[ext]
    if (!mime) {
      throw new Error(`Unsupported source image type "${ext || 'unknown'}" for "${raw}" — use png/jpg/webp/gif.`)
    }
    const bytes = await readFile(abs).catch(() => {
      throw new Error(`Source image "${raw}" doesn't exist or isn't readable.`)
    })
    if (bytes.byteLength > MAX_SOURCE_BYTES) {
      throw new Error(`Source image "${raw}" is too large (${formatBytes(bytes.byteLength)} > 8 MB).`)
    }
    sources.push({ mime, base64: bytes.toString('base64') })
  }
  return sources
}

interface SavedImage {
  absolutePath: string
  /** Path relative to the session directory when inside it, else absolute. */
  displayPath: string
  mime: string
  bytes: number
  /** Inline data URL for the chat attachment — absent when over the cap. */
  dataUrl?: string
}

async function saveImages(
  images: GeneratedImage[],
  options: { prompt: string; requestedPath?: string; directory: string; worktree: string },
): Promise<SavedImage[]> {
  const saved: SavedImage[] = []
  const kept = images.slice(0, MAX_RESULT_IMAGES)
  for (const [index, image] of kept.entries()) {
    const ext = MIME_EXT[image.mime] ?? 'png'
    let abs: string
    if (options.requestedPath) {
      abs = resolveWorkspacePath(options.requestedPath, options.directory, options.worktree)
      if (!path.extname(abs)) abs = `${abs}.${ext}`
      if (index > 0) {
        const parsed = path.parse(abs)
        abs = path.join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext}`)
      }
    } else {
      const name = `${slugify(options.prompt)}-${timestamp()}${index > 0 ? `-${index + 1}` : ''}.${ext}`
      abs = path.join(options.directory, DEFAULT_DIR, name)
    }
    await mkdir(path.dirname(abs), { recursive: true })
    await writeFile(abs, image.bytes)
    const relative = path.relative(options.directory, abs)
    saved.push({
      absolutePath: abs,
      displayPath: relative.startsWith('..') ? abs : relative,
      mime: image.mime,
      bytes: image.bytes.byteLength,
      ...(image.bytes.byteLength <= MAX_INLINE_BYTES
        ? { dataUrl: `data:${image.mime};base64,${Buffer.from(image.bytes).toString('base64')}` }
        : {}),
    })
  }
  return saved
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * ── The tool ─────────────────────────────────────────────────────────────────
 *
 **/

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9'] as const

const imageGenerate = defineHoshiTool({
  description: [
    "Generate an image (or edit existing ones) with this machine's image-capable AI model — Gemini image models via a connected Google or OpenRouter provider.",
    'Use it whenever the user asks for a picture: an illustration, logo, photo-style render, texture, asset for their project, or a visual edit of an image on disk.',
    'Write a rich visual prompt (subject, style, composition, lighting). Pass workspace image paths in sourceImages to edit or use them as reference.',
    "The image is saved into the workspace and shown to the user in the chat — don't re-describe it or read the file back afterwards.",
  ].join(' '),
  args: {
    prompt: z.string().describe('Detailed visual description of the image to generate (or the edit to make)'),
    path: z
      .string()
      .optional()
      .describe(`Workspace-relative output path (e.g. assets/hero.png). Default: ${DEFAULT_DIR}/<slug>-<time>.png`),
    sourceImages: z
      .array(z.string())
      .optional()
      .describe('Workspace paths of images to edit or use as reference (max 4, png/jpg/webp/gif)'),
    aspectRatio: z
      .enum(ASPECT_RATIOS)
      .optional()
      .describe('Aspect ratio of the generated image (Gemini image models; default 1:1)'),
    model: z
      .string()
      .optional()
      .describe('Override the auto-picked model, as "provider/model" (must support image output)'),
  },
  async execute(args, context): Promise<HoshiToolResult> {
    const selection = await selectModel(args.model, context.machine)
    const sources = await loadSourceImages(args.sourceImages, context.directory, context.worktree)
    const modelRef = `${selection.provider.id}/${selection.model.id}`

    const result = await DRIVERS[selection.provider.id as DriverId]({
      model: selection.model.id,
      key: selection.key,
      prompt: args.prompt,
      sources,
      aspectRatio: args.aspectRatio,
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(GENERATE_TIMEOUT_MS)]),
    })

    const saved = await saveImages(result.images, {
      prompt: args.prompt,
      requestedPath: args.path,
      directory: context.directory,
      worktree: context.worktree,
    })

    const listed = saved.map((image) => `${image.displayPath} (${formatBytes(image.bytes)})`).join(', ')
    const output = [
      `Generated ${saved.length === 1 ? 'an image' : `${saved.length} images`} with ${modelRef}: ${listed}.`,
      "The image is shown to the user in the chat — don't re-describe it or read the file back.",
      `To refine it, call image_generate again with sourceImages: ["${saved[0]!.displayPath}"] and the requested change.`,
      ...(result.note ? [`Model note: ${result.note.slice(0, 500)}`] : []),
    ].join(' ')

    return {
      title: saved[0]!.displayPath,
      output,
      metadata: {
        hoshi: {
          image: {
            provider: selection.provider.id,
            model: selection.model.id,
            prompt: args.prompt,
            files: saved.map((image) => ({
              path: image.displayPath,
              absolutePath: image.absolutePath,
              mime: image.mime,
              bytes: image.bytes,
            })),
          },
        },
      },
      attachments: saved
        .filter((image) => image.dataUrl)
        .map((image) => ({
          type: 'file' as const,
          mime: image.mime,
          url: image.dataUrl!,
          filename: path.basename(image.absolutePath),
        })),
    }
  },
})

export const imageTools: HoshiToolFactories = {
  image_generate: imageGenerate,
}
