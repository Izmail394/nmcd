/**
 * Приведение цены предложения к сопоставимому виду:
 *   1) единица измерения и фасовка -> цена за единицу измерения закупки;
 *   2) НДС -> цена с НДС;
 *   3) давность -> индексация по ИПЦ (п. 3.18 Методических рекомендаций, приказ МЭР № 567).
 *
 * Каждая поправка записывается с исходными числами, чтобы пересчёт можно было повторить вручную.
 */

import { formatMoney, formatNumber, round2 } from './stats.js';
import { findContentCount, findPackCount, findPieceCount, findQuantity, parseUnit } from './units.js';

const CONTENT_CHARACTERISTIC = /вес|масса|объ[её]м|длина|количеств|фасовк|нетто|метраж|площадь|в упаковке|содерж/i;

function characteristicsText(offer, filter) {
  return Object.entries(offer.characteristics)
    .filter(([name]) => !filter || filter.test(name))
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

function physicalConversion(offer, purchase, offerUnit) {
  if (offerUnit && offerUnit.dimension === purchase.dimension) {
    const factor = purchase.toBase / offerUnit.toBase;
    const adjustments =
      factor === 1
        ? []
        : [{ kind: 'unit', factor, description: `Единица «${offerUnit.code}» приведена к «${purchase.code}»: цена × ${formatNumber(factor, 6)}.` }];
    return { factor, adjustments };
  }
  if (offerUnit && ['mass', 'volume', 'length', 'area'].includes(offerUnit.dimension)) {
    return { factor: 1, adjustments: [], failure: `Единица продажи «${offerUnit.code}» несопоставима с единицей закупки «${purchase.code}».` };
  }
  const content = findQuantity(offer.title, purchase.dimension) ?? findQuantity(characteristicsText(offer, CONTENT_CHARACTERISTIC), purchase.dimension);
  if (!content) {
    return {
      factor: 1,
      adjustments: [],
      failure: `Цена указана за «${offerUnit?.code ?? 'единицу товара'}», а количество в «${purchase.base}» в предложении не найдено — привести к «${purchase.code}» нельзя.`,
    };
  }
  const factor = purchase.toBase / content.valueInBase;
  return {
    factor,
    adjustments: [
      {
        kind: 'pack',
        factor,
        description: `Единица продажи содержит ${content.matched} (${formatNumber(content.valueInBase, 4)} ${purchase.base}): цена за 1 ${purchase.code} = цена × ${formatNumber(factor, 6)}.`,
      },
    ],
  };
}

function countConversion(offer, purchase, offerUnit, unitAssumed) {
  if (offerUnit && ['mass', 'volume', 'length', 'area', 'service'].includes(offerUnit.dimension)) {
    return { factor: 1, adjustments: [], failure: `Единица продажи «${offerUnit.code}» несопоставима с единицей закупки «${purchase.code}».` };
  }
  const adjustments = [];
  const pieces = findPieceCount(`${offer.unitText ?? ''} ${offer.title}`) ?? findPieceCount(characteristicsText(offer, CONTENT_CHARACTERISTIC));
  // Если источник явно продаёт поштучно, делим только при явном указании комплекта («50 шт/уп», «набор из 4 шт»).
  // Единица, подставленная по настройке источника, не говорит о поштучной продаже: «(4 штуки)» в названии — комплект.
  const soldByPiece = offerUnit?.dimension === 'count' && !unitAssumed;
  const explicitPack = pieces !== null && /уп|пач|кор|наб|компл|блок|[xх×*]/i.test(pieces.matched);
  if (pieces && (!soldByPiece || explicitPack)) {
    const factor = 1 / pieces.count;
    adjustments.push({
      kind: 'pack',
      factor,
      description: `Единица продажи содержит ${pieces.count} шт («${pieces.matched}»): цена за 1 шт = цена / ${pieces.count}.`,
    });
    return { factor, adjustments };
  }
  if (offerUnit && offerUnit.dimension === 'pack') {
    return {
      factor: 1,
      adjustments: [],
      failure: `Цена указана за «${offerUnit.code}», а число штук в ней не найдено — привести к «шт» нельзя.`,
    };
  }
  if (!offerUnit) {
    adjustments.push({ kind: 'unit', factor: 1, description: 'Единица измерения в источнике не указана — принято, что цена дана за 1 шт.' });
  }
  return { factor: 1, adjustments };
}

function packConversion(offer, requirement, offerUnit, rules) {
  const purchase = requirement.unit;
  if (offerUnit && ['mass', 'volume', 'length', 'area', 'service'].includes(offerUnit.dimension)) {
    return { factor: 1, adjustments: [], failure: `Единица продажи «${offerUnit.code}» несопоставима с единицей закупки «${purchase.code}».` };
  }
  const adjustments = [];
  let factor = 1;
  const haystack = `${offer.unitText ?? ''} ${offer.title}`;
  const packs = purchase.code === 'упак' ? findPackCount(haystack) : null;

  if (offerUnit && offerUnit.dimension === 'pack' && offerUnit.code !== purchase.code && !packs) {
    return {
      factor: 1,
      adjustments: [],
      failure: `Цена указана за «${offerUnit.code}», а закупка — в «${purchase.code}»; сколько «${purchase.code}» в одной «${offerUnit.code}», в предложении не указано.`,
    };
  }
  if (packs) {
    factor /= packs.count;
    adjustments.push({
      kind: 'pack',
      factor: 1 / packs.count,
      description: `Единица продажи содержит ${packs.count} ${purchase.code} («${packs.matched}»): цена за 1 ${purchase.code} = цена / ${packs.count}.`,
    });
  } else if (!offerUnit) {
    adjustments.push({ kind: 'unit', factor: 1, description: `Единица измерения в источнике не указана — принято, что цена дана за 1 ${purchase.code}.` });
  } else if (offerUnit.code !== purchase.code) {
    adjustments.push({ kind: 'unit', factor: 1, description: `Единица продажи «${offerUnit.code}» принята равной 1 ${purchase.code}.` });
  }

  const required = requirement.packContent;
  if (required) {
    const found = findContentCount(offer.title, required.unit) ?? findContentCount(characteristicsText(offer, CONTENT_CHARACTERISTIC), required.unit);
    if (found) {
      // «2500 листов (5 пачек)» — в названии суммарное количество, а не на одну пачку.
      const perPack = packs && found.count >= required.value * packs.count ? found.count / packs.count : found.count;
      const ratio = required.value / perPack;
      if (ratio > rules.normalize.maxPackScaleUp) {
        return {
          factor,
          adjustments,
          failure: `Несопоставимая фасовка: в предложении ${formatNumber(perPack, 2)} ${required.unit}, требуется ${required.value} ${required.unit} — мелкая фасовка дороже в пересчёте, цена не приводится (допустимо увеличение не более чем в ${formatNumber(rules.normalize.maxPackScaleUp)} раза).`,
        };
      }
      if (perPack !== required.value && ratio >= 0.02) {
        factor *= ratio;
        adjustments.push({
          kind: 'pack',
          factor: ratio,
          description: `Фасовка отличается: в предложении ${formatNumber(perPack, 2)} ${required.unit}, требуется ${required.value} ${required.unit}; цена × ${required.value}/${formatNumber(perPack, 2)}.`,
        });
      }
    }
  }
  return { factor, adjustments };
}

function convertUnit(offer, requirement, rules, unitAssumed) {
  const purchase = requirement.unit;
  const parsed = parseUnit(offer.unitText);
  if (!parsed || parsed.dimension === 'unknown') {
    return { factor: 1, adjustments: [], failure: 'Единица продажи не указана или не распознана — сопоставимость цены не подтверждена.' };
  }
  const offerUnit = parsed;
  switch (purchase.dimension) {
    case 'mass':
    case 'volume':
    case 'length':
    case 'area':
      return physicalConversion(offer, purchase, offerUnit);
    case 'count':
      return countConversion(offer, purchase, offerUnit, unitAssumed);
    case 'pack':
      return packConversion(offer, requirement, offerUnit, rules);
    default: {
      // Услуги и нераспознанные единицы: сопоставимы только с такой же единицей или с предложением без единицы.
      if (!offerUnit || offerUnit.code === purchase.code || offerUnit.dimension === 'count') {
        const note =
          offerUnit && offerUnit.code === purchase.code
            ? []
            : [{ kind: 'unit', factor: 1, description: `Принято, что цена предложения дана за 1 ${purchase.code}.` }];
        return { factor: 1, adjustments: note };
      }
      return { factor: 1, adjustments: [], failure: `Единица продажи «${offerUnit.code}» несопоставима с единицей закупки «${purchase.code}».` };
    }
  }
}

function monthKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** Полных месяцев между датами. */
export function monthsBetween(from, to) {
  const months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  return to.getUTCDate() < from.getUTCDate() ? months - 1 : months;
}

/**
 * Коэффициент приведения цен прошлых периодов:
 *   k = (100 + Σ(ИПЦₜ − 100)) / 100, t от месяца формирования цены до месяца, предшествующего расчёту.
 */
export function indexCoefficient(priceDate, now, cpi) {
  const months = [];
  const missing = [];
  let sum = 0;
  let year = priceDate.getUTCFullYear();
  let month = priceDate.getUTCMonth();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth(); // не включая месяц расчёта
  while (year < endYear || (year === endYear && month < endMonth)) {
    const key = monthKey(year, month);
    const value = cpi.monthly[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum += value - 100;
      months.push(key);
    } else {
      missing.push(key);
    }
    month += 1;
    if (month > 11) {
      month = 0;
      year += 1;
    }
  }
  return { k: (100 + sum) / 100, months, missing };
}

function parseDate(text) {
  if (!text) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return Number.isNaN(date.getTime()) ? null : date;
}

export function normalizePrice(offer, requirement, rules, cpi, now, options = {}) {
  const unitCode = requirement.unit.code;
  const conversion = convertUnit(offer, requirement, rules, options.unitAssumed === true);
  if (conversion.failure) {
    return { price: { unitPriceRub: null, unitCode, adjustments: conversion.adjustments, failure: conversion.failure } };
  }
  const adjustments = [...conversion.adjustments];
  let price = offer.priceRub * conversion.factor;

  if (offer.vat === 'excluded') {
    const factor = 1 + rules.vat.ratePercent / 100;
    price *= factor;
    adjustments.push({
      kind: 'vat',
      factor,
      description: `Цена опубликована без НДС — добавлен НДС ${formatNumber(rules.vat.ratePercent)}%: цена × ${formatNumber(factor, 4)}.`,
    });
  }

  const priceDate = parseDate(offer.priceDate);
  if (offer.priceDate && !priceDate) {
    adjustments.push({ kind: 'index', factor: 1, description: `Дата цены «${offer.priceDate}» не распознана — индексация не применялась.` });
  }
  if (priceDate) {
    const age = monthsBetween(priceDate, now);
    if (age > rules.freshness.maxAgeMonths) {
      return {
        price: { unitPriceRub: null, unitCode, adjustments, failure: `Цена от ${offer.priceDate} старше ${rules.freshness.maxAgeMonths} мес.` },
        stale: `Цена сформирована ${offer.priceDate} — более ${rules.freshness.maxAgeMonths} мес. назад, не используется.`,
      };
    }
    if (age >= rules.freshness.indexAfterMonths) {
      const { k, months, missing } = indexCoefficient(priceDate, now, cpi);
      if (months.length > 0) {
        price *= k;
        const gap = missing.length > 0 ? ` Нет данных ИПЦ за ${missing.join(', ')} — эти месяцы учтены без изменения цен.` : '';
        adjustments.push({
          kind: 'index',
          factor: k,
          description: `Цена от ${offer.priceDate} (${age} мес. назад) приведена к текущему уровню по ИПЦ за ${months[0]}…${months[months.length - 1]}: k = ${formatNumber(k, 4)}.${gap}`,
        });
      } else {
        adjustments.push({
          kind: 'index',
          factor: 1,
          description: `Цена от ${offer.priceDate} старше ${rules.freshness.indexAfterMonths} мес., но данных ИПЦ за этот период нет — индексация не применялась.`,
        });
      }
    }
  }

  const unitPriceRub = round2(price);
  if (!(unitPriceRub > 0)) {
    return { price: { unitPriceRub: null, unitCode, adjustments, failure: 'После приведения цена не положительна.' } };
  }
  if (adjustments.some((adjustment) => adjustment.factor !== 1)) {
    adjustments.push({ kind: 'unit', factor: 1, description: `Итог: ${formatMoney(offer.priceRub)} → ${formatMoney(unitPriceRub)} руб. за 1 ${unitCode}.` });
  }
  return { price: { unitPriceRub, unitCode, adjustments } };
}
