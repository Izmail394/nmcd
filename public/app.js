'use strict';

const $ = (id) => document.getElementById(id);
let report = null;
let filter = 'all';

const EXAMPLES = [
  { label: 'Бумага А4', description: 'Бумага офисная А4, плотность 80 г/м2, пачка 500 листов, белизна не менее 146%', quantity: 200, unit: 'упак', okpd: '17.12.14.110' },
  { label: 'Кабель ВВГнг', description: 'Кабель силовой ВВГнг(А)-LS 3х2,5 мм2, напряжение 0,66 кВ', quantity: 500, unit: 'м', okpd: '27.32.13' },
  { label: 'Картридж', description: 'Картридж для лазерного принтера HP CF283A, ресурс не менее 1500 страниц', quantity: 20, unit: 'шт', okpd: '' },
];

const KIND = {
  contract_registry: 'реестр контрактов',
  gov_catalog: 'государственный каталог',
  aggregator: 'агрегатор торговли',
  distributor: 'каталог дистрибьютора',
  marketplace: 'интернет-магазин',
  manual: 'введено вручную',
  unknown: '',
};

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => (n == null ? '—' : `${new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ₽`);
const num = (n, digits = 2) => (n == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: digits }).format(n));
const date = (iso) => (iso ? new Date(iso).toLocaleDateString('ru-RU') : '—');

function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return `<a href="${esc(parsed.href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`;
  } catch {
    return '';
  }
}

