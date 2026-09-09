import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { RouteTable } from '../../http/router.js'
import { configureKernel } from '../../kernel/host-ports.js'
import { definePlugin, type Plugin } from '../define.js'
import { pluginStatuses, pluginToolNames, pluginTools, startPlugins, stopPlugins } from '../registry.js'
import webControl from './index.js'
import { chrome } from './chrome.js'
import { browserTools } from './tools.js'

/**
 * ── A missing dependency must WITHHOLD its tools, not merely be reported ─────
 *
 * The rule the plugin system states — "a degraded plugin contributes no tools"
 * — was true of the mechanism and false of this machine, because all 37 of
 * Hoshi's tools were contributed by ONE plugin. So `machine.state` could say
 * `web-control: degraded — chromium is not installed` while the same turn
 * offered the model all eight `browser_*` tools, every one certain to fail
 * (docs/STRUCTURE_REVIEW.md H-08). An agent told "unavailable" tries three more
 * times and then apologises, which is worse than never having seen the tool.
 *
 * It takes THREE facts to hold, and the census can only see the last one:
 *   1. `web-control` declares the browser as a system dependency;
 *   2. the browser tools are contributed BY that plugin;
 *   3. the registry skips a degraded plugin's setup entirely.
 * Any one of them silently undoes the other two — moving the tools to a plugin
 * that declares nothing is exactly what the defect WAS — so each is pinned here.
 *
 **/

const CONTEXT = { sessionId: 'ses_1', directory: '/w/acme/api', agent: 'personal' }

beforeEach(async () => {
  await stopPlugins()
  configureKernel({})
})

afterEach(async () => {
  await stopPlugins()
})

describe('what web-control declares', () => {
  it('verifies the browser Playwright will actually launch, not one on PATH', () => {
    /**
     *
     * This used to assert `--version`, which passed for `chromium --version` —
     * a PATH lookup for a binary this plugin never launches. `tools.ts`
     * resolves `playwright-core` out of `HOSHI_BROWSER_MODULE_ROOT` and calls
     * `chromium.launch()` with no `executablePath`, so the browser it drives is
     * Playwright's, under `PLAYWRIGHT_BROWSERS_PATH`, and on no machine's PATH
     * under the name `chromium`. The image installed that browser and the
     * plugin reported it missing, on every machine.
     *
     * So the property is not "it runs something" but "it asks the same
     * question the plugin does": through the same module root, for the same
     * executable.
     *
     **/
    expect(chrome.id).toBe('chromium')
    expect(chrome.verify).toContain('playwright-core')
    expect(chrome.verify).toContain('HOSHI_BROWSER_MODULE_ROOT')
    expect(chrome.verify).toContain('executablePath')
    expect(webControl.system).toContainEqual(chrome)
  })

  it('owns the browser tools itself, rather than letting another plugin contribute them', () => {
    /**
     *
     * The half that cannot be checked from the outside: a machine WITH a
     * browser looks identical either way. Placement is the whole fix.
     *
     **/
    expect(Object.keys(browserTools).sort()).toEqual([
      'browser_click',
      'browser_find',
      'browser_form_input',
      'browser_get_page_text',
      'browser_navigate',
      'browser_read_page',
      'browser_screenshot',
      'browser_type',
    ])
  })
})

describe('a plugin whose dependency is absent', () => {
  /** The same shape as web-control, with a dependency that cannot be satisfied. */
  const withMissingDependency = definePlugin({
    name: 'needs-a-browser',
    description: 'stands in for web-control on a machine without one',
    system: [
      {
        id: 'nope',
        reason: 'it drives something this machine does not have',
        verify: 'hoshi-no-such-browser --version',
      },
    ],
    setup(host) {
      host.tools.add(
        () => ({ browser_navigate: {} as never }),
        () => ['browser_navigate'],
      )
    },
  })

  it('reports itself degraded, with a reason a person can read', async () => {
    await startPlugins([withMissingDependency], new RouteTable())
    expect(pluginStatuses()).toEqual([
      expect.objectContaining({
        name: 'needs-a-browser',
        state: 'degraded',
        reason: expect.stringContaining('this machine does not have'),
      }),
    ])
  })

  it('offers the model none of its tools — not by name and not in the set', async () => {
    await startPlugins([withMissingDependency], new RouteTable())
    expect(pluginToolNames()).toEqual([])
    expect(Object.keys(await pluginTools(CONTEXT))).toEqual([])
  })

  it('still contributes nothing when its setup throws halfway through registering', async () => {
    /**
     *
     * Half a plugin is not a working one: whatever it managed to add before
     * throwing is discarded, or a partially-registered tool set is offered as
     * though the plugin had started.
     *
     **/
    const halfStarted = definePlugin({
      name: 'throws-midway',
      description: 'registers a tool and then fails',
      setup(host) {
        host.tools.add(
          () => ({ browser_navigate: {} as never }),
          () => ['browser_navigate'],
        )
        throw new Error('the browser would not launch')
      },
    })

    await startPlugins([halfStarted], new RouteTable())
    expect(pluginStatuses()[0]).toMatchObject({ state: 'degraded', reason: 'the browser would not launch' })
    expect(pluginToolNames()).toEqual([])
  })
})

describe('the same plugin with its dependency present', () => {
  it('contributes every tool it declared', async () => {
    const satisfied = definePlugin({
      name: 'has-a-browser',
      description: 'stands in for web-control on a machine with one',
      system: [{ id: 'node', reason: 'it is running this', verify: 'node --version' }],
      setup(host) {
        host.tools.add(
          () => ({ browser_navigate: {} as never }),
          () => ['browser_navigate'],
        )
      },
    })

    await startPlugins([satisfied], new RouteTable())
    expect(pluginStatuses()[0]).toMatchObject({ state: 'ready', reason: null })
    expect(pluginToolNames()).toEqual(['browser_navigate'])
  })
})
