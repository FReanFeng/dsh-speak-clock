# dsh-speak-clock

给「主动搭话」装个闹钟：**agent 自己定下一次开口的时间**，到点精确响一次。

## 和 speak-up 的分工

| | speak-up | speak-clock |
|---|---|---|
| 什么时候开口 | 掷骰子，随机 | **你/agent 定的那个时刻** |
| 频率 | 按间隔反复 | 一次一个，响完就完 |
| 谁决定 | 概率 | 明确指定 |

两者互不干扰：想要「偶尔冒个泡」用 speak-up，想要「明早八点提醒她」用这个。

## 工具

```
speak_later { delaySec: 1800, text: "该休息一下了" }
speak_later { at: "08:00", text: "早八别迟到" }
speak_clock { action: "list" }
speak_clock { action: "cancel", id: "1" }
```

- `delaySec` 和 `at` 二选一；`at` 支持 `"HH:MM"`（下一个该时刻）或 ISO 时间
- `sessionId` 省略 = 当前会话
- 上限 50 个；进程重启后未到点的继续计时，错过的记为 `missed`

## 轻探（常驻循环）

`speak_probe` 让 agent「过一会儿主动来一句」：没有固定时间，插件自己在后台转。

- **随机间隔**：谷时 45–100 分钟、峰时 90–150 分钟（设置里可调）
- **安静时段让路**：默认 23:00–07:30 不探
- **约定闹钟让路**：有约定闹钟挂着时整个停
- **对方回话重新计时**：从最后一条真人消息往后推一整轮
- **只算不存**：下一次时间只在内存里算，不写进 `schedules.json`，列表里不会冒出「十小时后的轻探」
- **没醒就重试**：到点会话没在运行 → 10 分钟后再试，最多 3 次

```
speak_probe { restart: true }      # 从现在重新计时
speak_probe { reset: true }        # 整个停掉
```

## 早晚安闹钟

当轻探算出来的下一次会落进安静时段，插件另排两条**真正的约定闹钟**（默认开，设置页可关）：

- **睡前**：`安静开始 − 15 分钟`（默认 22:45），离现在不足 20 分钟就跳过
- **早上**：`安静结束 + 5 分钟`（默认 07:35）

它们出现在闹钟列表里、能取消；同一天各只会有一条。早上那条响过之后，轻探在安静结束 + 20 分钟接手。

## 设置项

`%USERPROFILE%\.dsh\speak-clock\settings.json`：

| 字段 | 默认 | 意思 |
|---|---|---|
| `enabled` / `allowAll` / `sessions` | 开 / 开 / `[]` | 总开关与允许的会话 |
| `quietStart` / `quietEnd` | `23` / `7.5` | 安静时段（支持半点） |
| `peakMin` / `peakMax` | `90` / `150` | 峰时间隔（分钟） |
| `valleyMin` / `valleyMax` | `45` / `100` | 谷时间隔（分钟） |
| `probeNightAlarms` | `true` | 早晚安闹钟开关 |

## 数据

- `%USERPROFILE%\.dsh\speak-clock\schedules.json` —— 只放约定闹钟
- `%USERPROFILE%\.dsh\speak-clock\probe.json` —— 轻探的开关与上次投递时间
- `%USERPROFILE%\.dsh\speak-clock\probe-log.txt` —— 每次排程/触发各一行，出问题先看它

## 注意

- 写的必须是**完整消息对象**。塞字符串进会话日志会把日志写坏（2026-11-02 踩过一次），这里不会重犯。
- 到点时那个会话**必须活着**才会投递；没醒会重试 3 次，仍不行就记 `missed`。

