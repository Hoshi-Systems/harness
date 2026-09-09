import { describe, expect, it } from 'vitest'
import { quoteEnvValue, unquoteEnvValue, upsertEnv } from './dotenv.js'

describe('quote/unquote round-trip', () => {
  const values = [
    'plain',
    '',
    "has'quote",
    "'",
    "already'\\''escaped",
    'a=b',
    '#not-a-comment',
    '  padded  ',
    'multi\nline',
  ]

  for (const value of values) {
    it(`survives ${JSON.stringify(value)}`, () => {
      expect(unquoteEnvValue(quoteEnvValue(value))).toBe(value)
    })
  }
})

describe('upsertEnv', () => {
  it('replaces a key in place and appends the ones that are new', () => {
    const before = '# comment\nKEEP=mine\nAPI_KEY=old\n'
    expect(
      upsertEnv(
        before,
        new Map([
          ['API_KEY', 'new'],
          ['EXTRA', 'added'],
        ]),
      ),
    ).toBe("# comment\nKEEP=mine\nAPI_KEY='new'\nEXTRA='added'\n")
  })

  it('preserves comments, blanks and foreign keys verbatim', () => {
    const before = '# header\n\nOTHER=untouched\n'
    expect(upsertEnv(before, new Map([['NEW', 'v']]))).toBe("# header\n\nOTHER=untouched\nNEW='v'\n")
  })

  it('writes nothing for an empty result', () => {
    expect(upsertEnv('', new Map())).toBe('')
  })

  it("ends with exactly one newline, and keeps the author's interior blanks", () => {
    /**
     *
     * Two blank lines in, two blank lines out — only the newline-terminator's
     * own empty element is dropped, never the author's spacing.
     *
     **/
    expect(upsertEnv('A=1\n\n\n', new Map([['B', '2']]))).toBe("A=1\n\n\nB='2'\n")
  })

  it('does not treat `export KEY=` as owning KEY', () => {
    /**
     *
     * It is a different assignment form than the one we write, so it is foreign
     * content: left verbatim, and our own key appended separately.
     *
     **/
    expect(upsertEnv('export A=1\n', new Map([['A', 'x']]))).toBe("export A=1\nA='x'\n")
  })

  /**
   *
   * The file being merged into came out of a git clone, so it may hold a
   * multi-line quoted value — a PEM key is the everyday case. Every assertion
   * below fails against the line-at-a-time version this replaced.
   *
   **/
  describe('multi-line values in the file it merges into', () => {
    const pem = "CERT='-----BEGIN-----\nline1\nline2\n-----END-----'"

    it('leaves a multi-line value alone when updating a different key', () => {
      const before = `${pem}\nAPI_KEY=old\n`
      expect(upsertEnv(before, new Map([['API_KEY', 'new']]))).toBe(`${pem}\nAPI_KEY='new'\n`)
    })

    it('replaces the whole assignment, orphaning no continuation lines', () => {
      const before = `${pem}\nOTHER=keep\n`
      const after = upsertEnv(before, new Map([['CERT', 'replaced']]))

      expect(after).toBe("CERT='replaced'\nOTHER=keep\n")
      expect(after).not.toContain('line1')
      expect(after).not.toContain('-----END-----')
    })

    it("never rewrites a KEY= line sitting inside somebody else's value", () => {
      /**
       *
       * The sharp case: pulling a vault key whose name also appears inside a
       * certificate. This used to rewrite the middle of the cert and never add
       * the secret at all — the user lost the cert AND didn't get the key.
       *
       **/
      const before = "CERT='-----BEGIN-----\nAPI_KEY=inside-the-cert\n-----END-----'\nOTHER=keep\n"
      const after = upsertEnv(before, new Map([['API_KEY', 'from-vault']]))

      expect(after).toContain('API_KEY=inside-the-cert') // the cert is untouched
      expect(after).toContain("API_KEY='from-vault'") // and the secret really landed
      expect(after).toBe(`${before.trimEnd()}\nAPI_KEY='from-vault'\n`)
    })

    it('handles a value whose escaped quotes make the apostrophe count odd', () => {
      /**
       *
       * `'a'\''b'` is balanced but holds five apostrophes, so parity counting
       * would call it open and swallow the following line.
       *
       **/
      const before = "TRICKY='a'\\''b'\nAFTER=here\n"
      expect(upsertEnv(before, new Map([['AFTER', 'updated']]))).toBe("TRICKY='a'\\''b'\nAFTER='updated'\n")
    })

    it('protects a DOUBLE-quoted multi-line value too', () => {
      /**
       *
       * We only ever write single quotes, but the file we merge into is a
       * stranger's and doubles are just as common in a checked-in .env.
       *
       **/
      const before = 'CERT="-----BEGIN-----\nAPI_KEY=inside\n-----END-----"\nOTHER=keep\n'
      const after = upsertEnv(before, new Map([['API_KEY', 'from-vault']]))

      expect(after).toContain('API_KEY=inside')
      expect(after).toBe(`${before.trimEnd()}\nAPI_KEY='from-vault'\n`)
    })

    it('treats a backslash correctly per quote style', () => {
      /**
       *
       * A backslash is literal inside single quotes but escapes inside doubles,
       * so `"a\""` is still open while `'a\'` is already closed.
       *
       **/
      const stillOpen = 'A="a\\"\nB=x\n'
      expect(upsertEnv(stillOpen, new Map([['B', 'y']]))).toBe(`${stillOpen.trimEnd()}\nB='y'\n`)

      const closed = "A='a\\'\nB=x\n"
      expect(upsertEnv(closed, new Map([['B', 'y']]))).toBe("A='a\\'\nB='y'\n")
    })

    it('does not run away on an unterminated quote', () => {
      const before = "BROKEN='never closed\nORPHAN=x\n"
      expect(() => upsertEnv(before, new Map([['NEW', 'v']]))).not.toThrow()
      expect(upsertEnv(before, new Map([['NEW', 'v']]))).toContain("NEW='v'")
    })
  })
})
