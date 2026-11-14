/**
 * Правила сопоставления и расчёта. Значения по умолчанию можно переопределить в
 * config/rules.json — основная логика при этом не меняется. Снимок действующих
 * правил сохраняется в каждом отчёте.
 */
import fs from 'node:fs';

export const DEFAULT_RULES = {
  collect: { perSourceLimit: 15, perSourceTimeoutMs: 45_000 },
  relevance: {
    minScore: 0.5,
    weights: { text: 0.45, attributes: 0.45, okpd2: 0.1 },
    numericTolerancePercent: 5,
    unknownAttributeCredit: 0.4,
    minKeywordCoverage: 0.5,
    minConfirmedMustShare: 0.75,
  },
  priority: { preferPrimary: 1 },
  synonyms: {
    плотность: ['масса бумаги площадью 1м2', 'масса бумаги площадью 1 м2', 'масса 1 м2'],
    ресурс: ['ресурс картриджа', 'ресурс печати', 'количество страниц'],
    диагональ: ['размер диагонали', 'диагональ экрана'],
    мощность: ['номинальная мощность', 'потребляемая мощность'],
    сечение: ['сечение жилы', 'номинальное сечение'],
    напряжение: ['номинальное напряжение'],
  },
  normalize: { maxPackScaleUp: 2 },
  freshness: { maxAgeMonths: 36, indexAfterMonths: 6 },
  vat: { ratePercent: 22 },
  outliers: {
    minPrices: 3,
    cvThresholdPercent: 33,
    iqrFactor: 1.5,
    minForIqr: 5,
    minDeviationPercent: 20,
    medianRatioLow: 0.5,
    medianRatioHigh: 2,
  },
};

function isPlain(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Накладывает переопределения на значения по умолчанию; неизвестные ключи и нечисловые значения — ошибка. */
function merge(base, overrides, trail) {
  const result = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (key.startsWith('_')) continue; // комментарии в JSON
    const location = trail ? `${trail}.${key}` : key;
    if (!(key in base)) throw new Error(`config/rules.json: неизвестный параметр «${location}»`);
    const current = base[key];
    if (isPlain(current)) {
      if (!isPlain(value)) throw new Error(`config/rules.json: «${location}» должен быть объектом`);
      result[key] = merge(current, value, location);
    } else {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        throw new Error(`config/rules.json: «${location}» должен быть неотрицательным числом`);
      }
      result[key] = value;
    }
  }
  return result;
}

export function resolveRules(overrides) {
  if (overrides === undefined || overrides === null) return structuredClone(DEFAULT_RULES);
  if (!isPlain(overrides)) throw new Error('config/rules.json: ожидался объект');
  // Синонимы — единственный нечисловой раздел: проверяется отдельно и дополняет значения по умолчанию.
  const { synonyms, ...numeric } = overrides;
  const { synonyms: defaultSynonyms, ...defaults } = structuredClone(DEFAULT_RULES);
  const merged = merge(defaults, numeric, '');
  const rules = { ...merged, synonyms: defaultSynonyms };
  if (synonyms !== undefined) {
    if (!isPlain(synonyms)) throw new Error('config/rules.json: «synonyms» должен быть объектом');
    for (const [name, list] of Object.entries(synonyms)) {
      if (name.startsWith('_')) continue;
      if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || !item.trim())) {
        throw new Error(`config/rules.json: «synonyms.${name}» должен быть массивом непустых строк`);
      }
      rules.synonyms[name.toLowerCase()] = list;
    }
  }
  if (rules.outliers.minPrices < 2) throw new Error('config/rules.json: outliers.minPrices не может быть меньше 2');
  if (rules.relevance.minScore > 1) throw new Error('config/rules.json: relevance.minScore должен быть в диапазоне 0..1');
  return rules;
}

export function loadRules(file) {
  if (!fs.existsSync(file)) return structuredClone(DEFAULT_RULES);
  return resolveRules(JSON.parse(fs.readFileSync(file, 'utf8')));
}
