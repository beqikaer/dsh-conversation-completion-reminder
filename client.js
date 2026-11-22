/**
 * Browser half of the completion notifier.
 *
 * This file is loaded by the Host's client-module carrier, not by Node: it is a
 * plain CJS factory handed to `window.__ModuleLoader__.load`, so it must not use
 * ESM syntax and must not import anything but `react`.
 *
 * What it renders: the configure page of our own row in the Plugins page. The
 * Host owns the form (schema validation, conflict detection, persistence into the
 * profile patch), so this file only draws controls and forwards edits through
 * `form.mutate` — it never writes the patch file itself.
 *
 * Two shapes of form arrive here:
 *  - normally the Host injects `props.form` because the row id (`completion-notifier`)
 *    is the same string as our settings namespace;
 *  - if it does not, we fetch the form from the `configForms` service instead of
 *    declaring it in `inject`, because a missing service in an older Host would
 *    leave this whole plugin pending and freeze the GUI.
 */
window.__ModuleLoader__.load({
  id: 'dsh-conversation-completion-reminder',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports

    const React = require('react')

    /** Settings namespace, which must stay equal to the patch row id. */
    const NS = 'completion-notifier'

    const h = React.createElement

    /**
     * Page-local diagnostics. The settings block is registered from inside the
     * browser, where nothing the model can read records a failure, so each stage
     * leaves one line in localStorage. `dsh-app://` pages may deny storage; a
     * denied write must never break the plugin.
     */
    /**
     * Resolve a service without tripping Cordis' injected-proxy guard. A plain
     * `ctx.locale` read throws `cannot get property "locale" without inject`
     * when the service is not in the plugin's `inject` list, and a throw inside
     * `apply` makes the whole boot entry inactive — which is exactly how the
     * settings block disappeared. `ctx.get()` is the non-throwing lookup; the
     * property read stays as a last resort.
     */
    const serviceOf = (target, name) => {
      try {
        const viaGet = target && typeof target.get === 'function' ? target.get(name) : undefined
        if (viaGet) return viaGet
      } catch {}
      try {
        return target ? target[name] : undefined
      } catch {
        return undefined
      }
    }

    const cnDiag = (payload) => {
      try {
        const store = globalThis.localStorage
        if (!store) return
        const key = 'completion-notifier:diag'
        let previous = {}
        try {
          const raw = store.getItem(key)
          const parsed = raw ? JSON.parse(raw) : undefined
          if (parsed && typeof parsed === 'object') previous = parsed
        } catch {}
        store.setItem(key, JSON.stringify({ ...previous, ...payload, at: new Date().toISOString() }))
      } catch {}
    }

    const bool = (key, label, hint) => ({ key, label, hint, kind: 'boolean' })
    const text = (key, label, hint, placeholder) => ({ key, label, hint, kind: 'string', placeholder })
    const num = (key, label, hint) => ({ key, label, hint, kind: 'number' })
    const list = (key, label, hint, placeholder) => ({ key, label, hint, placeholder, kind: 'list' })

    /**
     * The page, top to bottom. Order is the order of the questions a person
     * actually asks: is it on, where does it go, what does it say, how much of
     * the answer is worth sending.
     */
    const SECTIONS = [
      {
        title: '开关',
        fields: [
          bool('enabled', '启用推送', '关掉后不再推送任何对话。'),
          bool('attachFiles', '附带文件本体', '除了卡片，还把产物文件本身发过去。'),
        ],
      },
      {
        title: '飞书',
        fields: [
          bool('weixinEnabled', '同时推送到微信', '关掉则只走飞书。'),
          text('botId', '机器人 Bot ID', '留空自动发现本机已接入的机器人。', 'bot_xxx'),
          text('openId', '接收人 Open ID', '留空自动使用该机器人的所有者。', 'ou_xxx'),
          text('targetId', '投递目标 ID', '一般不用改。', 'tgt_completion_notifier'),
          {
            key: 'format',
            label: '消息格式',
            hint: 'markdown 是飞书卡片，plain 是纯文本。',
            kind: 'select',
            options: [
              ['markdown', 'markdown 卡片'],
              ['plain', '纯文本'],
            ],
          },
        ],
      },
      {
        title: '微信',
        fields: [
          text('weixinBotId', '微信 Bot ID', '留空自动发现。', 'wx_xxx'),
          text('weixinToUserId', '微信接收人', '留空自动使用账号所有者。', 'xxx@im.wechat'),
          {
            key: 'weixinFormat',
            label: '消息格式',
            hint: '微信不支持卡片，plain 用【】加粗并自动转 CRLF。',
            kind: 'select',
            options: [
              ['plain', '纯文本'],
              ['markdown', 'markdown'],
            ],
          },
        ],
      },
      {
        title: '卡片内容',
        fields: [
          text('cardTitle', '卡片标题', '每张卡片顶部显示的名字。'),
          num('maxTaskChars', '任务原文上限', '字符数，超出截断。'),
          num('maxAnswerChars', '结果上限', '字符数，超出截断。'),
          num('maxArtifacts', '最多列几个产物', ''),
          num('maxAttachments', '最多发几个文件', '与上面的列表相互独立。'),
          num('maxAttachBytes', '单个文件上限（字节）', '超过则只留路径不发文件。'),
          list('attachTypes', '允许发送的文件类型', '逗号分隔的扩展名，留空表示不限制。不在列表里的产物只留在卡片路径中。', 'png, jpg, pdf, zip'),
        ],
      },
      {
        title: '推送时机',
        fields: [
          bool('skipSubagents', '跳过子代理', '子代理的轮次通常不值得单独通知。'),
          bool('skipSameChannel', '同通道不回声', '从飞书来的对话不再推回同一个飞书聊天。'),
          bool('skipImSessions', '跳过所有 IM 会话', '打开后连跨通道转发也停止。'),
          num('titleWaitMs', '等待会话名的间隔（毫秒）', '新会话的名字要等模型写完才有。'),
          num('titleWaitSteps', '最大等待次数', '间隔 × 次数 = 最长等待时间。'),
        ],
      },
    ]

    const ALL_FIELDS = SECTIONS.reduce((all, section) => all.concat(section.fields), [])

    /** Split a typed extension list into normalized, de-duplicated entries. */
    const parseList = (raw) => {
      const seen = new Set()
      const items = String(raw == null ? '' : raw)
        .split(/[,，;；\s]+/)
        .map((entry) => entry.trim().replace(/^\.+/, '').toLowerCase())
        .filter(Boolean)
      for (const item of items) seen.add(item)
      return Array.from(seen)
    }

    /** Render a stored array back into the single line the field edits. */
    const formatList = (value) => {
      if (Array.isArray(value)) return value.join(', ')
      return value == null ? '' : String(value)
    }

    /** Equality that also works for the array-valued fields. */
    const sameValue = (a, b) => {
      if (Array.isArray(a) || Array.isArray(b)) {
        return JSON.stringify(Array.isArray(a) ? a : [a]) === JSON.stringify(Array.isArray(b) ? b : [b])
      }
      return a === b
    }

    /** Decode one draft string back into the type the schema expects. */
    const coerce = (field, raw) => {
      if (field.kind === 'boolean') return raw === true
      if (field.kind === 'number') {
        const n = Number(raw)
        return Number.isFinite(n) ? n : 0
      }
      if (field.kind === 'list') return parseList(raw)
      return raw == null ? '' : String(raw)
    }

    /** Current saved value of one field, tolerating older Hosts without a base. */
    const valueOf = (state, field) => {
      const bag = state && typeof state === 'object' ? state : {}
      const sources = [bag.value, bag.base, bag.user]
      for (const source of sources) {
        if (source && typeof source === 'object' && source[field.key] !== undefined) {
          return source[field.key]
        }
      }
      return field.kind === 'boolean' ? false : ''
    }

    /**
     * Resolve the form to draw. `props.form` is the normal path; otherwise we
     * borrow the shared `configForms` service and subscribe to it ourselves.
     */
    const useFormSource = (props, ctx) => {
      const injected = props && props.form ? props.form : undefined
      const [tick, setTick] = React.useState(0)
      const controller = React.useMemo(() => {
        if (injected) return null
        const service = serviceOf(ctx, 'configForms')
        if (!service || typeof service.get !== 'function') return null
        try {
          return service.get(NS)
        } catch {
          return null
        }
      }, [injected, ctx])

      // Subscribe once per controller. `tick` is the state being bumped, so it
      // must not appear here — depending on it would resubscribe on every event.
      React.useEffect(() => {
        if (!controller || typeof controller.subscribe !== 'function') return undefined
        const off = controller.subscribe(() => setTick((value) => value + 1))
        if (typeof off === 'function') return off
        if (off && typeof off.dispose === 'function') return () => off.dispose()
        return undefined
      }, [controller])

      if (injected) return { state: injected.state, mutate: injected.mutate, source: 'host' }
      if (!controller) return { state: undefined, mutate: undefined, source: 'none' }
      const state = typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : undefined
      return { state, mutate: (ops, revision) => controller.mutate(ops, revision), source: 'service' }
    }

    const styles = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '2px 0 0' },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: '16px',
        padding: '16px 18px 18px',
        borderRadius: '12px',
        border: '1px solid rgba(127,127,127,0.16)',
        background: 'rgba(127,127,127,0.05)',
      },
      cardHead: { display: 'flex', alignItems: 'center', gap: '8px' },
      dot: { width: '6px', height: '6px', borderRadius: '999px', background: 'rgb(64,128,255)', flex: '0 0 auto' },
      sectionTitle: { fontSize: '12px', fontWeight: 600, letterSpacing: '0.6px', opacity: 0.72 },
      row: { display: 'flex', flexDirection: 'column', gap: '6px' },
      rowInline: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px', minHeight: '24px' },
      textCol: { display: 'flex', flexDirection: 'column', gap: '2px', minWidth: 0 },
      label: { fontSize: '13px', lineHeight: '20px', fontWeight: 500 },
      hint: { fontSize: '11px', lineHeight: '16px', opacity: 0.55 },
      input: {
        fontSize: '13px',
        lineHeight: '18px',
        padding: '7px 10px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'rgba(127,127,127,0.07)',
        color: 'inherit',
        width: '100%',
        maxWidth: '520px',
        boxSizing: 'border-box',
        outline: 'none',
      },
      inputNarrow: { maxWidth: '180px' },
      chips: { display: 'flex', flexWrap: 'wrap', gap: '6px', paddingTop: '2px' },
      chip: {
        fontSize: '11px',
        lineHeight: '18px',
        padding: '0 8px',
        borderRadius: '999px',
        background: 'rgba(64,128,255,0.12)',
        color: 'rgb(90,140,245)',
        whiteSpace: 'nowrap',
      },
      actions: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap', paddingTop: '2px' },
      button: {
        fontSize: '13px',
        lineHeight: '18px',
        padding: '7px 16px',
        borderRadius: '8px',
        border: '1px solid rgba(127,127,127,0.28)',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      primary: { borderColor: 'rgb(64,128,255)', background: 'rgb(64,128,255)', color: '#fff', fontWeight: 500 },
      disabled: { opacity: 0.45, cursor: 'default' },
      note: { fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
      error: { fontSize: '12px', lineHeight: '18px', color: 'rgb(226,88,88)' },
      toolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      toolbarText: { fontSize: '12px', lineHeight: '18px', opacity: 0.6 },
      layout: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', gap: '18px' },
      main: { flex: '1 1 520px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '12px' },
      aside: { flex: '1 1 300px', maxWidth: '340px', minWidth: '264px' },
      helpCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: '8px',
        padding: '14px 16px 16px',
        borderRadius: '12px',
        border: '1px solid rgba(64,128,255,0.28)',
        background: 'rgba(64,128,255,0.06)',
      },
      helpTitle: { fontSize: '12px', lineHeight: '18px', fontWeight: 600, letterSpacing: '0.4px' },
      helpLead: { fontSize: '12px', lineHeight: '19px', opacity: 0.7 },
      helpBlock: {
        display: 'flex',
        flexDirection: 'column',
        gap: '5px',
        paddingTop: '9px',
        borderTop: '1px solid rgba(127,127,127,0.16)',
      },
      helpName: { fontSize: '12px', lineHeight: '18px', fontWeight: 600 },
      helpText: { fontSize: '11.5px', lineHeight: '18px', opacity: 0.62 },
      copyLine: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' },
      code: {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        fontSize: '11px',
        lineHeight: '17px',
        padding: '1px 5px',
        borderRadius: '5px',
        background: 'rgba(127,127,127,0.16)',
        wordBreak: 'break-all',
      },
      linkBtn: {
        fontSize: '12px',
        lineHeight: '18px',
        padding: '4px 10px',
        borderRadius: '999px',
        border: '1px solid rgba(64,128,255,0.5)',
        background: 'transparent',
        color: 'rgb(90,140,245)',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      switchTrack: (on, disabled) => ({
        position: 'relative',
        width: '38px',
        height: '22px',
        flex: '0 0 auto',
        padding: 0,
        borderRadius: '999px',
        border: 'none',
        background: on ? 'rgb(64,128,255)' : 'rgba(127,127,127,0.3)',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.6 : 1,
        transition: 'background 140ms ease',
      }),
      switchKnob: (on) => ({
        position: 'absolute',
        top: '2px',
        left: on ? '18px' : '2px',
        width: '18px',
        height: '18px',
        borderRadius: '999px',
        background: '#fff',
        boxShadow: '0 1px 2px rgba(0,0,0,0.28)',
        transition: 'left 140ms ease',
      }),
    }

    /** One switch, drawn by hand so the page matches the rest of the shell. */
    const Switch = (props) => {
      const on = props.checked === true
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': props.label,
          disabled: props.disabled,
          onClick: () => props.onChange(!on),
          style: styles.switchTrack(on, props.disabled),
        },
        h('span', { style: styles.switchKnob(on) }),
      )
    }

    const Field = (props) => {
      const { field, draft, disabled, onChange } = props

      if (field.kind === 'boolean') {
        return h(
          'div',
          { style: styles.rowInline },
          h(
            'div',
            { style: styles.textCol },
            h('span', { style: styles.label }, field.label),
            field.hint ? h('span', { style: styles.hint }, field.hint) : null,
          ),
          h(Switch, { checked: draft === true, disabled: disabled, label: field.label, onChange: onChange }),
        )
      }

      const common = { style: styles.input, disabled: disabled, value: draft == null ? '' : draft }
      let control
      if (field.kind === 'select') {
        control = h(
          'select',
          { ...common, onChange: (event) => onChange(event.target.value) },
          field.options.map(([value, label]) => h('option', { key: value, value }, label)),
        )
      } else if (field.kind === 'number') {
        control = h('input', {
          ...common,
          style: { ...styles.input, ...styles.inputNarrow },
          type: 'number',
          inputMode: 'numeric',
          onChange: (event) => onChange(event.target.value),
        })
      } else {
        control = h('input', {
          ...common,
          type: 'text',
          placeholder: field.placeholder,
          spellCheck: false,
          onChange: (event) => onChange(event.target.value),
        })
      }

      const parsed = field.kind === 'list' ? parseList(draft) : null

      return h(
        'div',
        { style: styles.row },
        h('label', { style: styles.label }, field.label),
        control,
        parsed && parsed.length > 0
          ? h(
              'div',
              { style: styles.chips },
              parsed.map((item) => h('span', { key: item, style: styles.chip }, `.${item}`)),
            )
          : null,
        field.hint ? h('span', { style: styles.hint }, field.hint) : null,
      )
    }

    /** Inline monospace token, used for field paths and ids. */
    const code = (text) => h('span', { style: styles.code }, text)

    /** A path the reader will want in their clipboard rather than in their eyes. */
    const CopyChip = (props) => {
      const [done, setDone] = React.useState(false)
      const copy = () => {
        const finish = () => {
          setDone(true)
          try {
            setTimeout(() => setDone(false), 1400)
          } catch {
            /* no timer, the label simply stays */
          }
        }
        const nav = typeof navigator === 'undefined' ? undefined : navigator
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          Promise.resolve(nav.clipboard.writeText(props.text)).then(finish).catch(() => {})
          return
        }
        try {
          const area = document.createElement('textarea')
          area.value = props.text
          area.setAttribute('readonly', 'readonly')
          area.style.position = 'fixed'
          area.style.opacity = '0'
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          document.body.removeChild(area)
          finish()
        } catch {
          /* clipboard blocked: the path is still readable above */
        }
      }
      return h(
        'button',
        { type: 'button', style: styles.linkBtn, onClick: copy, title: '点击复制' },
        done ? '已复制' : props.label || '复制',
      )
    }

    /**
     * Where the ids come from. Everything here mirrors the resolution order in
     * `index.js` (`resolveRoutes`), so the page and the Host cannot drift into
     * "fill this in" advice the Host does not actually follow.
     */
    const HelpPanel = () => {
      const feishuFile = '%USERPROFILE%\\.dsh\\integrations\\dsh-feishu\\config.json'
      const weixinFile = '%USERPROFILE%\\.dsh\\integrations\\dsh-weixin\\config.json'
      return h(
        'aside',
        { style: styles.aside },
        h(
          'div',
          { style: styles.helpCard },
          h('div', { style: styles.helpTitle }, '这些 ID 从哪来'),
          h(
            'div',
            { style: styles.helpLead },
            '四个账号字段都可以留空：插件挂载时先问 DSH 已加载的机器人，再回落到集成配置文件里的第一条，机器人和接收人取自同一条。',
          ),
          h(
            'div',
            { style: styles.helpBlock },
            h('div', { style: styles.helpName }, '飞书'),
            h(
              'div',
              { style: styles.copyLine },
              code(feishuFile),
              h(CopyChip, { text: feishuFile, label: '复制路径' }),
            ),
            h('div', { style: styles.helpText }, code('bots[0].id'), ' → 机器人 Bot ID，形如 ', code('bot_7eac…')),
            h('div', { style: styles.helpText }, code('bots[0].ownerOpenIds[0]'), ' → 接收人 Open ID，形如 ', code('ou_046b…')),
            h(
              'div',
              { style: styles.helpText },
              'open_id 是「这个飞书应用眼里的某个人」：同一个人换一个应用就是另一个 ',
              code('ou_…'),
              '。要拿别人的，让 TA 给这个机器人发一句话，DSH 会记进 ',
              code('bots\\<id>\\state.json'),
              ' 的 ',
              code('p2p:ou_…'),
              '；已有会话的人，值就在那份 state.json 里。',
            ),
          ),
          h(
            'div',
            { style: styles.helpBlock },
            h('div', { style: styles.helpName }, '微信'),
            h(
              'div',
              { style: styles.copyLine },
              code(weixinFile),
              h(CopyChip, { text: weixinFile, label: '复制路径' }),
            ),
            h('div', { style: styles.helpText }, code('accounts[0].botId'), ' → 微信 Bot ID，形如 ', code('wx_eb63…')),
            h('div', { style: styles.helpText }, code('accounts[0].ownerUserId'), ' → 接收人，形如 ', code('o9cq…@im.wechat')),
          ),
          h(
            'div',
            { style: styles.helpBlock },
            h('div', { style: styles.helpName }, '投递目标 ID'),
            h(
              'div',
              { style: styles.helpText },
              '只是本插件给这个聊天起的固定别名，默认 ',
              code('tgt_completion_notifier'),
              ' / ',
              code('tgt_completion_notifier_wx'),
              '，建过一次就一直复用，不用改。',
            ),
          ),
          h(
            'div',
            { style: styles.helpBlock },
            h('div', { style: styles.helpName }, '想确认解析成了什么'),
            h(
              'div',
              { style: styles.helpText },
              '看日志 ',
              code('%USERPROFILE%\\.dsh\\completion-notifier.log'),
              ' 里的 ',
              code('routes: feishu=… → …, weixin=… → …'),
              ' 一行，那就是本轮真正使用的机器人、接收人和目标。',
            ),
          ),
          h(
            'div',
            { style: styles.helpBlock },
            h('div', { style: styles.helpName }, '什么时候必须手填'),
            h(
              'div',
              { style: styles.helpText },
              '同一通道挂了多个机器人、而你要用不是第一个的那个：显式写 ',
              code('botId'),
              ' / ',
              code('weixinBotId'),
              '。要推给不是账号主人的那位：显式写 ',
              code('openId'),
              ' / ',
              code('weixinToUserId'),
              '。',
            ),
          ),
        ),
      )
    }

    const ConfigPage = (props) => {
      const ctx = props.ctx
      const { state, mutate, source } = useFormSource(props, ctx)
      const baseValue = React.useMemo(() => {
        const bag = {}
        for (const field of ALL_FIELDS) {
          const value = valueOf(state, field)
          bag[field.key] = field.kind === 'list' ? formatList(value) : value
        }
        return bag
      }, [state])

      const [draft, setDraft] = React.useState(baseValue)
      const [busy, setBusy] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      // Declared with the other hooks: the page returns early while the form is
      // still missing, and a hook after those returns would change call order.
      const [helpOpen, setHelpOpen] = React.useState(true)

      // A saved revision replaces the draft; without this an outside edit would
      // leave stale text in the form that the next save would write back.
      const revision = state ? state.revision : undefined
      React.useEffect(() => {
        setDraft(baseValue)
        setMessage(null)
        setFailure(null)
      }, [revision])

      const editable = Boolean(mutate) && state && state.status === 'ready' && state.writable !== false

      const setField = (key) => (value) => {
        setDraft((current) => ({ ...current, [key]: value }))
        setMessage(null)
        setFailure(null)
      }

      const dirtyOps = React.useMemo(() => {
        const ops = []
        for (const field of ALL_FIELDS) {
          const next = coerce(field, draft[field.key])
          const current = coerce(field, baseValue[field.key])
          if (sameValue(next, current)) continue
          ops.push({ op: 'set', path: [field.key], value: next })
        }
        return ops
      }, [draft, baseValue])

      const save = async () => {
        if (!mutate || dirtyOps.length === 0) return
        setBusy(true)
        setFailure(null)
        try {
          await mutate(dirtyOps, revision)
          setMessage(`已保存 ${dirtyOps.length} 项`)
          setDraft(baseValue)
        } catch (error) {
          setFailure(error && error.message ? error.message : String(error))
        } finally {
          setBusy(false)
        }
      }

      const discard = () => {
        setDraft(baseValue)
        setMessage(null)
        setFailure(null)
      }

      if (!state) {
        return h(
          'div',
          { style: styles.note },
          source === 'none'
            ? '宿主的配置服务不可用，这个页面暂时无法编辑配置。'
            : '正在读取配置…',
        )
      }

      if (state.status === 'loading') return h('div', { style: styles.note }, '正在读取配置…')
      if (state.status === 'unavailable') {
        return h('div', { style: styles.note }, '这个插件当前没有可写的配置项。')
      }

      const dirtyCount = dirtyOps.length
      const saveDisabled = dirtyCount === 0 || busy || !editable

      const cards = SECTIONS.map((section) =>
        h(
          'section',
          { key: section.title, style: styles.card },
          h(
            'div',
            { style: styles.cardHead },
            h('span', { style: styles.dot }),
            h('span', { style: styles.sectionTitle }, section.title),
          ),
          section.fields.map((field) =>
            h(Field, {
              key: field.key,
              field: field,
              draft: draft[field.key],
              disabled: !editable || busy,
              onChange: setField(field.key),
            }),
          ),
        ),
      )

      const actions = h(
        'div',
        { style: styles.actions },
        h(
          'button',
          {
            type: 'button',
            style: saveDisabled
              ? { ...styles.button, ...styles.primary, ...styles.disabled }
              : { ...styles.button, ...styles.primary },
            disabled: saveDisabled,
            onClick: save,
          },
          busy ? '保存中…' : dirtyCount > 0 ? `保存 ${dirtyCount} 项修改` : '保存',
        ),
        h(
          'button',
          {
            type: 'button',
            style: dirtyCount === 0 || busy ? { ...styles.button, ...styles.disabled } : styles.button,
            disabled: dirtyCount === 0 || busy,
            onClick: discard,
          },
          '撤销',
        ),
        message ? h('span', { style: styles.note }, message) : null,
        failure ? h('span', { style: styles.error }, failure) : null,
      )

      return h(
        'div',
        { style: styles.wrap },
        h(
          'div',
          { style: styles.toolbar },
          h(
            'span',
            { style: styles.toolbarText },
            '账号字段留空会自动发现；想手动填，旁边写着每个 ID 去哪找。',
          ),
          h(
            'button',
            { type: 'button', style: styles.linkBtn, onClick: () => setHelpOpen((open) => !open) },
            helpOpen ? '收起 ID 说明' : '怎么拿到这些 ID？',
          ),
        ),
        h(
          'div',
          { style: styles.layout },
          h(
            'div',
            { style: styles.main },
            cards,
            actions,
            h(
              'div',
              { style: styles.note },
              '保存后立即生效：下一轮对话就按新配置推送，不用重启，也不会丢掉已建立的投递目标。',
            ),
          ),
          helpOpen ? h(HelpPanel) : null,
        ),
      )
    }

    /** The one-line form the Host uses when a page description is missing. */
    const ConfigSummary = (props) => {
      const { state } = useFormSource(props, props.ctx)
      if (!state || state.status !== 'ready') return h('span', null, '对话完成提醒')
      const on = valueOf(state, ALL_FIELDS[0]) !== false
      const weixin = valueOf(state, ALL_FIELDS.find((field) => field.key === 'weixinEnabled')) !== false
      return h('span', null, `${on ? '已开启' : '已关闭'} · 飞书${weixin ? ' + 微信' : ''}`)
    }

    /**
     * Slot components receive only the owner props, never the plugin context, so
     * the context is handed in explicitly by `apply`. Without it the page could
     * not fall back to `configForms` when the Host does not inject a form.
     */
    const Entry = (props) => {
      if (props.view === 'summary') return h(ConfigSummary, props)
      return h(ConfigPage, props)
    }

    /**
     * `plugins.row.config` is keyed by `<package>#<row id>`; our row id and our
     * settings namespace are the same string, which is what lets the Host hand us
     * a form at all.
     */
    const ROW_KEY = 'dsh-conversation-completion-reminder#completion-notifier'

    const install = (ctx) => {
      const slots = serviceOf(ctx, 'slots')
      cnDiag({ phase: 'install', slots: typeof slots, locale: typeof serviceOf(ctx, 'locale'), configForms: typeof serviceOf(ctx, 'configForms') })
      if (!slots || typeof slots.inject !== 'function') return

      // The settings menu needs a display label. Registering a one-namespace
      // dictionary under our package name is what lets us call
      // `ctx.locale.bind(...)` without inventing a locale service name.
      const locale = serviceOf(ctx, 'locale')
      const t = locale && typeof locale.bind === 'function' ? locale.bind('dsh-conversation-completion-reminder') : (key) => key
      if (locale && typeof locale.register === 'function') {
        ctx.effect(
          () =>
            locale.register('dsh-conversation-completion-reminder', {
              zh: {
                nav: '对话完成提醒',
                connecting: '正在检测配置服务…',
                unavailable: '宿主的配置服务不可用，这个页面暂时无法编辑配置。',
                embedded: '在插件页里配置',
              },
              en: {
                nav: 'Completion Notifier',
                connecting: 'Detecting configuration service…',
                unavailable: 'The host configuration service is unavailable, so this page cannot edit settings.',
                embedded: 'Configure on the plugins page',
              },
            }),
          'completion-notifier: locale dictionaries',
        )
      }

      // Bind the context into the component: the slot owner hands us only
      // `{view, form}`, so the fallback path needs `ctx` from here.
      const ConfigureEntry = (props) => Entry({ ...props, ctx })

      // The same React page can serve three mounts with one `ConfigPage` source:
      //  1. the plugins row's configure page (handed a live `form` by the host),
      //  2. the settings section summary line (host fills it in),
      //  3. this settings section body (fetches its own form from `configForms`).
      //
      // `ConfigPage` already resolves its own source: `props.form` when the Host
      // injects one, otherwise the shared `configForms` controller, which it
      // subscribes to and re-reads on every change. Probing that controller once
      // at mount and falling through to a "service unavailable" note turned a
      // normal race (the describe mirror arriving after first paint) into a dead
      // end, so the body renders the page directly and lets the subscription
      // fill the five groups in.
      const SettingsPanel = () => {
        // One delayed probe records what `configForms` actually hands back, so a
        // panel that stays on "reading" leaves a reason instead of a blank.
        React.useEffect(() => {
          const timer = setTimeout(() => {
            const service = serviceOf(ctx, 'configForms')
            let status = 'no-service'
            try {
              const controller = service && typeof service.get === 'function' ? service.get(NS) : undefined
              const snapshot = controller && typeof controller.getSnapshot === 'function' ? controller.getSnapshot() : undefined
              if (!controller) status = 'no-controller'
              else if (!snapshot) status = 'no-snapshot'
              else status = `state:${snapshot.status || 'unknown'}`
            } catch (error) {
              status = `probe-error:${(error && error.message) || error}`
            }
            cnDiag({ phase: 'panel', status, service: typeof service })
          }, 1500)
          return () => clearTimeout(timer)
        }, [])
        return h(ConfigPage, { ctx })
      }

      ctx.effect(
        () =>
          slots.inject('settings.section', () => {
            const off = slots.register(
              {
                name: 'settings.section',
                id: 'completion-notifier',
                order: 90,
                label: () => t('nav'),
                locale: 'dsh-conversation-completion-reminder',
              },
              SettingsPanel,
            )
            cnDiag({
              phase: 'section-registered',
              disposer: typeof off,
              label: (() => {
                try {
                  return String(t('nav'))
                } catch (error) {
                  return `label-error:${(error && error.message) || error}`
                }
              })(),
            })
            return off
          }),
        'completion-notifier: settings section',
      )

      ctx.effect(
        () =>
          slots.inject('plugins.row.config', () =>
            slots.register(
              {
                name: 'plugins.row.config',
                key: ROW_KEY,
                locale: 'dsh-conversation-completion-reminder',
              },
              ConfigureEntry,
            ),
          ),
        'completion-notifier: configure page',
      )
    }

    /**
     * A rejection inside `install` is invisible from the page: the boot entry
     * stays inactive and the settings block simply never appears. Copying the
     * message into the page-local diagnostic keeps the next investigation to a
     * single file instead of another renderer-cache dig.
     */
    const apply = (ctx) => {
      try {
        install(ctx)
        cnDiag({ phase: 'applied' })
      } catch (error) {
        cnDiag({ phase: 'apply-error', message: String((error && error.stack) || error) })
        throw error
      }
    }
    exports.name = 'dsh-conversation-completion-reminder'
    exports.apply = apply
    exports.inject = ['slots', 'locale']

    return module.exports
  },
})
