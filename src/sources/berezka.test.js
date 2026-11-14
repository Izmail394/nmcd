/**
 * Тесты чистых функций разбора адаптера ЕАТ «Берёзка».
 *
 * ВАЖНО: вживую сайт agregatoreat.ru (и проверенные API-хосты
 * tender-cache-api.agregatoreat.ru, registry-api.agregatoreat.ru, а также robots.txt)
 * на все запросы отдают HTTP 200 с антибот-страницей (JS-испытание: вычисление
 * хеша в браузере и установка cookie __js_p_/__jhash_), а не реальные данные —
 * см. test/fixtures/berezka/antibot-challenge-*.html, снятые вживую curl'ом.
 * Поэтому настоящую структуру успешного ответа каталога/лотов подтвердить не удалось,
 * и фикстуры *.synthetic.json — иллюстративные (не captured traffic), используются
 * только для проверки отказоустойчивого разбора (пустая выдача, неизвестная структура,
 * пропуск предложения без цены). Это явно отражено в отчёте адаптера.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceError } from '../core/http.js';
import { isAntiBotChallenge, parseSearch } from './berezka.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(here, '..', '..', 'test', 'fixtures', 'berezka');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

function makeResponse(body, url = 'https://agregatoreat.ru/') {
  return {
    status: 200,
    url,
    contentType: 'application/json; charset=utf-8',
    body,
    fetchedAt: '2026-11-13T10:00:00.000Z',
  };
}

test('isAntiBotChallenge распознаёт реальную антибот-страницу главной', () => {
  const body = readFixture('antibot-challenge-homepage.html');
  assert.equal(isAntiBotChallenge(body), true);
});

test('isAntiBotChallenge распознаёт реальную антибот-страницу API-хоста', () => {
  const body = readFixture('antibot-challenge-tender-cache-api.html');
  assert.equal(isAntiBotChallenge(body), true);
});

test('isAntiBotChallenge не срабатывает на обычном JSON', () => {
  assert.equal(isAntiBotChallenge('{"items":[]}'), false);
});

test('parseSearch бросает SourceError("blocked") на антибот-странице', () => {
  const response = makeResponse(readFixture('antibot-challenge-homepage.html'), 'https://agregatoreat.ru/');
  assert.throws(
    () => parseSearch(response),
    (error) => error instanceof SourceError && error.kind === 'blocked',
  );
});

test('parseSearch возвращает [] при пустой выдаче', () => {
  const response = makeResponse(readFixture('search-empty.synthetic.json'));
  const offers = parseSearch(response);
  assert.deepEqual(offers, []);
});

test('parseSearch бросает SourceError("parse") при неожиданной структуре ответа', () => {
  const response = makeResponse(readFixture('search-unexpected-shape.synthetic.json'));
  assert.throws(
    () => parseSearch(response),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseSearch бросает SourceError("parse") на не-JSON ответе', () => {
  const response = makeResponse('<html>совсем не то</html>');
  assert.throws(
    () => parseSearch(response),
    (error) => error instanceof SourceError && error.kind === 'parse',
  );
});

test('parseSearch разбирает корректные предложения и пропускает предложение без цены', () => {
  const fetchedAt = '2026-11-13T10:00:00.000Z';
  const response = { ...makeResponse(readFixture('search-example.synthetic.json')), fetchedAt };
  const offers = parseSearch(response);

  assert.equal(offers.length, 2, 'предложение OFFER-003 без цены должно быть пропущено');

  const [first, second] = offers;
  assert.ok(first && second, 'ожидались два предложения');
  assert.equal(first.sourceId, 'berezka');
  assert.equal(first.externalId, 'OFFER-001');
  assert.equal(first.title, 'Бумага офисная А4, 80 г/м2, 500 листов');
  assert.equal(first.priceRub, 320.5);
  assert.equal(first.unitText, 'упак');
  assert.equal(first.url, 'https://agregatoreat.ru/offer/OFFER-001');
  assert.equal(first.vat, 'unknown');
  assert.equal(first.supplier, 'ООО "Канцторг"');
  assert.deepEqual(first.characteristics, { Плотность: '80 г/м2', Формат: 'А4', 'Листов в упаковке': '500' });
  assert.equal(first.fetchedAt, fetchedAt, 'fetchedAt должен пробрасываться из аргумента, а не браться из текущего времени');

  assert.equal(second.externalId, 'OFFER-002');
  assert.equal(second.priceRub, 2890);
});

test('parseSearch принимает ответ как «голый» JSON-массив без обёртки items', () => {
  const body = JSON.stringify([
    {
      id: 'X-1',
      title: 'Тест прямого массива',
      url: 'https://agregatoreat.ru/offer/X-1',
      price: 10,
      unit: 'шт',
    },
  ]);
  const offers = parseSearch(makeResponse(body));
  assert.equal(offers.length, 1);
  assert.equal(offers[0]?.priceRub, 10);
});

test('parseSearch пропускает предложение без ссылки, даже если цена есть', () => {
  const body = JSON.stringify({ items: [{ id: 'Y-1', title: 'Без ссылки', price: 100 }] });
  const offers = parseSearch(makeResponse(body));
  assert.deepEqual(offers, []);
});
