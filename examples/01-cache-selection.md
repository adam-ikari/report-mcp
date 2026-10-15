---
template: sheet
theme: blueprint
title: 缓存迁移 · 里程碑 1：选型
subtitle: 三个候选，一个结论
cols: 3
---

数据来自 3 月 4 日那一轮压测：8 核 16 GB 单节点，负载取线上流量的 1.4 倍，
三个候选跑同一份脚本。结论在 A 面板，其余是过程。

## A 结论 {span=2 meta="一页读完"}

Redis 7 胜出——p99 不是最快的那个，但故障注入下它是唯一不丢已确认写入的候选，
这一条对本场景是硬要求。

| 候选 | p99 延迟 | 崩溃恢复 | 运维成本 | 判定 |
|---|---|---|---|---|
| Redis 7 | 1.8 ms | ok 重放 AOF | 已有现成监控 | ok 采用 |
| Dragonfly | 1.1 ms | warn 快照有 30 s 窗口 | 团队无经验 | warn 观察 |
| KeyDB | 2.4 ms | no 主从切换丢写 | 社区停滞 | no 淘汰 |

```callout ok 决定
选 Redis 7，双写过渡两周，第三周切读。Dragonfly 留到有真实流量回放环境时再评。
```

## B 请求路径

```flow LR
(Client) -> Gateway: 读请求
Gateway -> *Redis: 命中?
Redis --> Gateway: 值
Gateway -> [(MySQL)]: 未命中回源
Redis -> MySQL: 异步写回
group 缓存层: Gateway, Redis
```

## C 一次未命中

```sequence num
participants: 客户端, 网关, Redis, MySQL
客户端 -> 网关: GET user:42
网关 -> Redis: EXISTS
Redis --> 网关: miss
网关 -> MySQL: SELECT
MySQL --> 网关: 行
网关 -> Redis: SET + TTL 300
网关 --> 客户端: 200 OK
```

## D 约束

```kv cols=2
* 必须满足: 崩溃后不丢已确认的写
内存上限: 6 GB / 节点
团队熟悉度: Redis 3 人，Dragonfly 0 人
许可证: Redis RSALv2 / SSPL，内部使用不受限
```
