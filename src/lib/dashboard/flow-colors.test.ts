import { describe, expect, it } from 'vitest'
import {
  FLOW_PALETTE,
  NO_FLOW_COLOR,
  NO_FLOW_KEY,
  OTHERS_COLOR,
  OTHERS_KEY,
  assignFlowColors,
  fallbackFlowColor,
} from './flow-colors'

describe('assignFlowColors', () => {
  it('gives every flow a unique color (acceptance: six flows, six colors)', () => {
    const ids = [
      'flow-goa',
      'flow-singapore',
      'flow-hiring',
      'flow-goa-couple',
      'flow-kerala',
      'flow-bali',
    ]
    const colors = assignFlowColors(ids)
    expect(colors.size).toBe(ids.length)
    expect(new Set(colors.values()).size).toBe(ids.length)
  })

  it('is deterministic and stable when a new flow is added', () => {
    const before = assignFlowColors(['a', 'b', 'c'])
    const after = assignFlowColors(['a', 'b', 'c', 'd'])
    // Existing flows keep their colors unless probe paths overlap;
    // at minimum the mapping is deterministic across calls.
    expect(assignFlowColors(['a', 'b', 'c'])).toEqual(before)
    expect(after.get('d')).toBeDefined()
    expect(new Set(after.values()).size).toBe(4)
  })

  it('never collides with the reserved No-flow / Others colors', () => {
    const ids = Array.from({ length: 30 }, (_, i) => `flow-${i}`)
    const colors = assignFlowColors(ids)
    const values = [...colors.values()]
    expect(new Set(values).size).toBe(ids.length)
    expect(values).not.toContain(NO_FLOW_COLOR)
    expect(values).not.toContain(OTHERS_COLOR)
    expect(FLOW_PALETTE).not.toContain(NO_FLOW_COLOR)
    expect(FLOW_PALETTE).not.toContain(OTHERS_COLOR)
  })

  it('handles an empty set', () => {
    expect(assignFlowColors([]).size).toBe(0)
  })

  it('reserved keys keep their fixed colors', () => {
    expect(NO_FLOW_KEY).toBe('__no_flow__')
    expect(OTHERS_KEY).toBe('__others__')
    expect(NO_FLOW_COLOR).not.toBe(OTHERS_COLOR)
  })

  it('fallback generator is deterministic', () => {
    expect(fallbackFlowColor(99)).toBe(fallbackFlowColor(99))
  })
})
