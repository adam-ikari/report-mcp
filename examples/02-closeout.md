---
template: doc
theme: paper
title: 收尾 · 三周的缓存迁移做完了什么
subtitle: 读这一页就够了，前面的里程碑页是过程
---

迁移结束。线上 100% 的读流量走新缓存，回源率 3.1%，p99 从 4.2 ms 降到 1.9 ms。
这一页说清楚三件事：改了什么、还剩什么、如果下周出问题该看哪里。

## 三周里发生了什么

```timeline
第 1 周 | 选型与压测 | 见里程碑 1
第 2 周 | 双写上线 | 读仍走旧缓存
*第 3 周 | 切读 | 分 5 批，每批观察 6 小时
第 4 周 | 拆旧缓存 | 未开始，等一个发布窗口
```

## 改了什么

```tree list
config/
  ~ cache.yaml | 新增 driver 与 fallback 两段
  + cache_write.yaml | 双写开关，切读后关掉
src/
  gateway/
    ~ read_path.js | 命中判断改成可降级
    + fallback.js | Redis 不可用时直连 MySQL
  - legacy_cache/ | 第 4 周删
```

## 还剩什么

```callout warn 未完成
旧缓存的写入路径还在跑。它现在只服务一个内部报表任务，每天 02:00 读一次。
那个任务改读新缓存之前，legacy_cache/ 不能删。
```

| 事项 | 状态 | 负责人 |
|---|---|---|
| 报表任务改读新缓存 | warn 未开始 | 数据组 |
| 拆 legacy_cache/ | no 被上一条挡住 | 本组 |
| 监控面板补 AOF 延迟指标 | ok 已完成 | 本组 |

## 出问题看哪里

降级逻辑只有一个入口，读路径失败时它会打一行日志再回源：

```js
// src/gateway/fallback.js
export async function readWithFallback(key, deps) {
  const hit = await deps.cache.get(key).catch(() => null);
  if (hit !== null) return hit;
  deps.log("cache-degraded", { key });
  return deps.db.selectByKey(key);
}
```

看到 `cache-degraded` 密集出现，先看 Redis 的 AOF 重放队列长度，再看网络。
双写期间两边都有数据，降级不会导致错误结果，只会导致延迟回到迁移前的水平。

## 下一步

```ask
第 4 周的拆旧缓存，什么时候做？
* 等报表任务改完再做 | 一次干净移除，不留半截状态
- 先把双写关掉再说 | 减少一份写放大，旧缓存留着不管
```
