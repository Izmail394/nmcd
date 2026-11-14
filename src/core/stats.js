/**
 * Детерминированный расчёт НМЦД методом сопоставимых рыночных цен (анализа рынка):
 * исключение выбросов по явному правилу, коэффициент вариации, среднее арифметическое.
 *
 * Формулы соответствуют Методическим рекомендациям, утверждённым приказом
 * Минэкономразвития России от 02.10.2013 № 567 (пп. 3.19–3.21):
 *   V = σ / <ц> × 100,  σ = sqrt( Σ(цᵢ − <ц>)² / (n − 1) ),  НМЦ = v / n × Σцᵢ.
 */

const MAX_OUTLIER_PASSES = 3;

export function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** "1 234 567,89" — без зависимости от локали среды. */
export function formatMoney(value) {
  const fixed = round2(Math.abs(value)).toFixed(2);
  const [integer = '0', fraction = '00'] = fixed.split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${value < 0 ? '−' : ''}${grouped},${fraction}`;
}

export function formatNumber(value, digits = 2) {
  return (Math.round(value * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
}

export function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Среднее квадратичное отклонение, несмещённая оценка (делитель n − 1). */
export function sampleStdDev(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  const sumSquares = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Math.sqrt(sumSquares / (values.length - 1));
}

/** Коэффициент вариации, %. */
export function variationCoefficient(values) {
  const average = mean(values);
  if (average === 0) return 0;
  return (sampleStdDev(values) / average) * 100;
}

/** Квантиль с линейной интерполяцией (метод 7, как в Excel КВАРТИЛЬ.ВКЛ). */
export function quantile(sortedAscending, probability) {
  const position = (sortedAscending.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const low = sortedAscending[lower] ?? 0;
  const high = sortedAscending[upper] ?? low;
  return low + (high - low) * (position - lower);
}

export function median(values) {
  return quantile(
    [...values].sort((a, b) => a - b),
    0.5,
  );
}

function emptyCalculation(quantity, unitCode, rules) {
  return {
    status: 'insufficient_data',
    method: 'Метод сопоставимых рыночных цен (анализа рынка)',
    usedOffers: [],
    prices: [],
    count: 0,
    mean: null,
    median: null,
    min: null,
    max: null,
    stdDev: null,
    cv: null,
    cvThreshold: rules.outliers.cvThresholdPercent,
    homogeneous: null,
    quantity,
    unitCode,
    unitPrice: null,
    total: null,
    formula: null,
    outlierSteps: [],
    warnings: [],
  };
}

function describe(points) {
  const prices = points.map((point) => point.price);
  if (prices.length === 0) {
    return { usedOffers: [], prices: [], count: 0, mean: null, median: null, min: null, max: null, stdDev: null, cv: null };
  }
  return {
    usedOffers: points.map((point) => point.n),
    prices,
    count: prices.length,
    mean: round2(mean(prices)),
    median: round2(median(prices)),
    min: Math.min(...prices),
    max: Math.max(...prices),
    stdDev: prices.length > 1 ? round2(sampleStdDev(prices)) : null,
    cv: prices.length > 1 ? round2(variationCoefficient(prices)) : null,
  };
}

/** Шаг 1: явные выбросы. Правило зависит от размера выборки. */
function removeOutliers(points, rules) {
  const { iqrFactor, minForIqr, medianRatioLow, medianRatioHigh, minPrices } = rules.outliers;
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const prices = sorted.map((point) => point.price);
  const center = median(prices);
  const q1 = quantile(prices, 0.25);
  const q3 = quantile(prices, 0.75);
  const iqr = q3 - q1;

  let rule;
  let low;
  let high;
  let description;
  if (sorted.length >= minForIqr && iqr > 0) {
    rule = 'iqr';
    low = q1 - iqrFactor * iqr;
    high = q3 + iqrFactor * iqr;
    description =
      `Правило межквартильного размаха: Q1 = ${formatMoney(q1)}, Q3 = ${formatMoney(q3)}, IQR = ${formatMoney(iqr)}; ` +
      `допустимый диапазон [Q1 − ${formatNumber(iqrFactor)}·IQR; Q3 + ${formatNumber(iqrFactor)}·IQR] = [${formatMoney(Math.max(low, 0))}; ${formatMoney(high)}] руб.`;
  } else {
    rule = 'median_ratio';
    low = center * medianRatioLow;
    high = center * medianRatioHigh;
    description =
      `Выборка мала для квартилей (${sorted.length} цен) или цены совпадают, применено правило отношения к медиане: медиана = ${formatMoney(center)}; ` +
      `допустимый диапазон [${formatNumber(medianRatioLow)}·Me; ${formatNumber(medianRatioHigh)}·Me] = [${formatMoney(low)}; ${formatMoney(high)}] руб.`;
  }

  // На плотной выборке размах мал, и за его границы выходят обычные цены. Поэтому аномальной считается
  // только цена, которая ещё и заметно отличается от медианы.
  const minDeviation = rule === 'iqr' ? (center * rules.outliers.minDeviationPercent) / 100 : 0;
  if (rule === 'iqr') {
    description += ` Цена признаётся аномальной, если она вне диапазона и отличается от медианы ${formatMoney(center)} руб. более чем на ${formatNumber(rules.outliers.minDeviationPercent)}%.`;
  }
  const candidates = sorted
    .filter((point) => (point.price < low || point.price > high) && Math.abs(point.price - center) > minDeviation)
    .sort((a, b) => Math.abs(b.price - center) - Math.abs(a.price - center));
  const reasons = new Map();
  const removed = [];
  let remaining = sorted.length;
  for (const point of candidates) {
    if (remaining <= minPrices) break; // не опускаемся ниже минимального числа цен
    const side = point.price > high ? `выше верхней границы ${formatMoney(high)}` : `ниже нижней границы ${formatMoney(low)}`;
    const why = `цена ${formatMoney(point.price)} руб. ${side} руб.`;
    removed.push({ n: point.n, unitPriceRub: point.price, why });
    reasons.set(point.n, `Аномальная цена: ${why} (${rule === 'iqr' ? 'правило межквартильного размаха' : 'правило отношения к медиане'}).`);
    remaining -= 1;
  }
  const kept = sorted.filter((point) => !reasons.has(point.n));
  if (removed.length === 0) {
    return { kept, step: { rule, description: `${description} Выбросов не найдено.`, removed: [], cvAfter: round2(variationCoefficient(prices)) }, reasons };
  }
  return {
    kept,
    step: { rule, description, removed, cvAfter: round2(variationCoefficient(kept.map((point) => point.price))) },
    reasons,
  };
}

export function calculate(points, quantity, unitCode, rules) {
  const { minPrices, cvThresholdPercent } = rules.outliers;
  const calculation = emptyCalculation(quantity, unitCode, rules);
  const excluded = new Map();

  const valid = points.filter((point) => Number.isFinite(point.price) && point.price > 0);
  if (valid.length < minPrices) {
    Object.assign(calculation, describe(valid));
    calculation.insufficiencyReason =
      valid.length === 0
        ? 'Не найдено ни одного сопоставимого предложения с ценой. Цена не сформирована.'
        : `Найдено сопоставимых цен: ${valid.length}, для расчёта нужно не менее ${minPrices}. Цена не сформирована, чтобы не выдавать необоснованное значение.`;
    return { calculation, excluded };
  }

  // Очень далёкая цена расширяет границы и может «прикрыть» другую аномальную цену, поэтому правило
  // применяется повторно к оставшимся ценам, пока находятся выбросы (не более MAX_OUTLIER_PASSES проходов).
  const first = { kept: valid };
  for (let pass = 1; pass <= MAX_OUTLIER_PASSES && first.kept.length > minPrices; pass += 1) {
    const result = removeOutliers(first.kept, rules);
    if (result.step && (pass === 1 || result.step.removed.length > 0)) {
      if (pass > 1) result.step.description = `Повторная проверка оставшихся цен (проход ${pass}). ${result.step.description}`;
      calculation.outlierSteps.push(result.step);
    }
    for (const [n, reason] of result.reasons) excluded.set(n, { code: 'outlier', reason });
    first.kept = result.kept;
    if (result.reasons.size === 0) break;
  }

  // Не удаляем цены только ради достижения заданного коэффициента вариации:
  // неоднородная выборка должна требовать дополнительных данных.
  const kept = [...first.kept].sort((a, b) => a.n - b.n);
  Object.assign(calculation, describe(kept));
  const prices = kept.map((point) => point.price);
  const cv = variationCoefficient(prices);
  calculation.homogeneous = cv <= cvThresholdPercent;

  if (!calculation.homogeneous) {
    calculation.insufficiencyReason =
      `Выборка неоднородна: коэффициент вариации ${formatNumber(cv)}% превышает ${formatNumber(cvThresholdPercent)}% после исключения выбросов (цен в выборке: ${kept.length}). ` +
      `Цена не сформирована — нужны дополнительные предложения или уточнение характеристик; вручную исключить несопоставимые предложения можно в отчёте.`;
    return { calculation, excluded };
  }

  const unitPrice = round2(mean(prices));
  const total = round2(quantity * unitPrice);
  const sum = prices.map((price) => formatMoney(price)).join(' + ');
  calculation.status = 'ok';
  calculation.unitPrice = unitPrice;
  calculation.total = total;
  calculation.formula =
    `<ц> = (${sum}) / ${prices.length} = ${formatMoney(unitPrice)} руб. за 1 ${unitCode}; ` +
    `НМЦД = v × <ц> = ${formatNumber(quantity, 3)} × ${formatMoney(unitPrice)} = ${formatMoney(total)} руб.`;
  if (kept.length === minPrices) {
    calculation.warnings.push(`В расчёте минимально допустимое число цен (${minPrices}).`);
  }
  return { calculation, excluded };
}
