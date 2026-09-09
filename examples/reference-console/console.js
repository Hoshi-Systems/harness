const form = document.querySelector('#connection-form')
const machineUrl = document.querySelector('#machine-url')
const token = document.querySelector('#token')
const inspect = document.querySelector('#inspect')
const message = document.querySelector('#message')
const emptyState = document.querySelector('#empty-state')
const passport = document.querySelector('#passport')
const capabilityList = document.querySelector('#capabilities')

function text(value) {
  return typeof value === 'string' ? value : ''
}

function array(value) {
  return Array.isArray(value) ? value : []
}

function element(tag, className, content) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (content !== undefined) node.textContent = content
  return node
}

function normalizedOrigin(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Enter an http or https machine URL.')
  return url.origin
}

function readPassport(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.capabilities)) {
    throw new Error('The machine returned a response that is not a Capability Passport.')
  }
  return { schemaVersion: value.schemaVersion, capabilities: value.capabilities }
}

function setMessage(content, tone = '') {
  message.textContent = content
  message.className = `message ${tone}`.trim()
}

function fact(label, values) {
  const item = element('div', 'fact')
  item.append(element('dt', '', label))
  const list = element('dd')
  if (values.length === 0) list.append(element('span', 'quiet', 'None'))
  else {
    const chips = element('div', 'chips')
    for (const value of values) chips.append(element('span', 'chip', value))
    list.append(chips)
  }
  item.append(list)
  return item
}

function detailList(capability) {
  const requirements = capability.requires && typeof capability.requires === 'object' ? capability.requires : {}
  const surfaces = capability.surfaces && typeof capability.surfaces === 'object' ? capability.surfaces : {}
  const system = array(requirements.system).map((dependency) => {
    const id = text(dependency?.id)
    const reason = text(dependency?.reason)
    return reason ? `${id} — ${reason}` : id
  })
  const ports = array(requirements.ports).map(text).filter(Boolean)
  const tools = array(surfaces.tools).map(text).filter(Boolean)
  const routes = array(surfaces.routes)
    .map((route) => `${text(route?.method).toUpperCase()} ${text(route?.path)}`.trim())
    .filter(Boolean)

  const details = element('dl', 'details')
  details.append(fact('System requirements', system), fact('Kernel ports', ports), fact('Tools', tools), fact('Routes', routes))
  return details
}

function renderCapability(capability) {
  const owner = capability.owner && typeof capability.owner === 'object' ? capability.owner : {}
  const state = capability.state === 'degraded' ? 'degraded' : 'ready'
  const article = element('article', `capability ${state}`)
  const heading = element('div', 'capability-heading')
  const identity = element('div')
  identity.append(element('p', 'capability-id', text(capability.id) || 'Unnamed capability'))
  identity.append(element('h3', '', text(capability.title) || 'Untitled capability'))
  heading.append(identity)
  heading.append(element('span', `state ${state}`, state === 'ready' ? 'Ready' : 'Needs attention'))
  article.append(heading)
  article.append(element('p', 'description', text(capability.description) || 'No description supplied.'))

  const ownerLine = element('p', 'owner', `Owned by ${text(owner.kind) || 'plugin'}: ${text(owner.name) || 'unknown'}`)
  article.append(ownerLine)
  if (state === 'degraded') article.append(element('p', 'reason', text(capability.reason) || 'The owner did not provide a reason.'))
  article.append(detailList(capability))
  return article
}

function render(data, origin) {
  const capabilities = data.capabilities
  const ready = capabilities.filter((capability) => capability.state !== 'degraded').length
  const owners = new Set(capabilities.map((capability) => text(capability.owner?.name)).filter(Boolean)).size
  document.querySelector('#schema-version').textContent = String(data.schemaVersion ?? 'unknown')
  document.querySelector('#machine-origin').textContent = origin
  document.querySelector('#total-capabilities').textContent = String(capabilities.length)
  document.querySelector('#total-ready').textContent = String(ready)
  document.querySelector('#total-degraded').textContent = String(capabilities.length - ready)
  document.querySelector('#total-owners').textContent = String(owners)
  capabilityList.replaceChildren(...capabilities.map(renderCapability))
  emptyState.hidden = true
  passport.hidden = false
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  let origin
  try {
    origin = normalizedOrigin(machineUrl.value.trim())
  } catch (error) {
    setMessage(error.message, 'error')
    machineUrl.focus()
    return
  }
  if (!token.value.trim()) {
    setMessage('Enter an owner bearer token to inspect this machine.', 'error')
    token.focus()
    return
  }

  inspect.disabled = true
  setMessage('Reading the live Capability Passport…')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 10_000)
  try {
    const response = await fetch(`${origin}/capabilities`, {
      headers: { Authorization: `Bearer ${token.value.trim()}` },
      credentials: 'omit',
      signal: controller.signal,
    })
    if (response.status === 401) throw new Error('This machine did not accept that owner bearer token.')
    if (!response.ok) throw new Error(`The machine answered ${response.status}.`)
    render(readPassport(await response.json()), origin)
    setMessage('Passport updated.', 'success')
  } catch (error) {
    const reason = error.name === 'AbortError' ? 'The machine did not answer within ten seconds.' : error.message
    setMessage(`${reason} For a production daemon, add this console origin to CORS_ORIGINS.`, 'error')
  } finally {
    window.clearTimeout(timeout)
    token.value = ''
    inspect.disabled = false
  }
})
