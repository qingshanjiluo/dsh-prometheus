# dsh-prometheus

Prometheus 指标查询插件，适用于 DSH 平台。

## 功能

- **即时查询**：执行 PromQL 表达式，返回当前时刻的指标值
- **范围查询**：查询指定时间范围内的指标数据
- **目标状态**：查看所有抓取目标的健康状态
- **告警规则**：列出配置的告警规则及其当前状态
- **活跃告警**：查看当前触发的告警列表

## 安装

```bash
npm install dsh-prometheus
```

## 配置

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `enabled` | `boolean` | `true` | 是否启用插件 |
| `url` | `string` | `http://localhost:9090` | Prometheus 服务器地址 |
| `timeout` | `number` | `10000` | 请求超时时间（毫秒） |

## 工具

### prom_query

执行 PromQL 即时查询。

```json
{ "query": "up" }
```

### prom_range

执行 PromQL 范围查询。

```json
{
  "query": "rate(http_requests_total[5m])",
  "start": "2024-01-01T00:00:00Z",
  "end": "2024-01-01T01:00:00Z",
  "step": "60s"
}
```

### prom_targets

查看所有抓取目标状态。无需参数。

### prom_rules

查看告警规则。无需参数。

### prom_alerts

查看活跃告警。无需参数。

## 命令

```
/prom query up
/prom range rate(http_requests_total[5m])
/prom targets
/prom rules
/prom alerts
```
