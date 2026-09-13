// 构建产物加载冒烟：从 lib/index.js 导入插件，断言导出面并完成工具注册。
import assert from 'node:assert/strict'

const plugin = await import('../lib/index.js')

assert.equal(plugin.name, 'dsh-prometheus', 'export const name')
assert.ok(Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'tools', 'inject is ["tools"]')
assert.equal(typeof plugin.apply, 'function', 'export function apply')
assert.ok(plugin.Config, 'export const Config schema')
assert.equal(plugin.default, undefined, 'no default export')

const registered = []
const ctx = { tools: { register: (def) => { registered.push(def); return () => {} } } }
plugin.apply(ctx, { url: 'http://localhost:9090', timeoutMs: 10000 })

const names = registered.map((def) => def.name)
assert.deepEqual(
  [...names].sort(),
  ['prom_alerts', 'prom_query', 'prom_range', 'prom_rules', 'prom_targets'],
  `unexpected tool set: ${names.join(', ')}`,
)
for (const def of registered) {
  assert.ok(def.description && typeof def.description === 'string', `${def.name}: description`)
  assert.ok(def.parameters && typeof def.parameters === 'object', `${def.name}: parameters`)
  assert.ok(def.output?.schema && typeof def.output.render === 'function', `${def.name}: output contract`)
  assert.equal(typeof def.execute, 'function', `${def.name}: execute`)
}

console.log(`ok — ${registered.length} tools registered from built artifact`)
