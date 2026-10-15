import { describe, expect, it } from 'vitest';
import { resolveSurgeMultiplier } from '@/lib/policyServer';
import { localWallClock } from '@/lib/bookingQuote';
import type { PricingRule } from '@/lib/supabase';

/**
 * The surge resolver (§7.4) and the wall-clock conversion it reads.
 *
 * `resolveSurgeMultiplier` is the pure rule that decides which `pricing_rules`
 * row wins for a service at a moment. It was written in Phase 6 and unread by
 * the engine until Phase 8 wired it in; these tests pin the resolution so the
 * quote, the admin console and an invoice cannot disagree about the winner.
 */

function rule(overrides: Partial<PricingRule> = {}): PricingRule {
  return {
    id: 'rule-1',
    name: 'Evening peak',
    scope: 'global',
    category_id: null,
    service_id: null,
    multiplier: '1.2',
    days_of_week: [],
    start_minute: null,
    end_minute: null,
    priority: 0,
    valid_from: null,
    valid_to: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as PricingRule;
}

const QUERY = { serviceId: 'svc-1', categoryId: 'cat-1', minute: 600, dayOfWeek: 1 };

describe('resolveSurgeMultiplier', () => {
  it('returns 1 with no rule when the table is empty', () => {
    const { multiplier, rule: winner } = resolveSurgeMultiplier({ ...QUERY, rules: [] });
    expect(multiplier).toBe(1);
    expect(winner).toBeNull();
  });

  it('uses a global rule when the window matches', () => {
    const { multiplier, rule: winner } = resolveSurgeMultiplier({
      ...QUERY,
      rules: [rule({ start_minute: 480, end_minute: 720 })],
    });
    expect(multiplier).toBe(1.2);
    expect(winner?.id).toBe('rule-1');
  });

  it('ignores a rule whose minute window excludes the moment', () => {
    const { multiplier } = resolveSurgeMultiplier({
      ...QUERY,
      rules: [rule({ start_minute: 0, end_minute: 60 })],
    });
    expect(multiplier).toBe(1);
  });

  it('honours a window that wraps midnight', () => {
    const { multiplier } = resolveSurgeMultiplier({
      ...QUERY,
      minute: 30,
      rules: [rule({ start_minute: 1320, end_minute: 120 })],
    });
    expect(multiplier).toBe(1.2);
  });

  it('ignores a rule whose days-of-week excludes the day', () => {
    const { multiplier } = resolveSurgeMultiplier({
      ...QUERY,
      rules: [rule({ days_of_week: [0, 6] })],
    });
    expect(multiplier).toBe(1);
  });

  it('ignores an inactive rule and one outside its validity window', () => {
    expect(
      resolveSurgeMultiplier({ ...QUERY, rules: [rule({ is_active: false })] }).multiplier
    ).toBe(1);
    expect(
      resolveSurgeMultiplier({
        ...QUERY,
        rules: [rule({ valid_from: '2999-01-01T00:00:00.000Z' })],
      }).multiplier
    ).toBe(1);
  });

  it('prefers the more specific scope over a broader one', () => {
    const { multiplier, rule: winner } = resolveSurgeMultiplier({
      ...QUERY,
      rules: [
        rule({ id: 'global', scope: 'global', multiplier: '1.1' }),
        rule({ id: 'category', scope: 'category', category_id: 'cat-1', multiplier: '1.3' }),
        rule({ id: 'service', scope: 'service', service_id: 'svc-1', multiplier: '1.5' }),
      ],
    });
    expect(multiplier).toBe(1.5);
    expect(winner?.id).toBe('service');
  });

  it('breaks a tie on priority', () => {
    const { rule: winner } = resolveSurgeMultiplier({
      ...QUERY,
      rules: [rule({ id: 'low', priority: 1 }), rule({ id: 'high', priority: 5 })],
    });
    expect(winner?.id).toBe('high');
  });
});

describe('localWallClock', () => {
  it('reads the platform zone (Asia/Kolkata), not UTC', () => {
    // 2026-01-05 is a Monday. 01:00Z is 06:30 IST.
    expect(localWallClock(new Date('2026-01-05T01:00:00.000Z'))).toEqual({
      minute: 390,
      dayOfWeek: 1,
    });
  });

  it('rolls the day over when the zone crosses midnight', () => {
    // 20:00Z Monday is 01:30 IST on Tuesday.
    expect(localWallClock(new Date('2026-01-05T20:00:00.000Z'))).toEqual({
      minute: 90,
      dayOfWeek: 2,
    });
  });
});
