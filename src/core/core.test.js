import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { canonicalUrl, findDuplicates } from './dedupe.js';
import { SourceError } from './http.js';
import { indexCoefficient, normalizePrice } from './normalize.js';
import { recalculate, runPipeline } from './pipeline.js';
import { evaluateRelevance } from './relevance.js';
import { buildRequirement } from './requirement.js';
import { DEFAULT_RULES, resolveRules } from './rules.js';
import { calculate } from './stats.js';
import { parseUnit } from './units.js';
import { validateRequest } from './validate.js';

const NOW = new Date('2026-11-14T10:00:00Z');
const NO_CPI = { source: 'нет', updated: '', monthly: {} };
const noNetwork = {
  get: async () => {
    throw new Error('сеть в тестах не используется');
  },
  post: async () => {
    throw new Error('сеть в тестах не используется');
  },
};

function offer(overrides) {
  return {
    sourceId: 'shop',
    externalId: overrides.title,
    url: `https://shop.example/p/${encodeURIComponent(overrides.title)}`,
    unitText: 'упак',
    vat: 'unknown',
    characteristics: {},
    fetchedAt: NOW.toISOString(),
    ...overrides,
  };
}

function source(id, result, extra = {}) {
  return {
    id,
    name: `Источник ${id}`,
    kind: 'marketplace',
    homepage: `https://${id}.example`,
    search: async () => {
      if (result instanceof Error) throw result;
      return result.map((item) => ({ ...item, sourceId: id }));
    },
    ...extra,
  };
}

function deps(sources) {
  return { sources, http: noNetwork, rules: DEFAULT_RULES, cpi: NO_CPI, now: () => NOW, mode: 'live', appVersion: 'test' };
}

const PAPER = { description: 'Бумага офисная А4, плотность 80 г/м2, пачка 500 листов, белизна не менее 146%', quantity: 10, unit: 'упак' };

// ---------- Разбор описания ----------

test('описание закупки: наименование, характеристики, фасовка и запросы', () => {
  const requirement = buildRequirement(PAPER);
  assert.equal(requirement.subject, 'Бумага офисная А4');
  assert.deepEqual(requirement.keywords, ['бумаг', 'офис']);
  assert.equal(requirement.unit.code, 'упак');
  assert.deepEqual(requirement.packContent, { value: 500, unit: 'лист' });
  const byName = Object.fromEntries(requirement.attributes.map((attribute) => [attribute.name, attribute]));
  assert.equal(byName['плотность']?.numeric, 80);
  assert.equal(byName['плотность']?.unit, 'г/м2');
  assert.equal(byName['белизна']?.comparator, 'ge');
  assert.equal(byName['формат']?.value, 'A4');
  assert.equal(
    requirement.attributes.some((attribute) => attribute.unit === 'лист'),
    false,
    'фасовка учитывается пересчётом, а не как характеристика',
  );
  assert.equal(requirement.searchQueries[0], 'Бумага офисная А4 80 г/м2');
});

test('описание закупки: единицы характеристик приводятся к базовым, сроки не считаются существенными', () => {
  const requirement = buildRequirement({ description: 'Кабель силовой ВВГнг(А)-LS 3х2,5 мм2, напряжение 0,66 кВ, гарантия 12 мес', quantity: 100, unit: 'м' });
  const voltage = requirement.attributes.find((attribute) => attribute.name === 'напряжение');
  assert.equal(voltage?.numeric, 660);
  assert.equal(voltage?.unit, 'В');
  assert.equal(requirement.attributes.find((attribute) => attribute.name === 'типоразмер')?.value, '3x2.5');
  assert.equal(requirement.attributes.find((attribute) => attribute.unit === 'мес')?.importance, 'nice');
  assert.equal(requirement.unit.dimension, 'length');
});

test('описание закупки: без количества и единицы — расчёт на 1 шт с пояснением', () => {
  const requirement = buildRequirement({ description: 'Стул офисный' });
  assert.equal(requirement.quantity, 1);
  assert.equal(requirement.unit.code, 'шт');
  assert.equal(requirement.notes.length, 2);
});

