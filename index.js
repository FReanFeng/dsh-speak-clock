/**
 * dsh-speak-clock — 给主动搭话装个闹钟。
 *
 * speak-up 是「掷骰子看要不要开口」；这个是「定好几点几分，到点必开口一次」。
 * agent 自己预约，精确到秒，只响一次。
 *
 * 为什么单独一只，而不是改 speak-up：那只插件 inject 里没有 `tools`、也没注册工具，
 * 往里塞要动它 60 KB 的 host.js，作者一发新版就会被覆盖。这里自给自足，互不干扰。
 *
 * 写的仍然是**完整消息对象**（id / role / content / source）—— 字符串塞进会话日志会写坏，
 * 这个教训已经踩过一次（见 2026-11-02 那次 session 损坏）。
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'speak-clock'
export const inject = ['tools', 'webServer', 'systemPrompt']

const HOME = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'speak-clock')
const FILE = join(HOME, 'schedules.json')
const MAX_ENTRIES = 50
const SETTINGS_FILE = join(HOME, 'settings.json')

/** 小时数：允许半点（22.5 = 22:30），非法值回落默认。 */
const halfHour = (v, def) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 24) return def
  return Math.round(n * 2) / 2
}

/** 总开关 + 允许的会话白名单（空数组 = 不限制）。 */
function loadSettings() {
  const raw = (() => { try { return JSON.parse(readFileSync(SETTINGS_FILE, 'utf8')) } catch { return null } })()
  return {
    enabled: raw?.enabled !== false,
    // ⭐ allowAll：显式开关。以前用「sessions 为空 = 全允许」，
    //   用户取消到最后一个就绕回“全选”，所以改成独立布尔。
    allowAll: raw?.allowAll !== false,
    sessions: Array.isArray(raw?.sessions) ? raw.sessions.map(String) : [],
    defaultText: typeof raw?.defaultText === 'string' ? raw.defaultText : '',
    quietStart: halfHour(raw?.quietStart, 22),
    quietEnd: halfHour(raw?.quietEnd, 7.5),
    peakStart: Number.isInteger(raw?.peakStart) ? raw.peakStart : 8,
    peakEnd: Number.isInteger(raw?.peakEnd) ? raw.peakEnd : 18,
    peakMin: Number.isInteger(raw?.peakMin) ? raw.peakMin : 90,
    peakMax: Number.isInteger(raw?.peakMax) ? raw.peakMax : 150,
    valleyMin: Number.isInteger(raw?.valleyMin) ? raw.valleyMin : 45,
    valleyMax: Number.isInteger(raw?.valleyMax) ? raw.valleyMax : 100,
    probeNightAlarms: raw?.probeNightAlarms !== false,
  }
}

function saveSettings(next) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(
    SETTINGS_FILE,
    JSON.stringify(
      {
        enabled: next.enabled !== false,
        allowAll: next.allowAll !== false,
        sessions: next.sessions ?? [],
        defaultText: next.defaultText ?? '',
        quietStart: halfHour(next.quietStart, 22),
        quietEnd: halfHour(next.quietEnd, 7.5),
        peakStart: Number.isInteger(next.peakStart) ? next.peakStart : 8,
        peakEnd: Number.isInteger(next.peakEnd) ? next.peakEnd : 18,
        peakMin: Number.isInteger(next.peakMin) ? next.peakMin : 90,
        peakMax: Number.isInteger(next.peakMax) ? next.peakMax : 150,
        valleyMin: Number.isInteger(next.valleyMin) ? next.valleyMin : 45,
        valleyMax: Number.isInteger(next.valleyMax) ? next.valleyMax : 100,
        probeNightAlarms: next.probeNightAlarms !== false,
      },
      null,
      2,
    ),
  )
}

/** 轻探间隔：峰时探得少，谷时探得勤（区间可配）。
 *  峰时 = 周一到周五 9:00–12:00、14:00–18:00；其余全是谷时（午休、晚间、周末全天）。
 */
