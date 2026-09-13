import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index'
import type { FetchJson } from '../src/index'

interface RenderBlock { type: string; text: string }

interface RegisteredTool {
  name: string
  description: string
  parameters: Record<string, { type: string; required?: boolean }>
  output: { schema: unknown; render: (args: unknown, value: unknown) => RenderBlock[] }
  execute: (args: Record<string, unknown>, exec?: unknown) => Promise<Record<string, unknown>>
}

const EXPECTED_TOOLS = ['prom_alerts', 'prom_query', 'prom_range', 'prom_rules', 'prom_targets']

function buildTools(handlers: Record<string, unknown>, fetchJson?: FetchJson): Record<string, RegisteredTool> {
  const registered: RegisteredTool[] = []
  const ctx = { tools: { register: (def: unknown) => { registered.push(def as RegisteredTool); return () => {} } } }
  plugin.apply(ctx as unknown as Context, {
    url: 'http://prom.test:9090',
    timeoutMs: 1000,
    fetchJson,
    now: () => 1_700_000_000_000,
  })
  void handlers
  return Object.fromEntries(registered.map((def) => [def.name, def]))
}

/** 返回固定响应的假接缝，按端点分派；记录被请求的 URL。 */
function fakeFetch(bodies: Record<string, { json?: unknown; error?: string }>): { fn: FetchJson; urls: string[] } {
  const urls: string[] = []
  const fn: FetchJson = async (url) => {
    urls.push(url)
    const key = Object.keys(bodies).find((k) => url.includes(`/api/v1/${k}`))
    if (!key) return { status: 404, json: undefined, error: 'no fake for ' + url }
    const b = bodies[key]!
    if (b.error) return { status: 0, json: undefined, error: b.error }
    return { status: 200, json: b.json, error: '' }
  }
  return { fn, urls }
}

describe('export face', () => {
  it('exports the real Cordis plugin contract', () => {
    expect(plugin.name).toBe('dsh-prometheus')
    expect(plugin.inject).toEqual(['tools'])
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.Config).toBeTruthy()
    expect((plugin as { default?: unknown }).default).toBeUndefined()
  })

  it('apply registers the 5 prom tools with a full output contract', () => {
    const { fn } = fakeFetch({})
    const registered: RegisteredTool[] = []
    const ctx = { tools: { register: (def: unknown) => { registered.push(def as RegisteredTool); return () => {} } } }
    plugin.apply(ctx as unknown as Context, { url: 'http://prom.test', timeoutMs: 1000, fetchJson: fn })
    expect(registered.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS)
    for (const t of registered) {
      expect(typeof t.description).toBe('string')
      expect(t.description.length).toBeGreaterThan(40)
      expect(typeof t.output.render).toBe('function')
      expect(typeof t.execute).toBe('function')
    }
  })
})

describe('prom_query', () => {
  it('parses an instant vector and formats scalar values to 2 decimals', async () => {
    const { fn, urls } = fakeFetch({
      query: { json: { status: 'success', data: { result: [{ metric: { __name__: 'up', job: 'node' }, value: [1700000000, '1'] }] } } },
    })
    const tools = buildTools({}, fn)
    const r = await tools.prom_query!.execute({ query: 'up' })
    expect(r.query).toBe('up')
    expect(r.count).toBe(1)
    expect((r.results as unknown[])).toHaveLength(1)
    const first = (r.results as { value: string; metric: unknown }[])[0]!
    expect(first.value).toBe('1.00')
    expect(first.metric).toEqual({ __name__: 'up', job: 'node' })
    expect(r.error).toBe('')
    expect(urls[0]).toContain('query=up')
    expect(tools.prom_query!.output.render({}, r)[0]!.text).toBe('1 result(s) for up')
  })

  it('maps a seam error to an empty result set', async () => {
    const { fn } = fakeFetch({ query: { error: 'connection refused' } })
    const tools = buildTools({}, fn)
    const r = await tools.prom_query!.execute({ query: 'up' })
    expect(r).toMatchObject({ count: 0, results: [], error: 'connection refused' })
    expect(tools.prom_query!.output.render({}, r)[0]!.text).toBe('connection refused')
  })
})

