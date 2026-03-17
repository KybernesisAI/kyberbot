import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger (some imports chain to it)
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock config for timezone
vi.mock('../config.js', () => ({
  getTimezone: () => 'America/New_York',
  getRoot: () => '/mock/root',
}));

const {
  parseNaturalDate,
  parseNaturalDateDetailed,
  toISOString,
  formatForDisplay,
  detectTimezone,
  parseWithTimezone,
  getIANATimezone,
  formatInTimezone,
} = await import('./date-parser.js');

// ─────────────────────────────────────────────────────────────────────────────
// parseNaturalDate
// ─────────────────────────────────────────────────────────────────────────────

describe('parseNaturalDate', () => {
  const refDate = new Date('2025-06-15T12:00:00Z');

  it('parses "tomorrow" relative to reference date', () => {
    const result = parseNaturalDate('tomorrow', refDate);
    expect(result).toBeDefined();
    expect(result!.getDate()).toBe(16);
  });

  it('parses "in 2 hours" relative to reference', () => {
    const result = parseNaturalDate('in 2 hours', refDate);
    expect(result).toBeDefined();
    const diffMs = result!.getTime() - refDate.getTime();
    const diffHours = diffMs / (1000 * 60 * 60);
    expect(diffHours).toBeCloseTo(2, 0);
  });

  it('returns undefined for unparseable text', () => {
    const result = parseNaturalDate('xyzzy gibberish', refDate);
    expect(result).toBeUndefined();
  });

  it('uses current time as default reference', () => {
    const result = parseNaturalDate('tomorrow');
    expect(result).toBeDefined();
    // Should be roughly tomorrow
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    expect(result!.getDate()).toBe(tomorrow.getDate());
  });

  it('parses "next Monday"', () => {
    const result = parseNaturalDate('next Monday', refDate);
    expect(result).toBeDefined();
    expect(result!.getDay()).toBe(1); // Monday
    expect(result!.getTime()).toBeGreaterThan(refDate.getTime());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseNaturalDateDetailed
// ─────────────────────────────────────────────────────────────────────────────

describe('parseNaturalDateDetailed', () => {
  const refDate = new Date('2025-06-15T12:00:00Z');

  it('returns hasTime=true for time-specific input', () => {
    const result = parseNaturalDateDetailed('3pm', refDate);
    expect(result).not.toBeNull();
    expect(result!.hasTime).toBe(true);
  });

  it('returns hasTime=false for date-only input', () => {
    const result = parseNaturalDateDetailed('next Monday', refDate);
    expect(result).not.toBeNull();
    expect(result!.hasTime).toBe(false);
  });

  it('returns isRelative=true for "tomorrow"', () => {
    const result = parseNaturalDateDetailed('tomorrow at 3pm', refDate);
    expect(result).not.toBeNull();
    expect(result!.isRelative).toBe(true);
  });

  it('returns isRelative=true for "in 2 hours"', () => {
    const result = parseNaturalDateDetailed('in 2 hours', refDate);
    expect(result).not.toBeNull();
    expect(result!.isRelative).toBe(true);
  });

  it('returns isRelative=false for absolute dates', () => {
    const result = parseNaturalDateDetailed('June 20', refDate);
    expect(result).not.toBeNull();
    expect(result!.isRelative).toBe(false);
  });

  it('returns null for unparseable text', () => {
    const result = parseNaturalDateDetailed('not a date', refDate);
    expect(result).toBeNull();
  });

  it('includes matched text from input', () => {
    const result = parseNaturalDateDetailed('meeting tomorrow at 3pm please', refDate);
    expect(result).not.toBeNull();
    expect(result!.text).toBeDefined();
    expect(result!.text.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toISOString
// ─────────────────────────────────────────────────────────────────────────────

describe('toISOString', () => {
  it('returns ISO 8601 formatted string', () => {
    const date = new Date('2025-06-15T14:30:00Z');
    expect(toISOString(date)).toBe('2025-06-15T14:30:00.000Z');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatForDisplay
// ─────────────────────────────────────────────────────────────────────────────

describe('formatForDisplay', () => {
  it('includes time by default', () => {
    const date = new Date('2025-06-15T14:30:00Z');
    const result = formatForDisplay(date);
    // Should have day name, month, day, and time components
    expect(result).toMatch(/\w+/); // At least some text
  });

  it('excludes time when includeTime is false', () => {
    const date = new Date('2025-06-15T14:30:00Z');
    const withTime = formatForDisplay(date, true);
    const withoutTime = formatForDisplay(date, false);
    // The version with time should be longer
    expect(withTime.length).toBeGreaterThan(withoutTime.length);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// detectTimezone
// ─────────────────────────────────────────────────────────────────────────────

describe('detectTimezone', () => {
  it('detects PST timezone', () => {
    const result = detectTimezone('3pm PST');
    expect(result).not.toBeNull();
    expect(result!.abbreviation).toBe('PST');
    expect(result!.iana).toBe('America/Los_Angeles');
  });

  it('detects EST timezone', () => {
    const result = detectTimezone('meeting at 9am EST');
    expect(result).not.toBeNull();
    expect(result!.abbreviation).toBe('EST');
    expect(result!.iana).toBe('America/New_York');
  });

  it('detects UTC timezone', () => {
    const result = detectTimezone('deployment at 00:00 UTC');
    expect(result).not.toBeNull();
    expect(result!.abbreviation).toBe('UTC');
    expect(result!.iana).toBe('UTC');
  });

  it('detects JST timezone', () => {
    const result = detectTimezone('call at 10am JST');
    expect(result).not.toBeNull();
    expect(result!.abbreviation).toBe('JST');
    expect(result!.iana).toBe('Asia/Tokyo');
  });

  it('is case-insensitive', () => {
    const result = detectTimezone('3pm pst');
    expect(result).not.toBeNull();
    expect(result!.iana).toBe('America/Los_Angeles');
  });

  it('returns null when no timezone found', () => {
    const result = detectTimezone('tomorrow at 3pm');
    expect(result).toBeNull();
  });

  it('includes offset text', () => {
    const result = detectTimezone('3pm UTC');
    expect(result).not.toBeNull();
    expect(result!.offsetText).toMatch(/UTC[+-]?\d*/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// getIANATimezone
// ─────────────────────────────────────────────────────────────────────────────

describe('getIANATimezone', () => {
  it('returns IANA timezone for known abbreviation', () => {
    expect(getIANATimezone('PST')).toBe('America/Los_Angeles');
    expect(getIANATimezone('EST')).toBe('America/New_York');
    expect(getIANATimezone('UTC')).toBe('UTC');
    expect(getIANATimezone('JST')).toBe('Asia/Tokyo');
  });

  it('is case-insensitive', () => {
    expect(getIANATimezone('pst')).toBe('America/Los_Angeles');
    expect(getIANATimezone('est')).toBe('America/New_York');
  });

  it('returns null for unknown abbreviation', () => {
    expect(getIANATimezone('XYZ')).toBeNull();
    expect(getIANATimezone('')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseWithTimezone
// ─────────────────────────────────────────────────────────────────────────────

describe('parseWithTimezone', () => {
  it('parses date with explicit timezone', () => {
    const result = parseWithTimezone('3pm PST', 'America/New_York');
    expect(result).not.toBeNull();
    expect(result!.hasExplicitTimezone).toBe(true);
    expect(result!.sourceTimezone).toBe('America/Los_Angeles');
    expect(result!.localTimezone).toBe('America/New_York');
  });

  it('parses date without explicit timezone using local', () => {
    const result = parseWithTimezone('3pm', 'America/New_York');
    expect(result).not.toBeNull();
    expect(result!.hasExplicitTimezone).toBe(false);
    expect(result!.sourceTimezone).toBe('America/New_York');
  });

  it('returns null for unparseable text', () => {
    const result = parseWithTimezone('gibberish', 'America/New_York');
    expect(result).toBeNull();
  });

  it('preserves original text', () => {
    const input = '9am PST tomorrow';
    const result = parseWithTimezone(input, 'America/New_York');
    expect(result).not.toBeNull();
    expect(result!.originalText).toBe(input);
  });

  it('falls back to config timezone when localTimezone not provided', () => {
    const result = parseWithTimezone('3pm');
    expect(result).not.toBeNull();
    // Should use the mocked getTimezone() = 'America/New_York'
    expect(result!.localTimezone).toBe('America/New_York');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// formatInTimezone
// ─────────────────────────────────────────────────────────────────────────────

describe('formatInTimezone', () => {
  it('formats date in specified timezone', () => {
    const date = new Date('2025-06-15T18:00:00Z');
    const result = formatInTimezone(date, 'America/New_York');
    // Should show EDT/EST time
    expect(result).toMatch(/\w+/);
  });

  it('formats date in UTC', () => {
    const date = new Date('2025-06-15T18:00:00Z');
    const result = formatInTimezone(date, 'UTC');
    expect(result).toContain('6:00');
    expect(result).toMatch(/PM/i);
  });

  it('accepts custom format options', () => {
    const date = new Date('2025-06-15T18:00:00Z');
    const result = formatInTimezone(date, 'UTC', {
      timeZone: 'UTC',
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    });
    expect(result).toContain('18:00');
  });
});
