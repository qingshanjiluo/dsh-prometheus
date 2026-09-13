/**
 * dsh-prometheus — 查询 Prometheus HTTP API 的即时/范围/目标/规则/告警。
 *
 * 网络访问全部经可注入的 `fetchJson` 接缝（默认用 Node 全局 fetch +
 * `AbortSignal.timeout`）；单元测试注入假响应，运行期从不触达真实网络。
 * 删除了早先虚构的 `settings`/`commands` 注入与 `zod`，改用真实 Cordis 契约。
 * @module @qingshanjiluo/dsh-prometheus
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-prometheus'
export const inject = ['tools']

/** JSON 值（与 `type:'json'` 投影结构兼容）。 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** 一次 HTTP 取回 JSON 的结果（接缝契约）。 */
interface FetchResult {
  status: number
  json: unknown
  error: string
}

/**
 * 可注入的 HTTP-JSON 接缝。默认实现用全局 fetch；测试传入假函数喂固定响应。
 */
export type FetchJson = (url: string, timeoutMs: number) => Promise<FetchResult>

/** 生产接缝：Node 全局 fetch + 超时；任何失败都归一成 FetchResult 而不抛异常。 */
export async function defaultFetchJson(url: string, timeoutMs: number): Promise<FetchResult> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    const text = await res.text()
    if (!res.ok) return { status: res.status, json: undefined, error: `HTTP ${res.status} ${res.statusText}`.trim() }
    try {
      return { status: res.status, json: text.length ? JSON.parse(text) : undefined, error: '' }
    } catch {
      return { status: res.status, json: undefined, error: 'response body is not valid JSON' }
    }
  } catch (e) {
    return { status: 0, json: undefined, error: e instanceof Error ? e.message : 'request failed' }
  }
}

/** 部署配置。 */
export interface Config {
  /** Prometheus 基础地址（不含 /api 路径）。 */
  url: string
  /** 单次请求超时（毫秒）。 */
  timeoutMs: number
}

/** Schemastery 配置 schema。 */
export const Config: z<Config> = z.object({
  url: z.string().default('http://localhost:9090'),
  timeoutMs: z.number().default(10000),
})

/** apply 的完整配置（含宿主注入、但不进 YAML schema 的接缝字段）。 */
type ResolvedConfig = Config & { fetchJson?: FetchJson; now?: () => number }

/** 组装 /api/v1/<endpoint> 带查询串的 URL。 */
function apiV1(baseUrl: string, endpoint: string, params: Record<string, string>): string {
  const url = new URL(`/api/v1/${endpoint}`, baseUrl)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)
  return url.toString()
}

/** 把任意 JSON 安全转成 JsonValue（失败返回 null）。 */
function asJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value === undefined ? null : value)) as JsonValue
  } catch {
    return null
  }
}

/** 把 Prometheus 的字符串/数字值格式化为两位小数字符串（非数字原样）。 */
function fmtValue(v: unknown): string {
  if (typeof v === 'number') return v.toFixed(2)
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n.toFixed(2) : v
  }
  return String(v ?? '')
}

/** 取 `data` 段（Prometheus 响应为 {status, data}）。 */
function dataOf(json: unknown): Record<string, unknown> | undefined {
  if (json && typeof json === 'object' && 'data' in json) {
    const d = (json as { data?: unknown }).data
    if (d && typeof d === 'object') return d as Record<string, unknown>
  }
  return undefined
}

