/**
 * Оценка сопоставимости предложения с предметом закупки.
 *
 * Сопоставимость определяется не только по названию: каждая существенная
 * характеристика из описания закупки проверяется по характеристикам и названию
 * предложения. Итог — оценка 0..1 и явная причина включения или исключения.
 */

import { findMeasurements } from './requirement.js';
import { findStem, keywordStems, normalizeText, parseNumber, stem, stemsMatch, tokenize, trigramContainment } from './text.js';
import { formatNumber } from './stats.js';

/** Латинские буквы и цифры вместе, не короче 4 символов, минимум две буквы: «cf283a», но не «a4» и не «3x2». */
const MODEL_CODE = /^(?=(?:.*[a-z]){2})(?=.*\d)[a-z0-9-]{4,}$/;

const COLOR_STEMS = [
  'бел',
  'черн',
  'син',
  'красн',
  'зелен',
  'желт',
  'сер',
  'коричнев',
  'оранжев',
  'фиолетов',
  'голуб',
  'розов',
  'бежев',
  'прозрачн',
  'серебрист',
];

function compareNumeric(attribute, found, tolerancePercent) {
  const required = attribute.numeric ?? 0;
  const epsilon = Math.abs(required) * 1e-9;
  if (attribute.comparator === 'ge') return found >= required - epsilon;
  if (attribute.comparator === 'le') return found <= required + epsilon;
  return Math.abs(found - required) <= (Math.abs(required) * tolerancePercent) / 100 + epsilon;
}

function nameMatches(attributeName, characteristicName) {
  const wanted = keywordStems(attributeName);
  const actual = keywordStems(characteristicName);
  return wanted.length > 0 && wanted.every((stemmed) => findStem(actual, stemmed) >= 0);
}

const RANGE_LOW = /(?:≥|>=|>|(?<![а-яa-z])не менее|(?<![а-яa-z])от)\s*(\d+(?:[.,]\d+)?)/i;
const RANGE_HIGH = /(?:≤|<=|<|(?<![а-яa-z])не более|(?<![а-яa-z])до)\s*(\d+(?:[.,]\d+)?)/i;

/** Значение-диапазон из КТРУ: «≥ 80 и < 90», «не менее 1500». null — в значении нет границ. */
function parseRange(value) {
  const low = RANGE_LOW.exec(value);
  const high = RANGE_HIGH.exec(value);
  if (!low && !high) return null;
  const toNumber = (match, fallback) => (match ? Number((match[1] ?? '').replace(',', '.')) : fallback);
  return { low: toNumber(low, Number.NEGATIVE_INFINITY), high: toNumber(high, Number.POSITIVE_INFINITY) };
}

function rangeVerdict(attribute, range, tolerancePercent) {
  const required = attribute.numeric ?? 0;
  if (attribute.comparator === 'ge') return range.low >= required ? 'match' : range.high < required ? 'mismatch' : 'unknown';
  if (attribute.comparator === 'le') return range.high <= required ? 'match' : range.low > required ? 'mismatch' : 'unknown';
  const slack = (Math.abs(required) * tolerancePercent) / 100;
  return required >= range.low - slack && required <= range.high + slack ? 'match' : 'mismatch';
}

/** Название характеристики источника соответствует требуемой: по словам или по синонимам из правил. */
function characteristicMatches(attributeName, characteristicName, rules) {
  if (nameMatches(attributeName, characteristicName)) return true;
  const normalized = normalizeText(characteristicName);
  return (rules.synonyms[attributeName] ?? []).some((synonym) => normalized.includes(normalizeText(synonym)));
}

