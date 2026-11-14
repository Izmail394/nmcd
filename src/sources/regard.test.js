import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { SourceError } from '../core/http.js';
import createSource, { parseCard, parseSearch } from './regard.js';

const fetchedAt = '2026-11-13T17:00:00.000Z';
const fixture = (name) => readFileSync(new URL(`../../test/fixtures/regard/${name}`, import.meta.url), 'utf8');
const hasKind = (kind) => (error) => error instanceof SourceError && error.kind === kind;

test('parseSearch Регарда разбирает опубликованные цену, ссылку и характеристики', () => {
  const offers = parseSearch(fixture('search.html'), fetchedAt);

  assert.equal(offers.length, 3);
  assert.deepEqual(offers[0], {
    sourceId: 'regard',
    externalId: '105108',
    url: 'https://www.regard.ru/product/105108/bumaga-svetocopy-a4-80-g-m2-500-listov',
    title: 'Бумага SvetoCopy (A4, 80 г/м2, 500 листов)',
    priceRub: 550,
    unitText: null,
    vat: 'unknown',
    characteristics: {
      Тип: 'офисная бумага',
      Покрытие: 'матовое покрытие',
      Формат: 'A4',
      Плотность: '80 г/м2',
      'Количество листов': '500 шт.',
    },
    fetchedAt,
    evidence: 'Цена 550 RUB из JSON-LD выдачи Regard; цена без авторизации.',
  });
});

test('parseSearch Регарда возвращает пустой массив для реального сообщения об отсутствии результатов', () => {
  assert.deepEqual(parseSearch(fixture('empty.html'), fetchedAt), []);
});

test('parseSearch Регарда пропускает товар без валидной цены', () => {
  const body = fixture('search.html').replace('"price":550', '"price":"нет цены"');
  const offers = parseSearch(body, fetchedAt);

  assert.equal(offers.length, 2);
  assert.equal(offers[0]?.externalId, '144734');
});

test('parseSearch Регарда сохраняет копейки в цене', () => {
  const body = fixture('search.html').replace('"price":550', '"price":"550.50"');
  assert.equal(parseSearch(body, fetchedAt)[0]?.priceRub, 550.5);
});

test('parseSearch Регарда сохраняет специальные символы в опубликованном названии', () => {
  const body = fixture('search.html').replace('Бумага SvetoCopy (A4, 80 г/м2, 500 листов)', "Бумага «ёж» 😀 ' OR 1=1");
  assert.equal(parseSearch(body, fetchedAt)[0]?.title, "Бумага «ёж» 😀 ' OR 1=1");
});

test('parseSearch Регарда сообщает об изменении структуры', () => {
  assert.throws(() => parseSearch('<html><body>каталог доступен</body></html>', fetchedAt), hasKind('parse'));
});

test('parseSearch Регарда распознаёт антибот-страницу', () => {
  assert.throws(() => parseSearch('<html><script>window.__CHALLENGE__ = {}</script></html>', fetchedAt), hasKind('blocked'));
});

test('parseCard Регарда извлекает характеристики и поставщика карточки', () => {
  assert.deepEqual(parseCard(fixture('card.html')), {
    characteristics: {
      Тип: 'офисная бумага',
      Покрытие: 'матовое покрытие',
      Формат: 'A4',
      Плотность: '80 г/м2',
      'Количество листов': '500 шт.',
      Бренд: 'SvetoCopy',
    },
    supplier: 'Regard',
  });
});

test('адаптер Регарда не роняет выдачу из-за сбоя карточки и соблюдает limit', async () => {
  const source = createSource({ detailLimit: 1 });
  const urls = [];
  const offers = await source.search(
    { text: 'бумага', altTexts: [], limit: 2 },
    {
      http: {
        get: async (url, options) => {
          urls.push(url);
          assert.ok(options?.signal);
          if (urls.length === 1) return { status: 200, url, contentType: 'text/html', body: fixture('search.html'), fetchedAt };
          throw new SourceError('network', 'Сеть недоступна');
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

  assert.equal(offers.length, 2);
  assert.equal(urls.length, 2);
  assert.equal(offers[0]?.supplier, undefined);
});
