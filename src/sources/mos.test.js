import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceError } from '../core/http.js';
import { buildAutocompleteUrl, parseAutocomplete } from './mos.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', 'test', 'fixtures', 'mos');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

const FETCHED_AT = '2026-11-13T17:00:00.000Z';

test('parseAutocomplete: ноутбук — находит позицию со справочной ценой', () => {
  const body = readFixture('autocomplete-noutbuk.json');
  const offers = parseAutocomplete(body, FETCHED_AT);

  assert.equal(offers.length, 1, 'только одна из трёх позиций имеет справочную цену > 0');
  const [offer] = offers;
  assert.ok(offer);
  assert.equal(offer.sourceId, 'mos');
  assert.equal(offer.externalId, '47668942');
  assert.equal(offer.title, 'Ноутбук HONOR MagicBook X16 Plus 2025 серый 16"');
  assert.equal(offer.priceRub, 131500);
  assert.equal(typeof offer.priceRub, 'number');
  assert.equal(offer.unitText, 'Штука');
  assert.equal(offer.url, 'https://zakupki.mos.ru/sku/view/47668942');
  assert.equal(offer.vat, 'unknown');
  assert.deepEqual(offer.characteristics, {});
  assert.equal(offer.fetchedAt, FETCHED_AT);
});

test('parseAutocomplete: бумага офисная А4 — все позиции без цены пропускаются', () => {
  const body = readFixture('autocomplete-bumaga-a4.json');
  const offers = parseAutocomplete(body, FETCHED_AT);

  // У первой позиции referencePrice:null, у остальных двух 0.0 — цена неизвестна.
  assert.deepEqual(offers, []);
});

test('parseAutocomplete: пустая выдача -> []', () => {
  const body = readFixture('autocomplete-empty.json');
  const offers = parseAutocomplete(body, FETCHED_AT);
  assert.deepEqual(offers, []);
});

test('parseAutocomplete: изменённая структура ответа -> SourceError(parse)', () => {
  const body = JSON.stringify({ additionalInfo: null, count: 0 }); // нет поля items
  assert.throws(
    () => parseAutocomplete(body, FETCHED_AT),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseAutocomplete: не JSON -> SourceError(parse)', () => {
  assert.throws(
    () => parseAutocomplete('<html>не тот ответ</html>', FETCHED_AT),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseAutocomplete: позиция без id или без названия пропускается', () => {
  const body = JSON.stringify({
    items: [
      { specific: { okeiName: 'Штука', referencePrice: 100 } }, // нет id
      { id: '1', title: '', specific: { okeiName: 'Штука', referencePrice: 100 } }, // пустой title
      { id: '2', title: 'Валидная позиция', specific: { okeiName: 'Штука', referencePrice: 100 } },
    ],
  });
  const offers = parseAutocomplete(body, FETCHED_AT);
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.externalId, '2');
});

test('parseAutocomplete: отсутствие okeiName -> unitText null, предложение не теряется', () => {
  const body = JSON.stringify({
    items: [{ id: '3', title: 'Товар без единицы', specific: { referencePrice: 500 } }],
  });
  const offers = parseAutocomplete(body, FETCHED_AT);
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.unitText, null);
});

test('buildAutocompleteUrl: кодирует текст запроса в queryFilter', () => {
  const url = buildAutocompleteUrl('бумага');
  assert.ok(url.startsWith('https://zakupki.mos.ru/newapi/api/SkuSearch/QueryAutocomplete?queryFilter='));
  const queryFilterRaw = new URL(url).searchParams.get('queryFilter');
  assert.ok(queryFilterRaw);
  const queryFilter = JSON.parse(queryFilterRaw);
  assert.equal(queryFilter.isExact, false);
  assert.equal(queryFilter.keyword, 'бумага');
});