function checkNumeric(attribute, offer, rules) {
  const tolerancePercent = rules.relevance.numericTolerancePercent;
  const base = { name: attribute.name, required: attribute.value, importance: attribute.importance };
  const unit = attribute.unit ?? '';

  // 1. Характеристика с тем же названием — самый надёжный источник.
  for (const [name, value] of Object.entries(offer.characteristics)) {
    if (!characteristicMatches(attribute.name, name, rules)) continue;
    const range = parseRange(value);
    if (range) {
      const verdict = rangeVerdict(attribute, range, tolerancePercent);
      if (verdict === 'unknown') continue;
      return { ...base, found: `${name}: ${value}`.trim(), verdict, foundIn: 'characteristics' };
    }
    const measured = findMeasurements(`${value} ${name.includes(unit) ? unit : ''}`).find((item) => item.unit === unit);
    const bare = measured ? null : parseNumber(value.replace(/[^\d.,\s-]/g, '').trim());
    const numeric = measured?.numeric ?? bare;
    if (numeric === null || numeric === undefined) continue;
    const ok = compareNumeric(attribute, numeric, tolerancePercent);
    return { ...base, found: `${value}`.trim(), verdict: ok ? 'match' : 'mismatch', foundIn: 'characteristics' };
  }

  // 2. Любая характеристика со значением в той же единице.
  const fromCharacteristics = Object.entries(offer.characteristics).flatMap(([name, value]) =>
    findMeasurements(`${name} ${value}`)
      .filter((item) => item.unit === unit)
      .map((item) => ({ ...item, label: `${name}: ${value}` })),
  );
  const charMatch = fromCharacteristics.find((item) => compareNumeric(attribute, item.numeric, tolerancePercent));
  if (charMatch) return { ...base, found: charMatch.label, verdict: 'match', foundIn: 'characteristics' };

  // 3. Название предложения.
  const fromTitle = findMeasurements(offer.title).filter((item) => item.unit === unit);
  const titleMatch = fromTitle.find((item) => compareNumeric(attribute, item.numeric, tolerancePercent));
  if (titleMatch) return { ...base, found: `${formatNumber(titleMatch.numeric, 3)} ${unit}`, verdict: 'match', foundIn: 'title' };

  // Несовпадение фиксируется, только если значение в этой единице ровно одно — иначе неясно, к чему оно относится.
  const candidates = [
    ...fromCharacteristics.map((item) => ({ numeric: item.numeric, where: 'characteristics' })),
    ...fromTitle.map((item) => ({ numeric: item.numeric, where: 'title' })),
  ];
  const distinct = [...new Set(candidates.map((item) => item.numeric))];
  if (distinct.length === 1 && candidates[0]) {
    return { ...base, found: `${formatNumber(candidates[0].numeric, 3)} ${unit}`, verdict: 'mismatch', foundIn: candidates[0].where };
  }
  return {
    ...base,
    found: null,
    verdict: 'unknown',
    note:
      distinct.length > 1 ? `В предложении несколько значений в «${unit}», ни одно не совпало однозначно.` : 'В предложении нет данных об этой характеристике.',
  };
}

function checkFormat(attribute, offer, haystack) {
  const base = { name: attribute.name, required: attribute.value, importance: attribute.importance };
  const digit = attribute.value.slice(-1);
  const formats = [...haystack.matchAll(/(?<![a-zа-я0-9])[aа]\s?([0-6])(?![0-9a-zа-я])/g)].map((match) => match[1]);
  if (formats.includes(digit))
    return {
      ...base,
      found: `A${digit}`,
      verdict: 'match',
      foundIn: normalizeText(offer.title).match(new RegExp(`[aа]\\s?${digit}`)) ? 'title' : 'characteristics',
    };
  if (formats.length > 0) return { ...base, found: `A${formats[0]}`, verdict: 'mismatch', foundIn: 'title' };
  return { ...base, found: null, verdict: 'unknown', note: 'Формат в предложении не указан.' };
}

function normalizeSizes(text) {
  return text
    .toLowerCase()
    .replace(/,/g, '.')
    .replace(/\s?[xх×*]\s?/g, 'x');
}

function checkSize(attribute, haystack) {
  const base = { name: attribute.name, required: attribute.value, importance: attribute.importance };
  const sizes = [...normalizeSizes(haystack).matchAll(/\d+(?:\.\d+)?(?:x\d+(?:\.\d+)?)+/g)].map((match) => match[0]);
  const canonical = (size) =>
    size
      .split('x')
      .map((part) => String(Number(part)))
      .join('x');
  const wanted = canonical(attribute.value);
  if (sizes.some((size) => canonical(size) === wanted)) return { ...base, found: attribute.value, verdict: 'match', foundIn: 'title' };
  if (sizes.length > 0) return { ...base, found: sizes[0] ?? null, verdict: 'mismatch', foundIn: 'title' };
  return { ...base, found: null, verdict: 'unknown', note: 'Типоразмер в предложении не указан.' };
}