async function api(path, options) {
  const response = await fetch(path, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка сервера (${response.status})`);
  return data;
}

// ---------- Форма ----------

function addOffer() {
  const row = document.createElement('div');
  row.className = 'offer-row';
  row.innerHTML =
    '<label>Наименование<input name="title" required maxlength="300" placeholder="Бумага офисная А4 80 г/м2, 500 л"></label>' +
    '<label>Цена, ₽<input name="price" type="number" min="0.01" step="any" required></label>' +
    '<label>Единица<input name="unit" required maxlength="30" placeholder="упак"></label>' +
    '<label>Поставщик<input name="supplier" maxlength="300"></label>' +
    '<label>Ссылка<input name="url" type="url" placeholder="https://…"></label>' +
    '<button type="button" class="remove" aria-label="Удалить предложение">×</button>';
  row.querySelector('.remove').addEventListener('click', () => row.remove());
  $('offers').append(row);
}

function renderExamples() {
  for (const example of EXAMPLES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chip';
    button.textContent = example.label;
    button.addEventListener('click', () => {
      $('description').value = example.description;
      $('quantity').value = example.quantity;
      $('unit').value = example.unit;
      $('okpd').value = example.okpd;
    });
    $('examples').append(button);
  }
}

async function loadSources() {
  try {
    const sources = await api('/api/sources');
    if (!sources.length) {
      $('sources').textContent = 'Автоматические источники не подключены — добавьте предложения вручную.';
      return;
    }
    $('sources').innerHTML = sources
      .map((source) => {
        const disabled = !source.enabled || source.problem;
        const hint = source.problem || source.note || '';
        return `<label class="source${disabled ? ' off' : ''}" title="${esc(hint)}">
          <input type="checkbox" name="source" value="${esc(source.id)}" ${disabled ? 'disabled' : 'checked'}>
          <span><b>${esc(source.name)}</b><small>${esc(KIND[source.kind] ?? source.kind)}${disabled ? ' · отключён' : ''}</small></span>
        </label>`;
      })
      .join('');
  } catch {
    $('sources').textContent = 'Не удалось загрузить список источников.';
  }
}

async function loadHealth() {
  try {
    const health = await api('/api/health');
    const parts = [`v${health.version}`, health.mode === 'replay' ? 'воспроизведение снимков' : 'живые источники'];
    $('health').textContent = parts.join(' · ');
  } catch {
    /* бейдж остаётся по умолчанию */
  }
}

async function loadHistory() {
  try {
    const items = await api('/api/reports');
    $('history-card').hidden = items.length === 0;
    $('history').innerHTML = items
      .map(
        (item) => `<div class="run"><button type="button" class="link" data-report="${esc(item.id)}">${esc(item.subject)}</button>
          <span>${esc(date(item.createdAt))} · ${item.status === 'ok' ? esc(money(item.total)) : 'цена не сформирована'} · цен: ${esc(item.count)}</span></div>`,
      )
      .join('');
    for (const button of $('history').querySelectorAll('[data-report]')) {
      button.addEventListener('click', async () => show(await api(`/api/reports/${button.dataset.report}`)));
    }
  } catch {
    $('history-card').hidden = true;
  }
}

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('submit').disabled = true;
  $('status').textContent = 'Ищем предложения и выполняем расчёт. Обычно это занимает 10–40 секунд…';
  const manualOffers = [...document.querySelectorAll('.offer-row')].map((row) => {
    const value = (name) => row.querySelector(`[name=${name}]`).value.trim();
    return { title: value('title'), priceRub: Number(value('price')), unit: value('unit'), supplier: value('supplier'), url: value('url') };
  });
  const sources = [...document.querySelectorAll('[name=source]:checked')].map((input) => input.value);
  const hasSourceList = document.querySelectorAll('[name=source]').length > 0;
  const body = {
    description: $('description').value,
    quantity: Number($('quantity').value),
    unit: $('unit').value,
    okpd2: $('okpd').value.trim(),
    region: $('region').value.trim(),
    manualOffers,
    // Пустой список означает «не искать автоматически» — только ручные предложения.
    sources: hasSourceList ? sources : undefined,
  };
  try {
    show(await api('/api/calculate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    $('status').textContent = 'Расчёт завершён.';
    loadHistory();
  } catch (error) {
    $('status').textContent = `Ошибка: ${error.message}`;
  } finally {
    $('submit').disabled = false;
  }
});

// ---------- Отчёт ----------

function show(data) {
  report = data;
  filter = 'all';
  render();
  $('result').hidden = false;
  $('result').scrollIntoView({ behavior: 'smooth' });
}

function renderSummary(r) {
  const c = r.calculation;
  const ok = c.status === 'ok';
  const reliability = r.reliability;
  const head = ok
    ? `<span>НАЧАЛЬНАЯ (МАКСИМАЛЬНАЯ) ЦЕНА ДОГОВОРА</span><strong>${esc(money(c.total))}</strong>
       <p>${esc(money(c.unitPrice))} за 1 ${esc(c.unitCode)} × ${esc(num(c.quantity, 3))} ${esc(c.unitCode)}</p>`
    : `<span>ЦЕНА НЕ СФОРМИРОВАНА</span><strong class="warn">Недостаточно данных</strong><p>${esc(c.insufficiencyReason || '')}</p>`;
  const warnings = (c.warnings || []).map((warning) => `<p class="note">⚠ ${esc(warning)}</p>`).join('');
  const factors = reliability.factors.map((factor) => `<li>${esc(factor.name)}: <b>${esc(factor.value)}</b> — ${esc(factor.points)} из ${esc(factor.max)}</li>`).join('');
  $('summary').innerHTML = `
    <div class="summary${ok ? '' : ' bad'}">
      <div>${head}</div>
      <div class="metric"><span>ЦЕН В РАСЧЁТЕ</span><b>${esc(c.count)}</b></div>
      <div class="metric"><span>КОЭФФ. ВАРИАЦИИ</span><b>${c.cv == null ? '—' : `${esc(num(c.cv))}%`}</b><small>порог ${esc(num(c.cvThreshold))}%</small></div>
    </div>
    ${c.formula ? `<div class="card formula"><b>Расчёт, который можно повторить:</b><p>${esc(c.formula)}</p>
      <p class="muted">V = σ / &lt;ц&gt; × 100%; σ = √(Σ(цᵢ − &lt;ц&gt;)² / (n − 1)). Мин. ${esc(money(c.min))} · макс. ${esc(money(c.max))} · медиана ${esc(money(c.median))} · σ ${esc(money(c.stdDev))}</p>${warnings}</div>` : ''}
    ${factors ? `<div class="card"><b>Надёжность цены: ${esc(reliability.level)} — ${esc(reliability.score)} из 100</b><ul class="factors">${factors}</ul></div>` : ''}`;
}

function renderRequirement(r) {
  const q = r.requirement;
  const attributes = q.attributes
    .map((a) => `<span class="pill ${a.importance === 'must' ? 'yes' : 'soft'}" title="${a.importance === 'must' ? 'существенная' : 'дополнительная'}">${esc(a.name)}: ${esc(a.value)}</span>`)
    .join(' ');
  $('requirement').innerHTML = `
    <p><b>${esc(q.subject)}</b> · ${esc(num(q.quantity, 3))} ${esc(q.unit.code)}${q.okpd2 ? ` · ОКПД2 ${esc(q.okpd2)}` : ''}${q.region ? ` · ${esc(q.region)}` : ''}</p>
    <p>${attributes || '<span class="muted">Существенные характеристики не выделены — сопоставление идёт по наименованию.</span>'}</p>
    <p class="muted">Поисковые запросы: ${q.searchQueries.map((query) => `«${esc(query)}»`).join(', ')}.</p>
    ${q.notes.map((note) => `<p class="note">${esc(note)}</p>`).join('')}`;
}

function renderRuns(r) {
  $('runs').innerHTML =
    r.sources
      .map((s) => {
        const state = s.status === 'error' ? `<span class="bad-text">Недоступен: ${esc(s.errorMessage)}</span>` : s.status === 'empty' ? '<span>Ничего не найдено</span>' : `<span>Найдено: ${esc(s.offersFound)}</span>`;
        return `<div class="run"><div><b>${esc(s.sourceName)}</b> <small>${esc(KIND[s.kind] ?? '')}</small></div>${state}</div>`;
      })
      .join('') || '<p>Источники не использовались.</p>';
}

function offerCard(o) {
  const calculated = report.calculation.status === 'ok';
  const checks = (o.relevance?.checks || [])
    .map((c) => {
      const mark = c.verdict === 'match' ? '✓' : c.verdict === 'mismatch' ? '✕' : '?';
      return `<span class="check ${esc(c.verdict)}" title="требуется: ${esc(c.required)}">${mark} ${esc(c.name)}: ${esc(c.found ?? 'нет данных')}</span>`;
    })
    .join(' ');
  const own = Object.entries(o.raw.characteristics || {}).slice(0, 8).map(([name, value]) => `${esc(name)}: ${esc(value)}`).join(' · ');
  const adjustments = (o.price.adjustments || []).map((a) => `<li>${esc(a.description)}</li>`).join('');
  const manualChange = o.automaticDecision ? '<span class="pill soft">изменено вручную</span>' : '';
  const canToggle = o.price.unitPriceRub != null && o.decision.code !== 'duplicate';
  const toggle = !canToggle ? '' : o.decision.included
    ? `<button type="button" class="link" data-exclude="${o.n}">Исключить</button>`
    : `<button type="button" class="link" data-include="${o.n}">Включить в расчёт</button>`;
  const undo = o.automaticDecision ? `<button type="button" class="link" data-reset="${o.n}">Вернуть автоматическое решение</button>` : '';
  return `<article class="decision">
    <div>
      <span class="pill ${o.decision.included ? (calculated ? 'yes' : 'soft') : 'no'}">${o.decision.included ? (calculated ? 'В расчёте' : 'Сопоставимо, расчёта нет') : 'Исключено'}</span> ${manualChange}
      <span class="muted">№${o.n} · ${esc(o.sourceName)}${o.raw.supplier ? ` · ${esc(o.raw.supplier)}` : ''} · получено ${esc(date(o.raw.fetchedAt))}${o.raw.priceDate ? ` · цена от ${esc(date(o.raw.priceDate))}` : ''}</span>
      <h4>${esc(o.raw.title)}</h4>
      <p>${esc(o.decision.reason)}</p>
      ${checks ? `<p class="checks">${checks}</p>` : ''}
      ${own ? `<p class="muted small">${own}</p>` : ''}
      ${adjustments ? `<ul class="adjustments">${adjustments}</ul>` : ''}
      <p class="links">${safeLink(o.raw.url, 'Открыть источник ↗')} ${toggle} ${undo}</p>
    </div>
    <div class="price">${esc(money(o.raw.priceRub))}<small>за ${esc(o.raw.unitText || 'ед. не указана')}</small>
      <small>${o.price.unitPriceRub == null ? 'не приведено' : `→ ${esc(money(o.price.unitPriceRub))} / ${esc(o.price.unitCode)}`}</small>
      ${o.relevance ? `<small>сопоставимость ${esc(num(o.relevance.score))}</small>` : ''}
    </div>
  </article>`;
}

function renderDecisions(r) {
  const included = r.offers.filter((o) => o.decision.included).length;
  const tabs = [['all', `Все (${r.offers.length})`], ['in', `${r.calculation.status === 'ok' ? 'В расчёте' : 'Сопоставимые'} (${included})`], ['out', `Исключённые (${r.offers.length - included})`]];
  $('filters').innerHTML = tabs.map(([key, label]) => `<button type="button" class="chip${filter === key ? ' active' : ''}" data-filter="${key}">${esc(label)}</button>`).join('');
  const visible = r.offers.filter((o) => filter === 'all' || (filter === 'in') === o.decision.included);
  $('decisions').innerHTML = visible.map(offerCard).join('') || '<p>Предложений нет.</p>';
  for (const button of $('filters').querySelectorAll('[data-filter]')) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter;
      renderDecisions(report);
    });
  }
  const current = r.overrides || { exclude: [], include: [] };
  const change = (mutate) => async () => {
    const next = { exclude: [...current.exclude], include: [...current.include] };
    mutate(next);
    try {
      report = await api(`/api/reports/${report.id}/recalculate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      render();
    } catch (error) {
      $('status').textContent = `Ошибка пересчёта: ${error.message}`;
    }
  };
  const without = (list, n) => list.filter((value) => value !== n);
  for (const b of $('decisions').querySelectorAll('[data-exclude]')) {
    const n = Number(b.dataset.exclude);
    b.addEventListener('click', change((next) => { next.include = without(next.include, n); next.exclude.push(n); }));
  }
  for (const b of $('decisions').querySelectorAll('[data-include]')) {
    const n = Number(b.dataset.include);
    b.addEventListener('click', change((next) => {
      const wasExcludedByUser = next.exclude.includes(n);
      next.exclude = without(next.exclude, n);
      if (!wasExcludedByUser) next.include.push(n);
    }));
  }
  for (const b of $('decisions').querySelectorAll('[data-reset]')) {
    const n = Number(b.dataset.reset);
    b.addEventListener('click', change((next) => { next.exclude = without(next.exclude, n); next.include = without(next.include, n); }));
  }
}

