import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { SourceError } from '../core/http.js';
import { parseProductCharacteristics, parseSearch } from './etm.js';

const fixturesDir = path.resolve(import.meta.dirname, '../../test/fixtures/etm');
const fetchedAt = '2026-11-13T17:00:00.000Z';
const cableSearch = readFileSync(path.join(fixturesDir, 'search-cable.html'), 'utf8');
const emptySearch = readFileSync(path.join(fixturesDir, 'search-empty.html'), 'utf8');
const product = readFileSync(path.join(fixturesDir, 'product-5480173.html'), 'utf8');

test('разбирает публичные розничные цены и реквизиты предложений ЭТМ', () => {
  const offers = parseSearch(cableSearch, fetchedAt);

  assert.equal(offers.length, 3);
  assert.deepEqual(offers[0], {
    sourceId: 'etm',
    externalId: 'ETM5480173',
    url: 'https://www.etm.ru/cat/nn/5480173',
    title: 'Кабель силовой ВВГнг(А)-LS 3x2,5ок(N,PE)-0,66 100м ТРТС',
    priceRub: 185.93,
    unitText: 'м',
    vat: 'unknown',
    characteristics: {},
    supplier: 'КОРДЛАЙН',
    fetchedAt,
    evidence: 'Розничная цена: 185.93 ₽/м; код товара: ETM5480173',
  });
});

test('разбирает характеристики карточки товара ЭТМ', () => {
  const details = parseProductCharacteristics(product);

  assert.deepEqual(details, {
    externalId: 'ETM5480173',
    characteristics: {
      Страна: 'Россия',
      Производитель: 'КОРДЛАЙН',
      'Ед.измерения': 'м',
      'Тип изделия': 'Кабель',
      Марка: 'ВВГнг(A)-LS',
      'Количество жил': '3',
      'Сечение жилы, мм2': '2.5',
      'Материал жилы': 'Медь',
      'Конструкция жилы': 'Однопроволочная',
      'Форма жилы': 'Круглая',
    },
  });
});

test('возвращает пустой массив для подтверждённой пустой выдачи', () => {
  assert.deepEqual(parseSearch(emptySearch, fetchedAt), []);
});

test('пропускает товар без публичной розничной цены', () => {
  const noPrice = cableSearch.replace('"price98":"185.93"', '"price98":""').replace('"price482":"185.93"', '"price482":""');

  const offers = parseSearch(noPrice, fetchedAt);

  assert.equal(offers.length, 2);
  assert.equal(
    offers.some((offer) => offer.externalId === 'ETM5480173'),
    false,
  );
});

test('считает изменённую структуру ошибкой разбора', () => {
  assert.throws(
    () => parseSearch('<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script></html>', fetchedAt),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('распознаёт антибот-страницу при HTTP 200', () => {
  assert.throws(
    () => parseSearch('<html><title>Attention Required! | Cloudflare</title><p>captcha</p></html>', fetchedAt),
    (error) => error instanceof SourceError && error.kind === 'blocked',
  );
});
