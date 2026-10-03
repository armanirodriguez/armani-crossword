// Junk detection: strings that are in the source lists but make bad (or invalid) crossword entries.
//
// Systematic junk found by inspecting SCOWL + WordNet:
//   - unit symbols / abbreviations with no vowel at all ("csc", "hhd", "kb") — always junk; a word whose only vowel
//     is Y is fine when WordNet knows it ("myth", "gym", "lynx") and junk otherwise ("tyg");
//   - abbreviations that do contain a vowel ("kcal", "tanh", "psia") — an explicit list (there is no reliable rule);
//   - Roman numerals ("xiv", "lx") unless WordNet knows the string as an ordinary word ("mix");
//   - letter runs / keyboard rows ("abc", "qwerty") and tripled letters ("brrr", "zzz");
//   - pseudo-plurals that SCOWL's inflection generator produced for function words ("hims", "shes", "whats");
//   - anything outside 3..21 letters.

/** Abbreviations / symbols that look like words. Lowercase. */
export const ABBREVIATIONS = new Set([
  'csc', 'csch', 'sech', 'sinh', 'tanh', 'coth', 'arccos', 'arcsin', 'arctan', 'cosec', 'kcal', 'psia', 'psid',
  'dkl', 'hhd', 'kph', 'mph', 'rpm', 'mpg', 'ibid', 'etc', 'esp', 'approx', 'ppm', 'mgr', 'pkg', 'pkt', 'pkos',
  'pko', 'asap', 'aka', 'lol', 'omg', 'btw', 'fyi', 'imho', 'diy', 'faq', 'faqs', 'url', 'urls', 'http', 'https', 'html',
  'kbps', 'mbps', 'gbps', 'khz', 'mhz', 'ghz', 'oz', 'lbs', 'tbsp', 'tsp', 'qty', 'pls', 'thx', 'msec', 'nsec',
  'usec', 'kwh', 'cwt', 'nth', 'pwn', 'pwns', 'pwned', 'pwning', 'mkay',
]);

/** Closed-class words whose "-s" plural is a generator artefact ("hims", "whats"). Idioms like IFS/ANDS/BUTS,
 *  WHYS/HOWS (the hows and whys) and DOS (dos and don'ts) are deliberately not listed. */
const FUNCTION_WORDS = new Set([
  'he', 'him', 'she', 'my', 'me', 'you', 'what', 'that', 'this', 'would', 'could', 'should', 'might', 'anything',
  'everything', 'something', 'nothing', 'yep', 'yup', 'yeah', 'nope', 'whatever', 'whoever', 'who', 'whom', 'thee',
  'ye', 'thy', 'thou', 'our', 'their', 'your', 'mine', 'itself', 'mkay', 'whoa', 'ugh', 'huh', 'hmm', 'meh', 'duh',
]);

const ROMAN = /^m{0,4}(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz';
const KEYBOARD = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

/**
 * Why a lowercase a–z candidate is junk, or null if it's acceptable.
 * `known(word)` -> true if WordNet knows the word (directly or as an inflection of a known lemma).
 */
export function junkReason(word, known = () => false) {
  const w = word.toLowerCase();
  if (!/^[a-z]+$/.test(w)) return 'non-letters';
  if (w.length < 3) return 'too short';
  if (w.length > 21) return 'too long';
  if (!/[aeiouy]/.test(w)) return 'no vowel';
  if (!/[aeiou]/.test(w) && !known(w)) return 'no vowel';
  if (/(.)\1\1/.test(w)) return 'tripled letter';
  if (ABBREVIATIONS.has(w)) return 'abbreviation';
  if (ROMAN.test(w) && !known(w)) return 'roman numeral';
  if (ALPHABET.includes(w) || KEYBOARD.some((row) => row.startsWith(w) && w.length >= 4)) return 'letter string';
  if (w.endsWith('s') && FUNCTION_WORDS.has(w.slice(0, -1)) && !known(w)) return 'function-word plural';
  return null;
}
