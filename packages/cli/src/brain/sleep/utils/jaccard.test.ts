import { describe, it, expect } from 'vitest';
import { jaccardSimilarity, jaccardSimilarityArrays } from './jaccard.js';

describe('jaccardSimilarity', () => {
  it('should return 0 for two empty sets', () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(0);
  });

  it('should return 0 for disjoint sets', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['c', 'd']);
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('should return 1 for identical sets', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['a', 'b', 'c']);
    expect(jaccardSimilarity(a, b)).toBe(1);
  });

  it('should return correct value for partial overlap', () => {
    const a = new Set(['a', 'b', 'c']);
    const b = new Set(['b', 'c', 'd']);
    // intersection = {b, c} = 2, union = {a, b, c, d} = 4
    expect(jaccardSimilarity(a, b)).toBe(0.5);
  });

  it('should handle one empty set', () => {
    const a = new Set(['a', 'b']);
    const b = new Set<string>();
    expect(jaccardSimilarity(a, b)).toBe(0);
  });

  it('should handle subset relationship', () => {
    const a = new Set(['a', 'b']);
    const b = new Set(['a', 'b', 'c']);
    // intersection = 2, union = 3
    expect(jaccardSimilarity(a, b)).toBeCloseTo(2 / 3);
  });
});

describe('jaccardSimilarityArrays', () => {
  it('should work with string arrays', () => {
    // intersection = {b} = 1, union = {a, b, c} = 3
    expect(jaccardSimilarityArrays(['a', 'b'], ['b', 'c'])).toBeCloseTo(1 / 3);
  });

  it('should deduplicate array elements', () => {
    expect(jaccardSimilarityArrays(['a', 'a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('should handle empty arrays', () => {
    expect(jaccardSimilarityArrays([], [])).toBe(0);
  });
});
