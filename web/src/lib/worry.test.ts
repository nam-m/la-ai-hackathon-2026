import { describe, expect, it } from 'vitest'
import { barHeight, trendOf, worryColor } from './worry'

describe('trendOf', () => {
  it('reads rising worry as getting more worried', () => {
    expect(trendOf([0.1, 0.3, 0.5, 0.8], true)?.word).toBe('Getting more worried')
  })
  it('reads falling worry as calmer', () => {
    expect(trendOf([0.7, 0.2], true)?.word).toBe('Calmer now')
  })
  it('calls small changes steady', () => {
    expect(trendOf([0.3, 0.35, 0.4], true)?.word).toBe('Steady')
  })
  it('skips asks without a reading', () => {
    expect(trendOf([null, 0.1, null, 0.6], true)?.word).toBe('Getting more worried')
  })
  it('says nothing with fewer than two readings or with tone off', () => {
    expect(trendOf([null, 0.9, null], true)).toBeNull()
    expect(trendOf([0.1, 0.9], false)).toBeNull()
  })
})

describe('bars', () => {
  it('stay within 10-40px and clamp bad values', () => {
    expect(barHeight(0)).toBe(10)
    expect(barHeight(1)).toBe(40)
    expect(barHeight(7)).toBe(40)
    expect(barHeight(-1)).toBe(10)
  })
  it('run from light to deep amber', () => {
    expect(worryColor(0)).toBe('rgb(246, 217, 164)')
    expect(worryColor(1)).toBe('rgb(227, 166, 74)')
  })
})
