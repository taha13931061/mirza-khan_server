// Profanity / abusive-language filter for chat messages, group names, and usernames.
// - censorText(text): masks bad words inside free-form chat text (keeps the message, hides the word)
// - containsProfanity(text): hard check used for usernames / group names (these get rejected outright,
//   not masked, since letting someone register as "***" defeats the point of a name)
//
// Approach: normalize the input (strip diacritics/zero-width chars, collapse letter-spacing tricks
// like "ک ص ک" or "ک.ص.ک", unify Arabic/Persian look-alike letters) before matching against a word
// list, so simple evasion (spaces, dots, repeated letters) doesn't slip through.

// Persian/Finglish bad-word list. Kept as normalized (space/diacritic-free) roots; matching happens
// on normalized text, so variants like "کصکش" / "ک ص ک ش" both hit the same root.
const BAD_WORDS = [
  'کسکش', 'کیرم', 'کیرت', 'کیرش', 'کون', 'کونی', 'کوسکش', 'کص', 'کوص', 'کصکش',
  'جنده', 'جاکش', 'ننتو', 'ننهتو', 'مادرجنده', 'مادرقحبه', 'قحبه', 'هرزه',
  'کیری', 'گاییدم', 'گاییدن', 'بگا', 'بکن تو کونت', 'کیرتو', 'کیردرکونی',
  'حرومزاده', 'حرومزادگی', 'زنیکه', 'عنتر', 'کونده', 'لاشی', 'لاشخور',
  'خارکسه', 'خایه', 'کسکشخان', 'اوبکن', 'کسمشنگ', 'کسخل', 'گوه', 'عوضی',
  'fuck', 'shit', 'bitch', 'asshole', 'motherfucker', 'dick', 'pussy', 'cunt',
  'kir', 'kos', 'kOs', 'jende', 'koon', 'koskesh', 'kiri', 'kirto', 'gooh', 'goh',
];

// Arabic-form letters mapped to their Persian equivalents, plus a couple of common
// typographic substitutions people use to dodge simple filters.
const CHAR_MAP = {
  '\u064A': '\u06CC', // ي -> ی
  '\u0643': '\u06A9', // ك -> ک
  '\u0629': '\u0647', // ة -> ه
  '\u0623': '\u0627', '\u0625': '\u0627', '\u0622': '\u0627', // أ إ آ -> ا
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '@': 'a', '$': 's',
};

function normalize(input) {
  let s = String(input || '');
  // strip zero-width and combining diacritic characters used to break up words
  s = s.replace(/[\u200B-\u200F\u064B-\u0652\uFEFF]/g, '');
  s = s.toLowerCase();
  s = s.split('').map(ch => CHAR_MAP[ch] || ch).join('');
  // collapse whitespace/punctuation gaps that are commonly inserted between letters
  // to dodge filters (e.g. "ک.ص.ک", "k i r"), while keeping normal word boundaries.
  s = s.replace(/[\s._\-*]+/g, '');
  // collapse 3+ repeats of the same character down to 1 ("کیرررر" -> "کیر")
  s = s.replace(/(.)\1{2,}/g, '$1');
  return s;
}

const NORMALIZED_BAD_WORDS = BAD_WORDS.map(normalize).filter(Boolean);

function containsProfanity(text) {
  const n = normalize(text);
  if (!n) return false;
  return NORMALIZED_BAD_WORDS.some(w => w && n.includes(w));
}

// Masks bad words in free chat text while leaving the rest of the message intact.
// Works word-by-word (splitting on whitespace) so the surrounding sentence survives;
// a message that's abusive across multiple words (spaced out to dodge detection) still
// gets caught because we also run a normalized full-text check as a fallback.
function censorText(text) {
  const original = String(text || '');
  if (!original) return original;

  const tokens = original.split(/(\s+)/); // keep whitespace as separate tokens
  let anyMasked = false;
  const maskedTokens = tokens.map(tok => {
    if (/^\s+$/.test(tok) || !tok) return tok;
    const n = normalize(tok);
    if (n && NORMALIZED_BAD_WORDS.some(w => w && n.includes(w))) {
      anyMasked = true;
      return '*'.repeat(Math.max(3, tok.length));
    }
    return tok;
  });

  if (anyMasked) return maskedTokens.join('');

  // Fallback: whole message reads clean word-by-word, but spacing out a slur across
  // several words could still slip through (e.g. "ک ی ر ت و"). Do a coarse full-text
  // check and, if it hits, mask the whole message rather than guessing which piece.
  if (containsProfanity(original)) return '*'.repeat(Math.max(3, original.length));

  return original;
}

module.exports = { censorText, containsProfanity, normalize };
