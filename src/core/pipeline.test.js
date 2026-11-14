import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from './stats.js';
import { DEFAULT_RULES } from './rules.js';
import { runPipeline } from './pipeline.js';
import { createHttpClient } from './http.js';

test('среднее и итог воспроизводимы', () => {
  const { calculation } = calculate(
    [
      { n: 1, price: 100 },
      { n: 2, price: 110 },
      { n: 3, price: 120 },
    ],
    10,
    'шт',
    DEFAULT_RULES,
  );
  assert.equal(calculation.total, 1100);
  assert.equal(calculation.cv, 9.09);
});
test('недостаточно данных — цена отсутствует', () => {
  const { calculation } = calculate(
    [
      { n: 1, price: 100 },
      { n: 2, price: 110 },
    ],
    10,
    'шт',
    DEFAULT_RULES,
  );
  assert.equal(calculation.status, 'insufficient_data');
  assert.equal(calculation.total, null);
});
test('неоднородность не устраняется произвольным удалением цен', () => {
  const { calculation } = calculate(
    [100, 100, 160, 160].map((price, i) => ({ n: i + 1, price })),
    1,
    'шт',
    { ...DEFAULT_RULES, outliers: { ...DEFAULT_RULES.outliers, cvThresholdPercent: 10 } },
  );
  assert.equal(calculation.total, null);
  assert.equal(calculation.count, 4);
});
test('расчёт на ручных предложениях не обращается к сети', async () => {
  const r = await runPipeline(
    {
      description: 'Бумага офисная А4',
      quantity: 10,
      unit: 'шт',
      manualOffers: [100, 110, 120].map((priceRub, i) => ({ title: 'Бумага офисная А4', priceRub, unit: 'шт', supplier: `Поставщик ${i}` })),
    },
    {
      sources: [],
      http: createHttpClient(),
      rules: DEFAULT_RULES,
      cpi: { source: 'нет', updated: '', monthly: {} },
      now: () => new Date('2026-01-01T00:00:00Z'),
      mode: 'live',
      appVersion: 'test',
    },
  );
  assert.equal(r.calculation.total, 1100);
});
test('цена без единицы измерения исключается', async () => {
  const r = await runPipeline(
    {
      description: 'Бумага офисная А4',
      quantity: 1,
      unit: 'шт',
      manualOffers: [100, 110, 120].map((priceRub, i) => ({ title: 'Бумага офисная А4', priceRub, supplier: `Поставщик ${i}` })),
    },
    {
      sources: [],
      http: createHttpClient(),
      rules: DEFAULT_RULES,
      cpi: { source: 'нет', updated: '', monthly: {} },
      now: () => new Date('2026-01-01T00:00:00Z'),
      mode: 'live',
      appVersion: 'test',
    },
  );
  assert.equal(r.calculation.total, null);
});
