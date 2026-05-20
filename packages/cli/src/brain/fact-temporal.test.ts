import { describe, it, expect } from 'vitest';
import { detectTemporalExpiry } from './fact-temporal.js';

// Anchor every test on a known timestamp. 2026-05-18 is a Monday.
const MONDAY = '2026-05-18T10:00:00Z';

describe('detectTemporalExpiry', () => {
  describe('non-temporal content', () => {
    it('returns is_temporal=false for facts with no time expression', () => {
      const r = detectTemporalExpiry('Alice works at Acme', MONDAY);
      expect(r.is_temporal).toBe(false);
      expect(r.expires_at).toBeNull();
      expect(r.temporal_expression).toBeNull();
    });

    it('does not match partial words like "todays" or "soonish"', () => {
      // \btoday\b requires word boundaries on both sides — "todays" doesn't
      // qualify because the trailing 's' is a word character.
      const r = detectTemporalExpiry('She covered the todays headline', MONDAY);
      expect(r.is_temporal).toBe(false);

      const s = detectTemporalExpiry('Shipping soonish', MONDAY);
      expect(s.is_temporal).toBe(false);
    });

    it('truly returns false for unrelated content', () => {
      const r = detectTemporalExpiry('A pleasant conversation about coffee', MONDAY);
      expect(r.is_temporal).toBe(false);
    });
  });

  describe('relative expressions', () => {
    it('detects "tomorrow" and expires the day after', () => {
      const r = detectTemporalExpiry('I have an exam tomorrow', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('tomorrow');
      expect(r.expires_at).toBe('2026-05-20T00:00:00.000Z');
    });

    it('detects "today" and expires the following day', () => {
      const r = detectTemporalExpiry('Meeting today at 3pm', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('today');
      expect(r.expires_at).toBe('2026-05-19T00:00:00.000Z');
    });

    it('detects "tonight" same as today', () => {
      const r = detectTemporalExpiry('Dinner tonight', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('tonight');
      expect(r.expires_at).toBe('2026-05-19T00:00:00.000Z');
    });
  });

  describe('week/month expressions', () => {
    it('detects "this week" and expires 7 days later', () => {
      const r = detectTemporalExpiry('Plenty to do this week', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('this week');
      expect(r.expires_at).toBe('2026-05-25T00:00:00.000Z');
    });

    it('detects "next week" and expires 14 days later', () => {
      const r = detectTemporalExpiry('Big presentation next week', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('next week');
      expect(r.expires_at).toBe('2026-06-01T00:00:00.000Z');
    });

    it('detects "this weekend" and expires on the following Monday', () => {
      const r = detectTemporalExpiry('Camping this weekend', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('this weekend');
      // From Monday 2026-05-18, next Monday is 2026-05-25
      expect(r.expires_at).toBe('2026-05-25T00:00:00.000Z');
    });

    it('detects "this month" and expires on the first of the next month', () => {
      const r = detectTemporalExpiry('Lots happening this month', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('this month');
      expect(r.expires_at).toBe('2026-06-01T00:00:00.000Z');
    });

    it('detects "next month" and expires on the first of the month after', () => {
      const r = detectTemporalExpiry('Trip planned next month', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('next month');
      expect(r.expires_at).toBe('2026-07-01T00:00:00.000Z');
    });
  });

  describe('weekday expressions', () => {
    it('detects "this friday" and expires the day after that friday', () => {
      const r = detectTemporalExpiry('Lunch this friday', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('this friday');
      // From Monday 2026-05-18, next Friday is 2026-05-22, expire 2026-05-23
      expect(r.expires_at).toBe('2026-05-23T00:00:00.000Z');
    });

    it('detects "next tuesday"', () => {
      const r = detectTemporalExpiry('Demo next tuesday', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('next tuesday');
    });
  });

  describe('vague expressions', () => {
    it('detects "upcoming" and expires 30 days later', () => {
      const r = detectTemporalExpiry('Working on the upcoming launch', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('upcoming');
      expect(r.expires_at).toBe('2026-06-17T00:00:00.000Z');
    });

    it('detects "soon" and expires 14 days later', () => {
      const r = detectTemporalExpiry('Shipping soon', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('soon');
      expect(r.expires_at).toBe('2026-06-01T00:00:00.000Z');
    });
  });

  describe('priority — more specific patterns win', () => {
    it('prefers "this weekend" over a bare "this" or "weekend"', () => {
      const r = detectTemporalExpiry('Camping this weekend', MONDAY);
      expect(r.temporal_expression).toBe('this weekend');
    });

    it('prefers "tomorrow" over "today" when both might appear', () => {
      const r = detectTemporalExpiry('Tomorrow looks busy', MONDAY);
      expect(r.temporal_expression).toBe('tomorrow');
    });
  });

  describe('case insensitivity', () => {
    it('matches uppercase variants', () => {
      const r = detectTemporalExpiry('Big day TOMORROW', MONDAY);
      expect(r.is_temporal).toBe(true);
      expect(r.temporal_expression).toBe('tomorrow');
    });
  });
});
