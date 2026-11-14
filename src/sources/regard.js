/**
 * Регард (regard.ru): каталог публикует выдачу в разметке schema.org (JSON-LD, OfferCatalog).
 * Ассортимент — компьютерная и офисная техника, расходные материалы.
 * Единицу продажи магазин не публикует — unitText остаётся пустым, карточка товара
 * считается одной штукой на уровне конфигурации источника (defaultUnit).
 */

import { SourceError } from '../core/http.js';
import { extractJsonLd, hasType, httpUrl, isObject, price, text } from './_jsonld.js';

const SOURCE_ID = 'regard';
const SEARCH_URL = 'https://www.regard.ru/catalog?search=';
const ANTIBOT = /__CHALLENGE__|challenge-platform|servicepipe|captcha/i;
const NOTHING_FOUND = /ничего не найдено/i;

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Краткое описание Регарда — перечень через запятую: «офисная бумага, матовое покрытие,
 * формат: A4, 80 г/м2, количество листов: 500 шт.». Части «название: значение» берутся как есть,
 * неподписанные распознаются по очевидным признакам, остальное складывается в «Описание».
 */
function characteristicsFrom(description) {
  const characteristics = {};
  const rest = [];
  const parts = (text(description) ?? '')
    .split(/,\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  parts.forEach((part, index) => {
    const separator = part.indexOf(':');
    if (separator > 0) {
      const name = capitalize(part.slice(0, separator).trim());
      const value = part.slice(separator + 1).trim();
      if (name && value) characteristics[name] = value;
    } else if (index === 0) {
      characteristics['Тип'] = part;
    } else if (/покрытие/i.test(part)) {
      characteristics['Покрытие'] = part;
    } else if (/\d\s?г\/м[2²]/i.test(part)) {
      characteristics['Плотность'] = part;
    } else {
      rest.push(part);
    }
  });
  if (rest.length > 0) characteristics['Описание'] = rest.join(', ');
  return characteristics;
}

export function parseSearch(body, fetchedAt) {
  const catalog = extractJsonLd(body).find((block) => hasType(block, 'OfferCatalog'));
  if (!catalog) {
    if (ANTIBOT.test(body)) throw new SourceError('blocked', 'Регард показал страницу проверки — автоматический запрос отклонён.');
    if (NOTHING_FOUND.test(body)) return [];
    throw new SourceError('parse', 'В выдаче Регарда нет разметки OfferCatalog — структура страницы изменилась.');
  }
  const offers = [];
  for (const item of Array.isArray(catalog.itemListElement) ? catalog.itemListElement : []) {
    if (!isObject(item)) continue;
    const title = text(item.name);
    const url = httpUrl(item.url);
    const priceRub = price(item.price);
    const currency = text(item.priceCurrency) ?? 'RUB';
    if (!title || !url || priceRub === null || currency !== 'RUB') continue;
    const externalId = /\/product\/(\d+)/.exec(url)?.[1] ?? url;
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
      evidence: `Цена ${priceRub} RUB из JSON-LD выдачи Regard; цена без авторизации.`,
    });
  }
  return offers;
}

export function parseCard(body) {
  const product = extractJsonLd(body).find((block) => hasType(block, 'Product'));
  if (!product) {
    if (ANTIBOT.test(body)) throw new SourceError('blocked', 'Регард показал страницу проверки при открытии карточки.');
    throw new SourceError('parse', 'В карточке Регарда нет разметки Product.');
  }
  const characteristics = characteristicsFrom(product.description);
  const brand = isObject(product.brand) ? text(product.brand.name) : text(product.brand);
  if (brand) characteristics['Бренд'] = brand;
  const offer = isObject(product.offers) ? product.offers : {};
  const supplier = isObject(offer.seller) ? text(offer.seller.name) : null;
  return supplier ? { characteristics, supplier } : { characteristics };
}

const createSource = (options = {}) => {
  const detailLimit = typeof options.detailLimit === 'number' && options.detailLimit >= 0 ? Math.floor(options.detailLimit) : 6;
  return {
    id: SOURCE_ID,
    name: 'Регард',
    kind: 'marketplace',
    homepage: 'https://www.regard.ru',
    async search(query, ctx) {
      let offers = [];
      for (const phrase of [query.text, ...query.altTexts.slice(0, 2)]) {
        const response = await ctx.http.get(`${SEARCH_URL}${encodeURIComponent(phrase)}`, { signal: ctx.signal });
        offers = parseSearch(response.body, response.fetchedAt).slice(0, query.limit);
        if (offers.length > 0) break;
      }
      // Карточка добавляет бренд и продавца; сбой одной карточки не влияет на остальные предложения.
      for (const offer of offers.slice(0, detailLimit)) {
        try {
          const card = parseCard((await ctx.http.get(offer.url, { signal: ctx.signal })).body);
          offer.characteristics = { ...offer.characteristics, ...card.characteristics };
          if (card.supplier) offer.supplier = card.supplier;
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