function checkText(attribute, offer, titleStems) {
  const base = { name: attribute.name, required: attribute.value, importance: attribute.importance };
  const wanted = keywordStems(attribute.value);
  if (wanted.length === 0) {
    // Короткие обозначения («A+», «2») сравниваются как есть.
    const literal = normalizeText(attribute.value);
    for (const [name, value] of Object.entries(offer.characteristics)) {
      if (!nameMatches(attribute.name, name)) continue;
      const same = normalizeText(value).split(' ').includes(literal);
      return { ...base, found: value, verdict: same ? 'match' : 'mismatch', foundIn: 'characteristics' };
    }
    return { ...base, found: null, verdict: 'unknown', note: 'В предложении нет данных об этой характеристике.' };
  }
  for (const [name, value] of Object.entries(offer.characteristics)) {
    if (!nameMatches(attribute.name, name)) continue;
    const actual = keywordStems(value);
    const same = wanted.every((stemmed) => findStem(actual, stemmed) >= 0);
    return { ...base, found: value, verdict: same ? 'match' : 'mismatch', foundIn: 'characteristics' };
  }
  if (wanted.every((stemmed) => findStem(titleStems, stemmed) >= 0)) {
    return { ...base, found: attribute.value, verdict: 'match', foundIn: 'title' };
  }
  if (attribute.name === 'цвет') {
    const other = COLOR_STEMS.find((color) => !wanted.some((stemmed) => stemsMatch(stemmed, color)) && titleStems.some((token) => token.startsWith(color)));
    if (other) return { ...base, found: `другой цвет («${other}…»)`, verdict: 'mismatch', foundIn: 'title' };
  }
  return { ...base, found: null, verdict: 'unknown', note: 'В предложении нет данных об этой характеристике.' };
}

function checkAttribute(attribute, offer, haystack, titleStems, rules) {
  if (attribute.numeric !== undefined && attribute.unit) return checkNumeric(attribute, offer, rules);
  if (attribute.name === 'формат') return checkFormat(attribute, offer, haystack);
  if (attribute.name === 'типоразмер') return checkSize(attribute, haystack);
  return checkText(attribute, offer, titleStems);
}

function okpd2Match(required, actual) {
  if (!required || !actual) return 'n/a';
  const a = required.trim();
  const b = actual.trim();
  if (a === b || a.startsWith(b) || b.startsWith(a)) return 'exact';
  return a.slice(0, 5) === b.slice(0, 5) ? 'prefix' : 'none';
}

function list(values) {
  return values.join(', ');
}

