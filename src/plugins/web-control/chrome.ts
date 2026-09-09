import type { SystemDependency } from '../define.js'

/**
 * ── The browser this plugin drives ───────────────────────────────────────────
 *
 * The first declared system dependency, and the reason the mechanism exists:
 * browser control needs a real browser, and that is a fact about the MACHINE,
 * not about the code. Before this it lived in infra/machine/Dockerfile — a
 * different repo directory from the plugin that needs it, invisible from the
 * plugin's own source, and impossible to check at boot.
 *
 **/
export const chrome: SystemDependency = {
  id: 'chromium',
  reason: 'Browser control drives a real Chromium instance',

  /**
   *
   * The contract. Run at every boot, and the only thing the daemon trusts.
   *
   * It used to be `chromium --version`, which asks PATH about a binary this
   * plugin never launches. `tools.ts` resolves `playwright-core` out of
   * `HOSHI_BROWSER_MODULE_ROOT` and calls `chromium.launch()` with no
   * `executablePath`, so the browser it drives is PLAYWRIGHT's, under
   * `PLAYWRIGHT_BROWSERS_PATH` — `/opt/ms-playwright/chromium-<rev>/chrome-linux/chrome`
   * on the real image, and on no machine's PATH under the name `chromium`.
   *
   * So the check was not merely fragile, it was about a different program: the
   * image installs the browser this plugin uses and the plugin reported it
   * missing, on every machine, which is why the agent's browser was still
   * headless after the desktop it should have been visible on started working.
   *
   * This asks Playwright the same question the plugin does, then checks the
   * answer is really there and really executable. A machine that got Chromium
   * some other way still passes — provided it is the copy Playwright will
   * actually launch, which is the only copy that matters.
   *
   **/
  verify: `node -e 'const {createRequire} = require("module"); const pw = createRequire((process.env.HOSHI_BROWSER_MODULE_ROOT || "/app/browser") + "/noop.js")("playwright-core"); const fs = require("fs"); fs.accessSync(pw.chromium.executablePath(), fs.constants.X_OK)'`,

  /**
   *
   * No apt or brew recipe, and that is the honest answer rather than a missing
   * one. `apt install chromium` puts a browser on PATH that this plugin will
   * never launch, so the recipe would run, report success, and leave verify
   * failing for the same reason it was failing before — the installer's own
   * "installed, but the machine still cannot find it" branch, reached by
   * design every time.
   *
   * What this needs is `playwright-core install chromium` into the prefix
   * `HOSHI_BROWSER_MODULE_ROOT` points at, with the fonts headless Chromium
   * needs or every page renders in tofu. That is two coupled installs into
   * paths a package manager does not own, and infra/machine/Dockerfile is
   * where it lives.
   *
   **/

  /**
   *
   * Nothing here is impossible elsewhere, but nobody has verified it, and a
   * plugin that claims a platform it has not been run on is worse than one
   * that says so.
   *
   **/
  platforms: ['linux', 'darwin'],
}
