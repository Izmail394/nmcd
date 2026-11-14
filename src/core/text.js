/**
 * Работа с русским текстом без внешних моделей: нормализация, лёгкий стеммер,
 * ключевые слова и сходство строк. Всё детерминировано.
 */

const STOPWORDS = new Set([
  'и',
  'в',
  'во',
  'на',
  'с',
  'со',
  'по',
  'из',
  'не',
  'или',
  'к',
  'от',
  'до',
  'за',
  'под',
  'при',
  'без',
  'а',
  'о',
  'об',
  'для',
  'над',
  'же',
  'ли',
  'то',
  'как',
  'что',
  'это',
  'их',
  'его',
  'также',
  'т',
  'д',
  'др',
  'тд',
  'тп',
  'поставка',
  'поставки',
  'закупка',
  'закупки',
  'приобретение',
  'оказание',
  'выполнение',
  'нужд',
  'нужды',
  'шт',
  'штук',
  'штука',
  'уп',
  'упак',
  'руб',
  'цена',
  'тип',
  'вид',
  'the',
  'of',
  'for',
  'and',
  'with',
]);

// Окончания по убыванию длины: срезается самое длинное подходящее.
const ENDINGS = [
  'иями',
  'ями',
  'ами',
  'ого',
  'его',
  'ому',
  'ему',
  'ыми',
  'ими',
  'иях',
  'ией',
  'ием',
  'ные',
  'ная',
  'ное',
  'ный',
  'ая',
  'яя',
  'ое',
  'ее',
  'ые',
  'ие',
  'ый',
  'ий',
  'ой',
  'ую',
  'юю',
  'ов',
  'ев',
  'ей',
  'ам',
  'ям',
  'ах',
  'ях',
  'ом',
  'ем',
  'ою',
  'ею',
  'ия',
  'ья',
  'ье',
  'ых',
  'их',
  'а',
  'я',
  'о',
  'е',
  'ы',
  'и',
  'у',
  'ю',
  'ь',
  'й',
].sort((a, b) => b.length - a.length);

const MIN_STEM = 3;

export function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"“”„']/g, ' ')
    .replace(/[^a-zа-я0-9.,/%+×x*-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Слова без пунктуации; числа и латиница сохраняются. */
export function tokenize(text) {
  return normalizeText(text)
    .split(/[\s,/×*+]+|(?<![0-9])[.-]|[.-](?![0-9])/)
    .map((token) => token.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((token) => token.length > 0);
}

export function stem(word) {
  if (!/^[а-я]+$/.test(word)) return word;
  for (const ending of ENDINGS) {
    if (word.length - ending.length >= MIN_STEM && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }
  return word;
}

export function isStopword(token) {
  return STOPWORDS.has(token);
}

/** Основы значимых слов: без стоп-слов, чисел и однобуквенных токенов. */
export function keywordStems(text) {
  const seen = new Set();
  const result = [];
  for (const token of tokenize(text)) {
    if (isStopword(token) || token.length < 2 || /^[0-9.,xх-]+$/.test(token)) continue;
    const stemmed = stem(token);
    if (!seen.has(stemmed)) {
      seen.add(stemmed);
      result.push(stemmed);
    }
  }
  return result;
}

/** Основы совпадают, если равны или одна — начало другой (при длине от 4 символов). */
export function stemsMatch(a, b) {
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

/** Индекс первого токена текста, совпавшего с основой; -1, если совпадений нет. */
export function findStem(stems, target) {
  return stems.findIndex((candidate) => stemsMatch(candidate, target));
}

function trigrams(text) {
  const padded = `  ${normalizeText(text)} `;
  const grams = new Map();
  for (let i = 0; i < padded.length - 2; i += 1) {
    const gram = padded.slice(i, i + 3);
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  return grams;
}

/** Коэффициент Дайса по символьным триграммам, 0..1. */
export function trigramSimilarity(a, b) {
  const first = trigrams(a);
  const second = trigrams(b);
  let total = 0;
  for (const count of first.values()) total += count;
  for (const count of second.values()) total += count;
  if (total === 0) return 0;
  let overlap = 0;
  for (const [gram, count] of first) overlap += Math.min(count, second.get(gram) ?? 0);
  return (2 * overlap) / total;
}

/** Доля триграмм эталона, найденных в тексте, 0..1 (несимметрично: длинный текст не штрафуется). */
export function trigramContainment(reference, text) {
  const first = trigrams(reference);
  const second = trigrams(text);
  let total = 0;
  let overlap = 0;
  for (const [gram, count] of first) {
    total += count;
    overlap += Math.min(count, second.get(gram) ?? 0);
  }
  return total === 0 ? 0 : overlap / total;
}

/** Число из строки вида "1 234,56" / "1234.56"; null, если это не число. */
export function parseNumber(text) {
  const cleaned = text.replace(/[\s  ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}
