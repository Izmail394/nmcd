/**
 * Конвейер обоснования НМЦД:
 *   описание закупки -> требование -> сбор предложений -> проверка и дубли ->
 *   сопоставимость -> приведение цен -> выбросы -> расчёт -> отчёт.
 *
 * Все числа считает детерминированный код по заданным правилам.
 */
import { randomBytes } from 'node:crypto';
import { SourceError } from './http.js';
import { findDuplicates } from './dedupe.js';
import { normalizePrice } from './normalize.js';
import { evaluateRelevance } from './relevance.js';
import { buildRequirement } from './requirement.js';
import { calculate, formatMoney, formatNumber } from './stats.js';

const MANUAL_SOURCE = { id: 'manual', name: 'Коммерческие предложения (введены вручную)', kind: 'manual', homepage: '' };

const EXCLUSION_LABELS = {
  duplicate: 'дубли',
  low_relevance: 'низкая сопоставимость',
  attribute_mismatch: 'несопоставимые характеристики',
  unit_incompatible: 'неподходящая единица измерения',
  missing_data: 'недостаток данных',
  stale: 'устаревшая цена',
  accessory: 'сопутствующий товар',
  outlier: 'аномальная цена',
  lower_priority: 'ниже по приоритету источников',
  user_excluded: 'исключено пользователем',
};

export function createReportId(now) {
  const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `r${stamp}-${randomBytes(3).toString('hex')}`;
}