function isPeakNow(now = new Date()) {
  const day = now.getDay()
  if (day === 0 || day === 6) return false
  const h = now.getHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

function probeMinutes() {
  const s = loadSettings()
  const peak = isPeakNow()
  const lo = Math.max(1, peak ? s.peakMin : s.valleyMin)
  const hi = Math.max(lo, peak ? s.peakMax : s.valleyMax)
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/** 小时窗口判定（支持跨零点）。 */
function inWindow(now, start, end) {
  if (start === end) return false
  const h = now.getHours()
  return start > end ? h >= start || h < end : h >= start && h < end
}

/** 安静时段：默认 22 点到次日 7:30 不轻探（可在设置里改，支持半点）。 */
function quietLabel() {
  const s2 = loadSettings()
  const f = (h) => `${Math.floor(h)}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`
  return `${f(s2.quietStart)}–${f(s2.quietEnd)}`
}

function inQuietHours(now = new Date()) {
  const s = loadSettings()
  const start = Math.round(s.quietStart * 60) % 1440
  const end = Math.round(s.quietEnd * 60) % 1440
  if (start === end) return false
  const m = now.getHours() * 60 + now.getMinutes()
  return start > end ? (m >= start || m < end) : (m >= start && m < end)
}

/** 某个钟点（支持半点）今天的 Date。 */
function atHour(base, hour) {
  const d = new Date(base)
  d.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0)
  return d
}

/**
 * ⭐ 2026-11-24：算下一次轻探的时刻，别让它落进安静时段就作废。
 *   · 正常：now + 间隔
 *   · 落进安静段时：先看「安静开始前 15 分钟」来不来得及（留给睡前的最后一条）；
 *   · 来不及就排到「安静结束 + 0~10 分钟随机」（早上第一条）。
 */
const QUIET_LEAD_MIN = 15

/** 纯安静结束时刻（不加随机）。⭐ 2026-11-26：前天那套“夹到 22:45 / 07:3x”不用了。 */
function wakeAtQuietEnd(fromMs = Date.now()) {
  const s = loadSettings()
  const end = atHour(fromMs, s.quietEnd)
  if (end.getTime() <= fromMs) end.setDate(end.getDate() + 1)
  return end.getTime()
}

/**
 * ⭐ 2026-11-26：早晚安闹钟 —— 两条真正的约定闹钟（不再是 nudge）。
 *   睡前一条、早上一条，各排各的，谁也不改谁的时间；有它们挂着时轻探自动让路。
 */
function addNightAlarm(sessionId, atMs, text, marker) {
  const all = load()
  if (all.some((e) => e.night === marker && (!e.state || e.state === 'armed'))) return null
  const entry = { id: randomUUID(), sessionId, at: atMs, text, state: 'armed', createdAt: Date.now(), night: marker }
  all.push(entry)
  save(all)
  arm(entry)
  return entry
}

function ensureNightAlarms(sessionId, fromMs = Date.now()) {
  const s = loadSettings()
  const day = (ts) => new Date(ts).toISOString().slice(0, 10)
  const bedtime = atHour(fromMs, s.quietStart).getTime() - 15 * 60000
  if (bedtime > fromMs + 20 * 60000) {
    addNightAlarm(sessionId, bedtime, `（睡前最后一句）${defaultPrompt()}`, 'bedtime:' + day(bedtime))
  }
  const morning = wakeAtQuietEnd(fromMs) + 5 * 60000
  addNightAlarm(sessionId, morning, `（早上第一句）${defaultPrompt()}`, 'morning:' + day(morning))
}

/** 算下一次轻探：落在安静时段就排到安静结束（开关开着时另排早晚安闹钟）。 */
function planProbeNext(sessionId, fromMs = Date.now()) {
  const s = loadSettings()
  const at = fromMs + probeMinutes() * 60000
  if (!inQuietHours(new Date(at))) return at
  if (s.probeNightAlarms !== false) {
    try { ensureNightAlarms(sessionId, fromMs) } catch { /* 排不上就算了 */ }
    // 早上那条闹钟会先说话；轻探往后让 20 分钟再接手，别两条一起冒出来
    return wakeAtQuietEnd(fromMs) + 20 * 60000
  }
  return wakeAtQuietEnd(fromMs)
}

/** 调试记录：每次排轻探都把「现在 → 算出来的时刻」写一行，出怪时间好查。 */
function logProbePlanned(nowMs, atMs, why) {
  try {
    mkdirSync(HOME, { recursive: true })
    appendFileSync(
      join(HOME, 'probe-log.txt'),
      `${new Date(nowMs).toISOString()}  now=${fmt(nowMs)}  at=${fmt(atMs)}  gapMin=${Math.round((atMs - nowMs) / 60000)}  ${why}\n`,
    )
  } catch { /* 记不下就算了 */ }
}

/**
 * ⭐ 2026-11-26：修「早上排完，下一次跑到第二天晚上」的怪时间。
 *   算完以后过三道闸：必须晚于现在；不能超过 26 小时；绝不允许落在安静时段里。
 */
/** 排下一条轻探（有约定闹钟就停，链不断）。 */
/**
 * 这个会话里、某时刻之后最近一条**真人**消息的时间。
 *   · 读会话日志（sessions.get(id).snapshotEvents()）——插件没有事件订阅接口，但能读。
 *   · 我们自己递进去的轻探标了 source.kind='speak-clock'，得排掉，不然会把自语当成人回话。
 */
function lastHumanMessageAt(sessionId, sinceMs) {
  try {
    const sessions = host?.ctx?.get?.('sessions')
    const session = sessions?.get?.(sessionId)
    if (!session || typeof session.snapshotEvents !== 'function') return 0
    const events = session.snapshotEvents()
    let latest = 0
    for (const ev of events) {
      if (ev?.type !== 'user/message') continue
      if ((ev.time ?? 0) <= sinceMs) continue
      const kind = ev?.data?.source?.kind
      if (kind === 'speak-clock') continue
      if ((ev.time ?? 0) > latest) latest = ev.time
    }
    return latest
  } catch {
    return 0
  }
}

/**
 * ⭐ 2026-11-26：轻探改成「常驻循环」——下一次时间只在内存里算，不再往 schedules.json 排条目。
 *   这样不会出现「显示一个十小时后的轻探」这种事，机制（随机间隔、安静时段、约定闹钟让路、
 *   对方回话重新计时）都保留。
 */
const probeLoops = new Map() // sessionId -> { timer, dueAt }

function probeOff(sessionId) {
  const st = loadProbe()
  return Boolean(st.off && st.off[sessionId])
}

function setProbeOff(sessionId, off) {
  const st = loadProbe()
  st.off = st.off || {}
  if (off) st.off[sessionId] = true
  else delete st.off[sessionId]
  saveProbe(st)
}

function readProbeLastFire(sessionId) {
  const st = loadProbe()
  return Number((st.lastFireAt && st.lastFireAt[sessionId]) || 0)
}

function writeProbeLastFire(sessionId, at) {
  const st = loadProbe()
  st.lastFireAt = st.lastFireAt || {}
  st.lastFireAt[sessionId] = at
  saveProbe(st)
}

function clearProbeTimer(sessionId) {
  const cur = probeLoops.get(sessionId)
  if (cur && cur.timer) clearTimeout(cur.timer)
  probeLoops.delete(sessionId)
}

function scheduleProbeTick(sessionId, atMs) {
  clearProbeTimer(sessionId)
  const delay = Math.max(1000, atMs - Date.now())
  const t = setTimeout(() => { void probeTick(sessionId) }, delay)
  if (typeof t.unref === 'function') t.unref()
  probeLoops.set(sessionId, { timer: t, dueAt: atMs })
}

async function probeTick(sessionId) {
  try {
    if (probeOff(sessionId)) return
    if (!allowedBySettings(sessionId).ok) return
    // 有约定闹钟 → 让路，过会儿再看（不是取消）
    if (hasFixedAlarm(sessionId)) {
      scheduleProbeTick(sessionId, Date.now() + 5 * 60000)
      return
    }
    if (inQuietHours()) {
      try { if (loadSettings().probeNightAlarms !== false) ensureNightAlarms(sessionId) } catch { /* 忽略 */ }
      scheduleProbeTick(sessionId, wakeAtQuietEnd())
      return
    }
    const agent = findAgent(sessionId)
    if (!agent) {
      scheduleProbeTick(sessionId, Date.now() + 10 * 60000)
      return
    }
    // 对方刚回过话 → 从那条消息重新计时，别刚说完又来一句
    const replyAt = lastHumanMessageAt(sessionId, readProbeLastFire(sessionId))
    const mins = probeMinutes()
    if (replyAt && replyAt + mins * 60000 > Date.now()) {
      scheduleProbeTick(sessionId, replyAt + mins * 60000)
      return
    }
    await agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: defaultPrompt() }],
      source: { kind: 'speak-clock' },
    })
    const firedAt = Date.now()
    writeProbeLastFire(sessionId, firedAt)
    const nextAt = planProbeNext(sessionId, firedAt)
    logProbePlanned(firedAt, nextAt, '轻探已投出，排下一次')
    scheduleProbeTick(sessionId, nextAt)
  } catch {
    scheduleProbeTick(sessionId, Date.now() + 10 * 60000)
  }
}

