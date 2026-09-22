import { __testing__ as health } from '../../api/health.js';

// Domain fixtures keep asserting logical Redis operations. Preserve the wire
// response cardinality when an atomic script expands to multiple fixture ops.
export function decodeHealthPipeline(body) {
  const wire = JSON.parse(body);
  const groups = wire.map((command) => {
    if (command[0] === 'EVAL' && command[1] === health.HEALTH_VERDICT_WRITE_SNAPSHOT_SCRIPT) {
      // KEYS: lease, full, compact, retained full, retained compact.
      // ARGV: token, full json, compact json, live TTL, retained TTL.
      const keyCount = Number(command[2]);
      const [, full, compact, retainedFull, retainedCompact] = command.slice(3, 3 + keyCount);
      const [, fullJson, compactJson, ttl, retainedTtl] = command.slice(3 + keyCount);
      return [
        ['SET', full, fullJson, 'EX', ttl],
        ['SET', compact, compactJson, 'EX', ttl],
        ...(retainedFull ? [['SET', retainedFull, fullJson, 'EX', retainedTtl]] : []),
        ...(retainedCompact ? [['SET', retainedCompact, compactJson, 'EX', retainedTtl]] : []),
      ];
    }
    if (command[0] === 'EVAL' && command[1] === health.HEALTH_VERDICT_MUTATION_SCRIPT) {
      return [[command[6], command[4], ...command.slice(7)]];
    }
    return [command];
  });
  return {
    commands: groups.flat(),
    encodeResults(results) {
      let offset = 0;
      return groups.map((group) => {
        const values = results.slice(offset, offset + group.length);
        offset += group.length;
        return values.find((value) => value?.error) ?? values[0];
      });
    },
  };
}