function isHttpUrl(value) {
  try {
    const { protocol } = new URL(value);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
}

/** Что не так с предложением как с записью данных; null — всё на месте. */
function validateOffer(offer) {
  const missing = [];
  if (!offer.title?.trim()) missing.push('наименование');
  if (typeof offer.priceRub !== 'number' || !Number.isFinite(offer.priceRub) || offer.priceRub <= 0) missing.push('цена');
  if (offer.sourceId !== MANUAL_SOURCE.id && !isHttpUrl(offer.url)) missing.push('ссылка на источник');
  if (!offer.fetchedAt) missing.push('дата получения');
  return missing.length > 0 ? `Недостаточно данных: отсутствует ${missing.join(', ')}.` : null;
}

async function collectFromSource(source, requirement, deps) {
  const started = Date.now();
  const [text = requirement.subject, ...altTexts] = requirement.searchQueries;
  const base = { sourceId: source.id, sourceName: source.name, kind: source.kind, homepage: source.homepage, queriesTried: [text, ...altTexts] };
  const signal = AbortSignal.timeout(deps.rules.collect.perSourceTimeoutMs);
  try {
    const offers = await source.search(
      { text, altTexts, okpd2: requirement.okpd2, region: requirement.region, limit: deps.rules.collect.perSourceLimit },
      { http: deps.http, signal, log: (message) => deps.log?.(`[${source.id}] ${message}`), now: deps.now },
    );
    if (!Array.isArray(offers)) throw new SourceError('parse', 'Адаптер вернул не массив предложений');
    const limited = offers.slice(0, deps.rules.collect.perSourceLimit).map((offer) => ({ ...offer, sourceId: source.id }));
    return { run: { ...base, status: limited.length > 0 ? 'ok' : 'empty', offersFound: limited.length, durationMs: Date.now() - started }, offers: limited };
  } catch (error) {
    const timedOut = signal.aborted;
    const kind = error instanceof SourceError ? error.kind : timedOut ? 'timeout' : 'internal';
    const message =
      error instanceof SourceError
        ? error.message
        : timedOut
          ? `Источник не уложился в ${deps.rules.collect.perSourceTimeoutMs} мс`
          : `Внутренняя ошибка адаптера: ${error instanceof Error ? error.message : String(error)}`;
    deps.log?.(`[${source.id}] ошибка (${kind}): ${message}`);
    return { run: { ...base, status: 'error', offersFound: 0, durationMs: Date.now() - started, errorKind: kind, errorMessage: message }, offers: [] };
  }
}

function manualOffers(request, now) {
  return (request.manualOffers ?? []).map((input, index) => ({
    sourceId: MANUAL_SOURCE.id,
    externalId: `manual-${index + 1}`,
    url: input.url && isHttpUrl(input.url) ? input.url : '',
    title: input.title,
    priceRub: input.priceRub,
    unitText: input.unit?.trim() || null,
    vat: input.vat ?? 'unknown',
    characteristics: {},
    supplier: input.supplier?.trim() || undefined,
    priceDate: input.priceDate || undefined,
    fetchedAt: now.toISOString(),
    evidence: 'Введено пользователем вручную',
  }));
}

function includedReason(summary, offer) {
  const adjusted = offer.price.adjustments.filter((adjustment) => adjustment.factor !== 1).length;
  const price =
    offer.price.unitPriceRub === null
      ? ''
      : ` Цена за 1 ${offer.price.unitCode}: ${formatMoney(offer.price.unitPriceRub)} руб.${adjusted > 0 ? ' (приведена)' : ''}`;
  return `${summary}${price}`;
}

const PRIMARY_KINDS = new Set(['contract_registry', 'gov_catalog', 'aggregator', 'manual']);

/**
 * Ключ независимости цены: разные контракты реестра и разные поставщики КП — независимые наблюдения,
 * а несколько предложений одного магазина — нет.
 */
function independenceKey(offer) {
  if (offer.sourceKind === 'contract_registry') return `${offer.raw.sourceId}:${offer.raw.externalId.replace(/-[^-]*$/, '')}`;
  if (offer.sourceKind === 'manual') return `manual:${offer.raw.supplier ?? offer.raw.externalId}`;
  return offer.raw.sourceId;
}

/** Предложение прошло все проверки до статистики и может участвовать в расчёте. */
function isCandidate(offer) {
  return offer.decision.stage === 'final' || offer.decision.stage === 'statistics' || offer.decision.stage === 'user';
}

function reliabilityOf(calculation, offers) {
  if (calculation.status === 'insufficient_data' || calculation.cv === null) {
    return { score: 0, level: 'нет данных', factors: [] };
  }
  const used = offers.filter((offer) => calculation.usedOffers.includes(offer.n));
  const factors = [];

  const count = used.length;
  factors.push({ name: 'Число цен в расчёте', value: String(count), points: count >= 5 ? 25 : count === 4 ? 20 : 15, max: 25 });

  const cv = calculation.cv;
  factors.push({ name: 'Однородность (коэффициент вариации)', value: `${formatNumber(cv)}%`, points: cv <= 10 ? 25 : cv <= 20 ? 20 : 12, max: 25 });

  const sources = new Set(used.map(independenceKey)).size;
  factors.push({
    name: 'Независимые источники цен (контракты, поставщики, площадки)',
    value: String(sources),
    points: sources >= 3 ? 20 : sources === 2 ? 14 : 6,
    max: 20,
  });

  const scores = used.map((offer) => offer.relevance?.attributeScore).filter((score) => typeof score === 'number');
  const confirmed = scores.length > 0 ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
  factors.push({
    name: 'Подтверждённость характеристик',
    value: confirmed === null ? 'характеристики не заданы' : `${Math.round(confirmed * 100)}%`,
    points: confirmed === null ? 10 : Math.round(confirmed * 20),
    max: 20,
  });

  const official = used.filter((offer) => ['contract_registry', 'gov_catalog', 'aggregator'].includes(offer.sourceKind)).length;
  const share = official / used.length;
  factors.push({
    name: 'Доля государственных источников (ЕИС, ГИСП, агрегаторы)',
    value: `${Math.round(share * 100)}%`,
    points: Math.round(share * 10),
    max: 10,
  });

  const score = factors.reduce((sum, factor) => sum + factor.points, 0);
  return { score, level: score >= 75 ? 'высокая' : score >= 50 ? 'средняя' : 'низкая', factors };
}

/**
 * Статистический этап. Вызывается и при первом расчёте, и при пересчёте после
 * ручных правок: результат зависит только от предложений и правил.
 */
export function applyStatistics(offers, requirement, rules, overrides = { exclude: [], include: [] }) {
  const exclude = new Set(overrides.exclude);
  const include = new Set(overrides.include);

  for (const offer of offers) {
    // Вернуть автоматическое решение, если ручная правка снята.
    if (offer.automaticDecision && !exclude.has(offer.n) && !include.has(offer.n)) {
      offer.decision = offer.automaticDecision;
      delete offer.automaticDecision;
    }
    if (include.has(offer.n) && !isCandidate(offer) && offer.price.unitPriceRub !== null) {
      offer.automaticDecision ??= offer.decision;
      offer.decision = {
        included: true,
        reason: `Включено пользователем вручную. Автоматическое решение было: ${offer.automaticDecision.reason}`,
        stage: 'user',
      };
    }
  }

  const candidates = offers.filter((offer) => isCandidate(offer) && offer.price.unitPriceRub !== null);
  for (const offer of candidates) {
    if (exclude.has(offer.n)) {
      offer.automaticDecision ??= offer.decision;
      offer.decision = { included: false, code: 'user_excluded', reason: 'Исключено пользователем вручную.', stage: 'user' };
    }
  }
  // Приоритет источников: реестр контрактов — главный источник, цены магазинов привлекаются при нехватке данных.
  let pool = candidates.filter((offer) => !exclude.has(offer.n));
  // Один контракт — одно наблюдение цены: остальные позиции того же контракта в расчёт не идут,
  // иначе несколько строк одного контракта выглядели бы как независимые цены.
  const sameContract = new Map();
  const firstOfContract = new Map();
  for (const offer of pool) {
    if (offer.sourceKind !== 'contract_registry') continue;
    const key = independenceKey(offer);
    const first = firstOfContract.get(key);
    if (first === undefined || (include.has(offer.n) && !include.has(first))) {
      if (first !== undefined) sameContract.set(first, offer.n);
      firstOfContract.set(key, offer.n);
    } else {
      sameContract.set(offer.n, first);
    }
  }
  const contractDecisions = new Map(
    [...sameContract].map(([n, keptN]) => [
      n,
      { included: false, code: 'duplicate', reason: `Другая позиция того же контракта: один контракт — одно наблюдение цены, в расчёте учтена позиция №${keptN}. При необходимости эту позицию можно включить вручную.`, stage: 'statistics' },
    ]),
  );
  pool = pool.filter((offer) => !contractDecisions.has(offer.n) || include.has(offer.n));
  const lowered = new Map();
  const primary = pool.filter((offer) => PRIMARY_KINDS.has(offer.sourceKind));
  if (rules.priority.preferPrimary > 0 && primary.length >= rules.outliers.minPrices && primary.length < pool.length) {
    const reason =
      `Не использовано в расчёте: сопоставимых цен из приоритетных источников (реестр контрактов ЕИС, государственные каталоги и агрегаторы, введённые КП) достаточно — ${primary.length}. ` +
      `Цены магазинов и каталогов привлекаются, только если приоритетных цен меньше ${rules.outliers.minPrices}. Предложение сопоставимо; его можно включить вручную.`;
    for (const offer of pool) {
      if (PRIMARY_KINDS.has(offer.sourceKind)) continue;
      const decision = { included: false, code: 'lower_priority', reason, stage: 'statistics' };
      if (include.has(offer.n)) {
        offer.automaticDecision ??= decision;
        offer.decision = { included: true, reason: `Включено пользователем вручную. Автоматическое решение было: ${reason}`, stage: 'user' };
      } else {
        lowered.set(offer.n, decision);
      }
    }
    pool = pool.filter((offer) => !lowered.has(offer.n));
  }
  const points = pool.map((offer) => ({ n: offer.n, price: offer.price.unitPriceRub }));

  const { calculation, excluded } = calculate(points, requirement.quantity, requirement.unit.code, rules);
  for (const offer of candidates) {
    if (exclude.has(offer.n)) continue;
    const removal = excluded.get(offer.n);
    const forced = include.has(offer.n) && offer.automaticDecision !== undefined;
    const low = lowered.get(offer.n) ?? (include.has(offer.n) ? undefined : contractDecisions.get(offer.n));
    if (low) {
      offer.decision = low;
    } else if (removal) {
      offer.decision = { included: false, code: removal.code, reason: removal.reason, stage: 'statistics' };
    } else if (!forced) {
      // Предложение прошло отбор. Если цена по выборке не сформирована, это сказано прямо в причине,
      // чтобы отметку «включено» нельзя было принять за участие в рассчитанной НМЦД.
      const pending = calculation.status === 'ok' ? '' : ' Сопоставимо, но НМЦД по выборке не сформирована — причина указана в расчёте.';
      offer.decision = {
        included: true,
        reason: `${includedReason(offer.inclusionSummary ?? 'Сопоставимо с предметом закупки.', offer)}${pending}`,
        stage: 'final',
      };
    }
  }
  if (calculation.status === 'ok') {
    const observations = new Set(offers.filter((offer) => calculation.usedOffers.includes(offer.n)).map(independenceKey));
    if (observations.size === 1) calculation.warnings.push('Все цены получены из одного источника — рекомендуется дополнить выборку.');
  }
  if (lowered.size > 0) {
    calculation.warnings.push(`Расчёт выполнен по приоритетным источникам; сопоставимых цен магазинов и каталогов не использовано: ${lowered.size}.`);
  }
  return { calculation, reliability: reliabilityOf(calculation, offers) };
}

function countBy(items, key) {
  const counts = new Map();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return counts;
}

export function buildTrace(report) {
  const { requirement, sources, offers, calculation } = report;
  const trace = [];

  trace.push({
    step: '1. Разбор описания закупки',
    summary: `Предмет: «${requirement.subject}»; количество: ${formatNumber(requirement.quantity, 3)} ${requirement.unit.code}; существенных характеристик: ${requirement.attributes.length}.`,
    details: [
      ...requirement.attributes.map(
        (attribute) => `${attribute.name}: ${attribute.value} (${attribute.importance === 'must' ? 'существенная' : 'дополнительная'})`,
      ),
      ...(requirement.okpd2 ? [`ОКПД2: ${requirement.okpd2}`] : []),
      `Поисковые запросы: ${requirement.searchQueries.map((query) => `«${query}»`).join(', ')}`,
      ...requirement.notes,
    ],
  });

  const answered = sources.filter((run) => run.status === 'ok').length;
  trace.push({
    step: '2. Поиск предложений в открытых источниках',
    summary: `Опрошено источников: ${sources.length}; с результатами: ${answered}; найдено предложений: ${offers.length}.`,
    details: sources.map((run) =>
      run.status === 'error'
        ? `${run.sourceName}: недоступен — ${run.errorMessage} [${run.errorKind}]`
        : `${run.sourceName}: ${run.status === 'empty' ? 'ничего не найдено' : `${run.offersFound} предложений`} за ${run.durationMs} мс`,
    ),
  });

  const excluded = offers.filter((offer) => !offer.decision.included);
  const byCode = countBy(excluded, (offer) => offer.decision.code ?? 'other');
  const preStat = ['missing_data', 'duplicate', 'low_relevance', 'accessory', 'attribute_mismatch', 'unit_incompatible', 'stale'];
  trace.push({
    step: '3. Проверка данных, удаление дублей, оценка сопоставимости',
    summary: `Из ${offers.length} предложений отсеяно до расчёта: ${preStat.reduce((sum, code) => sum + (byCode.get(code) ?? 0), 0)}.`,
    details: preStat.filter((code) => byCode.has(code)).map((code) => `${EXCLUSION_LABELS[code]}: ${byCode.get(code)}`),
  });

  const adjusted = offers.filter((offer) => offer.price.adjustments.some((adjustment) => adjustment.factor !== 1));
  trace.push({
    step: '4. Приведение цен к сопоставимому виду',
    summary: `Цена за 1 ${requirement.unit.code}; пересчитано предложений: ${adjusted.length} (единицы измерения, фасовка, НДС, индексация).`,
    details: adjusted.slice(0, 30).map(
      (offer) =>
        `№${offer.n}: ${offer.price.adjustments
          .filter((adjustment) => adjustment.factor !== 1)
          .map((adjustment) => adjustment.description)
          .join(' ')}`,
    ),
  });

  trace.push({
    step: '5. Исключение аномальных цен',
    summary:
      calculation.outlierSteps.length === 0
        ? 'Этап не выполнялся: недостаточно сопоставимых цен.'
        : `Исключено: ${calculation.outlierSteps.reduce((sum, step) => sum + step.removed.length, 0)}.`,
    details: calculation.outlierSteps.flatMap((step) => [step.description, ...step.removed.map((removed) => `№${removed.n}: ${removed.why}`)]),
  });

  trace.push({
    step: '6. Расчёт',
    summary:
      calculation.status === 'ok'
        ? `НМЦД = ${formatMoney(calculation.total ?? 0)} руб.; цена за единицу ${formatMoney(calculation.unitPrice ?? 0)} руб.; n = ${calculation.count}; V = ${formatNumber(calculation.cv ?? 0)}%.`
        : (calculation.insufficiencyReason ?? 'Цена не сформирована.'),
    details: [
      ...(calculation.formula ? [calculation.formula] : []),
      ...(calculation.count > 0 ? [`Предложения в расчёте: ${calculation.usedOffers.map((n) => `№${n}`).join(', ')}`] : []),
      ...calculation.warnings,
    ],
  });
  return trace;
}

export async function runPipeline(request, deps) {
  const now = deps.now();

  // 1. Требование
  deps.onProgress?.({ stage: 'requirement', message: 'Разбор описания закупки' });
  const requirement = buildRequirement(request);

  // 2. Сбор
  // Список задан — ищем только в перечисленных источниках (идентификатор, которого нет, просто ничего не выберет).
  const selected = request.sources ? deps.sources.filter((source) => request.sources?.includes(source.id)) : deps.sources;
  deps.onProgress?.({ stage: 'collect', message: `Поиск в ${selected.length} источниках` });
  const collected = await Promise.all(
    selected.map(async (source) => {
      const result = await collectFromSource(source, requirement, deps);
      deps.onProgress?.({ stage: 'source', message: result.run.sourceName, source: result.run });
      return result;
    }),
  );
  const sources = collected.map((item) => item.run);
  const sourceInfo = new Map(selected.map((source) => [source.id, { name: source.name, kind: source.kind, defaultUnit: source.defaultUnit }]));
  const raw = collected.flatMap((item) => item.offers);

  const manual = manualOffers(request, now);
  if (manual.length > 0) {
    raw.push(...manual);
    sourceInfo.set(MANUAL_SOURCE.id, { name: MANUAL_SOURCE.name, kind: MANUAL_SOURCE.kind });
    sources.push({
      sourceId: MANUAL_SOURCE.id,
      sourceName: MANUAL_SOURCE.name,
      kind: MANUAL_SOURCE.kind,
      homepage: '',
      status: 'ok',
      offersFound: manual.length,
      durationMs: 0,
      queriesTried: [],
    });
  }

  // 3–4. Проверка, дубли, сопоставимость, приведение цен
  deps.onProgress?.({ stage: 'evaluate', message: `Оценка ${raw.length} предложений` });
  const duplicates = findDuplicates(raw);
  const offers = raw.map((offer, index) => {
    const info = sourceInfo.get(offer.sourceId);
    const evaluated = {
      n: index + 1,
      raw: offer,
      sourceName: info?.name ?? offer.sourceId,
      sourceKind: info?.kind ?? 'marketplace',
      price: { unitPriceRub: null, unitCode: requirement.unit.code, adjustments: [] },
      relevance: null,
      decision: { included: false, reason: '', stage: 'final' },
    };

    const invalid = validateOffer(offer);
    if (invalid) {
      evaluated.decision = { included: false, code: 'missing_data', reason: invalid, stage: 'validate' };
      return evaluated;
    }
    const duplicate = duplicates.get(index);
    if (duplicate) {
      evaluated.duplicateOf = duplicate.of + 1;
      evaluated.decision = { included: false, code: 'duplicate', reason: `Дубль предложения №${duplicate.of + 1}: ${duplicate.reason}.`, stage: 'dedupe' };
      return evaluated;
    }

    const relevance = evaluateRelevance(offer, requirement, deps.rules);
    evaluated.relevance = relevance.relevance;
    // Источник не публикует единицу продажи: берётся единица по умолчанию из настроек источника, с явной отметкой.
    const assumedUnit = offer.unitText === null ? info?.defaultUnit : undefined;
    const normalized = normalizePrice(assumedUnit ? { ...offer, unitText: assumedUnit } : offer, requirement, deps.rules, deps.cpi, now, {
      unitAssumed: Boolean(assumedUnit),
    });
    if (assumedUnit) {
      normalized.price.adjustments.unshift({
        kind: 'unit',
        factor: 1,
        description: `Источник не публикует единицу продажи; по настройке источника одна карточка товара принята за 1 ${assumedUnit}.`,
      });
    }
    evaluated.price = normalized.price;

    let decision;
    if (relevance.exclusion) {
      decision = { included: false, code: relevance.exclusion.code, reason: relevance.exclusion.reason, stage: 'relevance' };
    } else if (normalized.stale) {
      decision = { included: false, code: 'stale', reason: normalized.stale, stage: 'normalize' };
    } else if (normalized.price.unitPriceRub === null) {
      decision = {
        included: false,
        code: 'unit_incompatible',
        reason: normalized.price.failure ?? 'Цену не удалось привести к единице измерения закупки.',
        stage: 'normalize',
      };
    } else {
      evaluated.inclusionSummary = relevance.summary;
      decision = { included: true, reason: relevance.summary, stage: 'final' };
    }
    evaluated.decision = decision;
    return evaluated;
  });

  // 5–6. Выбросы и расчёт
  const { calculation, reliability } = applyStatistics(offers, requirement, deps.rules);

  const report = {
    id: createReportId(now),
    createdAt: now.toISOString(),
    appVersion: deps.appVersion,
    mode: deps.mode,
    request,
    requirement,
    sources,
    offers,
    calculation,
    reliability,
    trace: [],
    rules: deps.rules,
  };
  report.trace = buildTrace(report);
  deps.onProgress?.({ stage: 'done', message: 'Готово' });
  return report;
}

/** Пересчёт сохранённого отчёта после ручных правок: сеть не используется. */
export function recalculate(report, rules, overrides) {
  const copy = structuredClone(report);
  const { calculation, reliability } = applyStatistics(copy.offers, copy.requirement, rules, overrides);
  copy.calculation = calculation;
  copy.reliability = reliability;
  copy.overrides = { exclude: [...new Set(overrides.exclude)].sort((a, b) => a - b), include: [...new Set(overrides.include)].sort((a, b) => a - b) };
  copy.trace = buildTrace(copy);
  if (copy.overrides.exclude.length + copy.overrides.include.length > 0) {
    copy.trace.push({
      step: '7. Ручные правки',
      summary: `Пользователь исключил: ${copy.overrides.exclude.map((n) => `№${n}`).join(', ') || '—'}; включил вручную: ${copy.overrides.include.map((n) => `№${n}`).join(', ') || '—'}. Расчёт повторён по тем же правилам.`,
    });
  }
  return copy;
}