describe('prom_range', () => {
  it('summarizes series with point counts and defaults the window from the injected clock', async () => {
    const { fn, urls } = fakeFetch({
      query_range: { json: { data: { result: [{ metric: { job: 'a' }, values: [[1700000000, '2'], [1700000060, '3.5']] }] } } },
    })
    const tools = buildTools({}, fn)
    const r = await tools.prom_range!.execute({ query: 'rate(x[5m])' })
    expect(r.count).toBe(1)
    const s = (r.results as { points: number; latest: string }[])[0]!
    expect(s.points).toBe(2)
    expect(s.latest).toBe('3.50')
    expect(typeof r.start).toBe('string')
    expect(typeof r.end).toBe('string')
    expect(urls[0]).toContain('step=60s')
  })

  it('uses explicit start/end/step when provided', async () => {
    const { fn, urls } = fakeFetch({ query_range: { json: { data: { result: [] } } } })
    const tools = buildTools({}, fn)
    const r = await tools.prom_range!.execute({ query: 'q', start: '2024-01-01T00:00:00Z', end: '2024-01-01T01:00:00Z', step: '300s' })
    expect(r.start).toBe('2024-01-01T00:00:00Z')
    expect(r.end).toBe('2024-01-01T01:00:00Z')
    expect(urls[0]).toContain('step=300s')
    expect(r.count).toBe(0)
  })
})

describe('prom_targets', () => {
  it('counts up targets and extracts labels', async () => {
    const { fn } = fakeFetch({
      targets: { json: { data: { activeTargets: [
        { labels: { job: 'node', instance: 'h1:9100' }, health: 'up', lastError: '' },
        { labels: { job: 'node', instance: 'h2:9100' }, health: 'down', lastError: 'timeout' },
      ] } } },
    })
    const tools = buildTools({}, fn)
    const r = await tools.prom_targets!.execute({})
    expect(r).toMatchObject({ total: 2, up: 1, error: '' })
    const first = (r.targets as { job: string; instance: string; state: string }[])[0]!
    expect(first).toMatchObject({ job: 'node', instance: 'h1:9100', state: 'up' })
    expect(tools.prom_targets!.output.render({}, r)[0]!.text).toBe('1/2 targets up')
  })

  it('returns an error object on request failure', async () => {
    const { fn } = fakeFetch({ targets: { error: 'boom' } })
    const tools = buildTools({}, fn)
    expect(await tools.prom_targets!.execute({})).toMatchObject({ total: 0, up: 0, error: 'boom' })
  })
})

describe('prom_rules', () => {
  it('flattens rule groups', async () => {
    const { fn } = fakeFetch({
      rules: { json: { data: { groups: [
        { name: 'g1', rules: [{ name: 'r1', query: 'q1', state: 'firing', type: 'alerting' }, { name: 'r2', query: 'q2', state: 'inactive', type: 'recording' }] },
        { name: 'g2', rules: [{ name: 'r3', query: 'q3', state: 'inactive', type: 'alerting' }] },
      ] } } },
    })
    const tools = buildTools({}, fn)
    const r = await tools.prom_rules!.execute({})
    expect(r.total).toBe(3)
    const rules = r.rules as { group: string; name: string }[]
    expect(rules[0]).toMatchObject({ group: 'g1', name: 'r1' })
    expect(rules[2]).toMatchObject({ group: 'g2', name: 'r3' })
  })

  it('handles a missing groups array as empty', async () => {
    const { fn } = fakeFetch({ rules: { json: { data: {} } } })
    const tools = buildTools({}, fn)
    expect(await tools.prom_rules!.execute({})).toMatchObject({ total: 0, rules: [], error: '' })
  })
})

describe('prom_alerts', () => {
  it('extracts labels and annotations', async () => {
    const { fn } = fakeFetch({
      alerts: { json: { data: { alerts: [
        { labels: { alertname: 'HighCPU', severity: 'critical' }, annotations: { summary: 'cpu high' }, state: 'firing', activeAt: '2024-01-01T00:00:00Z' },
      ] } } },
    })
    const tools = buildTools({}, fn)
    const r = await tools.prom_alerts!.execute({})
    expect(r.total).toBe(1)
    const a = (r.alerts as Record<string, string>[])[0]!
    expect(a).toMatchObject({ name: 'HighCPU', state: 'firing', severity: 'critical', summary: 'cpu high' })
    expect(tools.prom_alerts!.output.render({}, r)[0]!.text).toBe('1 active alerts')
  })

  it('surfaces a seam error', async () => {
    const { fn } = fakeFetch({ alerts: { error: 'nope' } })
    const tools = buildTools({}, fn)
    expect(await tools.prom_alerts!.execute({})).toMatchObject({ total: 0, alerts: [], error: 'nope' })
  })
})
