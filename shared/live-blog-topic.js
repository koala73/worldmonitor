/**
 * A live blog's standing header ("Live Updates: LIVE: Iran-US war - Business
 * Recorder") names a topic, not an event. The publisher keeps it for days while
 * the page underneath changes, so it never pages a realtime subscriber,
 * whatever level the classifier gave it.
 *
 * Matches only a live label plus one of two topic shapes: one name followed by
 * a topic noun ("Iran-US war", "Ukraine war") or a topic noun, a preposition
 * and one name ("war in Ukraine"). A capitalized verb looks the same as a name
 * ("NATO Enters war"), so a multi-word name before the topic noun ("Middle
 * East crisis") is not matched either. A live headline that carries an event
 * ("Iran war live: tankers set ablaze in Hormuz") is left alone. A
 * missed cap costs one extra alert, a wrong cap silently drops a critical one.
 *
 * A tail after a spaced dash or bar is dropped only when it names the item's
 * own publisher. "Live: Iran-US war - Tehran hit by strikes" carries its event
 * there, and an aggregator feed's source rarely matches the publisher tail, so
 * those stay uncapped.
 *
 * Lives in `shared/` because the AIS relay needs it (Dockerfile.relay copies
 * `shared/`).
 */
const MAX_TITLE_CHARS = 300;
const LIVE_LABEL = /\blive(?:\s+(?:updates?|blog|coverage))?\b/gi;
const TAIL = /^(.*\S)\s+[-–—|]\s+([^-–—|:]{1,60})$/;
const SEPARATOR = /\s+[-–—|]\s+|[:|–—]/g;
const TOPIC = new Set(['war', 'conflict', 'crisis', 'tensions', 'standoff']);
const PREPOSITION = new Set(['in', 'on', 'with', 'between']);
const normalizeName = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const withoutLiveLabels = (text) => text.replace(LIVE_LABEL, ' ').replace(SEPARATOR, ' ').replace(/\s+/g, ' ').trim();

export function isLiveBlogTopicHeader(title, publisher) {
  if (typeof title !== 'string') return false;
  let text = title.slice(0, MAX_TITLE_CHARS);
  if (!text.match(LIVE_LABEL)) return false;
  const tail = text.match(TAIL);
  if (tail && withoutLiveLabels(tail[1]) && normalizeName(tail[2]) === normalizeName(publisher)) text = tail[1];
  const topic = withoutLiveLabels(text);
  const words = topic.split(' ');
  const isName = (word) => /^\p{Lu}/u.test(word);
  if (words.length === 2 && TOPIC.has(words[1].toLowerCase())) return isName(words[0]);
  const [first, preposition, name] = words;
  return words.length === 3 && TOPIC.has(first.toLowerCase()) && first === first.toLowerCase()
    && PREPOSITION.has(preposition) && isName(name);
}
