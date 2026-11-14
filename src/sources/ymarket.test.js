import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SourceError } from '../core/http.js';
import createSource, { parseCard, parseSearch } from './ymarket.js';

const fetchedAt = '2026-11-13T17:00:00.000Z';
const fixture = (name) => readFileSync(new URL(`../../test/fixtures/ymarket/${name}`, import.meta.url), 'utf8');
const hasKind = (kind) => (error) => error instanceof SourceError && error.kind === kind;

test('parseSearch Яндекс.Маркета разбирает опубликованные цену и характеристики', () => {
  const offers = parseSearch(fixture('search.html'), fetchedAt);

  assert.equal(offers.length, 3);
  assert.deepEqual(offers[0], {
    sourceId: 'ymarket',
    externalId: '101470777773',
    url: 'https://market.yandex.ru/card/bumaga-a4-svetocopy-dlya-printera-belaya-2500-listov-bumaga-ofisnaya-dlya-pechati-kserokopirovaniya-risovaniya-kalligrafii-i-letteringa-vlagostoykaya/4648531286',
    title: 'Бумага а4 SvetoCopy для принтера белая 2500 листов. Бумага офисная для печати, ксерокопирования, рисования, творчества.',
    priceRub: 2146,
    unitText: null,
    vat: 'unknown',
    characteristics: {
      Количество: '2500 листов',
      'Цвет товара': 'белый',
      Формат: 'A4',
      Плотность: '80 г/м²',
    },
    fetchedAt,
    evidence: 'Цена 2146 RUB из JSON-LD выдачи Яндекс.Маркета; цена без авторизации.',
  });
});

test('parseSearch Яндекс.Маркета возвращает пустой массив для пустого ItemList', () => {
  assert.deepEqual(parseSearch(fixture('empty.html'), fetchedAt), []);
});

test('parseSearch Яндекс.Маркета пропускает товар без цены', () => {
  const body = fixture('search.html').replace('"price":2146', '"price":null');
  const offers = parseSearch(body, fetchedAt);

  assert.equal(offers.length, 2);
  assert.equal(offers[0]?.externalId, '101949261125');
});

test('parseSearch Яндекс.Маркета сохраняет копейки в цене', () => {
  const body = fixture('search.html').replace('"price":2146', '"price":"2146.50"');
  assert.equal(parseSearch(body, fetchedAt)[0]?.priceRub, 2146.5);
});

test('parseSearch Яндекс.Маркета сообщает об изменении структуры', () => {
  assert.throws(() => parseSearch('<html><body>обычная страница</body></html>', fetchedAt), hasKind('parse'));
});

test('parseSearch Яндекс.Маркета распознаёт страницу капчи', () => {
  assert.throws(() => parseSearch('<html><title>Ой!</title>captcha.yandex.ru/showcaptcha</html>', fetchedAt), hasKind('blocked'));
});

test('parseCard Яндекс.Маркета извлекает характеристики карточки', () => {
  const characteristics = parseCard(fixture('search.html'));
  assert.deepEqual(characteristics, {
    Количество: '2500 листов',
    'Цвет товара': 'белый',
    Формат: 'A4',
    Плотность: '80 г/м²',
  });
});

test('адаптер Яндекс.Маркета переходит к альтернативному запросу после пустой выдачи и соблюдает limit', async () => {
  const requests = [];
  const source = createSource({ detailLimit: 0 });
  const offers = await source.search(
    { text: 'пусто', altTexts: ['бумага', 'запасной'], limit: 1 },
    {
      http: {
        get: async (url, options) => {
          requests.push(url);
          assert.ok(options?.signal);
          return { status: 200, url, contentType: 'text/html', body: requests.length === 1 ? fixture('empty.html') : fixture('search.html'), fetchedAt };
        },
        post: async () => {
          throw new Error('POST не должен вызываться');
        },
      },
      signal: AbortSignal.timeout(1_000),
      log: () => undefined,
      now: () => new Date(fetchedAt),
    },
  );

  assert.equal(offers.length, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[1] ?? '', /text=%D0%B1%D1%83%D0%BC%D0%B0%D0%B3%D0%B0/);
});
