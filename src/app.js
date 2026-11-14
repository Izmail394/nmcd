/**
 * HTTP-приложение: API расчёта, история отчётов, экспорт и статика интерфейса.
 * Собирается функцией buildApp, чтобы его можно было поднять в тестах без сети.
 */
import path from 'node:path';
import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { recalculate, runPipeline } from './core/pipeline.js';
import { resolveRules } from './core/rules.js';
import { isReportId } from './core/store.js';
import { validateOverrides, validateRequest } from './core/validate.js';
import { renderDocx } from './report/docx.js';

const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

export async function buildApp(deps) {
  const app = Fastify({ logger: deps.logger ?? true, bodyLimit: 512 * 1024 });
  const maxConcurrent = deps.maxConcurrent ?? 3;
  let running = 0;

  app.addHook('onSend', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', CSP);
  });

  await app.register(staticPlugin, { root: path.resolve(deps.publicDir) });

  app.get('/api/health', async () => ({
    status: 'ok',
    version: deps.appVersion,
    mode: deps.mode,
    sourcesEnabled: deps.registry.adapters.length,
  }));

  app.get('/api/sources', async () => deps.registry.list);

  app.get('/api/rules', async () => ({
    rules: deps.rules,
    cpi: { source: deps.cpi.source, updated: deps.cpi.updated, months: Object.keys(deps.cpi.monthly).length },
  }));

  app.post('/api/calculate', async (request, reply) => {
    const input = validateRequest(request.body);
    if (!input.ok) return reply.code(400).send({ error: input.error });
    if (running >= maxConcurrent) {
      return reply.code(429).send({ error: 'Сейчас выполняется несколько расчётов. Повторите запрос через минуту.' });
    }
    running += 1;
    try {
      const report = await runPipeline(input.value, {
        sources: deps.registry.adapters,
        http: deps.http,
        rules: deps.rules,
        cpi: deps.cpi,
        now: deps.now ?? (() => new Date()),
        mode: deps.mode,
        appVersion: deps.appVersion,
        log: (message) => request.log.info(message),
      });
      deps.store.save(report);
      return report;
    } catch (error) {
      request.log.error(error);
      return reply.code(500).send({ error: 'Внутренняя ошибка при расчёте. Подробности — в журнале сервера.' });
    } finally {
      running -= 1;
    }
  });

  app.get('/api/reports', async () => deps.store.list());

  app.get('/api/reports/:id', async (request, reply) => {
    const report = isReportId(request.params.id) ? deps.store.get(request.params.id) : null;
    if (!report) return reply.code(404).send({ error: 'Отчёт не найден.' });
    return report;
  });

  app.post('/api/reports/:id/recalculate', async (request, reply) => {
    const report = isReportId(request.params.id) ? deps.store.get(request.params.id) : null;
    if (!report) return reply.code(404).send({ error: 'Отчёт не найден.' });
    const overrides = validateOverrides(request.body);
    if (!overrides.ok) return reply.code(400).send({ error: overrides.error });
    // Пересчёт идёт по правилам, сохранённым в отчёте: результат зависит только от отчёта и правок.
    let rules;
    try {
      rules = resolveRules(report.rules);
    } catch {
      rules = deps.rules;
    }
    const updated = recalculate(report, rules, overrides.value);
    deps.store.save(updated);
    return updated;
  });

  app.get('/api/reports/:id/docx', async (request, reply) => {
    const report = isReportId(request.params.id) ? deps.store.get(request.params.id) : null;
    if (!report) return reply.code(404).send({ error: 'Отчёт не найден.' });
    const buffer = await renderDocx(report);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename="nmcd-${report.id}.docx"`)
      .send(buffer);
  });

  return app;
}
