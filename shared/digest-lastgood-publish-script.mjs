// Atomic replacement gate for the durable last-good digest snapshot (#7084),
// executed inside Redis so concurrent isolates cannot interleave a
// read-decide-write.
//
// MIRROR of shouldReplaceAccepted in server/worldmonitor/news/v1/_lastgood.ts —
// the same rules, in the same order. This script is the AUTHORITATIVE gate on
// every non-sidecar deployment; the TS function is the gate only in
// tauri-sidecar mode, which has no EVAL. Change them together, and note that
// tests/digest-lastgood-script.test.mjs EXECUTES this text in a Lua VM — a
// behavioural change here fails there, not just a byte-parity check.
//
// A second consumer holds a byte-identical copy: docker/redis-rest-proxy.mjs
// allowlists EVAL for exactly this script (its image bundles only its own
// file, so it cannot import this module). tests/digest-lastgood.test.mts pins
// the two copies equal — edit both or that test goes red.
//
// The script reads the revocation set and measures BOTH bodies inside this
// atomic operation. Stored bodies remain unfiltered, but a URL revoked after
// incumbent publication cannot keep inflating its richness and veto repair.
// That re-measurement is why the incumbent BODY is read rather than a cheap
// counts-only sibling key: publication-time counts predate later revocations.
//
// The candidate body is stored BYTE-FOR-BYTE as the caller serialized it
// (ARGV[5] is spliced into the stored JSON, never decoded and re-encoded).
// Redis's cjson cannot distinguish an empty JSON array from an empty object,
// so a decode/encode round trip silently rewrote every `[]` in the digest —
// `tickers: []` on every item, and `items: []` on any category the freshness
// floor emptied — as `{}`, which then threw out of the serve-time revocation
// filter and out of the browser's own `.map`.
//
// KEYS[1] = durable snapshot body key, KEYS[2] = revoked URL set,
// KEYS[3] = attempt identity key, KEYS[4] = optional canonical digest key.
// ARGV: 1=nowMs 2=maxAgeMs 3=candidateAcceptedAt 4=durableTtlSeconds
//       5=candidateDataJson (the digest body alone, verbatim)
//       6=optional canonicalTtlSeconds 7=canonicalMinGeneratedAtIso
//       8=canonicalMaxGeneratedAtIso 9=canonicalNegativeTtlSeconds 10=attemptTtlSeconds.
// Returns 1 when written, 0 when the live snapshot was kept, -1 when the
// candidate has no servable items.
//
// isNarrower: breadth is strict, depth has a floor. The `80` is
// LASTGOOD_MIN_ITEM_PCT from _lastgood.ts, written as a literal because the
// docker proxy allowlists this exact text; tests/digest-lastgood.test.mts pins
// the literal to the constant. Integer arithmetic (`* 100 < * 80`), so the
// comparison itself cannot differ between Lua's doubles and JS. A strict
// `items <` froze the live digest for ~6h on 2026-09-19 (a 289-item build kept
// losing to a 294-item incumbent).
//
// The durable floor is anchored to the PEAK: the richest item count accepted
// inside the six-hour window, carried in the row as peakItemCount/peakAt.
// Anchored to the incumbent instead, 20% steps compound (100 -> 80 -> 64 ...)
// and consume the recovery snapshot. A stored peak counts only while it is in
// the window and the incumbent still measures its stored itemCount; once
// revocations shrank it, a publication-time peak would veto its repair. Rows
// written before the field existed fall back to the incumbent's own count.
// Mirror: livePeak/nextPeak in _lastgood.ts.
export const DIGEST_LASTGOOD_PUBLISH_SCRIPT = [
  'local revoked = {}',
  "for _, url in ipairs(redis.call('SMEMBERS', KEYS[2])) do revoked[url] = true end",
  'local function countData(data)',
  "  if type(data) ~= 'table' or type(data.categories) ~= 'table' then return nil end",
  '  local categories = 0',
  '  local items = 0',
  '  for _, bucket in pairs(data.categories) do',
  '    categories = categories + 1',
  "    if type(bucket) == 'table' and type(bucket.items) == 'table' then",
  '      for _, item in ipairs(bucket.items) do',
  "        local isRevoked = type(item) == 'table' and type(item.link) == 'string' and revoked[item.link]",
  '        if not isRevoked then items = items + 1 end',
  '      end',
  '    end',
  '  end',
  '  return { categories = categories, items = items }',
  'end',
  'local okCandidate, candidateData = pcall(cjson.decode, ARGV[5])',
  'local candidate = nil',
  'if okCandidate then candidate = countData(candidateData) end',
  'if not candidate or candidate.categories < 1 or candidate.items < 1 then return -1 end',
  'local canonicalRaw = nil',
  "if KEYS[4] then canonicalRaw = redis.call('GET', KEYS[4]) end",
  'local function rejectNarrower()',
  `  local attempt = '{"ts":' .. ARGV[1] .. ',"outcome":"gate-held"}'`,
  "  redis.call('SET', KEYS[3], attempt, 'EX', ARGV[10])",
  "  if KEYS[4] and not canonicalRaw then redis.call('SET', KEYS[4], '\"__WM_NEG__\"', 'EX', ARGV[9]) end",
  '  return 0',
  'end',
  'local function isNarrower(nextData, currentData)',
  '  return nextData.categories < currentData.categories or nextData.items * 100 < currentData.items * 80',
  'end',
  'local function isLiveCanonicalClock(value)',
  "  if type(value) ~= 'string' then return false end",
  "  local year, month, day, hour, minute, second = string.match(value, '^(%d%d%d%d)%-(%d%d)%-(%d%d)T(%d%d):(%d%d):(%d%d)%.%d%d%dZ$')",
  '  if not year then return false end',
  '  year, month, day = tonumber(year), tonumber(month), tonumber(day)',
  '  hour, minute, second = tonumber(hour), tonumber(minute), tonumber(second)',
  '  if month < 1 or month > 12 or hour > 23 or minute > 59 or second > 59 then return false end',
  '  local leap = year % 4 == 0 and (year % 100 ~= 0 or year % 400 == 0)',
  '  local monthDays = { 31, leap and 29 or 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 }',
  '  if day < 1 or day > monthDays[month] then return false end',
  '  return value >= ARGV[7] and value <= ARGV[8]',
  'end',
  'local carriedPeak, carriedPeakAt = nil, nil',
  "local currentRaw = redis.call('GET', KEYS[1])",
  'if currentRaw then',
  '  local okCurrent, snapshot = pcall(cjson.decode, currentRaw)',
  "  if okCurrent and type(snapshot) == 'table' then",
  '    local current = countData(snapshot.data)',
  '    if current then',
  '      local delta = tonumber(ARGV[1]) - (tonumber(snapshot.acceptedAt) or 0)',
  '      local live = delta >= 0 and delta <= tonumber(ARGV[2])',
  '      if live then',
  '        local peak, peakAt = current.items, tonumber(snapshot.acceptedAt) or 0',
  '        local storedPeak, storedPeakAt = tonumber(snapshot.peakItemCount), tonumber(snapshot.peakAt) or 0',
  '        local peakDelta = tonumber(ARGV[1]) - storedPeakAt',
  '        local peakLive = storedPeak and peakDelta >= 0 and peakDelta <= tonumber(ARGV[2])',
  '        if peakLive and tonumber(snapshot.itemCount) == current.items and storedPeak > peak then',
  '          peak, peakAt = storedPeak, storedPeakAt',
  '        end',
  '        if isNarrower(candidate, { categories = current.categories, items = peak }) then return rejectNarrower() end',
  '        if peak > candidate.items then carriedPeak, carriedPeakAt = peak, peakAt end',
  '      end',
  '    end',
  '  end',
  'end',
  'if KEYS[4] then',
  '  if canonicalRaw then',
  '    local okCanonical, canonicalData = pcall(cjson.decode, canonicalRaw)',
  "    if okCanonical and type(canonicalData) == 'table' then",
  '      local currentCanonical = countData(canonicalData)',
  '      local live = isLiveCanonicalClock(canonicalData.generatedAt)',
  '      local usable = currentCanonical and currentCanonical.categories >= 1 and currentCanonical.items >= 1',
  '      if live and usable and isNarrower(candidate, currentCanonical) then return rejectNarrower() end',
  '    end',
  '  end',
  'end',
  // String-splice, never cjson.encode: ARGV[5] must reach Redis unchanged.
  // '%.0f' rather than '%d': Redis ships Lua 5.1 (where a float coerces) but
  // 5.3+ rejects '%d' on a non-integer-representable number, and tonumber on
  // a string yields a float. '%.0f' is exact for every ms timestamp and count
  // we produce, and behaves identically on both.
  "local stored = '{\"acceptedAt\":' .. string.format('%.0f', tonumber(ARGV[3]) or 0)",
  "  .. ',\"categoryCount\":' .. string.format('%.0f', candidate.categories)",
  "  .. ',\"itemCount\":' .. string.format('%.0f', candidate.items)",
  "  .. ',\"peakItemCount\":' .. string.format('%.0f', carriedPeak or candidate.items)",
  "  .. ',\"peakAt\":' .. string.format('%.0f', carriedPeakAt or tonumber(ARGV[3]) or 0)",
  '  .. \',"data":\' .. ARGV[5] .. \'}\'',
  "redis.call('SET', KEYS[1], stored, 'EX', ARGV[4])",
  "if KEYS[4] then redis.call('SET', KEYS[4], ARGV[5], 'EX', ARGV[6]) end",
  'return 1',
].join('\n');
