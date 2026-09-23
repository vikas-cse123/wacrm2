import { describe, expect, it } from 'vitest'
import {
  NO_AD_COLOR,
  NO_AD_KEY,
  OTHERS_COLOR,
  OTHERS_KEY,
} from './flow-colors'
import {
  adBucketColors,
  adChartState,
  normalizeContactsByAd,
  shortAdUrl,
  toSafeAdUrl,
} from './contacts-by-ad'

function row(adKey: string, adLabel: string, contacts: number, pct: number) {
  return { adKey, adLabel, contacts, pct }
}

describe('normalizeContactsByAd', () => {
  it('keeps valid rows sorted contacts-desc with No Ad last', () => {
    const { totalContacts, rows } = normalizeContactsByAd({
      totalContacts: 52,
      rows: [
        row('__no_ad__', 'No Ad', 20, 38.5),
        row('https://fb.me/aaa', 'https://fb.me/aaa', 26, 50),
        row('https://fb.me/bbb', 'https://fb.me/bbb', 6, 11.5),
      ],
    })
    expect(totalContacts).toBe(52)
    expect(rows.map((r) => r.adKey)).toEqual([
      'https://fb.me/aaa',
      'https://fb.me/bbb',
      '__no_ad__',
    ])
    // Bucket counts sum to the total: no double counting.
    expect(rows.reduce((s, r) => s + r.contacts, 0)).toBe(52)
    // Percentages sum to 100.
    const pctSum = rows.reduce((s, r) => s + r.pct, 0)
    expect(pctSum).toBeCloseTo(100, 5)
  })

  it('drops malformed rows and defaults a missing payload', () => {
    const { totalContacts, rows } = normalizeContactsByAd({
      totalContacts: 5,
      rows: [
        row('https://fb.me/aaa', 'https://fb.me/aaa', 5, 100),
        { adKey: '', adLabel: 'x', contacts: 3, pct: 10 },
        { adKey: 'u', adLabel: 'U', contacts: -1, pct: 0 },
        { adKey: 'u2', adLabel: 'U2', contacts: 2 },
        null,
      ],
    })
    expect(totalContacts).toBe(5)
    expect(rows).toHaveLength(1)
    expect(normalizeContactsByAd(null)).toEqual({ totalContacts: 0, rows: [] })
    expect(normalizeContactsByAd({})).toEqual({ totalContacts: 0, rows: [] })
  })
})

describe('shortAdUrl', () => {
  it('renders the human-readable portion of stored URLs', () => {
    expect(shortAdUrl('https://fb.me/50EJ17fxE')).toBe('fb.me/50EJ17fxE')
    expect(shortAdUrl('https://www.example.com/landing/')).toBe('example.com/landing')
    expect(shortAdUrl('http://ads.example.com/bali?utm=x')).toBe('ads.example.com/bali?utm=x')
  })

  it('middle-truncates long URLs without breaking layout', () => {
    const long = `https://example.com/${'a'.repeat(60)}/bali-packages`
    const short = shortAdUrl(long)
    expect(short.length).toBeLessThan(long.length)
    expect(short).toContain('…')
    expect(short.endsWith('packages')).toBe(true)
  })
})

describe('adChartState', () => {
  const adRow = row('https://fb.me/a', 'https://fb.me/a', 3, 60)
  const noAdRow = row(NO_AD_KEY, 'No Ad', 2, 40)

  it('is empty when nothing was messaged', () => {
    expect(adChartState(0, [])).toBe('empty')
    expect(adChartState(5, [])).toBe('empty')
  })

  it('is no-ads when contacts exist but none are ad-sourced', () => {
    expect(adChartState(2, [noAdRow])).toBe('no-ads')
  })

  it('is ready for mixed and ad-only sets', () => {
    expect(adChartState(5, [adRow, noAdRow])).toBe('ready')
    expect(adChartState(3, [adRow])).toBe('ready')
  })
})

describe('adBucketColors', () => {
  const rows = [
    row('https://fb.me/a', 'a', 10, 50),
    row('https://fb.me/b', 'b', 6, 30),
    row(OTHERS_KEY, 'Other', 2, 10),
    row(NO_AD_KEY, 'No Ad', 2, 10),
  ]

  it('gives every visible bucket a unique color', () => {
    const colors = adBucketColors(rows)
    const values = [...colors.values()]
    expect(new Set(values).size).toBe(values.length)
  })

  it('is stable across ranges for the same URL set', () => {
    const subset = adBucketColors(rows.slice(0, 2))
    const full = adBucketColors(rows)
    expect(full.get('https://fb.me/a')).toBe(subset.get('https://fb.me/a'))
    expect(full.get('https://fb.me/b')).toBe(subset.get('https://fb.me/b'))
  })

  it('reserves neutral gray for No Ad and slate for Other', () => {
    const colors = adBucketColors(rows)
    expect(colors.get(NO_AD_KEY)).toBe(NO_AD_COLOR)
    expect(colors.get(OTHERS_KEY)).toBe(OTHERS_COLOR)
    expect(colors.get('https://fb.me/a')).not.toBe(NO_AD_COLOR)
  })
})

describe('toSafeAdUrl', () => {
  it('uses full https URLs verbatim', () => {
    expect(toSafeAdUrl('https://fb.me/50EJ17fxE')).toBe('https://fb.me/50EJ17fxE')
    expect(toSafeAdUrl('http://example.com/a?b=c')).toBe('http://example.com/a?b=c')
    expect(toSafeAdUrl('  https://example.com/  ')).toBe('https://example.com/')
  })

  it('upgrades protocol-less ad URLs to https', () => {
    expect(toSafeAdUrl('fb.me/50EJ17fxE')).toBe('https://fb.me/50EJ17fxE')
    expect(toSafeAdUrl('fb.me/874neIpU9')).toBe('https://fb.me/874neIpU9')
    expect(toSafeAdUrl('instagram.com/p/DdN9fIuxAW1V')).toBe(
      'https://instagram.com/p/DdN9fIuxAW1V',
    )
    expect(toSafeAdUrl('instagram.com/p/DcnuXje9Veg')).toBe(
      'https://instagram.com/p/DcnuXje9Veg',
    )
  })

  it('rejects reserved buckets, blanks, and bare words', () => {
    expect(toSafeAdUrl('No Ad')).toBeNull()
    expect(toSafeAdUrl('Other')).toBeNull()
    expect(toSafeAdUrl('')).toBeNull()
    expect(toSafeAdUrl('   ')).toBeNull()
    expect(toSafeAdUrl('notaurl')).toBeNull()
    expect(toSafeAdUrl('campaign-x')).toBeNull()
  })

  it('rejects unsafe schemes', () => {
    expect(toSafeAdUrl('javascript:alert(1)')).toBeNull()
    expect(toSafeAdUrl('JaVaScRiPt://evil.com')).toBeNull()
    expect(toSafeAdUrl('data:text/html,<h1>x</h1>')).toBeNull()
    expect(toSafeAdUrl('ftp://example.com/f')).toBeNull()
    expect(toSafeAdUrl('https://example.com/"onmouseover="x')).toBeNull()
  })
})
