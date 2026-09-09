/**
 * ── The HGL protocol, declared once ──────────────────────────────────────────
 *
 * HGL is the flat-node JSON document a model emits and a client renders. Two
 * ends have to agree about it exactly: `packages/harness`'s `ui_render` tool,
 * which tells the model what may be emitted and refuses what may not, and
 * `@hoshi/ui`'s renderer, which turns a node into a component.
 *
 * They agreed by hand. Both files said so — "keep the two lists in step,
 * together", "mirrored here for the same reason the UI component allowlist is
 * mirrored" — and the reason each gave was wrong by the time it was read. The
 * machine side said it "ships standalone into OpenCode and cannot import" the
 * UI, which stopped being true when the harness became a package in this
 * workspace; the UI side said the machine "cannot import this list: it runs on
 * the machine, and this is a Nuxt layer", which is true of the layer and not of
 * the names.
 *
 * The real obstacle was neither: `@hoshi/shared` had no build, so the harness
 * could take TYPES from it and nothing else — a runtime import would have put a
 * `.ts` file in the machine image for node to choke on. That is what
 * `@hoshi/shared/hgl` fixes, and this file is what it exists to carry.
 *
 * What is here is the CONTRACT — names and shapes, no framework. The renderer
 * stays in `@hoshi/ui` (it needs the components), the tool behaviour stays in
 * the harness (it needs the session), and neither can drift from the other
 * without a compile error: the UI's allowlist is typed `Record<HglComponentName,
 * …>`, so a component the list does not name will not build, and one it names
 * but the map omits will not either.
 *
 **/

/**
 *
 * The design-system components a `component` node may name.
 *
 * An allowlist, not a re-export of the package, on purpose: no portalled
 * overlays (a chat message must never take over the viewport) and no app chrome
 * or chat internals (they read stores a message does not have).
 *
 **/
export const HGL_COMPONENT_NAMES = [
  'Accordion',
  'AccordionContent',
  'AccordionItem',
  'AccordionTrigger',
  'ActivityHeatmap',
  'ActivityIndicator',
  'Alert',
  'AlertDescription',
  'AlertTitle',
  'Avatar',
  'AvatarFallback',
  'AvatarImage',
  'Badge',
  'Breadcrumb',
  'BreadcrumbEllipsis',
  'BreadcrumbItem',
  'BreadcrumbLink',
  'BreadcrumbList',
  'BreadcrumbPage',
  'BreadcrumbSeparator',
  'Button',
  'Card',
  'CardAction',
  'CardContent',
  'CardDescription',
  'CardFooter',
  'CardHeader',
  'CardTitle',
  'Checkbox',
  'CircularProgress',
  'Collapsible',
  'CollapsibleContent',
  'CollapsibleTrigger',
  'DefinitionList',
  'DefinitionRow',
  'DiffStat',
  'Divider',
  'EmptyState',
  'EntityAvatar',
  'HoshiLoader',
  'InfoBanner',
  'InlineMeta',
  'Input',
  'Kbd',
  'KbdGroup',
  'List',
  'ListRow',
  'Logo',
  'MachineCard',
  'MarkdownContent',
  'PixelComputer',
  'Progress',
  'ScrollArea',
  'ScrollBar',
  'ScrollRow',
  'Section',
  'SectionCard',
  'Separator',
  'Skeleton',
  'SparkBars',
  'StatPill',
  'StatusBadge',
  'StatusDot',
  'Steps',
  'Switch',
  'Table',
  'TableBody',
  'TableCaption',
  'TableCell',
  'TableFooter',
  'TableHead',
  'TableHeader',
  'TableRow',
  'Tabs',
  'TabsContent',
  'TabsList',
  'TabsTrigger',
  'Tag',
  'Textarea',
  'TodoChecklist',
] as const

export type HglComponentName = (typeof HGL_COMPONENT_NAMES)[number]

/**
 *
 * The components that take a `bind: "stateKey"` prop instead of a v-model.
 *
 * They are in the allowlist despite needing two-way state precisely because of
 * this: the surface owns the state, and the node names a key in it.
 *
 **/
export const HGL_BINDABLE_COMPONENTS = ['Input', 'Textarea', 'Checkbox', 'Switch'] as const

export type HglBindableComponent = (typeof HGL_BINDABLE_COMPONENTS)[number]

/** Node type → the props the client's normalizer requires. A node missing one
 *  of these is refused where it is emitted rather than rendered as a fallback,
 *  because a fallback teaches the model nothing. */
export const HGL_REQUIRED_PROPS: Record<string, readonly string[]> = {
  markdown: ['text'],
  heading: ['text'],
  code: ['code'],
  stack: [],
  row: [],
  grid: [],
  card: [],
  divider: [],
  actions: [],
  stat: ['label', 'value'],
  definitions: ['items'],
  progress: ['value'],
  badge: ['label'],
  button: ['label'],
  link: ['label', 'url'],
  image: ['src'],
  timeline: ['items'],
  gallery: ['images'],
  confirm: ['title'],
  form: ['title', 'fields'],
  choice: ['title', 'options'],
  chart: ['type', 'series'],
  table: ['columns', 'rows'],
  tasks: ['title', 'tasks'],
  component: ['component'],
}

export type HglNodeType = keyof typeof HGL_REQUIRED_PROPS

/** What an `actions` node's entries may DO. Anything else is refused: an action
 *  is a verb the client knows how to perform, not an escape hatch. */
export const HGL_ACTION_VERBS = ['submit', 'prompt', 'intent', 'link', 'copy', 'createSession'] as const

export type HglActionVerb = (typeof HGL_ACTION_VERBS)[number]
