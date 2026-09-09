import { describe, expect, it } from 'vitest'
import { installCommand, verifyDependency } from './system.js'
import type { SystemDependency } from './define.js'

/**
 *
 * The split this file exists to protect: **verify is the contract, install is a
 * convenience.** A machine that got the software some other way — a base image,
 * an admin, a different package manager — must pass, and a recipe that ran
 * successfully must still not be believed until verify says so.
 *
 **/

const present: SystemDependency = { id: 'node', reason: 'it is running this', verify: 'node --version' }
const absent: SystemDependency = {
  id: 'definitely-not-installed',
  reason: 'nothing needs this',
  verify: 'hoshi-no-such-binary --version',
}

describe('verifying', () => {
  it('believes the machine, not the recipe', async () => {
    /**
     *
     * No `install` block at all, and it still passes: how the thing got here
     * is not the daemon's business.
     *
     **/
    expect(await verifyDependency(present)).toBe(true)
  })

  it('reports a missing dependency rather than throwing', async () => {
    /**
     *
     * A plugin whose dependency is absent must degrade, not crash the daemon.
     *
     **/
    expect(await verifyDependency(absent)).toBe(false)
  })

  it('runs the verify in a shell, so a builtin is a legal check', async () => {
    /**
     *
     * `command -v foo` is the portable way to ask whether a binary exists, and
     * `command` is a shell BUILTIN. This used to spawn the first word as a
     * program, which made the idiom depend on whether a host happens to ship a
     * `/usr/bin/command` shim — macOS does, Debian does not. The `desktop`
     * plugin wrote exactly that idiom, so it verified true on every developer's
     * Mac and false on every machine the image ships, and the machine served no
     * screen at all.
     *
     * `exit 0` is the fixture rather than `command -v`, precisely because no
     * platform ships an `exit` binary: this goes red on macOS and on Linux
     * alike the moment the shell goes away, instead of passing on the one
     * machine nobody deploys.
     *
     **/
    const builtin: SystemDependency = { id: 'a-builtin', reason: 'the shell is the contract', verify: 'exit 0' }
    expect(await verifyDependency(builtin)).toBe(true)
  })

  it('refuses a platform the plugin never claimed', async () => {
    /**
     *
     * Claiming a platform nobody has run it on is worse than saying so.
     *
     **/
    const elsewhere: SystemDependency = { ...present, platforms: [process.platform === 'linux' ? 'darwin' : 'linux'] }
    expect(await verifyDependency(elsewhere)).toBe(false)
  })
})

describe('the install recipe', () => {
  const chrome: SystemDependency = {
    id: 'chromium',
    reason: 'browser control needs a browser',
    verify: 'chromium --version',
    install: { apt: ['chromium', 'fonts-liberation'], brew: ['--cask chromium'] },
  }

  it('speaks each manager in its own words', () => {
    expect(installCommand(chrome, 'apt')).toEqual({
      command: 'apt-get',
      args: ['install', '-y', '--no-install-recommends', 'chromium', 'fonts-liberation'],
    })
    expect(installCommand(chrome, 'brew')).toEqual({ command: 'brew', args: ['install', '--cask chromium'] })
  })

  it('has nothing to say for a manager it was not written for', () => {
    /**
     *
     * Null, not a guess: inventing an apt package name from a brew cask would
     * install the wrong thing, confidently.
     *
     **/
    expect(installCommand({ ...chrome, install: { brew: ['--cask chromium'] } }, 'apt')).toBeNull()
  })

  it('has nothing to say when the plugin declared no recipe at all', () => {
    /**
     *
     * Perfectly legitimate: some dependencies are the image's job, and the
     * plugin's only claim is that it needs them.
     *
     **/
    expect(installCommand(present, 'apt')).toBeNull()
  })
})
