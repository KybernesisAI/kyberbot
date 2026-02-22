/**
 * KyberBot — Jaccard Similarity
 *
 * Measures similarity between two sets: |intersection| / |union|
 * - 0.0 = no overlap
 * - 1.0 = identical sets
 */

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersectionSize = 0;
  for (const item of setA) {
    if (setB.has(item)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

export function jaccardSimilarityArrays(arrA: string[], arrB: string[]): number {
  return jaccardSimilarity(new Set(arrA), new Set(arrB));
}
