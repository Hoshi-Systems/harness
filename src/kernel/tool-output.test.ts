import { describe, expect, it } from 'vitest'
import { describeToolOutput, MAX_TOOL_OUTPUT } from './tool-output.js'

describe('describeToolOutput', () => {
  it('renders a shell result as its own output, not as JSON', () => {
    const text = describeToolOutput({ stdout: 'hoshi-ok\n', stderr: '', exitCode: 0 })
    expect(text).toBe('hoshi-ok')
  })

  it('keeps stderr, and says so when the command failed', () => {
    const text = describeToolOutput({ stdout: '', stderr: 'no such file', exitCode: 2 })
    expect(text).toBe('no such file\nexit code 2')
  })

  it('reports a silent failure — an empty body would read as success', () => {
    expect(describeToolOutput({ stdout: '', stderr: '', exitCode: 1 })).toBe('exit code 1')
  })

  it('has no body for a command that succeeded silently', () => {
    expect(describeToolOutput({ stdout: '', stderr: '', exitCode: 0 })).toBeUndefined()
  })

  it('numbers a file read from the line the read actually started at', () => {
    const text = describeToolOutput({ filePath: 'a.ts', content: 'const a = 1\nconst b = 2', fromLine: 40 })
    expect(text).toBe('40: const a = 1\n41: const b = 2')
  })

  it('lists a directory with its folders marked', () => {
    const text = describeToolOutput({
      dirPath: '.',
      count: 2,
      entries: [
        { name: 'src', type: 'directory' },
        { name: 'index.ts', type: 'file' },
      ],
    })
    expect(text).toBe('src/\nindex.ts')
  })

  it('prints search hits the way grep does', () => {
    const text = describeToolOutput({ matches: [{ file: 'a.ts', line: 3, content: 'const a = 1' }] })
    expect(text).toBe('a.ts:3: const a = 1')
  })

  it('says a search found nothing rather than showing an empty box', () => {
    expect(describeToolOutput({ pattern: 'zzz', matchCount: 0, matches: [] })).toBe('no matches')
  })

  it('pretty-prints any other structured result', () => {
    expect(describeToolOutput({ filePath: 'demo.txt', bytesWritten: 15 })).toBe(
      '{\n  "filePath": "demo.txt",\n  "bytesWritten": 15\n}',
    )
  })

  it('caps a large result so a read cannot paste a file into the history twice', () => {
    const text = describeToolOutput('x'.repeat(MAX_TOOL_OUTPUT + 500))
    expect(text!.length).toBeLessThan(MAX_TOOL_OUTPUT + 100)
    expect(text).toContain('truncated, 500 more characters')
  })

  it('has nothing to show for nothing', () => {
    expect(describeToolOutput(undefined)).toBeUndefined()
    expect(describeToolOutput(null)).toBeUndefined()
    expect(describeToolOutput('   ')).toBeUndefined()
  })

  it('survives a result that cannot be serialized', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(describeToolOutput(cyclic)).toBe('[result could not be serialized]')
  })
})
