# dsh-prometheus

查询 Prometheus HTTP API（`/api/v1/*`）的 DeepSeek Harness 工具插件：即时查询、范围查询、抓取目标、告警规则、活跃告警。所有网络访问都经可注入的 `fetchJson` 接缝（默认使用 Node 全局 `fetch` + `AbortSignal.timeout`），单元测试注入假响应、运行期不触达真实网络。

> 运行时需要一个可访问的 Prometheus 服务器；无服务器时工具会返回 `error` 字段而非抛异常。

## 安装

```bash
npx -y @deepseek-ai/dsh plugin --profile web add @qingshanjiluo/dsh-prometheus
```

重启 DSH 后生效（`dsh --profile web --dump-config` 可在重启前预览是否已纳入 bundle）。

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `url` | `string` | `http://localhost:9090` | Prometheus 基础地址（不含 `/api` 路径） |
| `timeoutMs` | `number` | `10000` | 单次请求超时（毫秒） |

## 工具

| 工具 | 参数 | 说明 |
|------|------|------|
| `prom_query` | `query` | PromQL 即时查询，返回各序列的标签集与格式化标量值 |
| `prom_range` | `query`, `start?`, `end?`, `step?` | PromQL 范围查询，返回每条序列的采样点数与最新值；缺省时间窗为最近一小时 |
| `prom_targets` | — | 抓取目标健康状态：总数、up 数、逐目标 `{job,instance,state,lastError}` |
| `prom_rules` | — | 告警/记录规则（摊平分组）：`{group,name,query,state,type}` |
| `prom_alerts` | — | 活跃告警：`{name,state,severity,summary,activeAt}` |

### 示例

```json
{ "query": "rate(http_requests_total[5m])" }
```

```json
{ "query": "up", "start": "2024-01-01T00:00:00Z", "end": "2024-01-01T01:00:00Z", "step": "300s" }
```

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run build       # tsc -p + tsdown -> lib/
node scripts/load-smoke.mjs   # 断言从构建产物可注册 5 个工具
```

## 许可

MIT