/** 安全数组：非数组返回 []。 */
function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** 安全对象：非对象返回 {}。 */
function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** 标签集合里的字符串。 */
function label(map: Record<string, unknown>, key: string): string {
  const v = map[key]
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

const errorField = { type: 'string', required: true, description: 'Empty on success; otherwise the request/parse error.' } as const
const metricField = { type: 'json', description: 'The Prometheus metric label set.' } as const

/**
 * 注册 5 个 Prometheus 查询工具。
 * @param ctx - 携带 ctx.tools 的注册上下文。
 * @param config - 部署配置（可含宿主注入的 fetchJson 接缝，不进 YAML schema）。
 */
export function apply(ctx: Context, config: ResolvedConfig): void {
  const base = config.url
  const timeout = config.timeoutMs
  const fetchJson = config.fetchJson ?? defaultFetchJson

  ctx.tools.register(defineTool({
    name: 'prom_query',
    description:
      'Run an instant PromQL query against a Prometheus server (GET /api/v1/query). Pass the PromQL expression as `query`. Returns each result series with its label set and a formatted scalar value. On request or parse failure it sets error and returns an empty result set.',
    parameters: { query: { type: 'string', required: true, description: 'PromQL instant-vector expression.' } },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true, description: 'The echoed PromQL expression.' },
          count: { type: 'integer', required: true, description: 'Number of result series.' },
          results: {
            type: 'array',
            required: true,
            description: 'Instant-vector result series.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { metric: metricField, value: { type: 'string', description: 'Formatted scalar value.' } },
            },
          },
          error: errorField,
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.error || `${v.count} result(s) for ${v.query}` }],
    },
    execute: async (args) => {
      const r = await fetchJson(apiV1(base, 'query', { query: args.query }), timeout)
      if (r.error) return { query: args.query, count: 0, results: [], error: r.error }
      const data = dataOf(r.json)
      const results = arr(data?.result).map((raw) => {
        const m = obj(raw)
        const pair = Array.isArray(m.value) ? m.value[m.value.length - 1] : m.value
        return { metric: asJson(m.metric), value: fmtValue(pair) }
      })
      return { query: args.query, count: results.length, results, error: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'prom_range',
    description:
      'Run a PromQL range query (GET /api/v1/query_range). Pass `query` plus optional RFC3339/ISO `start` and `end` and a `step` (default 60s); when start/end are omitted the last hour is used. Returns each series with its point count and latest formatted value.',
    parameters: {
      query: { type: 'string', required: true, description: 'PromQL range-vector expression.' },
      start: { type: 'string', description: 'ISO start timestamp; defaults to one hour ago.' },
      end: { type: 'string', description: 'ISO end timestamp; defaults to now.' },
      step: { type: 'string', description: 'Query resolution step, e.g. "60s"; defaults to "60s".' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true, description: 'Echoed expression.' },
          start: { type: 'string', required: true, description: 'Effective start timestamp used.' },
          end: { type: 'string', required: true, description: 'Effective end timestamp used.' },
          count: { type: 'integer', required: true, description: 'Number of series.' },
          results: {
            type: 'array',
            required: true,
            description: 'Range-vector series summaries.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                metric: metricField,
                points: { type: 'integer', description: 'Number of samples in the series.' },
                latest: { type: 'string', description: 'Formatted latest sample value.' },
              },
            },
          },
          error: errorField,
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.error || `${v.count} series over ${v.start} .. ${v.end}` }],
    },
    execute: async (args) => {
      const now = (config.now ?? (() => Date.now()))()
      const start = args.start || new Date(now - 3_600_000).toISOString()
      const end = args.end || new Date(now).toISOString()
      const r = await fetchJson(apiV1(base, 'query_range', { query: args.query, start, end, step: args.step || '60s' }), timeout)
      if (r.error) return { query: args.query, start, end, count: 0, results: [], error: r.error }
      const data = dataOf(r.json)
      const results = arr(data?.result).map((raw) => {
        const m = obj(raw)
        const values = arr(m.values)
        const last = values.length ? values[values.length - 1] : undefined
        const latest = Array.isArray(last) ? last[last.length - 1] : last
        return { metric: asJson(m.metric), points: values.length, latest: fmtValue(latest) }
      })
      return { query: args.query, start, end, count: results.length, results, error: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'prom_targets',
    description:
      'List scrape targets and their health (GET /api/v1/targets). No arguments. Returns total targets, how many are "up", and per-target {job, instance, state, lastError}.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true, description: 'Number of active targets.' },
          up: { type: 'integer', required: true, description: 'How many targets report health "up".' },
          targets: {
            type: 'array',
            required: true,
            description: 'Active target summaries.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                job: { type: 'string', description: 'Job label.' },
                instance: { type: 'string', description: 'Instance label.' },
                state: { type: 'string', description: 'Target health (up/down).' },
                lastError: { type: 'string', description: 'Last scrape error, if any.' },
              },
            },
          },
          error: errorField,
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.error || `${v.up}/${v.total} targets up` }],
    },
    execute: async () => {
      const r = await fetchJson(apiV1(base, 'targets', {}), timeout)
      if (r.error) return { total: 0, up: 0, targets: [], error: r.error }
      const data = dataOf(r.json)
      const targets = arr(data?.activeTargets).map((raw) => {
        const t = obj(raw)
        const l = obj(t.labels)
        return { job: label(l, 'job'), instance: label(l, 'instance'), state: label(t, 'health'), lastError: label(t, 'lastError') }
      })
      return { total: targets.length, up: targets.filter((t) => t.state === 'up').length, targets, error: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'prom_rules',
    description:
      'List recording/alerting rules grouped in the server (GET /api/v1/rules). No arguments. Flattens rule groups into {group, name, query, state, type}.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true, description: 'Number of rules.' },
          rules: {
            type: 'array',
            required: true,
            description: 'Flattened rule summaries.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                group: { type: 'string', description: 'Owning group name.' },
                name: { type: 'string', description: 'Rule name.' },
                query: { type: 'string', description: 'Rule expression.' },
                state: { type: 'string', description: 'Rule state.' },
                type: { type: 'string', description: 'recording or alerting.' },
              },
            },
          },
          error: errorField,
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.error || `${v.total} rules` }],
    },
    execute: async () => {
      const r = await fetchJson(apiV1(base, 'rules', {}), timeout)
      if (r.error) return { total: 0, rules: [], error: r.error }
      const data = dataOf(r.json)
      const rules: { group: string; name: string; query: string; state: string; type: string }[] = []
      for (const gRaw of arr(data?.groups)) {
        const g = obj(gRaw)
        const group = label(g, 'name')
        for (const rRaw of arr(g.rules)) {
          const rr = obj(rRaw)
          rules.push({ group, name: label(rr, 'name'), query: label(rr, 'query'), state: label(rr, 'state'), type: label(rr, 'type') })
        }
      }
      return { total: rules.length, rules, error: '' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'prom_alerts',
    description:
      'List currently firing alerts (GET /api/v1/alerts). No arguments. Returns each alert as {name, state, severity, summary, activeAt}.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'integer', required: true, description: 'Number of alerts.' },
          alerts: {
            type: 'array',
            required: true,
            description: 'Alert summaries.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', description: 'alertname label.' },
                state: { type: 'string', description: 'Alert state.' },
                severity: { type: 'string', description: 'severity label.' },
                summary: { type: 'string', description: 'summary annotation.' },
                activeAt: { type: 'string', description: 'When it started firing.' },
              },
            },
          },
          error: errorField,
        },
      },
      render: (_a, v) => [{ type: 'text', text: v.error || `${v.total} active alerts` }],
    },
    execute: async () => {
      const r = await fetchJson(apiV1(base, 'alerts', {}), timeout)
      if (r.error) return { total: 0, alerts: [], error: r.error }
      const data = dataOf(r.json)
      const alerts = arr(data?.alerts).map((raw) => {
        const a = obj(raw)
        const l = obj(a.labels)
        const an = obj(a.annotations)
        return { name: label(l, 'alertname'), state: label(a, 'state'), severity: label(l, 'severity'), summary: label(an, 'summary'), activeAt: label(a, 'activeAt') }
      })
      return { total: alerts.length, alerts, error: '' }
    },
  }))
}