test('единицы измерения: синонимы и составные обозначения', () => {
  assert.equal(parseUnit('Штука')?.code, 'шт');
  assert.equal(parseUnit('Километр; тысяча метров')?.code, 'км');
  assert.equal(parseUnit('руб./кг')?.code, 'кг');
  assert.equal(parseUnit('неведомая')?.dimension, 'unknown');
  assert.equal(parseUnit(null), null);
});

// ---------- Приведение цен ----------

test('цена приводится к единице закупки: метры из бухты, килограммы из граммов, штуки из набора', () => {
  const cable = buildRequirement({ description: 'Кабель ВВГнг', quantity: 1, unit: 'м' });
  const coil = normalizePrice(offer({ title: 'Кабель ВВГнг бухта 100 м', priceRub: 9950, unitText: 'шт' }), cable, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(coil.price.unitPriceRub, 99.5);
  const perKm = normalizePrice(offer({ title: 'Кабель ВВГнг', priceRub: 190000, unitText: 'Километр; тысяча метров' }), cable, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(perKm.price.unitPriceRub, 190);

  const sugar = buildRequirement({ description: 'Сахар', quantity: 1, unit: 'кг' });
  assert.equal(normalizePrice(offer({ title: 'Сахар 500 г', priceRub: 60, unitText: 'шт' }), sugar, DEFAULT_RULES, NO_CPI, NOW).price.unitPriceRub, 120);

  const pens = buildRequirement({ description: 'Ручка шариковая', quantity: 1, unit: 'шт' });
  const pack = normalizePrice(offer({ title: 'Ручка шариковая синяя, 50 шт/уп', priceRub: 500, unitText: 'упак' }), pens, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(pack.price.unitPriceRub, 10);
  assert.match(pack.price.adjustments[0]?.description ?? '', /50 шт/);
});

test('фасовка: крупная упаковка делится, мелкая не домножается, неизвестная единица не принимается', () => {
  const paper = buildRequirement(PAPER);
  const box = normalizePrice(offer({ title: 'Бумага А4 500 листов х 5 шт', priceRub: 2000, unitText: 'шт' }), paper, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(box.price.unitPriceRub, 400);
  const total = normalizePrice(offer({ title: 'Бумага А4 2500 листов', priceRub: 2000 }), paper, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(total.price.unitPriceRub, 400);
  const small = normalizePrice(offer({ title: 'Бумага А4 100 листов', priceRub: 166 }), paper, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(small.price.unitPriceRub, null);
  assert.match(small.price.failure ?? '', /Несопоставимая фасовка/);
  const unknown = normalizePrice(offer({ title: 'Бумага А4 500 листов', priceRub: 400, unitText: null }), paper, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(unknown.price.unitPriceRub, null);
  const byWeight = normalizePrice(offer({ title: 'Бумага А4', priceRub: 400, unitText: 'кг' }), paper, DEFAULT_RULES, NO_CPI, NOW);
  assert.match(byWeight.price.failure ?? '', /несопоставима/);
});

test('НДС добавляется к ценам без НДС, старые цены индексируются по ИПЦ или отбрасываются', () => {
  const requirement = buildRequirement({ description: 'Стул офисный', quantity: 1, unit: 'шт' });
  const net = normalizePrice(offer({ title: 'Стул офисный', priceRub: 1000, unitText: 'шт', vat: 'excluded' }), requirement, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(net.price.unitPriceRub, 1220);

  const cpi = { source: 'тест', updated: '', monthly: { '2026-01': 101, '2026-02': 100.5, '2026-03': 100.5 } };
  const { k, months } = indexCoefficient(new Date('2026-01-15T00:00:00Z'), new Date('2026-04-10T00:00:00Z'), cpi);
  assert.equal(Math.round(k * 1000) / 1000, 1.02);
  assert.deepEqual(months, ['2026-01', '2026-02', '2026-03']);

  const old = normalizePrice(
    offer({ title: 'Стул офисный', priceRub: 1000, unitText: 'шт', priceDate: '2022-01-10' }),
    requirement,
    DEFAULT_RULES,
    NO_CPI,
    NOW,
  );
  assert.equal(old.price.unitPriceRub, null);
  assert.match(old.stale ?? '', /36 мес/);
});

test('таблица ИПЦ Росстата из config/cpi.json: официальные значения на месте, цена контракта индексируется', () => {
  const cpi = JSON.parse(readFileSync(new URL('../../config/cpi.json', import.meta.url), 'utf8'));
  assert.equal(cpi.monthly['2022-03'], 107.61);
  assert.equal(cpi.monthly['2024-12'], 101.32);
  assert.equal(cpi.monthly['2026-09'], 100.35);
  assert.equal(
    Object.keys(cpi.monthly).every((key) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key)),
    true,
  );
  assert.equal(
    Object.values(cpi.monthly).every((value) => value > 95 && value < 110),
    true,
  );
  assert.match(cpi.source, /Росстат/);

  // Цена от декабря 2025: суммируются приросты с декабря 2025 по сентябрь 2026 (октябрь ещё не опубликован).
  const { k, months, missing } = indexCoefficient(new Date('2025-12-01T00:00:00Z'), NOW, cpi);
  assert.equal(months.length, 10);
  assert.deepEqual(missing, ['2026-10']);
  assert.equal(Math.round(k * 10000) / 10000, 1.0526);

  const requirement = buildRequirement({ description: 'Стул офисный', quantity: 1, unit: 'шт' });
  const old = normalizePrice(offer({ title: 'Стул офисный', priceRub: 1000, unitText: 'шт', priceDate: '2025-12-01' }), requirement, DEFAULT_RULES, cpi, NOW);
  assert.equal(old.price.unitPriceRub, 1052.6);
  assert.match(old.price.adjustments.map((item) => item.description).join(' '), /по ИПЦ за 2025-12…2026-09: k = 1,0526\. Нет данных ИПЦ за 2026-10/);

  // Свежая цена (младше 6 месяцев) не индексируется.
  const fresh = normalizePrice(offer({ title: 'Стул офисный', priceRub: 1000, unitText: 'шт', priceDate: '2026-08-20' }), requirement, DEFAULT_RULES, cpi, NOW);
  assert.equal(fresh.price.unitPriceRub, 1000);
});

// ---------- Сопоставимость ----------

test('сопоставимость: характеристики важнее названия', () => {
  const requirement = buildRequirement(PAPER);
  const good = evaluateRelevance(offer({ title: 'Бумага офисная Ballet, А4, 80 г/м2, 500 л, белизна 153%', priceRub: 500 }), requirement, DEFAULT_RULES);
  assert.equal(good.exclusion, undefined);
  assert.equal(
    good.relevance.checks.every((check) => check.verdict === 'match'),
    true,
  );

  const dense = evaluateRelevance(
    offer({ title: 'Бумага офисная А4, 500 л', priceRub: 500, characteristics: { Плотность: '160 г/м2', Белизна: '150 %' } }),
    requirement,
    DEFAULT_RULES,
  );
  assert.equal(dense.exclusion?.code, 'attribute_mismatch');
  assert.match(dense.exclusion?.reason ?? '', /плотность: требуется 80 г\/м2/);

  const dull = evaluateRelevance(offer({ title: 'Бумага офисная А4 80 г/м2 белизна 60%', priceRub: 300 }), requirement, DEFAULT_RULES);
  assert.equal(dull.exclusion?.code, 'attribute_mismatch');

  const vague = evaluateRelevance(offer({ title: 'Бумага офисная цветная А4', priceRub: 900 }), requirement, DEFAULT_RULES);
  assert.equal(vague.exclusion?.code, 'missing_data');

  const other = evaluateRelevance(offer({ title: 'Скрепки металлические 28 мм', priceRub: 50 }), requirement, DEFAULT_RULES);
  assert.equal(other.exclusion?.code, 'low_relevance');

  const accessory = evaluateRelevance(offer({ title: 'Лоток для бумаги офисной А4 80 г/м2 146%', priceRub: 700 }), requirement, DEFAULT_RULES);
  assert.equal(accessory.exclusion?.code, 'accessory');
});

test('сопоставимость: артикул из описания обязателен, ОКПД2 учитывается в оценке', () => {
  const cartridge = buildRequirement({ description: 'Картридж для лазерного принтера HP CF283A', quantity: 1, unit: 'шт', okpd2: '26.20.40.120' });
  const same = evaluateRelevance(
    offer({ title: 'Картридж лазерный Cactus CS-CF283A для принтера HP', priceRub: 400, okpd2: '26.20.40.120' }),
    cartridge,
    DEFAULT_RULES,
  );
  assert.equal(same.exclusion, undefined);
  assert.equal(same.relevance.okpd2Match, 'exact');
  const wrong = evaluateRelevance(offer({ title: 'Картридж лазерный NV Print CE285A для принтера HP', priceRub: 300 }), cartridge, DEFAULT_RULES);
  assert.equal(wrong.exclusion?.code, 'attribute_mismatch');
  assert.match(wrong.exclusion?.reason ?? '', /CF283A/);
});

// ---------- Дубли ----------

test('дубли: тот же идентификатор, та же ссылка без меток, то же содержание в другом источнике', () => {
  assert.equal(canonicalUrl('https://www.Shop.example/p/1/?utm_source=x&b=2&a=1#top'), 'shop.example/p/1?a=1&b=2');
  const first = offer({ title: 'Бумага А4', priceRub: 500, externalId: '1', url: 'https://shop.example/p/1' });
  const duplicates = findDuplicates([
    first,
    { ...first },
    { ...first, externalId: '2', url: 'https://shop.example/p/1?utm_source=mail' },
    { ...first, sourceId: 'other', externalId: '9', url: 'https://other.example/x' },
    { ...first, externalId: '3', url: 'https://shop.example/p/3', priceRub: 510 },
  ]);
  assert.deepEqual([...duplicates.keys()], [1, 2, 3]);
  assert.match(duplicates.get(3)?.reason ?? '', /в другом источнике/);
});

// ---------- Расчёт ----------

test('расчёт: формула воспроизводима, выброс исключается по межквартильному размаху', () => {
  const points = [100, 102, 98, 101, 99, 300].map((price, index) => ({ n: index + 1, price }));
  const { calculation, excluded } = calculate(points, 7, 'шт', DEFAULT_RULES);
  assert.equal(calculation.status, 'ok');
  assert.deepEqual(calculation.usedOffers, [1, 2, 3, 4, 5]);
  assert.equal(calculation.unitPrice, 100);
  assert.equal(calculation.total, 700);
  assert.equal(calculation.cv, 1.58);
  assert.equal(excluded.get(6)?.code, 'outlier');
  assert.match(calculation.formula ?? '', /\(100,00 \+ 102,00 \+ 98,00 \+ 101,00 \+ 99,00\) \/ 5 = 100,00/);
  assert.equal(calculation.outlierSteps[0]?.rule, 'iqr');
});

test('расчёт: на плотной выборке цена вне размаха, но близкая к медиане, не считается аномальной', () => {
  const points = [681.12, 754.02, 761.16, 775.88, 783.84, 1027.81].map((price, index) => ({ n: index + 1, price }));
  const { calculation, excluded } = calculate(points, 1, 'упак', DEFAULT_RULES);
  assert.deepEqual([...excluded.keys()], [6], '681,12 отличается от медианы на 11% и остаётся; 1 027,81 (+34%) исключается');
  assert.deepEqual(calculation.usedOffers, [1, 2, 3, 4, 5]);
  assert.equal(calculation.unitPrice, 751.2);
  assert.match(calculation.outlierSteps[0]?.description ?? '', /более чем на 20%/);
});

test('расчёт: очень далёкая цена не прикрывает следующую аномальную — правило применяется повторно', () => {
  const points = [401, 530, 600, 711, 814, 2498, 10160].map((price, index) => ({ n: index + 1, price }));
  const { calculation, excluded } = calculate(points, 1, 'шт', DEFAULT_RULES);
  assert.deepEqual([...excluded.keys()].sort(), [6, 7]);
  assert.equal(calculation.outlierSteps.length, 2);
  assert.match(calculation.outlierSteps[1]?.description ?? '', /проход 2/);
  assert.deepEqual(calculation.usedOffers, [1, 2, 3, 4, 5]);
  assert.equal(calculation.status, 'ok');
  assert.equal(calculation.unitPrice, 611.2);
});

test('расчёт: малая выборка проверяется отношением к медиане и не опускается ниже минимума', () => {
  const small = calculate(
    [
      { n: 1, price: 100 },
      { n: 2, price: 105 },
      { n: 3, price: 110 },
      { n: 4, price: 400 },
    ],
    1,
    'шт',
    DEFAULT_RULES,
  );
  assert.equal(small.calculation.outlierSteps[0]?.rule, 'median_ratio');
  assert.deepEqual(small.calculation.usedOffers, [1, 2, 3]);
  assert.equal(small.calculation.warnings.length, 1);

  const minimum = calculate(
    [
      { n: 1, price: 100 },
      { n: 2, price: 105 },
      { n: 3, price: 400 },
    ],
    1,
    'шт',
    DEFAULT_RULES,
  );
  assert.equal(minimum.calculation.count, 3, 'при трёх ценах выброс не удаляется — иначе цен станет меньше минимума');
  assert.equal(minimum.calculation.status, 'insufficient_data');
  assert.equal(minimum.calculation.total, null);
});

test('правила: переопределяются из конфигурации, опечатки и нечисловые значения отклоняются', () => {
  const rules = resolveRules({ _comment: 'x', outliers: { cvThresholdPercent: 20 } });
  assert.equal(rules.outliers.cvThresholdPercent, 20);
  assert.equal(rules.outliers.minPrices, DEFAULT_RULES.outliers.minPrices);
  assert.throws(() => resolveRules({ outliers: { cvTreshold: 20 } }), /неизвестный параметр «outliers.cvTreshold»/);
  assert.throws(() => resolveRules({ vat: { ratePercent: '20' } }), /неотрицательным числом/);
  assert.throws(() => resolveRules({ outliers: { minPrices: 1 } }), /не может быть меньше 2/);
});

// ---------- Конвейер ----------

const GOOD = [
  offer({ title: 'Бумага офисная SvetoCopy А4 80 г/м2 500 листов белизна 146%', priceRub: 500 }),
  offer({ title: 'Бумага офисная Ballet А4 80 г/м2 500 листов белизна 153%', priceRub: 520 }),
  offer({ title: 'Бумага офисная Projecta А4 80 г/м2 500 листов белизна 150%', priceRub: 480 }),
];

test('конвейер: недоступные и сломанные источники не мешают расчёту и видны в отчёте', async () => {
  const report = await runPipeline(
    PAPER,
    deps([
      source('good', GOOD),
      source('blocked', new SourceError('blocked', 'капча')),
      source('changed', new SourceError('parse', 'структура страницы изменилась')),
      source('crashed', new TypeError('x is undefined')),
      source('empty', []),
    ]),
  );
  const status = Object.fromEntries(report.sources.map((run) => [run.sourceId, `${run.status}:${run.errorKind ?? ''}`]));
  assert.deepEqual(status, { good: 'ok:', blocked: 'error:blocked', changed: 'error:parse', crashed: 'error:internal', empty: 'empty:' });
  assert.equal(report.calculation.status, 'ok');
  assert.equal(report.calculation.unitPrice, 500);
  assert.equal(report.calculation.total, 5000);
  assert.equal(report.trace.length, 6);
  assert.match(report.trace[1]?.details?.join('\n') ?? '', /недоступен — капча \[blocked\]/);
});

test('конвейер: каждое предложение получает решение с причиной; дубли и неполные записи исключаются', async () => {
  const report = await runPipeline(
    PAPER,
    deps([
      source('a', GOOD),
      source('b', [
        { ...GOOD[0], url: 'https://b.example/1' },
        offer({ title: 'Бумага офисная А4 80 г/м2 500 листов белизна 146%', priceRub: 0 }),
        offer({ title: 'Бумага офисная Xerox А4 80 г/м2 500 листов белизна 150%', priceRub: 510, url: 'javascript:alert(1)' }),
        offer({ title: 'Бумага офисная А3 80 г/м2 500 листов белизна 146%', priceRub: 900 }),
      ]),
    ]),
  );
  assert.equal(
    report.offers.every((item) => item.decision.reason.length > 0),
    true,
  );
  const codes = report.offers.map((item) => item.decision.code ?? 'in');
  assert.deepEqual(codes, ['in', 'in', 'in', 'duplicate', 'missing_data', 'missing_data', 'attribute_mismatch']);
  assert.equal(report.offers[3]?.duplicateOf, 1);
  assert.deepEqual(report.calculation.usedOffers, [1, 2, 3]);
});

test('конвейер: при недостатке данных цена не формируется', async () => {
  const report = await runPipeline(PAPER, deps([source('a', GOOD.slice(0, 2))]));
  assert.equal(report.calculation.status, 'insufficient_data');
  assert.equal(report.calculation.total, null);
  assert.match(report.calculation.insufficiencyReason ?? '', /нужно не менее 3/);
  assert.equal(report.reliability.level, 'нет данных');
});

test('конвейер: единица по умолчанию из настроек источника применяется с явной отметкой', async () => {
  const noUnit = GOOD.map((item) => ({ ...item, unitText: null }));
  const strict = await runPipeline(PAPER, deps([source('a', noUnit)]));
  assert.equal(strict.calculation.status, 'insufficient_data');
  assert.equal(strict.offers[0]?.decision.code, 'unit_incompatible');

  const assumed = await runPipeline(PAPER, deps([source('a', noUnit, { defaultUnit: 'шт' })]));
  assert.equal(assumed.calculation.status, 'ok');
  assert.match(assumed.offers[0]?.price.adjustments[0]?.description ?? '', /по настройке источника/);
  assert.equal(assumed.offers[0]?.raw.unitText, null, 'исходные данные источника не изменяются');
});

test('конвейер: ручные правки пересчитываются без сети и отражаются в отчёте', async () => {
  const extra = offer({ title: 'Бумага офисная Xerox А4 80 г/м2 500 листов белизна 150%', priceRub: 540 });
  const cheap = offer({ title: 'Бумага офисная А4 80 г/м2 500 листов', priceRub: 460 });
  const report = await runPipeline(PAPER, deps([source('a', [...GOOD, extra, cheap])]));
  assert.equal(report.calculation.unitPrice, 510);
  assert.equal(report.offers[4]?.decision.code, 'missing_data');

  const edited = recalculate(report, DEFAULT_RULES, { exclude: [4], include: [5] });
  assert.equal(edited.offers[3]?.decision.code, 'user_excluded');
  assert.equal(edited.offers[4]?.decision.included, true);
  assert.deepEqual(edited.calculation.usedOffers, [1, 2, 3, 5]);
  assert.equal(edited.calculation.unitPrice, 490);
  assert.equal(edited.trace.at(-1)?.step, '7. Ручные правки');
  assert.equal(report.calculation.unitPrice, 510, 'исходный отчёт не изменяется');

  const restored = recalculate(edited, DEFAULT_RULES, { exclude: [], include: [] });
  assert.deepEqual(restored.calculation.usedOffers, [1, 2, 3, 4]);
  assert.equal(restored.offers[4]?.decision.code, 'missing_data');
});

// ---------- Реестр контрактов: характеристики КТРУ и приоритет источников ----------

const PAPER_WITH_CODE = { ...PAPER, okpd2: '17.12.14.110' };

function contractOffer(reestr, position, priceRub, characteristics, title = 'Бумага для офисной техники') {
  return offer({
    title,
    priceRub,
    unitText: 'Пачка',
    externalId: `${reestr}-${position}`,
    url: `https://zakupki.gov.ru/epz/contract/contractCard/payment-info-and-target-of-order.html?reestrNumber=${reestr}`,
    okpd2: '17.12.14.110',
    characteristics,
    priceDate: '2026-09-01',
    vat: 'included',
  });
}

const KTRU_RANGE = { 'Масса бумаги площадью 1м2': '≥ 80 и < 90 Грамм', Формат: 'А4', 'Количество листов в пачке': '500Штука' };
const KTRU_EXACT = { 'Масса бумаги площадью 1м2, г': '80Грамм', Формат: 'А4', 'Белизна:': '165' };

test('характеристики КТРУ: диапазоны, синонимы названий и код ОКПД2', () => {
  const requirement = buildRequirement(PAPER_WITH_CODE);
  const range = evaluateRelevance(contractOffer('1', 1, 350, KTRU_RANGE), requirement, DEFAULT_RULES);
  assert.equal(range.exclusion, undefined, 'плотность и формат подтверждены, белизна неизвестна, код ОКПД2 совпал');
  const density = range.relevance.checks.find((check) => check.name === 'плотность');
  assert.equal(density?.verdict, 'match');
  assert.match(density?.found ?? '', /≥ 80 и < 90/);

  const exact = evaluateRelevance(contractOffer('2', 1, 350, KTRU_EXACT), requirement, DEFAULT_RULES);
  assert.equal(
    exact.relevance.checks.every((check) => check.verdict === 'match'),
    true,
  );

  const heavy = evaluateRelevance(contractOffer('3', 1, 700, { 'Масса бумаги площадью 1м2': '≥ 160 и < 170 Грамм', Формат: 'А4' }), requirement, DEFAULT_RULES);
  assert.equal(heavy.exclusion?.code, 'attribute_mismatch');

  const dull = evaluateRelevance(contractOffer('4', 1, 300, { ...KTRU_RANGE, Белизна: '< 100' }), requirement, DEFAULT_RULES);
  assert.equal(dull.exclusion?.code, 'attribute_mismatch', 'верхняя граница диапазона ниже требуемого минимума');

  // Без кода ОКПД2 в запросе неподтверждённая белизна — недостаток данных.
  const noCode = evaluateRelevance(contractOffer('5', 1, 350, KTRU_RANGE), buildRequirement(PAPER), DEFAULT_RULES);
  assert.equal(noCode.exclusion?.code, 'missing_data');

  const custom = resolveRules({ synonyms: { белизна: ['яркость по cie'] } });
  assert.deepEqual(custom.synonyms['белизна'], ['яркость по cie']);
  assert.equal(custom.synonyms['плотность']?.length, DEFAULT_RULES.synonyms['плотность']?.length, 'встроенные синонимы сохраняются');
  const bright = evaluateRelevance(contractOffer('6', 1, 350, { ...KTRU_RANGE, 'Яркость по CIE': '≥ 150' }), buildRequirement(PAPER), custom);
  assert.equal(bright.exclusion, undefined);
  assert.throws(() => resolveRules({ synonyms: { белизна: 'яркость' } }), /массивом непустых строк/);
});

test('фасовка из характеристик КТРУ: «Количество листов в пачке 250» пересчитывается к пачке 500 листов', () => {
  const requirement = buildRequirement(PAPER_WITH_CODE);
  const half = normalizePrice(contractOffer('7', 1, 200, { 'Количество листов в пачке': '250Штука' }), requirement, DEFAULT_RULES, NO_CPI, NOW);
  assert.equal(half.price.unitPriceRub, 400);
});

test('позиции одного контракта с общей ссылкой — не дубли', () => {
  const duplicates = findDuplicates([
    contractOffer('10', 1, 350, KTRU_RANGE),
    contractOffer('10', 2, 20, {}, 'Скрепки 28 мм'),
    contractOffer('10', 2, 20, {}, 'Скрепки 28 мм'),
  ]);
  assert.deepEqual([...duplicates.keys()], [2]);
});

test('один контракт — одно наблюдение цены: три позиции одного контракта не дают расчёта', async () => {
  const sameContract = [1, 2, 3].map((position) => contractOffer('30', position, 340, KTRU_RANGE, `Бумага для офисной техники, позиция ${position}`));
  const registry = source('eis', sameContract, { kind: 'contract_registry' });
  const report = await runPipeline(PAPER_WITH_CODE, deps([registry]));
  assert.equal(report.calculation.status, 'insufficient_data');
  assert.equal(report.calculation.count, 1);
  assert.deepEqual(
    report.offers.map((item) => item.decision.code ?? 'in'),
    ['in', 'duplicate', 'duplicate'],
  );
  assert.match(report.offers[1]?.decision.reason ?? '', /один контракт — одно наблюдение/);

  // Ещё два других контракта — расчёт возможен, лишние позиции первого по-прежнему не учитываются.
  const more = [...sameContract, contractOffer('31', 1, 330, KTRU_RANGE), contractOffer('32', 1, 350, KTRU_EXACT)];
  const ok = await runPipeline(PAPER_WITH_CODE, deps([source('eis', more, { kind: 'contract_registry' })]));
  assert.equal(ok.calculation.status, 'ok');
  assert.deepEqual(ok.calculation.usedOffers, [1, 4, 5]);
  assert.equal(ok.calculation.unitPrice, 340);

  // Позицию можно вернуть вручную, и это видно в отчёте.
  const forced = recalculate(ok, DEFAULT_RULES, { exclude: [], include: [2] });
  assert.equal(forced.calculation.usedOffers.includes(2), true);
});

test('приоритет источников: при достаточном числе цен контрактов розничные цены в расчёт не берутся', async () => {
  const contracts = [contractOffer('21', 1, 330, KTRU_RANGE), contractOffer('22', 1, 350, KTRU_EXACT), contractOffer('23', 1, 340, KTRU_RANGE)];
  const registry = source('eis', contracts, { kind: 'contract_registry' });
  const shop = source('shop', GOOD);
  const report = await runPipeline(PAPER_WITH_CODE, deps([registry, shop]));
  assert.deepEqual(report.calculation.usedOffers, [1, 2, 3]);
  assert.equal(report.calculation.unitPrice, 340);
  assert.equal(report.calculation.total, 3400);
  assert.deepEqual(
    report.offers.slice(3).map((item) => item.decision.code),
    ['lower_priority', 'lower_priority', 'lower_priority'],
  );
  assert.match(report.offers[3]?.decision.reason ?? '', /приоритетных источников .* достаточно — 3/);
  assert.match(report.calculation.warnings.join(' '), /не использовано: 3/);
  assert.equal(
    report.calculation.warnings.some((warning) => /одного источника/.test(warning)),
    false,
    'разные контракты — независимые цены',
  );

  // Контрактов меньше минимума — розница привлекается.
  const mixed = await runPipeline(
    PAPER_WITH_CODE,
    deps([
      source('eis', contracts.slice(0, 2), { kind: 'contract_registry' }),
      source(
        'shop',
        GOOD.map((item) => ({ ...item, priceRub: 345 })),
      ),
    ]),
  );
  assert.equal(mixed.calculation.count, 5);
  assert.equal(
    mixed.offers.some((item) => item.decision.code === 'lower_priority'),
    false,
  );

  // Правило отключается в конфигурации.
  const flat = await runPipeline(PAPER_WITH_CODE, {
    ...deps([registry, shop]),
    rules: resolveRules({ priority: { preferPrimary: 0 }, outliers: { cvThresholdPercent: 90 } }),
  });
  assert.equal(flat.calculation.count, 6);

  // Розничное предложение можно включить вручную и вернуть обратно.
  const forced = recalculate(report, DEFAULT_RULES, { exclude: [], include: [4] });
  assert.equal(forced.offers[3]?.decision.included, true);
  assert.equal(forced.offers[3]?.decision.stage, 'user');
  assert.equal(forced.calculation.usedOffers.includes(4), true);
  const back = recalculate(forced, DEFAULT_RULES, { exclude: [], include: [] });
  assert.equal(back.offers[3]?.decision.code, 'lower_priority');
  assert.deepEqual(back.calculation.usedOffers, [1, 2, 3]);
});

// ---------- Проверка входных данных ----------

test('входные данные API проверяются с понятными сообщениями', () => {
  assert.equal(validateRequest({ description: 'ок' }).ok, false);
  assert.equal(validateRequest({ description: 'Бумага', quantity: -1 }).ok, false);
  assert.equal(validateRequest({ description: 'Бумага', okpd2: 'DROP TABLE' }).ok, false);
  assert.equal(validateRequest({ description: 'Бумага', manualOffers: [{ title: 'x', priceRub: 10, url: 'javascript:alert(1)' }] }).ok, false);
  const valid = validateRequest({
    description: ' Бумага ',
    quantity: 5,
    unit: 'упак',
    okpd2: '17.12.14.110',
    sources: [],
    manualOffers: [{ title: 'КП', priceRub: 10, unit: 'упак' }],
  });
  assert.equal(valid.ok, true);
  if (valid.ok) {
    assert.equal(valid.value.description, 'Бумага');
    assert.deepEqual(valid.value.sources, []);
  }
});
