export interface NEREntity {
  text: string;
  type: string;
  confidence: number;
  start: number;
  end: number;
}

interface TokenClassificationItem {
  entity?: string;
  entity_group?: string;
  score?: number;
  word?: string;
  start?: number;
  end?: number;
}

interface AggregatedEntity extends NEREntity {
  tokenCount: number;
}

const ENTITY_PREFIX_RE = /^[BIES]-/;

function normalizeType(label: string): string {
  return label.replace(ENTITY_PREFIX_RE, '');
}

function inferSpan(text: string, rawWord: string, cursor: number): { start: number; end: number; word: string } {
  const word = rawWord.startsWith('##') ? rawWord.slice(2) : rawWord;
  if (!word) {
    return { start: cursor, end: cursor, word };
  }

  const lowerText = text.toLowerCase();
  const lowerWord = word.toLowerCase();
  const directStart = Math.max(0, Math.min(cursor, text.length));

  if (lowerText.slice(directStart, directStart + lowerWord.length) === lowerWord) {
    return { start: directStart, end: directStart + word.length, word };
  }

  const found = lowerText.indexOf(lowerWord, directStart);
  if (found !== -1) {
    return { start: found, end: found + word.length, word };
  }

  return { start: directStart, end: directStart, word };
}

export function normalizeTokenClassificationOutput(output: unknown, text: string): NEREntity[] {
  if (!Array.isArray(output)) return [];

  const entities: AggregatedEntity[] = [];
  let cursor = 0;

  for (const item of output as TokenClassificationItem[]) {
    const label = item.entity_group ?? item.entity;
    const rawWord = item.word;
    const score = item.score;
    if (!label || label === 'O' || typeof rawWord !== 'string' || typeof score !== 'number') {
      continue;
    }

    const type = normalizeType(label);
    const isContinuation = rawWord.startsWith('##') || label.startsWith('I-') || label.startsWith('E-');
    const inferred = inferSpan(text, rawWord, cursor);
    const start = typeof item.start === 'number' ? item.start : inferred.start;
    const end = typeof item.end === 'number' ? item.end : inferred.end;
    const word = inferred.word;
    const previous = entities[entities.length - 1];

    if (previous && previous.type === type && isContinuation) {
      const separator = rawWord.startsWith('##') || start <= previous.end ? '' : ' ';
      previous.text += `${separator}${word}`;
      previous.end = Math.max(previous.end, end);
      previous.confidence = (previous.confidence * previous.tokenCount + score) / (previous.tokenCount + 1);
      previous.tokenCount += 1;
    } else {
      entities.push({
        text: word,
        type,
        confidence: score,
        start,
        end,
        tokenCount: 1,
      });
    }

    cursor = Math.max(cursor, end);
  }

  return entities.map(({ tokenCount: _tokenCount, ...entity }) => entity);
}