/** 给所有允许的会话起循环；已经起着的跳过。 */
function ensureProbes() {
  for (const s of sesssionList()) {
    if (!allowedBySettings(s.id).ok) continue
    if (probeOff(s.id)) continue
    const cur = probeLoops.get(s.id)
    if (cur && cur.dueAt > Date.now() - 60000) continue
    if (inQuietHours()) {
      try { if (loadSettings().probeNightAlarms !== false) ensureNightAlarms(s.id) } catch { /* 忽略 */ }
      scheduleProbeTick(s.id, wakeAtQuietEnd())
      continue
    }
    if (!s.alive) {
      scheduleProbeTick(s.id, Date.now() + 10 * 60000)
      continue
    }
    scheduleProbeTick(s.id, planProbeNext(s.id))
  }
}

/** 这个会话有没有「约定闹钟」（不是轻探的那种）。 */
function hasFixedAlarm(sessionId) {
  return load().some(
    (e) =>
      (!e.state || e.state === 'armed') &&
      e.probe === undefined &&
      e.nudge !== true &&
      (!sessionId || e.sessionId === sessionId),
  )
}

/** 有约定闹钟了就把轻探链拆掉。 */
function dropProbeChain(sessionId) {
  const kept = load().filter(
    (e) => !(e.probe !== undefined && (!sessionId || e.sessionId === sessionId) && (!e.state || e.state === 'armed')),
  )
  save(kept)
  for (const [id, t] of timers) {
    if (!kept.some((e) => e.id === id)) {
      clearTimeout(t)
      timers.delete(id)
    }
  }
}
const PROBE_FILE = join(HOME, 'probe.json')

