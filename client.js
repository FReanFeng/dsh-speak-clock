// dsh-speak-clock 的网页半边：
//   ① 会话标题旁的倒计时    ② 设置里的「搭话闹钟」页（选会话 + 定时 + 取消）
window.__ModuleLoader__.load({
  id: 'dsh-speak-clock',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const pad = (n) => String(n).padStart(2, '0')

    async function getJson(url) {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    async function postJson(url, body) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    }

    function fmtTime(ts) {
      const d = new Date(ts)
      return d.getMonth() + 1 + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    function leftText(ts) {
      const left = Math.max(0, ts - Date.now())
      const hh = Math.floor(left / 3600000)
      const mm = Math.floor((left % 3600000) / 60000)
      const ss = Math.floor((left % 60000) / 1000)
      return (hh > 0 ? hh + ':' : '') + pad(mm) + ':' + pad(ss)
    }

    // ── 会话标题旁的倒计时 ──────────────────────────────────────────
    function Countdown(props) {
      const sessionId = props.sessionId
      const [entry, setEntry] = React.useState(null)
      const [, setTick] = React.useState(0)

      React.useEffect(() => {
        let alive = true
        async function pull() {
          try {
            const json = await getJson('/dsh-speak-clock/state?sessionId=' + encodeURIComponent(String(sessionId ?? '')))
            if (!alive) return
            const list = Array.isArray(json && json.entries) ? json.entries.slice() : []
            list.sort((a, b) => a.at - b.at)
            setEntry(list.length ? list[0] : null)
          } catch {
            /* 拉不到就保持上一次的值 */
          }
        }
        pull()
        const pullTimer = setInterval(pull, 10000)
        const tickTimer = setInterval(() => setTick((n) => n + 1), 1000)
        return () => {
          alive = false
          clearInterval(pullTimer)
          clearInterval(tickTimer)
        }
      }, [sessionId])

      if (!entry) return null
      const soon = entry.at - Date.now() <= 60000
      return h(
        'span',
        {
          title: '下一条搭话：' + new Date(entry.at).toLocaleString() + '\n' + (entry.text || ''),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
            padding: '1px 6px',
            borderRadius: '9px',
            fontVariantNumeric: 'tabular-nums',
            fontSize: '12px',
            lineHeight: '18px',
            border: '1px solid currentColor',
            opacity: soon ? 1 : 0.65,
            color: 'inherit',
            whiteSpace: 'nowrap',
          },
        },
        h('span', { 'aria-hidden': true }, '⏰'),
        h('span', null, leftText(entry.at)),
      )
    }

    // ── 设置页 ────────────────────────────────────────────────────
    const card = {
      border: '1px solid currentColor',
      borderRadius: '10px',
      padding: '10px 12px',
      marginTop: '10px',
      opacity: 0.95,
    }
    const dim = { opacity: 0.6, fontSize: '12px' }
    const input = {
      background: 'transparent',
      color: 'inherit',
      border: '1px solid currentColor',
      borderRadius: '6px',
      padding: '4px 8px',
      fontSize: '13px',
      opacity: 0.9,
    }
    const btn = Object.assign({}, input, { cursor: 'pointer', padding: '4px 10px' })

    function Settings(props) {
      const [sessions, setSessions] = React.useState([])
      const [entries, setEntries] = React.useState([])
      const [sessionId, setSessionId] = React.useState('')
      const [minutes, setMinutes] = React.useState('30')
      const [text, setText] = React.useState('')
      const [probeText, setProbeText] = React.useState('')
      const [defaultText, setDefaultText] = React.useState('')
      const [quietStart, setQuietStart] = React.useState('23')
      const [quietEnd, setQuietEnd] = React.useState('7.5')
      const [peakStart, setPeakStart] = React.useState('8')
      const [peakEnd, setPeakEnd] = React.useState('18')
      const [peakMin, setPeakMin] = React.useState('90')
      const [peakMax, setPeakMax] = React.useState('150')
      const [valleyMin, setValleyMin] = React.useState('45')
      const [valleyMax, setValleyMax] = React.useState('100')
      const [msg, setMsg] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [showAll, setShowAll] = React.useState(false)
      const [filterSession, setFilterSession] = React.useState('')
      const [gate, setGate] = React.useState({ enabled: true, sessions: [] })

      const refresh = React.useCallback(async () => {
        try {
          const g = await getJson('/dsh-speak-clock/settings')
          if (g && g.settings) {
            setGate({
              enabled: g.settings.enabled !== false,
              allowAll: g.settings.allowAll !== false,
              sessions: Array.isArray(g.settings.sessions) ? g.settings.sessions : [],
              prompt: String(g.settings.prompt ?? ''),
              speakUpAvailable: Boolean(g.settings.speakUpAvailable),
            })
            if (!defaultText && g.settings.defaultText) setDefaultText(String(g.settings.defaultText))
            if (g.settings.quietStart !== undefined) setQuietStart(String(g.settings.quietStart))
            if (g.settings.quietEnd !== undefined) setQuietEnd(String(g.settings.quietEnd))
            if (g.settings.peakStart !== undefined) setPeakStart(String(g.settings.peakStart))
            if (g.settings.peakEnd !== undefined) setPeakEnd(String(g.settings.peakEnd))
            if (g.settings.peakMin !== undefined) setPeakMin(String(g.settings.peakMin))
            if (g.settings.peakMax !== undefined) setPeakMax(String(g.settings.peakMax))
            if (g.settings.valleyMin !== undefined) setValleyMin(String(g.settings.valleyMin))
            if (g.settings.valleyMax !== undefined) setValleyMax(String(g.settings.valleyMax))
          }
        } catch { /* 忽略 */ }
        try {
          const s = await getJson('/dsh-speak-clock/sessions' + (showAll ? '?all=1' : ''))
          setSessions(Array.isArray(s?.sessions) ? s.sessions : [])
        } catch { /* 忽略 */ }
        try {
          const e = await getJson('/dsh-speak-clock/history')
          setEntries(Array.isArray(e?.entries) ? e.entries : [])
        } catch { /* 忽略 */ }
      }, [showAll])

      React.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 8000)
        return () => clearInterval(t)
      }, [refresh])

      const pending = entries.filter((e) => !e.state || e.state === 'armed')
      const others = entries.filter((e) => e.state && e.state !== 'armed')
      const probeFor = pending.find((e) => e.probe !== undefined && e.sessionId === sessionId)
      const fixedFor = pending.find((e) => e.probe === undefined && e.sessionId === sessionId)
      // 按会话筛选「在等的」列表
      const titleOf = (id) => (sessions.find((s) => s.id === id) || {}).title || String(id).slice(0, 16) + '…'
      const shownPending = filterSession ? pending.filter((e) => e.sessionId === filterSession) : pending

      async function probeAction(reset) {
        if (!sessionId) return setMsg('先选一个会话。')
        setBusy(true)
        try {
          const r = await postJson('/dsh-speak-clock/probe', { sessionId, reset, text: probeText })
          setMsg(r?.ok ? r.text : '没成：' + (r?.text || ''))
          await refresh()
        } catch (err) {
          setMsg('没成：' + String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      async function saveGate(patch) {
        const next = { enabled: gate.enabled, sessions: gate.sessions, ...patch }
        setGate(next)
        try {
          await postJson('/dsh-speak-clock/settings', next)
        } catch (err) {
          setMsg('保存开关失败：' + String(err?.message ?? err))
        }
      }

      function toggleSession(id) {
        // allowAll 是显式开关：全允许时取消一个，就先把它落实成
        // 「所有已知会话 - 这一个」，并把 allowAll 关掉。
        // （旧版用「空数组 = 全允许」，取消到最后一个会绕回全选。）
        if (gate.allowAll) {
          const base = sessions.map((s) => s.id)
          saveGate({ allowAll: false, sessions: base.filter((x) => x !== id) })
          return
        }
        const has = gate.sessions.includes(id)
        saveGate({ allowAll: false, sessions: has ? gate.sessions.filter((x) => x !== id) : [...gate.sessions, id] })
      }

      const allowed = (id) => gate.allowAll || gate.sessions.includes(id)

      async function add() {
        if (busy) return
        const mins = Number(minutes)
        if (!sessionId) return setMsg('先选一个会话。')
        if (!Number.isFinite(mins) || mins <= 0) return setMsg('分钟数要大于 0。')
        setBusy(true)
        try {
          const r = await postJson('/dsh-speak-clock/add', { sessionId, delaySec: Math.round(mins * 60), text })
          setMsg(r?.ok ? '定好了：' + r.text : '没成功：' + (r?.text || ''))
          if (r?.ok) { setText(''); await refresh() }
        } catch (err) {
          setMsg('没成功：' + String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      async function cancel(id) {
        setBusy(true)
        try {
          await postJson('/dsh-speak-clock/cancel', { id })
          await refresh()
        } catch (err) {
          setMsg('取消失败：' + String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { fontSize: '13px' } },
        h('h3', { style: { margin: '0 0 4px' } }, '搭话闹钟'),
        h('div', { style: dim }, '到点往选定的会话递一句话，让它自己开一轮。一次性，响完就删。'),

        h('div', { style: card },
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', cursor: 'pointer', fontWeight: 600 } },
            h('input', { type: 'checkbox', checked: gate.enabled, onChange: (e) => saveGate({ enabled: e.target.checked }) }),
            h('span', null, '总开关' + (gate.enabled ? '' : '（已关，所有闹钟都不会响）')),
          ),
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '目标会话'),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', cursor: 'pointer' } },
            h('input', { type: 'checkbox', checked: showAll, onChange: (e) => setShowAll(e.target.checked) }),
            h('span', { style: dim }, '显示全部会话（包括现在没在运行的）'),
          ),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '6px' } },
            h('span', { style: Object.assign({}, dim, { flex: 1 }) }, gate.allowAll ? '现在：全部允许' : '现在：只允许勾选的'),
            h('button', { style: btn, disabled: busy, onClick: () => saveGate({ allowAll: true, sessions: [] }) }, '全部允许'),
          ),
          sessions.length === 0
            ? h('div', { style: dim }, '没有可选的会话（先打开一个，或勾上上面那项）。')
            : sessions.map((s) => h('label', {
                key: s.id,
                style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0', cursor: s.alive ? 'pointer' : 'default', opacity: s.alive ? 1 : 0.5 },
              },
                h('input', {
                  type: 'checkbox',
                  checked: allowed(s.id),
                  title: '允许这个会话使用搭话闹钟',
                  onChange: () => toggleSession(s.id),
                }),
                h('input', {
                  type: 'radio',
                  name: 'speak-clock-session',
                  checked: sessionId === s.id,
                  disabled: !s.alive || !allowed(s.id),
                  onChange: () => setSessionId(s.id),
                }),
                h('span', null, (s.title || (s.alive ? '（没起名）' : s.id.slice(0, 18) + '…')) + (s.alive ? '' : ' · 没在运行，选不了')),
              )),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '默认文案'),
          h('div', { style: dim }, gate.speakUpAvailable
            ? '约定和轻探留空时都用这句；主动搭话里配的是「' + gate.prompt + '」'
            : '主动搭话没装（或没配文案），留空就用内置那句：「' + gate.prompt + '」'),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
            h('input', {
              style: Object.assign({}, input, { flex: 1 }),
              placeholder: '留空 = 默认文案',
              value: defaultText,
              onChange: (e) => setDefaultText(e.target.value),
            }),
            h('button', { style: btn, onClick: () => saveGate({ defaultText }), disabled: busy }, '保存'),
          ),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '定一个'),
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
            h('span', null, '多久后'),
            h('input', { style: Object.assign({}, input, { width: '64px' }), value: minutes, onChange: (e) => setMinutes(e.target.value) }),
            h('span', null, '分钟'),
          ),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' } },
            h('input', {
              style: Object.assign({}, input, { flex: 1 }),
              placeholder: '到点要说的话（留空 = 默认文案）',
              value: text,
              onChange: (e) => setText(e.target.value),
            }),
            h('button', { style: btn, onClick: () => setText(gate.prompt || ''), disabled: busy || !gate.prompt }, '用默认文案'),
          ),
          h('div', { style: { marginTop: '8px', display: 'flex', gap: '8px', alignItems: 'center' } },
            h('div', { style: Object.assign({}, dim, { flex: 1 }) }, '留空则用：「' + (gate.prompt || '（默认文案为空）') + '」'),
            h('button', { style: btn, onClick: add, disabled: busy }, '添加'),
          ),
          msg ? h('div', { style: Object.assign({}, dim, { marginTop: '8px' }) }, msg) : null,
          gate.enabled ? null : h('div', { style: Object.assign({}, dim, { marginTop: '8px' }) }, '总开关关着：新闹钟会被拒绝，已定的到点也会跳过（记 blocked）。'),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '峰时 / 谷时'),
          h('div', { style: dim }, '峰时 = 周一至周五 9:00–12:00、14:00–18:00（忙）；其余全是谷时：午休 12–14、18 点至次日 9 点、周六周日全天。'),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: dim }, '峰时间隔'),
            h('input', { style: Object.assign({}, input, { width: '64px' }), value: peakMin, onChange: (e) => setPeakMin(e.target.value) }),
            h('span', { style: dim }, '~'),
            h('input', { style: Object.assign({}, input, { width: '64px' }), value: peakMax, onChange: (e) => setPeakMax(e.target.value) }),
            h('span', { style: dim }, '分钟（探得少）'),
          ),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: dim }, '谷时间隔'),
            h('input', { style: Object.assign({}, input, { width: '64px' }), value: valleyMin, onChange: (e) => setValleyMin(e.target.value) }),
            h('span', { style: dim }, '~'),
            h('input', { style: Object.assign({}, input, { width: '64px' }), value: valleyMax, onChange: (e) => setValleyMax(e.target.value) }),
            h('span', { style: dim }, '分钟（探得勤）'),
            h('button', {
              style: btn,
              disabled: busy,
              onClick: () => saveGate({
                peakMin: Number(peakMin), peakMax: Number(peakMax),
                valleyMin: Number(valleyMin), valleyMax: Number(valleyMax),
              }),
            }, '保存'),
          ),
        ),

        h('div', { style: card },
          h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '轻探'),
          h('div', { style: dim }, '没有约定闹钟时才会开；一旦定了约定闹钟，轻探自动停。每次 45–100 分钟随机，没人回就自己续。'),
          h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: dim }, '安静时段'),
            h('input', { style: Object.assign({}, input, { width: '56px' }), value: quietStart, onChange: (e) => setQuietStart(e.target.value) }),
            h('span', { style: dim }, '点到'),
            h('input', { style: Object.assign({}, input, { width: '56px' }), value: quietEnd, onChange: (e) => setQuietEnd(e.target.value) }),
            h('span', { style: dim }, '点（这个时间段不轻探；可以写 7.5 这种半点）'),
            h('button', {
              style: btn,
              disabled: busy,
              onClick: () => saveGate({ quietStart: Number(quietStart), quietEnd: Number(quietEnd) }),
            }, '保存'),
          ),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '8px', cursor: 'pointer' } },
            h('input', {
              type: 'checkbox',
              checked: gate.probeNightAlarms !== false,
              onChange: (e) => saveGate({ probeNightAlarms: e.target.checked }),
            }),
            h('span', { style: dim }, '早晚安闹钟（睡前 = 安静开始前 15 分，早上 = 安静结束后 5 分；都是真正的约定闹钟，会出现在列表里）'),
          ),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
            h('input', {
              style: Object.assign({}, input, { flex: 1 }),
              placeholder: '轻探要说的话（留空 = 默认文案）',
              value: probeText,
              onChange: (e) => setProbeText(e.target.value),
            }),
            h('button', { style: btn, onClick: () => setProbeText(gate.prompt || ''), disabled: busy || !gate.prompt }, '用默认文案'),
          ),
          h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
            h('span', { style: Object.assign({}, dim, { flex: 1 }) },
              probeFor
                ? '在走：' + leftText(probeFor.at) + ' 后（' + fmtTime(probeFor.at) + '）'
                : fixedFor
                  ? '当前会话有约定闹钟，轻探不可用'
                  : '现在没有轻探'),
            probeFor
              ? h('button', { style: btn, onClick: () => probeAction(true), disabled: busy }, '停掉')
              : h('button', { style: btn, onClick: () => probeAction(false), disabled: busy || !sessionId || Boolean(fixedFor) }, '开一条'),
          ),
        ),

        h('div', { style: card },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px', flexWrap: 'wrap' } },
            h('span', { style: { fontWeight: 600 } }, '在等的（' + shownPending.length + '）'),
            h('select', {
              style: Object.assign({}, input, { padding: '2px 6px' }),
              value: filterSession,
              onChange: (e) => setFilterSession(e.target.value),
            },
              h('option', { value: '' }, '全部会话'),
              sessions.map((s) => h('option', { key: s.id, value: s.id }, s.title || String(s.id).slice(0, 12) + '…')),
            ),
          ),
          shownPending.length === 0
            ? h('div', { style: dim }, pending.length ? '这个会话没有在等的闹钟。' : '没有在等的闹钟。')
            : shownPending.map((e) => h('div', { key: e.id, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' } },
                h('span', { style: { fontVariantNumeric: 'tabular-nums', opacity: 0.7 } }, leftText(e.at)),
                h('span', { style: { fontSize: '11px', padding: '0 5px', borderRadius: '6px', border: '1px solid currentColor', opacity: 0.7 } }, e.probe !== undefined ? '轻探' : '约定'),
                h('span', { style: { fontSize: '11px', padding: '0 5px', borderRadius: '6px', background: 'rgba(128,128,128,.18)' } }, titleOf(e.sessionId)),
                h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                  (e.text || '') + ' · ' + fmtTime(e.at)),
                h('button', { style: btn, onClick: () => cancel(e.id), disabled: busy }, '取消'),
              )),
        ),

        others.length
          ? h('div', { style: card },
              h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '最近的结果'),
              others.slice(0, 6).map((e) => h('div', { key: e.id, style: Object.assign({}, dim, { padding: '2px 0' }) },
                fmtTime(e.at) + ' ｜ ' + e.state + (e.note ? ' ｜ ' + e.note : '') + ' ｜ ' + (e.text || ''),
              )),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.session.header.actions', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.actions', id: 'speak-clock-countdown', order: 45 },
            Countdown,
          ),
        )
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'speak-clock', order: 56, label: () => '搭话闹钟' },
            Settings,
          ),
        )
      },
    }
  },
})
