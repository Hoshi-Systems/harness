import { describe, expect, it } from 'vitest'
import { foldRule, grantSuggestions, levelFromRules, matches, subjectOf } from './tool-patterns.js'

/**
 *
 * What a rule matches is the whole safety story of pattern permissions: a rule
 * that reads as "allow git push" and matches something else is worse than no
 * rule at all.
 *
 **/

describe('subjectOf', () => {
  it('scopes a shell rule by the command', () => {
    expect(subjectOf('bash', { command: 'git push origin main' })).toBe('git push origin main')
  })

  it('scopes a file rule by the path', () => {
    expect(subjectOf('write', { filePath: 'src/index.ts', content: 'x' })).toBe('src/index.ts')
  })

  it('has no subject for a tool nobody scopes by argument', () => {
    expect(subjectOf('ui_ask', { question: 'ok?' })).toBeNull()
  })
})

describe('matches', () => {
  it('spans separators, because "under src" is what src/* means to a person', () => {
    expect(matches('src/*', 'src/deep/nested/file.ts')).toBe(true)
  })

  it('anchors both ends, so a rule cannot match a longer command by accident', () => {
    expect(matches('git push', 'git push --force')).toBe(false)
    expect(matches('git push *', 'git push --force')).toBe(true)
  })

  it('treats regex characters in a pattern as literal text', () => {
    expect(matches('rm -rf .', 'rm -rf x')).toBe(false)
    expect(matches('rm -rf .', 'rm -rf .')).toBe(true)
  })
})

describe('levelFromRules', () => {
  const rules = [
    { pattern: '*', level: 'ask' as const },
    { pattern: 'git *', level: 'allow' as const },
    { pattern: 'git push *', level: 'deny' as const },
  ]

  it('lets the most specific rule win, not the first', () => {
    // The order rules land in is the order the cards happened to arrive; the
    // one a person would predict is "the rule about git push beats the blanket".
    expect(levelFromRules(rules, 'git push --force')).toBe('deny')
    expect(levelFromRules(rules, 'git status')).toBe('allow')
    expect(levelFromRules(rules, 'rm -rf /')).toBe('ask')
  })

  it('says nothing when no rule applies, so the tool level decides', () => {
    expect(levelFromRules([{ pattern: 'git *', level: 'allow' }], 'npm install')).toBeNull()
  })

  it('says nothing when the call has no subject to match', () => {
    expect(levelFromRules([{ pattern: '*', level: 'allow' }], null)).toBeNull()
  })
})

describe('foldRule', () => {
  it('drops rules the new one fully supersedes', () => {
    const folded = foldRule([{ pattern: 'git push origin', level: 'allow' }], 'git push *', 'allow')
    expect(folded).toEqual([{ pattern: 'git push *', level: 'allow' }])
  })

  it('keeps rules about something else', () => {
    const folded = foldRule([{ pattern: 'npm *', level: 'allow' }], 'git *', 'allow')
    expect(folded.map((rule) => rule.pattern).sort()).toEqual(['git *', 'npm *'])
  })

  it('replaces the same pattern rather than stacking a second copy', () => {
    const folded = foldRule([{ pattern: 'git *', level: 'allow' }], 'git *', 'deny')
    expect(folded).toEqual([{ pattern: 'git *', level: 'deny' }])
  })
})

describe('grantSuggestions', () => {
  it('offers the command family, not just the exact line', () => {
    // Granting only `echo hoshi-ok` brings the same card back on the next
    // command — which is how people learn to stop reading cards.
    expect(grantSuggestions('bash', { command: 'echo hoshi-ok' })).toEqual({
      exact: ['echo hoshi-ok'],
      prefix: ['echo *'],
    })
  })

  it('offers the directory for a file call', () => {
    expect(grantSuggestions('write', { filePath: 'src/app/main.ts' })).toEqual({
      exact: ['src/app/main.ts'],
      prefix: ['src/app/*'],
    })
  })

  it('offers nothing to scope by when the tool has no subject', () => {
    expect(grantSuggestions('ui_render', {})).toEqual({ exact: [], prefix: [] })
  })
})