function loadProbe() {
  try {
    return JSON.parse(readFileSync(PROBE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function saveProbe(v) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(PROBE_FILE, JSON.stringify(v, null, 2))
}

function allowedBySettings(sessionId) {
  const s = loadSettings()
  if (!s.enabled) return { ok: false, why: '总开关是关着的' }
  if (s.allowAll) return { ok: true, why: '' }
  if (!s.sessions.includes(String(sessionId))) return { ok: false, why: '这个会话没在允许名单里' }
  return { ok: true, why: '' }
}

/** 上一次响过的闹钟（用于在下一轮提示 agent：响过了，要不要续一个）。 */
let lastFired = null

function pendingFor(sessionId) {
  return load().filter((e) => (!e.state || e.state === 'armed') && (!sessionId || e.sessionId === sessionId))
}

function contextText(sessionId) {
  const list = pendingFor(sessionId)
  const lines = []
  if (list.length) {
    const next = list.slice().sort((a, b) => a.at - b.at)[0]
    const mins = Math.max(0, Math.round((next.at - Date.now()) / 60000))
    lines.push(`【搭话闹钟】下次 ${fmt(next.at)}（约 ${mins} 分钟后）到点会递：「${String(next.text).slice(0, 60)}」`)
    if (list.length > 1) lines.push(`另有 ${list.length - 1} 条在排队。`)
    lines.push('规则：用户给出新的日程或安排时（例如「我上午有课」），先看这个时间还合不合适；要改就用 speak_reschedule，不要重新定一条。')
    const loop = probeLoops.get(sessionId)
    if (loop && loop.dueAt) {
      lines.push(`轻探在走：下一次约 ${Math.max(0, Math.round((loop.dueAt - Date.now()) / 60000))} 分钟后（对方刚回过话的话，会自动从那条消息重新计时）。`)
    }
  } else if (lastFired && sessionId && lastFired.sessionId === sessionId && Date.now() - lastFired.at < 30 * 60 * 1000) {
    lines.push(`【搭话闹钟】刚才 ${fmt(lastFired.at)} 响过一次，现在没有待响的。`)
    lines.push('如果你还需要下一次（比如她说下午才回来），现在就用 speak_later 定一个；不需要就不用管。')
  }
  return lines.join('\n')
}

function speakUpPrompt() {
  try {
    const p = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'speak-up-config.json')
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    const t = String(cfg?.['触发文案'] ?? '').trim()
    return t
  } catch {
    return ''
  }
}

/** 内置兜底：speak-up 没装、也没填默认文案时用这句。 */
const BUILTIN_TEXT = '好久没人跟我说话了，去问一句吧。'

/** 文案回退链：本插件默认 → speak-up（装了才用）→ 内置一句。 */
function defaultPrompt() {
  const own = String(loadSettings().defaultText ?? '').trim()
  if (own) return own
  const up = speakUpPrompt()
  if (up) return up
  return BUILTIN_TEXT
}
const MAX_DELAY_SEC = 7 * 24 * 3600

/** @type {Map<string, NodeJS.Timeout>} */
const timers = new Map()
/** @type {any} */
let host = null

function load() {
  try {
    const list = JSON.parse(readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function save(list) {
  mkdirSync(HOME, { recursive: true })
  writeFileSync(FILE, JSON.stringify(list, null, 2))
}

function remove(id) {
  const next = load().filter((e) => e.id !== id)
  save(next)
  return next
}

function agentsOf() {
  try {
    return host?.ctx?.get?.('agents') ?? host?.ctx?.agents ?? null
  } catch {
    return null
  }
}

function findAgent(sessionId) {
  const agents = agentsOf()
  if (!agents) return null
  try {
    const direct = agents.get?.(sessionId)
    if (direct) return direct
    const list = agents.list?.() ?? []
    return list.find((a) => String(a?.session?.id ?? a?.id ?? '') === String(sessionId)) ?? null
  } catch {
    return null
  }
}

/** speak-up 挂在宿主 webServer 上的前缀；它的 /roll 和定时器是同一段逻辑。 */
function sesssionList() {
  const out = []
  const seen = new Set()
  try {
    const sessions = host?.ctx?.get?.('sessions')
    const titles = host?.ctx?.get?.('sessionTitle')
    const list = sessions?.list?.() ?? []
    for (const s of list) {
      const id = String(s?.id ?? s?.session?.id ?? '')
      if (!id || seen.has(id)) continue
      let title = ''
      try { title = titles?.get?.(s)?.title ?? '' } catch { /* 没标题就算了 */ }
      seen.add(id)
      out.push({ id, title, alive: Boolean(findAgent(id)) })
    }
  } catch { /* 服务不在就返回空 */ }
  return out
}

/** 扫磁盘上所有真会话目录（带 session.v4.jsonl.zstd 的），包括现在没运行的。 */
function diskSessions() {
  const found = []
  const base = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  let workspaces = []
  try {
    workspaces = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return found
  }
  for (const ws of workspaces) {
    const wsDir = join(base, ws)
    let entries = []
    try {
      entries = readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      continue
    }
    for (const name of entries) {
      const dir = join(wsDir, name)
      const log = join(dir, 'session.v4.jsonl.zstd')
      if (!existsSync(log)) continue
      found.push({ id: name, workspace: ws, mtime: statSync(log).mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found
}

/** 活着的 + 磁盘上的，合成一份；活着的优先（有标题）。 */
function allSessions(includeDormant) {
  const list = sesssionList()
  const byId = new Map(list.map((x) => [x.id, x]))
  if (includeDormant) {
    for (const d of diskSessions()) {
      if (byId.has(d.id)) continue
      byId.set(d.id, { id: d.id, title: '', alive: false, dormant: true, workspace: d.workspace })
    }
  }
  return [...byId.values()]
}

function webRoute(webServer, path, handler) {
  ctx0.effect(() => webServer.register({ kind: 'exact', path, handler }))
}

let ctx0 = null

function jsonBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) }
    })
    req.on('error', () => resolve({}))
  })
}

function reply(res, value) {
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}



async function fire(entry) {
  timers.delete(entry.id)
  const list = load()
  const idx = list.findIndex((e) => e.id === entry.id)

  const mark = (state, note) => {
    if (idx < 0) return
    list[idx].state = state
    list[idx].note = note ?? list[idx].note
    if (state === 'fired') list[idx].firedAt = Date.now()
    if (state === 'missed') list[idx].missedAt = Date.now()
    save(list)
    // ⭐ 2026-11-26：触发结果也写一行，出问题时能分清是「没排上」「排了没触发」还是「触发了没投递」
    try {
      mkdirSync(HOME, { recursive: true })
      appendFileSync(
        join(HOME, 'probe-log.txt'),
        `${new Date().toISOString()}  fire=${state}  ${entry.probe !== undefined ? 'probe' : 'fixed'}  ${note || ''}\n`,
      )
    } catch { /* 记不下就算了 */ }
  }

  const agent = findAgent(entry.sessionId)
  if (!agent) {
    // ⭐ 2026-11-26：到点时那个会话还没被唤醒（比如刚开机、QQ 会话要等你发消息才醒），
    //   以前直接记 missed 就结束了 —— 链断、你什么也收不到。
    //   现在改成「10 分钟后再试」，最多试 3 次；还不行才放弃并排下一条。
    const tries = Number(entry.retries || 0)
    if (tries < 3) {
      mark('missed', '到点时那个会话没在运行，10 分钟后再试（第 ' + (tries + 1) + ' 次）')
      entry.retries = tries + 1
      entry.at = Date.now() + 10 * 60000
      entry.state = 'armed'
      if (idx >= 0) {
        list[idx] = entry
        save(list)
      }
      arm(entry)
      return
    }
    mark('missed', '到点时那个会话一直没在运行，放弃这一条')
    return
  }
  const gate = allowedBySettings(entry.sessionId)
  if (!gate.ok) {
    mark('blocked', gate.why)
    return
  }

  try {
    await agent.followup({
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text: entry.text }],
      source: { kind: 'speak-clock' },
    })
    lastFired = { at: Date.now(), sessionId: entry.sessionId, text: entry.text }
    mark('fired')
    // 重复闹钟：响完自己续一条，不靠 agent 记得
    if (entry.everyMin > 0) {
      const next = {
        id: randomUUID(),
        sessionId: entry.sessionId,
        at: Date.now() + entry.everyMin * 60000,
        text: entry.text,
        state: 'armed',
        everyMin: entry.everyMin,
        // ⭐ 2026-11-14 修：这里原来把 nudge 标记丢了 → 续出来的自检提醒
        //   会被当成「约定闹钟」，把轻探链永久堵死。
        ...(entry.nudge === true ? { nudge: true } : {}),
        createdAt: Date.now(),
      }
      const all2 = load()
      all2.push(next)
      save(all2)
      arm(next)
    }
  } catch (err) {
    mark('failed', String(err?.message ?? err).slice(-200))
  }
}

