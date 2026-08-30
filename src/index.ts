/**
 * dsh-prometheus — Prometheus 指标查询
 *
 * 功能：
 * 1. 即时查询（PromQL）
 * 2. 范围查询
 * 3. 目标状态查看
 * 4. 告警规则查看
 * 5. 活跃告警列表
 *
 * 工具：prom_query, prom_range, prom_targets, prom_rules, prom_alerts
 * 命令：/prom
 * 配置：enabled, url, timeout
 */
import { z } from 'zod';

export const name = 'dsh-prometheus';
export const inject = ['settings', 'tools', 'commands'];

const configSchema = z.object({
  enabled: z.boolean().default(true),
  url: z.string().default('http://localhost:9090'),
  timeout: z.number().int().min(1000).max(60000).default(10000),
});

type Config = z.infer<typeof configSchema>;

async function promFetch(config: Config, endpoint: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`/api/v1/${endpoint}`, config.url);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeout);
  try {
    const res = await fetch(url.toString(), { signal: controller.signal });
    const data = await res.json();
    clearTimeout(timer);
    return data;
  } catch (e: any) {
    clearTimeout(timer);
    return { error: e.message || '请求失败' };
  }
}

function formatValue(value: any): string {
  if (typeof value === 'number') return value.toFixed(2);
  return String(value);
}

export function apply(ctx: any, config: Config) {
  if (!config.enabled) return;

  ctx.tools.register({
    name: 'prom_query',
    description: 'PromQL 即时查询',
    parameters: z.object({ query: z.string().describe('PromQL 表达式') }),
    async execute({ query }: any) {
      const data = await promFetch(config, 'query', { query });
      if (data.error) return { error: data.error };
      const results = data.data?.result?.map((r: any) => ({
        metric: r.metric,
        value: formatValue(r.value?.[1]),
      })) || [];
      return { query, results, count: results.length };
    },
  });

  ctx.tools.register({
    name: 'prom_range',
    description: 'PromQL 范围查询',
    parameters: z.object({
      query: z.string(),
      start: z.string().optional().describe('开始时间 ISO'),
      end: z.string().optional().describe('结束时间 ISO'),
      step: z.string().default('60s'),
    }),
    async execute({ query, start, end, step }: any) {
      const s = start || new Date(Date.now() - 3600000).toISOString();
      const e = end || new Date().toISOString();
      const data = await promFetch(config, 'query_range', { query, start: s, end: e, step });
      if (data.error) return { error: data.error };
      const results = data.data?.result?.map((r: any) => ({
        metric: r.metric,
        values: r.values?.length || 0,
        latest: formatValue(r.values?.[r.values.length - 1]?.[1]),
      })) || [];
      return { query, timeRange: { start: s, end: e }, results };
    },
  });

  ctx.tools.register({
    name: 'prom_targets',
    description: '查看抓取目标状态',
    parameters: z.object({}),
    async execute() {
      const data = await promFetch(config, 'targets');
      if (data.error) return { error: data.error };
      const targets = data.data?.activeTargets?.map((t: any) => ({
        job: t.labels?.job,
        instance: t.labels?.instance,
        state: t.health,
        lastError: t.lastError || '',
      })) || [];
      return { total: targets.length, active: targets.filter((t: any) => t.state === 'up').length, targets };
    },
  });

  ctx.tools.register({
    name: 'prom_rules',
    description: '查看告警规则',
    parameters: z.object({}),
    async execute() {
      const data = await promFetch(config, 'rules');
      if (data.error) return { error: data.error };
      const rules = data.data?.groups?.flatMap((g: any) => g.rules?.map((r: any) => ({
        group: g.name,
        name: r.name,
        query: r.query,
        state: r.state,
        type: r.type,
      }))) || [];
      return { total: rules.length, rules };
    },
  });

  ctx.tools.register({
    name: 'prom_alerts',
    description: '查看活跃告警',
    parameters: z.object({}),
    async execute() {
      const data = await promFetch(config, 'alerts');
      if (data.error) return { error: data.error };
      const alerts = data.data?.alerts?.map((a: any) => ({
        name: a.labels?.alertname,
        state: a.state,
        severity: a.labels?.severity,
        summary: a.annotations?.summary,
        activeAt: a.activeAt,
      })) || [];
      return { total: alerts.length, alerts };
    },
  });

  ctx.commands.register({
    name: 'prom',
    description: 'Prometheus 查询',
    async execute(args: string) {
      const parts = args.trim().split(/\s+/);
      const action = parts[0] || 'query';
      const param = parts.slice(1).join(' ');
      const result = await ctx.tools.execute(`prom_${action}`, { query: param });
      return { content: JSON.stringify(result, null, 2) };
    },
  });

  ctx.settings.register({ title: 'prometheus', description: 'Prometheus 指标查询', config: configSchema });
}