function renderOutliers(r) {
  const steps = r.calculation.outlierSteps || [];
  $('outliers').innerHTML = steps.length
    ? steps.map((step) => `<div class="trace"><p>${esc(step.description)}</p>${step.removed.length ? `<ul>${step.removed.map((x) => `<li>№${esc(x.n)}: ${esc(x.why)}</li>`).join('')}</ul>` : ''}</div>`).join('')
    : '<p>Этап не выполнялся: сопоставимых цен меньше минимума.</p>';
}

function render() {
  const r = report;
  $('result-title').textContent = `Обоснование цены: ${r.requirement.subject}`;
  $('docx').href = `/api/reports/${encodeURIComponent(r.id)}/docx`;
  renderSummary(r);
  renderRequirement(r);
  renderRuns(r);
  renderDecisions(r);
  renderOutliers(r);
  $('trace').innerHTML = r.trace
    .map((t) => `<div class="trace"><h4>${esc(t.step)}</h4><p>${esc(t.summary)}</p>${t.details?.length ? `<ul>${t.details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : ''}</div>`)
    .join('');
}

$('add').addEventListener('click', addOffer);
$('print').addEventListener('click', () => window.print());
$('download').addEventListener('click', () => {
  if (!report) return;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
  link.download = `nmcd-${report.id}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});

renderExamples();
loadSources();
loadHealth();
loadHistory();
