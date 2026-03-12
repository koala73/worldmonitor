// Jaccard n-gram similarity for near-duplicate detection

function getNgrams(text: string, n = 2): Set<string> {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < n) return new Set(words.length > 0 ? [words.join(' ')] : []);
  const ngrams = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    ngrams.add(words.slice(i, i + n).join(' '));
  }
  return ngrams;
}

export function jaccardSimilarity(a: string, b: string, ngramSize = 2): number {
  const setA = getNgrams(a, ngramSize);
  const setB = getNgrams(b, ngramSize);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const gram of setA) {
    if (setB.has(gram)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}
