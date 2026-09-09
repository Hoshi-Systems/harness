import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { loadPluginModules, pluginSpecifiers } from './load.js'

/**
 *
 * The daemon loads plugins it did not ship, and the one thing that can go
 * quietly wrong is the one thing this suite is for: a plugin defined by a
 * second copy of the harness registers with a kernel nothing serves, and
 * reports ready. Everything else here is the shape of the seam — a path, a
 * bare name resolved from a directory, a module that is not a list.
 *
 **/

const scratch = mkdtempSync(path.join(tmpdir(), 'harness-load-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const definePluginModule = path.resolve(import.meta.dirname, '../plugins/define.ts')

function fixture(name: string, source: string): string {
  const file = path.join(scratch, name)
  writeFileSync(file, source)
  return file
}

describe('loading a plugin package', () => {
  it('loads a list of plugins this harness defined, by path', async () => {
    const file = fixture(
      'own.mjs',
      `import { definePlugin } from ${JSON.stringify(definePluginModule)}
       export default [definePlugin({ name: 'fixture', description: 'A plugin from outside', setup() {} })]`,
    )
    const [loaded] = await loadPluginModules([file])
    expect(loaded.plugins.map((plugin) => plugin.name)).toEqual(['fixture'])
  })

  it('takes a plain relative path that names a file as that file, not as a package', async () => {
    fixture('plain.mjs', 'export default []')
    const [loaded] = await loadPluginModules(['plain.mjs'], scratch)
    expect(loaded.plugins).toEqual([])
  })

  it('resolves a bare name from the directory it is asked to, not from the harness', async () => {
    const packageDir = path.join(scratch, 'node_modules', 'some-plugins')
    mkdirSync(packageDir, { recursive: true })
    writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({ name: 'some-plugins', main: 'index.mjs' }))
    writeFileSync(path.join(packageDir, 'index.mjs'), 'export const plugins = []')
    const [loaded] = await loadPluginModules(['some-plugins'], scratch)
    expect(loaded.specifier).toBe('some-plugins')
    expect(loaded.plugins).toEqual([])
  })

  it('refuses a module that is not a plugin list', async () => {
    const file = fixture('not-a-list.mjs', 'export default { name: "lonely" }')
    await expect(loadPluginModules([file])).rejects.toThrow(/does not export a plugin list/)
  })

  it('refuses a plugin defined by a different copy of the harness, and says so', async () => {
    /**
     *
     * The shape is right and the brand is missing — exactly what a plugin
     * built against a second install of this package looks like from here.
     *
     **/
    const file = fixture(
      'foreign.mjs',
      `export default [{ name: 'foreign', description: '', configure: () => undefined, setup() {} }]`,
    )
    await expect(loadPluginModules([file])).rejects.toThrow(/"foreign".*different copy of @hoshi\/harness/)
  })
})

describe('the list a flag or a variable carries', () => {
  it('splits on commas and ignores blanks', () => {
    expect(pluginSpecifiers(' ./a.js, @scope/b ,,')).toEqual(['./a.js', '@scope/b'])
    expect(pluginSpecifiers(undefined)).toEqual([])
  })
})