function arm(entry) {
  const delay = entry.at - Date.now()
  if (delay <= 0) {
    void fire(entry)
    return
  }
  const t = setTimeout(() => { void fire(entry) }, delay)
  if (typeof t.unref === 'function') t.unref()
  timers.set(entry.id, t)
}

function parseWhen(args) {
  const delaySec = Number(args?.delaySec)
  if (Number.isFinite(delaySec) && delaySec > 0) {
    return Date.now() + Math.min(delaySec, MAX_DELAY_SEC) * 1000
  }
  const at = String(args?.at ?? '').trim()
  if (!at) return null
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(at)) {
    const parts = at.split(':').map(Number)
    const d = new Date()
    d.setHours(parts[0], parts[1], parts[2] ?? 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime()
  }
  const parsed = Date.parse(at)
  return Number.isNaN(parsed) ? null : parsed
}

function fmt(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function sessionTitles() {
  try {
    return new Map(allSessions(true).map((x) => [x.id, x.title || x.id.slice(0, 16) + '…']))
  } catch {
    return new Map()
  }
}

function summarize(entry, titles) {
  const left = Math.max(0, Math.round((entry.at - Date.now()) / 1000))
  const name = (titles && titles.get(entry.sessionId)) || entry.sessionId.slice(0, 16) + '…'
  return `[${entry.id.slice(0, 8)}] ${fmt(entry.at)}（${left}s 后）→ 会话「${name}」 ｜ ${entry.state ?? 'armed'} ｜ 「${entry.text.slice(0, 30)}」`
}

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    text: { type: 'string' },
    id: { type: 'string' },
    at: { type: 'number' },
  },
  required: ['ok', 'text'],
  additionalProperties: true,
}

