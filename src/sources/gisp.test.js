/**
 * Тесты чистых функций разбора для адаптера ГИСП (gisp.gov.ru).
 *
 * Фикстуры в test/fixtures/gisp/*.html — это РЕАЛЬНЫЕ ответы, сохранённые при
 * разведке (curl, обычный User-Agent Chrome): все проверенные пути сайта
 * (/, /goods/, /exhkqyad) отдают одну и ту же страницу анти-бота ServicePipe
 * с кодом 200 вместо каталога. Реального ответа каталога с товарами и ценами
 * получить не удалось — сайт блокирует автоматические запросы на уровне edge
 * (подробности см. в комментариях gisp.js и в отчёте задачи).
 *
 * Поэтому ниже два слоя тестов:
 *  1) на реальных фикстурах — проверяют распознавание блокировки;
 *  2) на синтетических JSON-строках, написанных для этого теста вручную
 *     (НЕ выданы источником) — проверяют защитный разбор обобщённой структуры
 *     каталога (контейнер items/data/results/..., пропуск позиций без цены,
 *     ошибка при неузнанной структуре). Эта ветка кода никогда не была
 *     проверена на настоящем ответе ГИСП, так как до него не удалось дойти.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceError } from '../core/http.js';
import { isAntibotChallenge, parseSearch } from './gisp.js';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'test', 'fixtures', 'gisp');
const FETCHED_AT = '2026-11-13T12:00:00.000Z';

function readFixture(name) {
  return fs.readFileSync(path.join(FIXTURES_DIR, name), 'utf8');
}

const REAL_ANTIBOT_FIXTURES = ['root-antibot-challenge.html', 'goods-antibot-challenge.html', 'noscript-redirect-antibot-challenge.html'];

test('isAntibotChallenge: распознаёт все сохранённые реальные страницы анти-бота ГИСП', () => {
  for (const name of REAL_ANTIBOT_FIXTURES) {
    const body = readFixture(name);
    assert.equal(isAntibotChallenge(body), true, `фикстура ${name} должна определяться как страница анти-бота`);
  }
});

test('isAntibotChallenge: не путает обычный JSON/HTML со страницей анти-бота', () => {
  assert.equal(isAntibotChallenge('{"items":[]}'), false);
  assert.equal(isAntibotChallenge('<html><body>Каталог товаров</body></html>'), false);
});

test('parseSearch: на реальных страницах анти-бота бросает SourceError("blocked") с понятным сообщением', () => {
  for (const name of REAL_ANTIBOT_FIXTURES) {
    const body = readFixture(name);
    assert.throws(
      () => parseSearch(body, FETCHED_AT),
      (error) => {
        assert.ok(error instanceof SourceError, `${name}: ожидалась SourceError`);
        assert.equal(error.kind, 'blocked');
        assert.match(error.message, /анти-бот|ServicePipe|блок/i);
        return true;
      },
    );
  }
});

test('parseSearch: разбирает корректные поля предложения (синтетический ответ каталога)', () => {
  const body = JSON.stringify({
    items: [
      {
        id: 'GISP-42',
        name: 'Кабель силовой ВВГнг-LS 3х2.5',
        price: 125.5,
        unit: 'м',
        url: '/goods/card/42',
        okpd2: '27.32.13.110',
        manufacturer: 'ООО «Завод кабельной продукции»',
        region: 'Московская область',
        characteristics: { Сечение: '2.5 мм2', Жилы: '3' },
      },
    ],
  });

  const offers = parseSearch(body, FETCHED_AT);

  assert.equal(offers.length, 1);
  const offer = offers[0];
  assert.equal(offer.sourceId, 'gisp');
  assert.equal(offer.externalId, 'GISP-42');
  assert.equal(offer.title, 'Кабель силовой ВВГнг-LS 3х2.5');
  assert.equal(offer.priceRub, 125.5);
  assert.equal(offer.unitText, 'м');
  assert.equal(offer.url, 'https://gisp.gov.ru/goods/card/42');
  assert.equal(offer.okpd2, '27.32.13.110');
  assert.equal(offer.supplier, 'ООО «Завод кабельной продукции»');
  assert.equal(offer.region, 'Московская область');
  assert.deepEqual(offer.characteristics, { Сечение: '2.5 мм2', Жилы: '3' });
  assert.equal(offer.vat, 'unknown');
  assert.equal(offer.fetchedAt, FETCHED_AT);
});

test('parseSearch: пустая выдача каталога -> []', () => {
  const body = JSON.stringify({ items: [] });
  assert.deepEqual(parseSearch(body, FETCHED_AT), []);
});

test('parseSearch: позиция без цены (0 или отсутствует) пропускается, остальные возвращаются', () => {
  const body = JSON.stringify({
    items: [
      { id: '1', name: 'Светильник без цены', price: 0, url: '/goods/1' },
      { id: '2', name: 'Светильник без поля цены', url: '/goods/2' },
      { id: '3', name: 'Светильник светодиодный LED-40', price: 2300, unit: 'шт', url: '/goods/3' },
    ],
  });

  const offers = parseSearch(body, FETCHED_AT);

  assert.equal(offers.length, 1);
  assert.equal(offers[0].externalId, '3');
  assert.equal(offers[0].priceRub, 2300);
});

test('parseSearch: ответ не JSON и не страница анти-бота -> SourceError("parse")', () => {
  assert.throws(
    () => parseSearch('<html><body>какая-то другая страница</body></html>', FETCHED_AT),
    (error) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'parse');
      return true;
    },
  );
});

test('parseSearch: JSON без ожидаемого контейнера товаров -> SourceError("parse")', () => {
  assert.throws(
    () => parseSearch(JSON.stringify({ status: 'ok', payload: { count: 0 } }), FETCHED_AT),
    (error) => {
      assert.ok(error instanceof SourceError);
      assert.equal(error.kind, 'parse');
      return true;
    },
  );
});
