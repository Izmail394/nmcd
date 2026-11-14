/**
 * Яндекс.Маркет: выдача поиска публикует товары в разметке schema.org (JSON-LD, ItemList).
 * Берётся только то, что опубликовано: название, цена, ссылка, SKU и краткие характеристики.
 * Единицу продажи Маркет не публикует — unitText остаётся пустым, карточка товара
 * считается одной штукой на уровне конфигурации источника (defaultUnit).
 */

import { SourceError } from '../core/http.js';
import { extractJsonLd, hasType, httpUrl, isObject, price, text } from './_jsonld.js';

const SOURCE_ID = 'ymarket';
const SEARCH_URL = 'https://market.yandex.ru/search?text=';
const CAPTCHA = /showcaptcha|captcha\.yandex|smartcaptcha|Подтвердите, что запросы отправляли вы/i;

/** «Количество: 5 штук; Формат: A4» -> { Количество: '5 штук', Формат: 'A4' }. Повтор названия — берётся последнее значение. */
function characteristicsFrom(description) {
  const characteristics = {};
  for (const part of (text(description) ?? '').split(';')) {
    const separator = part.indexOf(':');
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name && value) characteristics[name] = value;
  }
  return characteristics;
}

function products(html) {
  const blocks = extractJsonLd(html);
  const list = blocks.find((block) => hasType(block, 'ItemList'));
  if (list) {
    const elements = Array.isArray(list.itemListElement) ? list.itemListElement : [];
    return elements.map((element) => (isObject(element) && isObject(element.item) ? element.item : element)).filter(isObject);
  }
  const standalone = blocks.filter((block) => hasType(block, 'Product'));
  return standalone.length > 0 ? standalone : null;
}

export function parseSearch(body, fetchedAt) {
  if (CAPTCHA.test(body)) {
    throw new SourceError('blocked', 'Яндекс.Маркет показал проверку «Вы не робот» — автоматический запрос отклонён.');
  }
  const items = products(body);
  if (items === null) {
    throw new SourceError('parse', 'В выдаче Яндекс.Маркета нет разметки ItemList — структура страницы изменилась.');
  }
  const offers = [];
  for (const item of items) {
    const offer = isObject(item.offers) ? item.offers : {};
    const title = text(item.name);
    const url = httpUrl(item.url) ?? httpUrl(offer.url) ?? httpUrl(item['@id']);
    const priceRub = price(offer.price);
    const currency = text(offer.priceCurrency) ?? 'RUB';
    if (!title || !url || priceRub === null || (currency !== 'RUB' && currency !== 'RUR')) continue;
    const externalId =
      text(item.sku) ??
      url
        .replace(/[?#].*$/, '')
        .split('/')
        .filter(Boolean)
        .pop() ??
      url;
    offers.push({
      sourceId: SOURCE_ID,
      externalId,
      url,
      title,
      priceRub,
      unitText: null,
      vat: 'unknown',
      characteristics: characteristicsFrom(item.description),
      fetchedAt,
      evidence: `Цена ${priceRub} RUB из JSON-LD выдачи Яндекс.Маркета; цена без авторизации.`,
    });
  }
  return offers;
}

/** Характеристики первой карточки товара в разметке страницы. */
export function parseCard(body) {
  if (CAPTCHA.test(body)) {
    throw new SourceError('blocked', 'Яндекс.Маркет показал проверку «Вы не робот» при открытии карточки.');
  }
  const first = products(body)?.[0];
  return first ? characteristicsFrom(first.description) : {};
}

const createSource = (options = {}) => {
  const detailLimit = typeof options.detailLimit === 'number' && options.detailLimit >= 0 ? Math.floor(options.detailLimit) : 6;
  return {
    id: SOURCE_ID,
    name: 'Яндекс.Маркет',
    kind: 'marketplace',
    homepage: 'https://market.yandex.ru',
    async search(query, ctx) {
      let offers = [];
      for (const phrase of [query.text, ...query.altTexts.slice(0, 2)]) {
        const response = await ctx.http.get(`${SEARCH_URL}${encodeURIComponent(phrase)}`, { signal: ctx.signal });
        offers = parseSearch(response.body, response.fetchedAt).slice(0, query.limit);
        if (offers.length > 0) break;
      }
      // Характеристики обычно есть уже в выдаче; карточки дозапрашиваются только там, где их нет.
      let requested = 0;
      for (const offer of offers) {
        if (requested >= detailLimit) break;
        if (Object.keys(offer.characteristics).length > 0) continue;
        requested += 1;
        try {
          const card = await ctx.http.get(offer.url, { signal: ctx.signal });
          offer.characteristics = parseCard(card.body);
        } catch (error) {
          ctx.log(`карточка ${offer.externalId} не получена: ${error instanceof Error ? error.message : String(error)}`);
          if (error instanceof SourceError && error.kind === 'blocked') break;
        }
      }
      return offers;
    },
  };
};

export default createSource;