export function apply(ctx) {
  host = { ctx }
  ctx0 = ctx

  // 网页半边要看的倒计时数据：只返回还没响的闹钟
  const webServer = (() => { try { return ctx.get?.('webServer') } catch { return null } })()
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-speak-clock/state',
      handler: (req, res) => {
        let sid = ''
        try {
          const url = new URL(req.url ?? '/', 'http://localhost')
          sid = url.searchParams.get('sessionId') ?? ''
        } catch { /* 解析不了就当没传 */ }
        const pending = load()
          .filter((e) => !e.state || e.state === 'armed')
          .filter((e) => !sid || e.sessionId === sid)
          .map((e) => ({ id: e.id, at: e.at, text: e.text, kind: e.kind ?? 'text', sessionId: e.sessionId }))
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: true, now: Date.now(), entries: pending }))
      },
    }))

    const addAlarm = (payload, sessionId) => {
      const at = parseWhen(payload)
      if (!at) return { ok: false, text: '时间没说清：给分钟数或 "HH:MM"。' }
      const text = String(payload?.text ?? '').trim() || defaultPrompt()
      if (!text) return { ok: false, text: '文案空着，而说话-up 也没配置触发文案。' }
      if (!sessionId) return { ok: false, text: '先选一个会话。' }
      if (!findAgent(sessionId)) return { ok: false, text: '那个会话现在没在运行。' }
      const pending = load().filter((e) => !e.state || e.state === 'armed')
      if (pending.length >= MAX_ENTRIES) return { ok: false, text: `上限 ${MAX_ENTRIES} 条，先取消几个。` }
      const gate = allowedBySettings(sessionId)
      if (!gate.ok) return { ok: false, text: gate.why }
      dropProbeChain(sessionId)
      const entry = { id: randomUUID(), sessionId, at, text, state: 'armed', createdAt: Date.now() }
      const all = load()
      all.push(entry)
      save(all)
      arm(entry)
      return { ok: true, text: `已定：${fmt(at)}` }
    }

    webRoute(webServer, '/dsh-speak-clock/sessions', async (req, res) => {
      let all = false
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        all = url.searchParams.get('all') === '1'
      } catch { /* 默认只看活着的 */ }
      reply(res, { ok: true, sessions: allSessions(all) })
    })

    webRoute(webServer, '/dsh-speak-clock/settings', async (req, res) => {
      if (req.method === 'POST') {
        const body = await jsonBody(req)
        const current = loadSettings()
        const next = {
          enabled: body?.enabled === undefined ? current.enabled : Boolean(body.enabled),
          allowAll: body?.allowAll === undefined ? current.allowAll : Boolean(body.allowAll),
          sessions: Array.isArray(body?.sessions) ? body.sessions.map(String) : current.sessions,
          defaultText: body?.defaultText === undefined ? current.defaultText : String(body.defaultText),
          quietStart: body?.quietStart === undefined ? current.quietStart : Number(body.quietStart),
          quietEnd: body?.quietEnd === undefined ? current.quietEnd : Number(body.quietEnd),
          peakStart: body?.peakStart === undefined ? current.peakStart : Number(body.peakStart),
          peakEnd: body?.peakEnd === undefined ? current.peakEnd : Number(body.peakEnd),
          peakMin: body?.peakMin === undefined ? current.peakMin : Number(body.peakMin),
          peakMax: body?.peakMax === undefined ? current.peakMax : Number(body.peakMax),
          valleyMin: body?.valleyMin === undefined ? current.valleyMin : Number(body.valleyMin),
          valleyMax: body?.valleyMax === undefined ? current.valleyMax : Number(body.valleyMax),
          probeNightAlarms: body?.probeNightAlarms === undefined ? current.probeNightAlarms : Boolean(body.probeNightAlarms),
        }
        saveSettings(next)
        // 关掉某间（或关总开关）后，把它已经排着的闹钟一并撤掉，
        // 不然它会一直在后台数着时间、到点还响。
        // ⚠️ nudge（自检提醒）不在此列：它是维护性提醒，不归「会话搭话闹钟」管。
        let pruned = 0
        const kept = []
        for (const e of load()) {
          const armed = !e.state || e.state === 'armed'
          const okNow = next.enabled && (next.allowAll || next.sessions.includes(e.sessionId))
          if (armed && !okNow && e.nudge !== true) {
            const t = timers.get(e.id)
            if (t) clearTimeout(t)
            timers.delete(e.id)
            e.state = 'blocked'
            e.note = next.enabled ? '会话已被关闭' : '总开关关着'
            pruned += 1
          }
          kept.push(e)
        }
        if (pruned > 0) save(kept)
        // 重新允许某个会话时，把它的轻探立刻补回来（不然得等到下一个 10 分钟一跳）
        try {
          ensureProbes()
        } catch { /* 拿不到会话列表就算了 */ }
        return reply(res, { ok: true, settings: next, pruned })
      }
      const speakUp = speakUpPrompt()
      reply(res, {
        ok: true,
        settings: { ...loadSettings(), prompt: defaultPrompt(), speakUpPrompt: speakUp, speakUpAvailable: Boolean(speakUp) },
      })
    })

    webRoute(webServer, '/dsh-speak-clock/add', async (req, res) => {
      const body = await jsonBody(req)
      const r = addAlarm(body, String(body?.sessionId ?? ''))
      reply(res, r)
    })

    webRoute(webServer, '/dsh-speak-clock/probe', async (req, res) => {
      const body = await jsonBody(req)
      const sessionId = String(body?.sessionId ?? '')
      if (!sessionId) return reply(res, { ok: false, text: '先选一个会话。' })
      if (body?.reset) {
        setProbeOff(sessionId, true)
        clearProbeTimer(sessionId)
        return reply(res, { ok: true, text: '轻探已停。' })
      }
      if (inQuietHours()) return reply(res, { ok: false, text: '现在是安静时段（' + quietLabel() + '），轻探不开。' })
      if (hasFixedAlarm(sessionId)) return reply(res, { ok: false, text: '这个会话有约定闹钟，轻探不开。' })
      if (!findAgent(sessionId)) return reply(res, { ok: false, text: '那个会话现在没在运行。' })
      const gate2 = allowedBySettings(sessionId)
      if (!gate2.ok) return reply(res, { ok: false, text: gate2.why })
      setProbeOff(sessionId, false)
      const mins = probeMinutes()
      const at = Date.now() + mins * 60000
      scheduleProbeTick(sessionId, at)
      reply(res, { ok: true, text: `轻探：${mins} 分钟后（${fmt(at)}）` })
    })

    webRoute(webServer, '/dsh-speak-clock/cancel', async (req, res) => {
      const body = await jsonBody(req)
      const id = String(body?.id ?? '')
      // 虚拟条目（轻探）：取消 = 停掉这个会话的轻探循环
      if (id.startsWith('probe:')) {
        const sid = id.slice('probe:'.length)
        setProbeOff(sid, true)
        clearProbeTimer(sid)
        return reply(res, { ok: true, text: '轻探已停（这个会话不再自动探话）。' })
      }
      const target = load().find((e) => e.id === id)
      if (!target) return reply(res, { ok: false, text: '没找到这条闹钟。' })
      const t = timers.get(target.id)
      if (t) clearTimeout(t)
      timers.delete(target.id)
      remove(target.id)
      reply(res, { ok: true, text: '已取消' })
    })

    webRoute(webServer, '/dsh-speak-clock/history', async (req, res) => {
      // ⭐ 2026-11-26：轻探不落盘，但设置页要能看见它，否则出问题发现不了。
      //   这里额外塞一条「虚拟条目」（virtual:true），只读展示，不改 schedules.json。
      const virtual = []
      for (const [sid, loop] of probeLoops) {
        if (!loop || !loop.dueAt) continue
        virtual.push({
          id: 'probe:' + sid,
          sessionId: sid,
          at: loop.dueAt,
          probe: true,
          virtual: true,
          text: '（轻探·后台自动续）',
        })
      }
      reply(res, { ok: true, entries: virtual.concat(load().slice(-30).reverse()) })
    })
  }

  // 恢复：进程重启后把还没到点的闹钟重新挂上
  for (const entry of load()) {
    if (!entry || typeof entry.at !== 'number' || !entry.sessionId || !entry.text) continue
    if (entry.state === 'fired' || entry.state === 'failed' || entry.state === 'missed') continue
    arm(entry)
  }

  // 轻探默认开着：启动补一轮，之后每 10 分钟检查一下
  try {
    ensureProbes()
  } catch { /* 服务未就绪就算了 */ }
  // ⭐ 2026-11-26：轻探不再排条目。把以前留在 schedules.json 里的轻探条目清掉（只清 probe 那种）。
  try {
    const kept = load().filter((e) => e.probe === undefined)
    if (kept.length !== load().length) save(kept)
  } catch { /* 清不掉就算了 */ }

  const probeTimer = setInterval(() => {
    try { ensureProbes() } catch { /* 忽略 */ }
  }, 10 * 60 * 1000)
  if (typeof probeTimer.unref === 'function') probeTimer.unref()
  // 启动就先起一次，别等 10 分钟
  try { setTimeout(() => { try { ensureProbes() } catch { /* 忽略 */ } }, 5000).unref?.() } catch { /* 忽略 */ }

  const disposers = []

  disposers.push(ctx.tools.register({
    name: 'speak_later',
    description: [
      '给「主动搭话」定一个闹钟：到点往指定会话送一句话，让 agent 自己开一轮。只响一次。',
      '参数二选一：delaySec（多少秒后）或 at（"HH:MM" 表示下一个该时刻；也接受 ISO 时间）。',
      'sessionId 省略 = 当前会话。text 是到点时递进去的那句话。',
      '会上限 50 条；进程重启后未到点的会继续计时，已错过记录为 missed。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        delaySec: { type: 'number', description: '多少秒后响。' },
        at: { type: 'string', description: '"HH:MM" 表示下一个该时刻；也接受 ISO 时间。' },
        text: { type: 'string', description: '到点时递进会话的那句话。' },
        everyMin: { type: 'number', description: '可选：每隔多少分钟自动续一次（响完自己重定，不靠 agent 记得）。' },
        nudge: { type: 'boolean', description: '可选：true = 这条只是提醒/自检，不算「约定闹钟」——不会把轻探停掉。' },
        sessionId: { type: 'string', description: '目标会话；省略 = 当前会话。' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      const at = parseWhen(args)
      if (!at) return { ok: false, text: '时间没说清：给 delaySec（秒）或 at（"HH:MM" / ISO）。' }
      const text = String(args?.text ?? '').trim() || defaultPrompt()
      if (!text) return { ok: false, text: 'text 空着，而 speak-up 也没配置触发文案。' }
      const sessionId = String(args?.sessionId ?? '').trim() || String(exec?.agent?.id ?? '')
      if (!sessionId) return { ok: false, text: '拿不到会话 id，请显式传 sessionId。' }
      if (!findAgent(sessionId)) return { ok: false, text: `会话 ${sessionId.slice(0, 16)}… 现在没在运行，闹钟会送不进去。` }

      const list = load().filter((e) => e.state === 'armed' || e.state === undefined)
      if (list.length >= MAX_ENTRIES) return { ok: false, text: `闹钟太多了（上限 ${MAX_ENTRIES}），先取消几个。` }

      const entry = { id: randomUUID(), sessionId, at, text, state: 'armed', createdAt: Date.now() }
      const every = Number(args?.everyMin)
      if (Number.isFinite(every) && every > 0) entry.everyMin = Math.max(1, Math.round(every))
      if (args?.nudge === true) entry.nudge = true
      if (entry.nudge !== true) dropProbeChain(sessionId)
      const all = load()
      all.push(entry)
      save(all)
      arm(entry)
      return { ok: true, id: entry.id, at, text: `闹钟定好了：${fmt(at)} → 会话 ${sessionId.slice(0, 16)}…\n到时候递这句：「${text}」` }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'speak_reschedule',
    description: [
      '改一条还没响的闹钟的时间（不新建）。不给 id 就改当前会话最早那条。',
      '参数：delaySec（多少秒后）或 at（"HH:MM" / ISO）。',
      '什么时候用：用户说了新的日程（「我上午有课」），而上下文里【搭话闹钟】显示的时间不合适时。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '闹钟 id；省略 = 当前会话最早的那条。' },
        delaySec: { type: 'number', description: '多少秒后响。' },
        at: { type: 'string', description: '"HH:MM" 或 ISO 时间。' },
        text: { type: 'string', description: '可选：连提示词一起换（比如睡前那条改成早上的事）。' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      const at = parseWhen(args)
      if (!at) return { ok: false, text: '时间没说清：给 delaySec（秒）或 at（"HH:MM" / ISO）。' }
      const list = load()
      const sid = String(exec?.agent?.id ?? '')
      const wanted = String(args?.id ?? '').trim()
      let target = null
      if (wanted) target = list.find((e) => e.id === wanted || e.id.startsWith(wanted)) ?? null
      if (!target) {
        target = list
          .filter((e) => (!e.state || e.state === 'armed') && (!sid || e.sessionId === sid))
          .sort((a, b) => a.at - b.at)[0] ?? null
      }
      if (!target) return { ok: false, text: '没有可改的闹钟。' }
      const gate = allowedBySettings(target.sessionId)
      if (!gate.ok) return { ok: false, text: gate.why }
      target.at = at
      const newText = String(args?.text ?? '').trim()
      if (newText) target.text = newText
      save(list)
      const t = timers.get(target.id)
      if (t) clearTimeout(t)
      dropProbeChain(target.sessionId)
      arm(target)
      return { ok: true, text: `已改到 ${fmt(at)}（会话 ${String(target.sessionId).slice(0, 16)}…）` + (newText ? `\n文案：「${newText}」` : '') }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'speak_probe',
    description: [
      '「轻探」：对方只说在做某事、没给结束时间时（「我去玩游戏了」），用它定下一次探话。',
      '默认一直开着：45–100 分钟随机探一次，没人回就自己续；安静时段（' + quietLabel() + '）和有约定闹钟时自动停。',
      'restart:true = 重新计时。对方刚回了话时调它，把下一次从现在往后推一整个间隔（不带也能重排，但这样意图更明确）。',
      'reset:true = 整个停掉，只在用户明确说「别探了」时用。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '到点要说的话；省略 = 用 speak-up 的触发文案。' },
        restart: { type: 'boolean', description: 'true = 现在重新计时（对方刚回话）。' },
        reset: { type: 'boolean', description: 'true = 停掉轻探（用户说「别探了」）。' },
        sessionId: { type: 'string', description: '目标会话；省略 = 当前会话。' },
      },
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args, exec) {
      const sessionId = String(args?.sessionId ?? '').trim() || String(exec?.agent?.id ?? '')
      if (!sessionId) return { ok: false, text: '拿不到会话 id，请显式传 sessionId。' }

      if (args?.reset) {
        setProbeOff(sessionId, true)
        clearProbeTimer(sessionId)
        return { ok: true, text: '轻探已停（不再自动探话）。' }
      }

      if (!findAgent(sessionId)) return { ok: false, text: '那个会话现在没在运行。' }
      const gate = allowedBySettings(sessionId)
      if (!gate.ok) return { ok: false, text: gate.why }

      if (inQuietHours()) {
        return { ok: false, text: '现在是安静时段（' + quietLabel() + '），轻探不开。' }
      }
      if (hasFixedAlarm(sessionId)) {
        return { ok: false, text: '这个会话已经有约定闹钟了，轻探不开；等那条响过或取消之后再用。' }
      }

      setProbeOff(sessionId, false)
      const mins = probeMinutes()
      const at = Date.now() + mins * 60000
      scheduleProbeTick(sessionId, at)
      return {
        ok: true,
        at,
        text: `轻探：${mins} 分钟后（${fmt(at)}）\n之后在后台自己续（随机间隔、安静时段让路、有约定闹钟让路）；对方回了话会从那条消息重新计时。`,
      }
    },
  }))

  disposers.push(ctx.tools.register({
    name: 'speak_clock',
    description: '查看／取消「主动搭话」的闹钟。action=list 看全部，cancel 取消一条（传 id 或序号），status 只看还有几个在等。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'cancel', 'status'] },
        id: { type: 'string', description: 'cancel 时要取消的 id（也接受 list 里的序号，从 1 开始）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: RESULT_SCHEMA, render: (_a, v) => [{ type: 'text', text: v.text }] },
    async execute(args) {
      const list = load()
      const pending = list.filter((e) => e.state === 'armed' || e.state === undefined)
      const action = String(args?.action ?? 'list')

      if (action === 'status') {
        return { ok: true, text: pending.length ? `还有 ${pending.length} 个闹钟在等：\n${pending.map((e) => summarize(e, sessionTitles())).join('\n')}` : '没有在等的闹钟。' }
      }
      if (action === 'cancel') {
        const raw = String(args?.id ?? '').trim()
        if (!raw) return { ok: false, text: '要取消哪一个？给我 id 或 list 里的序号。' }
        const byId = list.find((e) => e.id === raw || e.id.startsWith(raw))
        const idx = Number(raw)
        const byIndex = Number.isInteger(idx) && idx >= 1 && idx <= pending.length ? pending[idx - 1] : null
        const target = byId ?? byIndex
        if (!target) return { ok: false, text: `没找到闹钟「${raw}」。` }
        const t = timers.get(target.id)
        if (t) clearTimeout(t)
        timers.delete(target.id)
        remove(target.id)
        return { ok: true, text: `已取消：${fmt(target.at)} 那条。` }
      }
      if (!list.length) return { ok: true, text: '一个闹钟都没有。用 speak_later 定一个。' }
      const titles = sessionTitles()
      const lines = list.map((e, i) => `${i + 1}. ${summarize(e, titles)}`)
      // 轻探不落盘，但列表里也让它露个面，出问题好发现
      for (const [sid, loop] of probeLoops) {
        if (!loop || !loop.dueAt) continue
        const name = titles.get(sid) || String(sid).slice(0, 16) + '…'
        const mins = Math.max(0, Math.round((loop.dueAt - Date.now()) / 60000))
        lines.push(`轻探：${mins} 分钟后（${fmt(loop.dueAt)}）→ 会话「${name}」· 后台自己续`)
      }
      return { ok: true, text: lines.join('\n') }
    },
  }))

  // 把「还有哪些闹钟」放进运行时上下文——agent 看得到才能自己改。
  try {
    ctx.effect(() => ctx.systemPrompt.context({
      name: 'speak-clock',
      order: 60,
      text: (assembly) => {
        let sid = ''
        try {
          sid = String(assembly?.scope?.session?.id ?? assembly?.scope?.id ?? assembly?.session?.id ?? '')
        } catch { /* 拿不到就全局 */ }
        return contextText(sid)
      },
    }))
  } catch { /* 没有 systemPrompt 服务就算了，工具还能用 */ }

  // 常驻规则：所有 agent 一开始就知道这套工具怎么用（不依赖有没有闹钟）
  try {
    ctx.effect(() => ctx.systemPrompt.section({
      name: 'speak-clock-rules',
      order: 62,
      text: [
        '【搭话闹钟】你有三个工具管「定时主动说话」：',
        '- speak_later {delaySec|at, text, everyMin?}：定一次；到点往会话里递这句话。',
        '- speak_reschedule {id?, delaySec|at, text?}：改已有闹钟的时间（可连文案一起换）。',
        '- speak_probe {restart?, reset?, text?, sessionId?}：轻探——默认一直开着，45–100 分钟随机探一次；安静时段、或者这个会话有约定闹钟时自动停。',
        '  对方回过话之后，插件会从那条消息自动重新计时（不用你调 restart，调了也行）；只有用户明确说"别探了"才传 reset:true。',
        '- speak_clock {action: list|cancel|status}：看还有哪些在等、取消。',
        '规则：',
        '1. 用户给出新的安排（要睡了、有课、出门、不在家）时，先看已定的闹钟还合不合适，优先用 speak_reschedule 改期，不要「取消再定」。',
        '2. 改期时连文案一起换：叫睡的那条改成早上，就别还留着「快 22:30 了」。',
        '3. 闹钟响过后，只有确实还需要下一次才续；不需要就不管，不要机械重定。',
        '4. 定之前想清楚什么时候真的有用：半夜、对方明确在睡/上课的时间别定。',
      ].join('\n'),
    }))
  } catch { /* 没有 systemPrompt 服务就算了 */ }

  const cleanup = () => {
    clearInterval(probeTimer)
    for (const t of timers.values()) clearTimeout(t)
    timers.clear()
    for (const d of disposers) {
      try { d() } catch { /* already disposed */ }
    }
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => cleanup)
  else if (typeof ctx.on === 'function') ctx.on('dispose', cleanup)
}
