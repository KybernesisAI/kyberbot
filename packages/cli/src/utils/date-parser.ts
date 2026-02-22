/**
 * KyberBot — Natural Language Date Parser
 *
 * Parses human-friendly date/time expressions like:
 * - "3pm" -> today at 3pm
 * - "tomorrow at 2pm" -> tomorrow at 2pm
 * - "next Monday" -> next Monday
 * - "in 2 hours" -> 2 hours from now
 * - "9am PST" -> 9am in Pacific timezone
 */

import * as chrono from 'chrono-node';
import { getTimezone } from '../config.js';

const TIMEZONE_MAP: Record<string, string> = {
  'PST': 'America/Los_Angeles',
  'PDT': 'America/Los_Angeles',
  'PT': 'America/Los_Angeles',
  'MST': 'America/Denver',
  'MDT': 'America/Denver',
  'MT': 'America/Denver',
  'CST': 'America/Chicago',
  'CDT': 'America/Chicago',
  'CT': 'America/Chicago',
  'EST': 'America/New_York',
  'EDT': 'America/New_York',
  'ET': 'America/New_York',
  'HST': 'Pacific/Honolulu',
  'AKST': 'America/Anchorage',
  'AKDT': 'America/Anchorage',
  'GMT': 'Europe/London',
  'UTC': 'UTC',
  'BST': 'Europe/London',
  'CET': 'Europe/Paris',
  'CEST': 'Europe/Paris',
  'WET': 'Europe/Lisbon',
  'EET': 'Europe/Helsinki',
  'EEST': 'Europe/Helsinki',
  'ICT': 'Asia/Bangkok',
  'JST': 'Asia/Tokyo',
  'KST': 'Asia/Seoul',
  'CST_CHINA': 'Asia/Shanghai',
  'IST': 'Asia/Kolkata',
  'SGT': 'Asia/Singapore',
  'HKT': 'Asia/Hong_Kong',
  'AEST': 'Australia/Sydney',
  'AEDT': 'Australia/Sydney',
  'AWST': 'Australia/Perth',
  'ACST': 'Australia/Adelaide',
};

export function parseNaturalDate(
  text: string,
  referenceDate?: Date
): Date | undefined {
  const ref = referenceDate || new Date();
  const result = chrono.parseDate(text, ref, { forwardDate: true });
  return result || undefined;
}

export function parseNaturalDateDetailed(
  text: string,
  referenceDate?: Date
): {
  date: Date;
  text: string;
  hasTime: boolean;
  isRelative: boolean;
} | null {
  const ref = referenceDate || new Date();
  const results = chrono.parse(text, ref, { forwardDate: true });

  if (results.length === 0) return null;

  const result = results[0];
  const parsed = result.start;

  const hasTime =
    parsed.isCertain('hour') ||
    parsed.isCertain('minute') ||
    text.toLowerCase().includes('am') ||
    text.toLowerCase().includes('pm');

  const isRelative =
    text.toLowerCase().includes('tomorrow') ||
    text.toLowerCase().includes('yesterday') ||
    text.toLowerCase().includes('next') ||
    text.toLowerCase().includes('in ') ||
    text.toLowerCase().includes('ago');

  return {
    date: parsed.date(),
    text: result.text,
    hasTime,
    isRelative,
  };
}

export function toISOString(date: Date): string {
  return date.toISOString();
}

export function formatForDisplay(date: Date, includeTime = true): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  };

  if (includeTime) {
    options.hour = 'numeric';
    options.minute = '2-digit';
    options.hour12 = true;
  }

  return date.toLocaleDateString('en-US', options);
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMEZONE DETECTION AND CONVERSION
// ═══════════════════════════════════════════════════════════════════════════════

export function detectTimezone(text: string): {
  abbreviation: string;
  iana: string;
  offsetText: string;
} | null {
  for (const [abbr, iana] of Object.entries(TIMEZONE_MAP)) {
    const regex = new RegExp(`\\b${abbr}\\b`, 'i');
    if (regex.test(text)) {
      return {
        abbreviation: abbr,
        iana,
        offsetText: getTimezoneOffsetString(iana),
      };
    }
  }

  return null;
}

export function parseWithTimezone(
  text: string,
  localTimezone?: string
): {
  date: Date;
  dateInLocalTime: Date;
  sourceTimezone: string;
  localTimezone: string;
  hasExplicitTimezone: boolean;
  originalText: string;
} | null {
  let local: string;
  try {
    local = localTimezone || getTimezone();
  } catch {
    local = localTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  const detectedTz = detectTimezone(text);

  let cleanedText = text;
  if (detectedTz) {
    cleanedText = text.replace(new RegExp(`\\b${detectedTz.abbreviation}\\b`, 'i'), '').trim();
  }

  const parsed = parseNaturalDate(cleanedText);
  if (!parsed) return null;

  let resultDate = parsed;
  let sourceTz = local;

  if (detectedTz) {
    const sourceOffset = getTimezoneOffset(detectedTz.iana, parsed);
    const localOffset = getTimezoneOffset(local, parsed);
    const offsetDiffMinutes = localOffset - sourceOffset;
    resultDate = new Date(parsed.getTime() + offsetDiffMinutes * 60 * 1000);
    sourceTz = detectedTz.iana;
  }

  return {
    date: resultDate,
    dateInLocalTime: resultDate,
    sourceTimezone: sourceTz,
    localTimezone: local,
    hasExplicitTimezone: detectedTz !== null,
    originalText: text,
  };
}

function getTimezoneOffset(timezone: string, date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const utcFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const localParts = formatter.formatToParts(date);
  const utcParts = utcFormatter.formatToParts(date);

  const getPart = (parts: Intl.DateTimeFormatPart[], type: string): number => {
    const part = parts.find(p => p.type === type);
    return part ? parseInt(part.value, 10) : 0;
  };

  const localMinutes = getPart(localParts, 'hour') * 60 + getPart(localParts, 'minute');
  const utcMinutes = getPart(utcParts, 'hour') * 60 + getPart(utcParts, 'minute');

  const localDay = getPart(localParts, 'day');
  const utcDay = getPart(utcParts, 'day');

  let offsetMinutes = localMinutes - utcMinutes;
  if (localDay !== utcDay) {
    offsetMinutes += (localDay > utcDay ? 1 : -1) * 24 * 60;
  }

  return offsetMinutes;
}

function getTimezoneOffsetString(timezone: string): string {
  const offset = getTimezoneOffset(timezone, new Date());
  const sign = offset >= 0 ? '+' : '-';
  const hours = Math.floor(Math.abs(offset) / 60);
  const minutes = Math.abs(offset) % 60;

  if (minutes === 0) {
    return `UTC${sign}${hours}`;
  }
  return `UTC${sign}${hours}:${minutes.toString().padStart(2, '0')}`;
}

export function getIANATimezone(abbreviation: string): string | null {
  return TIMEZONE_MAP[abbreviation.toUpperCase()] || null;
}

export function formatInTimezone(
  date: Date,
  timezone: string,
  options?: Intl.DateTimeFormatOptions
): string {
  const defaultOptions: Intl.DateTimeFormatOptions = {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  };

  return date.toLocaleString('en-US', { ...defaultOptions, ...options });
}
