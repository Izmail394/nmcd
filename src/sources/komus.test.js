/**
 * Тесты чистых функций разбора адаптера Комуса.
 *
 * Фикстуры в test/fixtures/komus/ — обрезанные РЕАЛЬНЫЕ ответы, снятые вживую curl'ом
 * (Chrome UA, с паузами между запросами, без решения капч и подмены отпечатков):
 *  - blocked-listing.html — настоящий ответ POST /api/listing: HTTP 503, защитная
 *    страница ngenix («Запросы с вашего IP-адреса похожи на автоматические»).
 *  - product-paper-a4.html / product-pen.html — настоящие карточки товаров (вырезаны
 *    служебные блоки, сохранена структура: schema.org микроданные, список характеристик).
 *  - product-no-price.html — та же карточка бумаги, но строка с ценой вырезана
 *    (проверка «товар без цены пропускается»).
 *  - search-shell.html — начало настоящей страницы выдачи `/search?text=...`: в ней
 *    нет ни карточек товаров, ни признака «ничего не найдено» (это подтверждено вживую —
 *    выдачу полностью рисует браузер через защищённый /api/listing), поэтому она служит
 *    примером «структура не распознана».
 *
 * Успешного ответа /api/listing получить вживую не удалось (эндпоинт блокируется),
 * поэтому разбор его JSON (`parseListing`) для «валидного списка товаров» проверяется
 * только на минимальных структурных примерах ниже (обозначено явно) — это проверка
 * устойчивости разбора по именам полей, а не воспроизведение настоящих данных Комуса.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceError } from '../core/http.js';
import { isBotChallenge, parseListing, parseProductPage } from './komus.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', 'test', 'fixtures', 'komus');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

function htmlResponse(body, url, status = 200) {
  return { status, url, contentType: 'text/html; charset=utf-8', body, fetchedAt: '2026-11-14T10:00:00.000Z' };
}

const LISTING_URL = 'https://www.komus.ru/api/listing';

function jsonResponse(body, url = LISTING_URL) {
  return { status: 200, url, contentType: 'application/json; charset=utf-8', body, fetchedAt: '2026-11-14T10:00:00.000Z' };
}

test('isBotChallenge распознаёт реальную защитную страницу ngenix', () => {
  assert.equal(isBotChallenge(readFixture('blocked-listing.html')), true);
});

test('isBotChallenge не срабатывает на обычном JSON', () => {
  assert.equal(isBotChallenge('{"products":[]}'), false);
});

test('parseListing бросает SourceError("blocked") на реальной защитной странице ngenix', () => {
  const response = htmlResponse(readFixture('blocked-listing.html'), LISTING_URL, 503);
  assert.throws(
    () => parseListing(response),
    (error) => error instanceof SourceError && error.kind === 'blocked',
  );
});

test('parseListing бросает SourceError("parse") на не-JSON ответе (реальный обрывок страницы выдачи)', () => {
  const response = htmlResponse(readFixture('search-shell.html'), 'https://www.komus.ru/search?text=x');
  assert.throws(
    () => parseListing(response),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseListing бросает SourceError("parse"), если в JSON нет распознанного списка товаров', () => {
  assert.throws(
    () => parseListing(jsonResponse('{"facets":[],"pagination":{"totalResults":0}}')),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseListing возвращает [] при пустом списке товаров', () => {
  assert.deepEqual(parseListing(jsonResponse('{"products":[]}')), []);
});

test('parseListing: структурная проверка устойчивости разбора по именам полей (не настоящие данные Комуса)', () => {
  const fetchedAt = '2026-11-14T10:00:00.000Z';
  const body = JSON.stringify({
    products: [
      { name: 'Позиция с ценой и ссылкой', price: { value: 123.45 }, url: '/p/1/', code: 'SKU-1', unitName: 'шт' },
      { name: 'Позиция без цены', url: '/p/2/', code: 'SKU-2' },
    ],
  });
  const offers = parseListing({ ...jsonResponse(body), fetchedAt });
  assert.equal(offers.length, 1, 'позиция без цены должна быть пропущена');
  assert.equal(offers[0]?.sourceId, 'komus');
  assert.equal(offers[0]?.externalId, 'SKU-1');
  assert.equal(offers[0]?.priceRub, 123.45);
  assert.equal(offers[0]?.unitText, 'шт');
  assert.equal(offers[0]?.url, 'https://www.komus.ru/p/1/');
  assert.equal(offers[0]?.vat, 'included');
  assert.equal(offers[0]?.fetchedAt, fetchedAt);
});

test('parseProductPage разбирает настоящую карточку бумаги: цена, артикул, характеристики', () => {
  const fetchedAt = '2026-11-14T09:30:00.000Z';
  const url = 'https://www.komus.ru/katalog/.../bumaga-ofisnaya-ballet-classic-a4-80-g-kv-m-marka-b-153-cie-500-listov-/p/65685/';
  const response = { ...htmlResponse(readFixture('product-paper-a4.html'), url), fetchedAt };

  const offer = parseProductPage(response);
  assert.ok(offer, 'ожидалось предложение');
  assert.equal(offer.sourceId, 'komus');
  assert.equal(offer.externalId, '65685');
  assert.equal(offer.title, 'Бумага офисная Ballet Classic А4 80 г/кв.м марка B 153 CIE (500 листов)');
  assert.equal(offer.priceRub, 660.06);
  assert.equal(offer.unitText, null, 'единицу продажи статическая карточка не публикует');
  assert.equal(offer.vat, 'included');
  assert.equal(offer.url, url, 'url должен совпадать со страницей карточки');
  assert.equal(offer.fetchedAt, fetchedAt, 'fetchedAt должен пробрасываться из аргумента');
  assert.deepEqual(offer.characteristics, {
    'Торговая марка': 'Ballet Classic',
    'Формат листов': 'А4',
    'Марка бумаги': 'B',
    'Количество листов в пачке': '500',
    'Белизна CIE %': '153 ± 3',
  });
});

test('parseProductPage разбирает настоящую карточку ручки (второй реальный пример)', () => {
  const url = 'https://www.komus.ru/katalog/.../ruchka-sharikovaya-attache-meridian-sinyaya-.../p/1197263/';
  const offer = parseProductPage(htmlResponse(readFixture('product-pen.html'), url));

  assert.ok(offer);
  assert.equal(offer.externalId, '1197263');
  assert.equal(offer.title, 'Ручка шариковая Attache Meridian синяя (серо-фиолетовый корпус, толщина линии 0.35 мм)');
  assert.equal(offer.priceRub, 41.8);
  assert.equal(offer.vat, 'included');
  assert.deepEqual(offer.characteristics, {
    'Торговая марка': 'Attache',
    Коллекция: 'Ручки Meridian',
    'Цвет чернил': 'синий',
    'Толщина линии письма, мм': '0.35',
    'Диаметр шарика, мм': '0.6',
  });
});

test('parseProductPage пропускает товар без цены (реальная карточка с вырезанной строкой цены)', () => {
  const url = 'https://www.komus.ru/katalog/.../p/65685/';
  const offer = parseProductPage(htmlResponse(readFixture('product-no-price.html'), url));
  assert.equal(offer, null);
});

test('parseProductPage бросает SourceError("blocked") на реальной защитной странице ngenix', () => {
  const response = htmlResponse(readFixture('blocked-listing.html'), 'https://www.komus.ru/katalog/.../p/1/', 503);
  assert.throws(
    () => parseProductPage(response),
    (error) => error instanceof SourceError && error.kind === 'blocked',
  );
});

test('parseProductPage бросает SourceError("parse") на странице, не похожей на карточку товара', () => {
  const response = htmlResponse(readFixture('search-shell.html'), 'https://www.komus.ru/search?text=x');
  assert.throws(
    () => parseProductPage(response),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});
