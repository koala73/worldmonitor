/**
 * A live blog's standing header ("Live Updates: LIVE: Iran-US war - Business
 * Recorder") names a topic, not an event. The publisher keeps it for days while
 * the page underneath changes, so it never pages a realtime subscriber,
 * whatever level the classifier gave it.
 *
 * Matches only a live label plus one of two topic shapes: names followed by a
 * topic noun ("Iran-US war", "Middle East crisis") or a topic noun, a
 * preposition and names ("war in Ukraine"). A capital letter marks a name only
 * when the topic noun is lowercase; in a title-case or all-caps headline every
 * verb is capitalized too, so only the two-word "<Name> <Topic>" form matches
 * there. A live headline that carries an event ("Iran war live: tankers set
 * ablaze in Hormuz", "Live: Iran War Ceasefire Collapses") is left alone. A
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
const MAX_TOPIC_WORDS = 4;
const LIVE_LABEL = /\blive(?:\s+(?:updates?|blog|coverage))?\b/gi;
const TAIL = /^(.*\S)\s+[-–—|]\s+([^-–—|:]{1,60})$/;
const SEPARATOR = /\s+[-–—|]\s+|[:|–—]/g;
const TOPIC = new Set(['war', 'conflict', 'crisis', 'tensions', 'standoff']);
const PREPOSITION = new Set(['in', 'on', 'with', 'between']);
const EVENT = /\b(?:declares?|declared|ends?|ended|begins?|began|starts?|started|erupts?|erupted|escalates?|escalated|resumes?|resumed|over|ceasefire|truce|coup|invasion)\b/i;
const normalizeName = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const withoutLiveLabels = (text) => text.replace(LIVE_LABEL, ' ').replace(SEPARATOR, ' ').replace(/\s+/g, ' ').trim();

export function isLiveBlogTopicHeader(title, publisher) {
  if (typeof title !== 'string') return false;
  let text = title.slice(0, MAX_TITLE_CHARS);
  if (!text.match(LIVE_LABEL)) return false;
  const tail = text.match(TAIL);
  if (tail && withoutLiveLabels(tail[1]) && normalizeName(tail[2]) === normalizeName(publisher)) text = tail[1];
  const topic = withoutLiveLabels(text);
  if (!topic || EVENT.test(topic)) return false;
  const words = topic.split(' ');
  if (words.length < 2 || words.length > MAX_TOPIC_WORDS) return false;
  const isName = (word) => /^\p{Lu}/u.test(word);
  const last = words[words.length - 1];
  if (TOPIC.has(last.toLowerCase())) {
    if (last !== last.toLowerCase()) return words.length === 2 && isName(words[0]);
    return words.slice(0, -1).every(isName);
  }
  const [first, preposition, ...names] = words;
  return TOPIC.has(first.toLowerCase()) && first === first.toLowerCase()
    && PREPOSITION.has(preposition) && names.length > 0 && names.every(isName);
}
