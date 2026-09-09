import { describe, expect, it } from 'vitest'
import { CronExpressionParser } from 'cron-parser'
import { resolveCadence } from './triggers.js'

/** What the sidecar computes for a schedule's next run, mirroring
 *  `nextCronRun` — which is private, so the behaviour is pinned through the
 *  parser contract it depends on. */
function nextRun(expression: string, timezone: string | null): Date {
  return CronExpressionParser.parse(expression, timezone ? { tz: timezone } : undefined)
    .next()
    .toDate()
}

/** The wall-clock hour `instant` lands on, read in `timezone`. */
function hourIn(instant: Date, timezone: string): number {
  return Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', hour12: false }).format(instant),
  )
}

describe('a cron schedule fires on the user’s clock, not the machine’s', () => {
  /**
   *
   * The bug: the picker collects "09:00" and emits `0 9 * * 1-5`, but the
   * machine is a container running UTC. Parsed without a zone, "every weekday
   * at 9am" fired at 09:00 UTC — noon for a Kyiv user.
   *
   **/
  const EVERY_WEEKDAY_AT_9 = '0 9 * * 1-5'

  for (const timezone of ['Europe/Kyiv', 'America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
    it(`lands on 09:00 in ${timezone}`, () => {
      expect(hourIn(nextRun(EVERY_WEEKDAY_AT_9, timezone), timezone)).toBe(9)
    })
  }

  it('puts the same expression at different instants per zone', () => {
    const kyiv = nextRun(EVERY_WEEKDAY_AT_9, 'Europe/Kyiv')
    const la = nextRun(EVERY_WEEKDAY_AT_9, 'America/Los_Angeles')
    expect(kyiv.getTime()).not.toBe(la.getTime())
  })

  it('keeps the wall clock fixed across a DST shift', () => {
    /**
     *
     * Europe/Kyiv moves on the last Sunday of March. A stored UTC offset would
     * drift an hour here; a stored ZONE does not.
     *
     **/
    const zone = 'Europe/Kyiv'
    const before = CronExpressionParser.parse('0 9 * * *', { tz: zone, currentDate: new Date('2026-03-01T00:00:00Z') })
      .next()
      .toDate()
    const after = CronExpressionParser.parse('0 9 * * *', { tz: zone, currentDate: new Date('2026-05-01T00:00:00Z') })
      .next()
      .toDate()

    expect(hourIn(before, zone)).toBe(9)
    expect(hourIn(after, zone)).toBe(9)
    /**
     *
     * ...and the two really do sit either side of the shift, so this is not
     * vacuously true: their UTC hours differ.
     *
     **/
    expect(before.getUTCHours()).not.toBe(after.getUTCHours())
  })
})

describe('resolveCadence', () => {
  it('keeps a valid zone alongside a cron', () => {
    expect(resolveCadence(undefined, '0 9 * * *', 'Europe/Kyiv')).toEqual({
      intervalMinutes: null,
      cronExpression: '0 9 * * *',
      timezone: 'Europe/Kyiv',
    })
  })

  it('treats an absent zone as machine-local, so old clients still work', () => {
    expect(resolveCadence(undefined, '0 9 * * *').timezone).toBeNull()
    expect(resolveCadence(undefined, '0 9 * * *', '  ').timezone).toBeNull()
  })

  it('rejects a zone the runtime does not know', () => {
    expect(() => resolveCadence(undefined, '0 9 * * *', 'Mars/Olympus_Mons')).toThrow()
    expect(() => resolveCadence(undefined, '0 9 * * *', 'not a zone')).toThrow()
  })

  it('carries no zone in interval mode — there is no wall clock to anchor', () => {
    expect(resolveCadence(30, undefined, 'Europe/Kyiv')).toEqual({
      intervalMinutes: 30,
      cronExpression: null,
      timezone: null,
    })
  })

  it('still enforces exactly one cadence mode', () => {
    expect(() => resolveCadence(30, '0 9 * * *')).toThrow()
    expect(() => resolveCadence(undefined, undefined)).toThrow()
  })
})