export function evaluateRelevance(offer, requirement, rules) {
  const titleTokens = tokenize(offer.title);
  const titleStems = titleTokens.map(stem);
  const characteristicsText = Object.entries(offer.characteristics)
    .map(([name, value]) => `${name} ${value}`)
    .join(' ');
  const allStems = [...titleStems, ...tokenize(characteristicsText).map(stem)];
  const haystack = normalizeText(`${offer.title} ${characteristicsText}`);

  const matchedKeywords = [];
  const missingKeywords = [];
  for (const keyword of requirement.keywords) {
    (findStem(allStems, keyword) >= 0 ? matchedKeywords : missingKeywords).push(keyword);
  }
  const coverage = requirement.keywords.length > 0 ? matchedKeywords.length / requirement.keywords.length : 0;
  const textScore = Math.min(1, 0.7 * coverage + 0.3 * trigramContainment(requirement.subject, offer.title));

  const checks = requirement.attributes.map((attribute) => checkAttribute(attribute, offer, haystack, titleStems, rules));
  let attributeScore = null;
  if (checks.length > 0) {
    let weightSum = 0;
    let credit = 0;
    for (const check of checks) {
      const weight = check.importance === 'must' ? 1 : 0.5;
      weightSum += weight;
      credit += weight * (check.verdict === 'match' ? 1 : check.verdict === 'unknown' ? rules.relevance.unknownAttributeCredit : 0);
    }
    attributeScore = credit / weightSum;
  }

  const okpd2 = okpd2Match(requirement.okpd2, offer.okpd2);
  const { weights } = rules.relevance;
  let weightTotal = weights.text;
  let score = weights.text * textScore;
  if (attributeScore !== null) {
    weightTotal += weights.attributes;
    score += weights.attributes * attributeScore;
  }
  if (okpd2 !== 'n/a') {
    weightTotal += weights.okpd2;
    score += weights.okpd2 * (okpd2 === 'exact' ? 1 : okpd2 === 'prefix' ? 0.6 : 0);
  }
  score = weightTotal > 0 ? Math.round((score / weightTotal) * 100) / 100 : 0;

  const relevance = {
    score,
    textScore: Math.round(textScore * 100) / 100,
    attributeScore: attributeScore === null ? null : Math.round(attributeScore * 100) / 100,
    okpd2Match: okpd2,
    checks,
    matchedKeywords,
    missingKeywords,
  };

  const matched = checks.filter((check) => check.verdict === 'match');
  const unknown = checks.filter((check) => check.verdict === 'unknown');
  const mismatched = checks.filter((check) => check.verdict === 'mismatch');
  const scoreText = formatNumber(score, 2);

  // --- Причины исключения, от самой однозначной к менее однозначной ---
  const head = requirement.keywords[0];
  if (head) {
    const headIndex = findStem(titleStems, head);
    if (headIndex < 0 && findStem(allStems, head) < 0) {
      return {
        relevance,
        summary: '',
        exclusion: { code: 'low_relevance', reason: `Другой предмет: в наименовании и характеристиках нет ключевого слова «${head}…» (оценка ${scoreText}).` },
      };
    }
    const precededByFor = headIndex > 0 && titleTokens.slice(Math.max(0, headIndex - 2), headIndex).includes('для');
    if (precededByFor) {
      return {
        relevance,
        summary: '',
        exclusion: { code: 'accessory', reason: `Сопутствующий товар, а не предмет закупки: «${head}…» встречается только в обороте «для …».` },
      };
    }
  }
  // Обозначение модели или артикул из описания закупки (CF283A, RTX4060) должно присутствовать в предложении.
  const missingCodes = requirement.keywords.filter((keyword) => MODEL_CODE.test(keyword) && findStem(allStems, keyword) < 0);
  if (missingCodes.length > 0) {
    return {
      relevance,
      summary: '',
      exclusion: {
        code: 'attribute_mismatch',
        reason: `Другая модель или артикул: в предложении нет обозначения «${list(missingCodes.map((code) => code.toUpperCase()))}».`,
      },
    };
  }
  const mustMismatch = mismatched.filter((check) => check.importance === 'must');
  if (mustMismatch.length > 0) {
    const details = mustMismatch.map((check) => `${check.name}: требуется ${check.required}, в предложении ${check.found}`);
    return { relevance, summary: '', exclusion: { code: 'attribute_mismatch', reason: `Несопоставимые характеристики — ${details.join('; ')}.` } };
  }
  const must = checks.filter((check) => check.importance === 'must');
  const confirmed = must.filter((check) => check.verdict === 'match');
  // Совпадение кода ОКПД2 засчитывается как одна подтверждённая существенная характеристика:
  // реестр контрактов публикует код всегда, а полный набор характеристик — нет.
  const codeBonus = okpd2 === 'exact' ? 1 : 0;
  if (must.length > 0 && (confirmed.length + codeBonus) / (must.length + codeBonus) < rules.relevance.minConfirmedMustShare) {
    const missing = must.filter((check) => check.verdict !== 'match').map((check) => `${check.name} (${check.required})`);
    return {
      relevance,
      summary: '',
      exclusion: {
        code: 'missing_data',
        reason: `Недостаточно данных для сопоставления: в предложении не подтверждены существенные характеристики — ${list(missing)}; подтверждено ${confirmed.length} из ${must.length}.`,
      },
    };
  }
  if (coverage < rules.relevance.minKeywordCoverage) {
    return {
      relevance,
      summary: '',
      exclusion: {
        code: 'low_relevance',
        reason: `Низкое сходство наименования: найдено ${matchedKeywords.length} из ${requirement.keywords.length} ключевых слов (нет: ${list(missingKeywords)}); оценка ${scoreText}.`,
      },
    };
  }
  if (score < rules.relevance.minScore) {
    return {
      relevance,
      summary: '',
      exclusion: {
        code: 'low_relevance',
        reason: `Оценка сопоставимости ${scoreText} ниже порога ${formatNumber(rules.relevance.minScore, 2)}: подтверждено характеристик ${matched.length} из ${checks.length}.`,
      },
    };
  }

  const parts = [`Оценка сопоставимости ${scoreText}`, `ключевые слова: ${matchedKeywords.length} из ${requirement.keywords.length}`];
  if (matched.length > 0) parts.push(`подтверждено: ${list(matched.map((check) => `${check.name} ${check.required}`))}`);
  if (unknown.length > 0) parts.push(`нет данных: ${list(unknown.map((check) => check.name))}`);
  const softMismatch = mismatched.filter((check) => check.importance !== 'must');
  if (softMismatch.length > 0) parts.push(`отличается (несущественно): ${list(softMismatch.map((check) => `${check.name} — ${check.found}`))}`);
  if (okpd2 === 'exact') parts.push('ОКПД2 совпадает');
  if (okpd2 === 'prefix') parts.push('ОКПД2 совпадает по классу');
  return { relevance, summary: `${parts.join('; ')}.` };
}
