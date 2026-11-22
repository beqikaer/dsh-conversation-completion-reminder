/**
 * completion-notifier — host half.
 *
 * Watches every Session in this Host and, the moment a Turn ends, pushes one
 * compact Feishu card describing what that conversation produced: the task, the
 * answer summary, and every artifact path the turn mentioned or wrote.
 *
 * Why a plugin instead of a scheduled scan: `turn/end` is a durable Session
 * event, so notification is event-driven and immediate; and it travels through
 * `ctx.dshIm.send()` (proactive delivery) instead of the model's final reply.
 * The old polling design had to spend a model turn just to notice work, and it
 * inherited dsh-im's session-sync echo — every scan answer was delivered back
 * into the chat, which is what flooded the conversation.
 *
 * @module dsh-conversation-completion-reminder
 */

/**
 * Nothing here is tied to one machine or one account.
 *
 * A channel is described by three things only — which bot carries it, who
 * receives it, and under which target key — and all three are configurable. Left
 * empty, each is discovered at mount: the bot from `ctx.dshIm.listBots()`, the
 * recipient from that bot's own integration config (its owner id), so the same
 * bundle works on a fresh profile without editing source.
 */

/** Stable delivery-target keys; created on demand, reused afterwards. */
const DEFAULT_TARGET_ID = 'tgt_completion_notifier'
const DEFAULT_WEIXIN_TARGET_ID = 'tgt_completion_notifier_wx'

/** Where the per-channel account files live, relative to DSH_HOME. */
const FEISHU_CONFIG = 'integrations\\dsh-feishu\\config.json'
const WEIXIN_CONFIG = 'integrations\\dsh-weixin\\config.json'

/** Every card wears this name by default, so the source of a notification is never a guess. */
const DEFAULT_CARD_TITLE = '信息提醒'

/** Tools whose arguments name a file the turn actually wrote. */
const WRITE_TOOLS = new Set([
  'write', 'edit', 'apply_patch', 'notebook_edit', 'create_file', 'str_replace_editor',
])

/** Extensions that make a bare path interesting enough to report. */
const ARTIFACT_EXT = /\.(?:md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|xlsx?|docx?|pptx?|pdf|zip|7z|rar|csv|tsv|png|jpe?g|gif|webp|svg|exe|msi|log|py|ps1|bat|sh|html?|css|ya?ml|toml|sql|php|ini|conf|db|sqlite)$/i

/** Absolute Windows (or UNC) path. */
const WIN_PATH = /(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`<>|?*\r\n]+/g

/**
 * Quoted span. Windows paths routinely contain spaces ("D:\Program Files\…"), so
 * the unquoted matcher stops at the first space and yields half a path; anything
 * the turn wrapped in backticks or quotes is read whole instead.
 */
const QUOTED_SPAN = /[`"]([^`"\r\n]{4,300})[`"]/g

/** Bare path-like token that still carries a known artifact extension. */
const REL_PATH = /\b[\w.~$@\-]+(?:[\\/][\w.~$@\-]+)*\.(?:md|txt|json|jsonl|js|mjs|cjs|ts|tsx|jsx|xlsx?|docx?|pptx?|pdf|zip|7z|rar|csv|tsv|png|jpe?g|gif|webp|svg|exe|msi|log|py|ps1|bat|sh|html?|css|ya?ml|toml|sql|php|ini|conf|db|sqlite)\b/gi

/** Resolved options; every field has a safe default so the bundle runs unconfigured. */
const DEFAULTS = Object.freeze({
  enabled: true,
  cardTitle: DEFAULT_CARD_TITLE,
  // Empty means "discover it": the bot from listBots(), the recipient from that
  // bot's integration config. Filling these in pins one specific chat instead.
  botId: '',
  openId: '',
  targetId: DEFAULT_TARGET_ID,
  format: 'markdown',
  weixinEnabled: true,
  weixinBotId: '',
  weixinToUserId: '',
  weixinTargetId: DEFAULT_WEIXIN_TARGET_ID,
  weixinFormat: 'plain',
  // The task is shown whole by default: "内容为任务完整点" — a clipped instruction
  // is what made the old card ambiguous.
  maxTaskChars: 2000,
  maxAnswerChars: 1200,
  maxArtifacts: 12,
  // Attach the artifacts themselves, not just their paths: one tap beats typing a
  // path into Explorer. Text-only stays available because a channel the reader
  // does not control may refuse files.
  attachFiles: true,
  // Per-run cap: a turn that wrote 40 frames must not become 40 uploads.
  maxAttachments: 5,
  // Which artifact extensions may be uploaded. An empty list means "no
  // filtering": a turn that produced .py or .mp4 files still sends them.
  attachTypes: [
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
    'pdf', 'txt', 'md', 'csv', 'json', 'yaml', 'yml', 'log',
    'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'zip', '7z', 'tar', 'gz',
  ],
  // Uploading is not free; anything above this is reported by path only.
  maxAttachBytes: 20 * 1024 * 1024,
  // A short wait, not a long one: measurement showed the title lands on the order
  // of a minute after the first turn ends (it is a writing turn of its own), so
  // polling longer would only delay the card. The task's first line is the
  // stand-in until the name exists — see renderCard's 会话 line.
  titleWaitMs: 400,
  titleWaitSteps: 3,
  skipSubagents: true,
  // Never report a conversation back into the very chat that just spoke: that
  // chat already shows the answer, so the card would be a duplicate.
  skipSameChannel: true,
  // Opt-in: drop every IM-originated conversation, whatever the destination.
  skipImSessions: false,
  skipSessionIds: [],
  notifyOn: ['completed', 'error', 'max-tokens'],
  // Blank = the profile-adjacent default. Resolved in trace(), which cannot run
  // before DEFAULT_TRACE_PATH exists.
  tracePath: '',
})

/**
 * Load a peer dependency the way the Host does, not the way this file's own path
 * would.
 *
 * A bundle installed with `link:` is a symlink into the profile, and Node resolves
 * ESM specifiers against the symlink's *real* path — so a bare
 * `import('@deepseek-ai/schemastery')` here looks for node_modules next to this
 * file and fails, silently turning Config into `undefined` and the settings card
 * into nothing at all. Anchoring the lookup on the profile directory finds the
 * copy the Host itself loaded.
 */
const importPeer = async (specifier) => {
  const { createRequire } = await import('node:module')
  const { pathToFileURL } = await import('node:url')
  const anchors = []
  if (process.env.DSH_PROFILE_DIR) anchors.push(process.env.DSH_PROFILE_DIR)
  if (process.env.DSH_HOME && process.env.DSH_PROFILE) {
    anchors.push(`${process.env.DSH_HOME}/profiles/${process.env.DSH_PROFILE}`)
  }
  anchors.push(`${process.env.USERPROFILE ?? process.env.HOME ?? '.'}${process.platform === 'win32' ? '\\' : '/'}.dsh/profiles/${process.env.DSH_PROFILE ?? 'desktop'}`)
  for (const dir of anchors) {
    try {
      const resolved = createRequire(`${dir}/package.json`).resolve(specifier)
      return (await import(pathToFileURL(resolved).href)).default
    } catch {
      // try the next anchor, then the plain specifier
    }
  }
  try {
    return (await import(specifier)).default
  } catch {
    return null
  }
}

/** Lazy schemastery: the settings card is optional, running the plugin is not. */
const Schema = await importPeer('@deepseek-ai/schemastery')

/**
 * Lazy fs: every delivery attempt is also appended to a plain log file, because
 * the Host keeps no readable runtime log — without this a silent failure is
 * indistinguishable from "no conversation finished".
 */
let fsPromises = null
try {
  fsPromises = await import('node:fs/promises')
} catch {
  fsPromises = null
}

/** Lazy crypto: only real-attachment delivery needs hashing and AES-ECB. */
let nodeCrypto = null
try {
  nodeCrypto = await import('node:crypto')
} catch {
  nodeCrypto = null
}

/** Profile home; every integration file below hangs off it. */
const DSH_HOME = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME
  ? process.env.DSH_HOME
  : `${process.env.USERPROFILE ?? process.env.HOME ?? '.'}${process.platform === 'win32' ? '\\' : '/'}.dsh`

/**
 * Where the delivery trail is written (one line per attempt).
 *
 * The Host keeps no readable runtime log, so this file is the only way to tell a
 * silent failure from "no conversation finished". It lives beside the profile by
 * default — the one directory that exists on every install — and can be pointed
 * anywhere through config.
 */
const DEFAULT_TRACE_PATH = `${DSH_HOME}\\completion-notifier.log`

/** Trim the trail once it grows past this size. */
const TRACE_MAX_BYTES = 512 * 1024

export const name = 'completion-notifier'

/** The proactive-delivery seam; nothing else is required to mount. */
export const inject = ['dshIm']

/**
 * Config.
 *
 * Every field a person would actually change while the plugin runs is marked
 * `.volatile()`. That flag is what makes the two halves of the settings story
 * work at once:
 *
 *  - the Host only offers a configuration form for an entry that has at least
 *    one volatile field (`volatileForm()` returns undefined otherwise, and the
 *    entry then never shows up in the settings document at all);
 *  - a volatile field is written straight into the running instance instead of
 *    remounting it, so saving in the GUI does not drop the delivery trail or
 *    lose the targets already confirmed.
 *
 * The reader is `refresh()` in apply(): it re-reads each reference before a turn
 * is reported, which is why an edit lands on the next conversation rather than
 * only after a restart. Arrays stay non-volatile on purpose — they are edited in
 * the file, not in a form, and a form round-trip on them is more risk than help.
 */
export const Config = Schema === null
  ? undefined
  : Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled).volatile(),
    cardTitle: Schema.string().default(DEFAULTS.cardTitle).volatile(),
    // Blank = auto-discover. A filled value pins one specific bot / receiver.
    botId: Schema.string().default(DEFAULTS.botId).volatile(),
    openId: Schema.string().default(DEFAULTS.openId).volatile(),
    targetId: Schema.string().default(DEFAULTS.targetId).volatile(),
    format: Schema.string().default(DEFAULTS.format).volatile(),
    weixinEnabled: Schema.boolean().default(DEFAULTS.weixinEnabled).volatile(),
    weixinBotId: Schema.string().default(DEFAULTS.weixinBotId).volatile(),
    weixinToUserId: Schema.string().default(DEFAULTS.weixinToUserId).volatile(),
    weixinTargetId: Schema.string().default(DEFAULTS.weixinTargetId).volatile(),
    weixinFormat: Schema.string().default(DEFAULTS.weixinFormat).volatile(),
    tracePath: Schema.string().default(DEFAULT_TRACE_PATH).volatile(),
    maxTaskChars: Schema.number().default(DEFAULTS.maxTaskChars).volatile(),
    maxAnswerChars: Schema.number().default(DEFAULTS.maxAnswerChars).volatile(),
    maxArtifacts: Schema.number().default(DEFAULTS.maxArtifacts).volatile(),
    attachFiles: Schema.boolean().default(DEFAULTS.attachFiles).volatile(),
    maxAttachments: Schema.number().default(DEFAULTS.maxAttachments).volatile(),
    maxAttachBytes: Schema.number().default(DEFAULTS.maxAttachBytes).volatile(),
    attachTypes: Schema.array(Schema.string()).default(DEFAULTS.attachTypes).volatile(),
    titleWaitMs: Schema.number().default(DEFAULTS.titleWaitMs).volatile(),
    titleWaitSteps: Schema.number().default(DEFAULTS.titleWaitSteps).volatile(),
    skipSubagents: Schema.boolean().default(DEFAULTS.skipSubagents).volatile(),
    skipSameChannel: Schema.boolean().default(DEFAULTS.skipSameChannel).volatile(),
    skipImSessions: Schema.boolean().default(DEFAULTS.skipImSessions).volatile(),
    skipSessionIds: Schema.array(Schema.string()).default([]),
    notifyOn: Schema.array(Schema.string()).default(DEFAULTS.notifyOn),
  })

/** A `.volatile()` field resolves to a live reference, not to the value itself. */
const isLiveRef = (value) => typeof value === 'object' && value !== null && typeof value.get === 'function'

/** Read a config value that may be a live reference; `undefined` when unset. */
const liveValue = (value) => (isLiveRef(value) ? value.get() : value)

/** Strip wrapping quotes and trailing sentence punctuation from a captured path. */function cleanPath(value) {
  let text = String(value ?? '').trim()
  while (/^["'`(<]/.test(text)) text = text.slice(1)
  while (/["'`)>.,;:!?，。；：！？、]$/.test(text)) text = text.slice(0, -1)
  return text
}

/** Whether a token is worth reporting (drops prose noise and dependency trees). */
function isReportable(token) {
  if (typeof token !== 'string') return false
  if (token.length < 6 || token.length > 260) return false
  if (!ARTIFACT_EXT.test(token)) return false
  if (/^(?:node_modules|\.git)[\\/]/i.test(token)) return false
  // A relative token must look like a path, not a bare filename quoted in prose.
  return /[\\/]/.test(token) || /^[A-Za-z]:/.test(token)
}

/** Collect unique artifact paths from free text, in first-seen order. */
function collectPaths(text, push) {
  if (typeof text !== 'string' || text.length === 0) return
  // Quoted spans first: they survive spaces in directory names.
  for (const match of text.match(QUOTED_SPAN) ?? []) {
    const inner = match.slice(1, -1)
    if (!/^[A-Za-z]:[\\/]|^\\\\/.test(inner)) continue
    const path = cleanPath(inner)
    if (isReportable(path)) push(path)
  }
  for (const match of text.match(WIN_PATH) ?? []) {
    const path = cleanPath(match)
    if (isReportable(path)) push(path)
  }
  for (const match of text.matchAll(REL_PATH)) {
    // A relative hit that continues a longer path (`…\~Ai\Harness\x.md` yields
    // `Ai\Harness\x.md`) is a fragment, not a second file.
    const before = match.index > 0 ? text[match.index - 1] : ''
    if (before && /[\\/~$@\w.-]/.test(before)) continue
    const path = cleanPath(match[0])
    if (isReportable(path)) push(path)
  }
}

/** Normalise for suffix comparison: lowercase, one separator, no trailing slash. */
function comparablePath(path) {
  return String(path ?? '').replace(/[\\/]+/g, '\\').replace(/\\+$/, '').toLowerCase()
}

/**
 * Drop fragments that are the tail of a longer path already in the list, and
 * exact repeats in any case. One file must appear once, with its full path.
 */
function dedupePaths(paths) {
  const full = paths.map(comparablePath)
  return paths.filter((path, index) => {
    const self = full[index]
    for (let other = 0; other < full.length; other += 1) {
      if (other === index) continue
      const candidate = full[other]
      if (candidate === self) return other > index // keep the first of an exact pair
      if (candidate.endsWith(`\\${self}`) || candidate.endsWith(`:${self}`)) return false
    }
    return true
  })
}

/** Read the file path out of a tool call's raw JSON arguments. */
function pathInToolArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  let args
  try {
    args = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!args || typeof args !== 'object') return undefined
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'abs_path']) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      const path = cleanPath(value)
      if (path) return path
    }
  }
  return undefined
}

/** Concatenate the text blocks of one assistant message. */
function answerTextOf(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/** Normalise prose: no hard-wrapped trailing spaces, no double-blank gaps. */
function tidy(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Collapse a long answer into a readable preview. */
function preview(text, limit) {
  const flat = tidy(text)
  if (flat.length <= limit) return flat
  return `${flat.slice(0, limit).trimEnd()}\n…（已截断，共 ${flat.length} 字）`
}

/** "session-a704d261-…" → "a704d261": the shared prefix says nothing. */
function shortId(sessionId) {
  const raw = String(sessionId ?? '')
  return (raw.startsWith('session-') ? raw.slice(8) : raw).slice(0, 8)
}

/** Byte count as a short human figure. */
function formatBytes(size) {
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  const units = ['KB', 'MB', 'GB']
  let value = size / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** How long the turn took, coarse enough to read at a glance. */
function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return ''
  const total = Math.round(ms / 1000)
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

/** Local HH:MM for the moment the turn ended. */
function clockOf(value) {
  const date = value instanceof Date ? value : new Date(value ?? Date.now())
  if (Number.isNaN(date.getTime())) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Last segment of a path. */
function baseName(path) {
  const parts = String(path ?? '').split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : String(path ?? '')
}

/** Lower-case extension without the dot; '' for dotfiles and extensionless names. */
function extOf(path) {
  const name = baseName(path)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Normalize a user-typed extension list into a Set, or undefined for "no filter". */
function allowedExtensionsOf(value) {
  if (!Array.isArray(value)) return undefined
  const cleaned = value
    .map((entry) => String(entry ?? '').trim().replace(/^\.+/, '').toLowerCase())
    .filter(Boolean)
  return cleaned.length ? new Set(cleaned) : undefined
}

/** Everything before the last segment. */
function dirName(path) {
  const text = String(path ?? '')
  const cut = text.search(/[^\\/]+$/)
  if (cut <= 0) return ''
  const dir = text.slice(0, cut)
  return /^[A-Za-z]:$/.test(dir) ? `${dir}\\` : dir.replace(/[\\/]+$/, '')
}

/** Existence and size of one reported path, so a stale guess can be flagged. */
async function inspectArtifact(path) {
  if (fsPromises === null) return { known: false }
  try {
    const info = await fsPromises.stat(path)
    return { known: true, exists: true, isDir: info.isDirectory(), size: info.size }
  } catch {
    return { known: true, exists: false }
  }
}

/** One short human label for the turn-ending reason. */
function reasonLabel(reason) {
  switch (typeof reason?.kind === 'string' ? reason.kind : 'unknown') {
    case 'completed': return { icon: '✅', text: '完成' }
    case 'error': return { icon: '🔴', text: '出错' }
    case 'max-tokens': return { icon: '🟡', text: '输出超长被截断' }
    case 'aborted': return { icon: '⚪', text: '被中止' }
    case 'blocked': return { icon: '⚪', text: '被阻塞' }
    case 'interrupted': return { icon: '⚪', text: '中断（崩溃遗留）' }
    case 'forked': return { icon: '⚪', text: '分叉关闭' }
    default: return { icon: '⚪', text: '结束' }
  }
}

/** A line that is nothing but a short section name, e.g. `产物：`. */
const LABEL_LINE = /^\s*[^\s：:]{1,12}[：:]\s*$/

/**
 * Drop answer lines that only announce artifact paths: those paths already get a
 * dedicated, better-formatted section below, so repeating them inline makes the
 * card twice as long for no new information.
 */
function stripArtifactLines(text, artifacts) {
  if (artifacts.length === 0) return text
  const known = artifacts.map(comparablePath)

  /** Paths named anywhere in one line. */
  const pathsIn = (line) => {
    const found = []
    for (const match of line.match(QUOTED_SPAN) ?? []) {
      const inner = cleanPath(match.slice(1, -1))
      if (inner) found.push(inner)
    }
    for (const match of line.match(WIN_PATH) ?? []) found.push(cleanPath(match))
    for (const match of line.match(REL_PATH) ?? []) found.push(cleanPath(match))
    return found.sort((a, b) => b.length - a.length)
  }

  // Classify first, prune second: deciding "is this a listing entry" needs the
  // line, and deciding "is this label now empty" needs its neighbours.
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    if (!line.trim()) {
      rows.push({ kind: 'blank', line })
      continue
    }
    if (LABEL_LINE.test(line)) {
      rows.push({ kind: 'label', line })
      continue
    }
    const bare = line.replace(/^[\s>*\-•·\d.)、]+/, '')
    const hit = pathsIn(bare).find((path) => known.includes(comparablePath(path)))
    if (hit === undefined) {
      rows.push({ kind: 'text', line })
      continue
    }
    // Whatever prose survives taking the path out settles it: `缺失的那个：<path>`
    // and `- <path>` are listing entries; a full sentence that merely names a file
    // is content and stays.
    const rest = bare.split(hit).join('').replace(/[\s:：\-—·、,，。.]/g, '')
    rows.push(rest.length <= 12 ? { kind: 'listing', line } : { kind: 'text', line })
  }

  // A label survives only if real content still follows it with no blank line in
  // between; `产物：` whose every entry was stripped would read as a broken promise.
  const pruned = []
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row.kind !== 'label') {
      if (row.kind !== 'listing') pruned.push(row.line)
      continue
    }
    let next = index + 1
    let keeps = false
    while (next < rows.length) {
      const kind = rows[next].kind
      if (kind === 'blank') break
      if (kind === 'text') {
        keeps = true
        break
      }
      if (kind === 'label') break
      next += 1
    }
    if (keeps) pruned.push(row.line)
  }

  return pruned.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/**
 * Unwrap the machine envelope a scheduled message arrives in.
 *
 * A reminder turn's user message is not prose: it is `[SCHEDULE REMINDER]` plus
 * id/occurrence fields plus the real instruction buried in a JSON string. Showing
 * that raw turns the most useful line of the card into noise, so pull the actual
 * prompt out and drop the rest.
 */
function tidyTask(text) {
  const raw = String(text ?? '')
  if (!/^\[SCHEDULE REMINDER\]/i.test(raw.trim())) return tidy(raw)
  const match = raw.match(/reminder_prompt_json:\s*("(?:[^"\\]|\\.)*")/s)
  if (match) {
    try {
      const prompt = JSON.parse(match[1])
      if (typeof prompt === 'string' && prompt.trim()) return tidy(prompt)
    } catch {
      // Fall through to the raw text; a malformed envelope is not worth crashing.
    }
  }
  // No parsable payload: at least drop the bookkeeping lines that follow the tag.
  return tidy(raw.replace(/^[\s\S]*?\[SCHEDULE REMINDER\]/i, '')
    .replace(/^\s*(?:schedule_id_json|occurrence_at|reminder_prompt_json)\s*:.*$/gm, '')
    .replace(/^\s*This is a scheduled message from the user\s*$/gim, ''))
}

/** Human labels for the channels a Session can originate from. */
const CHANNEL_LABEL = {
  feishu: '飞书',
  weixin: '微信',
  wecom: '企业微信',
  'wecom-app': '企业微信应用',
  dingtalk: '钉钉',
  qq: 'QQ',
  telegram: 'Telegram',
  discord: 'Discord',
  slack: 'Slack',
  matrix: 'Matrix',
  whatsapp: 'WhatsApp',
  imessage: 'iMessage',
  email: '邮件',
  office: 'Office',
}

/**
 * One short phrase for where the turn was started from.
 *
 * A card can arrive from several entry points — this desktop GUI, a Feishu bot,
 * a Weixin bot, or the scheduler — and the reader needs to know which one, and
 * which bot carried it, without opening the session.
 */
function sourceLabel({ described, scheduled }) {
  if (scheduled) return '⏰ 来自 定时任务'
  if (described) {
    const channel = CHANNEL_LABEL[described.channel] ?? described.channel ?? 'IM'
    const bot = typeof described.botName === 'string' && described.botName.trim()
      ? described.botName.trim()
      : ''
    return bot ? `💬 来自 ${channel} · ${bot}` : `💬 来自 ${channel}`
  }
  return '🖥 来自 桌面端'
}

/** First non-empty line, shortened, for use as a name when the session has none. */
function firstLine(text, limit = 24) {
  const line = String(text ?? '').split('\n').map((part) => part.trim()).find(Boolean) ?? ''
  if (line.length <= limit) return line
  return `${line.slice(0, limit).trimEnd()}…`
}

/**
 * Render the card for one finished turn.
 *
 * Field order is fixed by what a reader asks in sequence: is this a notification,
 * who started it, when, which conversation, which turn, where, what was asked,
 * what came out, and what files exist. The headline is the notifier's own name so
 * every card is recognisable at a glance; the task gets a full-width section of
 * its own further down, which is also why it no longer has to be truncated.
 */
function renderCard({
  title, turn, reason, task, answer, artifacts, artifactInfo,
  cwd, durationMs, endedAt, source, options, markdown = true,
}) {
  const { icon, text } = reasonLabel(reason)
  const b = (value) => (markdown ? `**${value}**` : `【${value}】`)
  const rule = markdown ? '---' : '─'.repeat(16)
  const headline = tidy(options.cardTitle) || DEFAULT_CARD_TITLE

  // The headline is the notifier itself, not the task: every card then arrives
  // under one recognisable name, and the task gets a section of its own where it
  // can run to full length instead of being squeezed into a title line.
  const taskText = task ? tidyTask(task) : ''
  const lines = [`${icon} ${b(headline)}`, rule]

  // 来自 — which doorway this turn came through, and which bot carried it. It
  // opens a block of its own, so the name and the rule above stay a clean header.
  lines.push('', sourceLabel(source ?? {}))

  // 时间 — when it ended, and how long it took.
  const clock = clockOf(endedAt)
  const duration = formatDuration(durationMs)
  const moments = []
  if (clock) moments.push(clock)
  if (duration) moments.push(`用时 ${duration}`)
  if (moments.length) lines.push(`🕒 ${moments.join(' · ')}`)

  // 会话 — the conversation's name, never its id: "session-f32f5586" identifies
  // nothing to a person, and the name is what the GUI shows in the sidebar. A
  // brand-new session is named ~a minute after its first turn, far too late to
  // hold a card, so the task's own first line stands in until the name exists.
  const name = String(title ?? '').trim()
  const fallbackName = firstLine(taskText, 40)
  lines.push(`🗂 会话 ${name ? firstLine(name, 40) : (fallbackName || '（未命名对话）')}`)

  // 轮数 — plus the verdict, which has nowhere else to sit now the headline is
  // the notifier's name rather than the task.
  lines.push(`🔁 第 ${turn} 轮 · ${icon} ${text}`)

  // 文件夹 — where it ran.
  const dir = typeof cwd === 'string' && cwd ? cwd : ''
  if (dir) lines.push(`📁 ${dir}`)

  lines.push('')

  // 任务 — in full. It used to be truncated into the headline; with the card now
  // carrying a fixed name, the task has a section of its own and is shown whole,
  // so a reader can tell exactly what was asked without opening the session.
  lines.push(`📝 ${b('任务')}`)
  lines.push(taskText
    ? preview(taskText, options.maxTaskChars)
    : '（本轮没有任务文本）')
  lines.push('')

  // 结果
  lines.push(`💬 ${b('结果')}`)
  const resultText = answer ? stripArtifactLines(answer, artifacts) : ''
  lines.push(resultText
    ? preview(resultText, options.maxAnswerChars)
    : (answer ? '（本轮回复只是在列文件，清单见下）' : '（本轮没有文字回复）'))
  lines.push('')

  if (artifacts.length) {
    const shown = artifacts.slice(0, options.maxArtifacts)
    lines.push(`📦 ${b(`产物 ${artifacts.length} 个`)}`)
    shown.forEach((path, index) => {
      const info = artifactInfo[index] ?? {}
      let note = ''
      if (info.exists === false) note = '（未找到）'
      else if (info.isDir) note = '· 目录'
      else if (info.size !== undefined) note = `· ${formatBytes(info.size)}`
      lines.push(`${index + 1}. ${baseName(path)}${note ? ` ${note}` : ''}`)
      const parent = dirName(path)
      if (parent) lines.push(`   ${parent}`)
    })
    if (artifacts.length > shown.length) {
      lines.push(`…另有 ${artifacts.length - shown.length} 个未列出`)
    }
  } else {
    lines.push(`📦 ${b('产物')}`, '（本轮没有提到文件）')
  }

  if (reason?.kind === 'error') {
    const detail = reason?.error
    const message = typeof detail === 'string' ? detail
      : (typeof detail?.message === 'string' ? detail.message : '')
    if (message) lines.push('', `⚠️ ${b('错误')}`, preview(message, 300))
  }

  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  // iLink wants CRLF. We proved the old template really did carry 46 "\n" — the
  // WeChat client simply rendered them as one long line. Bare LF is only a JS
  // convention; the plain-text path is the one that reaches WeChat untouched, so
  // it is the one that has to speak CRLF. Markdown must stay LF because
  // chunkMarkdownText normalizes \r\n back to \n before chunking.
  return markdown ? joined : joined.replace(/\n/g, '\r\n')
}

/* ------------------------------------------------------------------------- *
 * Real attachments.
 *
 * dsh-im's proactive send() carries text only — its file path lives in each
 * channel's *bridge*, reachable from an inbound conversation, not from a Host
 * plugin. So each channel's own upload API is spoken to directly: the Feishu
 * open platform (tenant token → im/v1/files → im/v1/messages) and the Weixin
 * iLink protocol (getuploadurl → AES-ECB CDN upload → sendmessage with a
 * file_item). Both were verified against the live accounts before being wired
 * here; neither needs a dsh-im internal module.
 * ------------------------------------------------------------------------- */

const FEISHU_BASE = 'https://open.feishu.cn/open-apis'
const WEIXIN_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c'
const WEIXIN_CDN_HOST = 'novac2c.cdn.weixin.qq.com'
const WEIXIN_PROTOCOL_VERSION = '2.4.6'
const UPLOAD_TIMEOUT_MS = 60_000

/** A failure whose `code` is worth printing in the trail. */
const attachmentError = (code, message, options = {}) =>
  Object.assign(new Error(message), { code, ...options })

/** Read one JSON file, or null when it is absent or unparseable. */
const readJsonFile = async (path) => {
  if (fsPromises === null) return null
  try {
    return JSON.parse(await fsPromises.readFile(path, 'utf8'))
  } catch {
    return null
  }
}

/**
 * One credential value.
 *
 * The seam is asked first (it is what every other plugin uses, and it hides the
 * storage layout); the reference map is read directly only as a fallback, so an
 * install whose credentials live elsewhere still delivers.
 */
const readSecret = async (ctx, ref) => {
  try {
    const resolved = await ctx?.credentials?.resolve?.(ref)
    const value = typeof resolved?.value === 'string' ? resolved.value.trim() : ''
    if (value) return value
  } catch {
    // Fall through to the file.
  }
  if (fsPromises === null) return ''
  try {
    const text = await fsPromises.readFile(`${DSH_HOME}\\.credentials.yaml`, 'utf8')
    for (const row of text.split(/\r?\n/)) {
      const trimmed = row.trim()
      if (!trimmed.startsWith(`${ref}:`)) continue
      const value = trimmed.slice(ref.length + 1).trim().replace(/^['"]|['"]$/g, '')
      if (value) return value
    }
  } catch {
    return ''
  }
  return ''
}

/** POST JSON with a hard timeout; the body is returned parsed. */
const postJson = async (url, body, headers = {}) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  const text = await response.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = null
  }
  return { status: response.status, ok: response.ok, parsed, text }
}

/** Multipart/form-data body, built by hand so no Blob/FormData global is assumed. */
const multipartBody = (fields, fileField, fileName, fileBytes, boundary) => {
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      'utf8',
    ))
  }
  // Both the plain and the RFC 5987 form are sent: a Chinese file name must
  // survive the header, and parsers differ in which one they honour.
  const encodedName = encodeURIComponent(fileName)
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; `
    + `filename="${fileName.replace(/["\r\n]/g, '_')}"; filename*=UTF-8''${encodedName}\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  ))
  chunks.push(fileBytes)
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'))
  return Buffer.concat(chunks)
}

/** Cached tenant token per Feishu app id. */
const feishuTokens = new Map()

const feishuToken = async (appId, appSecret, { refresh = false } = {}) => {
  const cached = feishuTokens.get(appId)
  if (!refresh && cached !== undefined && cached.expiresAt > Date.now()) return cached.value
  const result = await postJson(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`, {
    app_id: appId,
    app_secret: appSecret,
  })
  if (result.parsed?.code !== 0 || typeof result.parsed?.tenant_access_token !== 'string') {
    throw attachmentError('feishu-token-failed', `tenant token rejected (code ${result.parsed?.code}: ${result.parsed?.msg ?? result.status})`)
  }
  // Refresh a minute early: a token that expires mid-upload fails the upload.
  const ttl = Number(result.parsed.expire ?? 0) * 1000
  feishuTokens.set(appId, {
    value: result.parsed.tenant_access_token,
    expiresAt: Date.now() + Math.max(ttl - 60_000, 30_000),
  })
  return result.parsed.tenant_access_token
}

/** Upload one file to Feishu and send it as a `file` message to one open id. */
const feishuSendFile = async ({ appId, appSecret, openId, fileName, bytes, attempt = 0 }) => {
  const token = await feishuToken(appId, appSecret, { refresh: attempt > 0 })
  const boundary = `----notifier${Math.random().toString(16).slice(2)}`
  const body = multipartBody({ file_type: 'stream', file_name: fileName }, 'file', fileName, bytes, boundary)
  const uploadResponse = await fetch(`${FEISHU_BASE}/im/v1/files`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    body,
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  const uploadText = await uploadResponse.text()
  let upload = null
  try {
    upload = JSON.parse(uploadText)
  } catch {
    upload = null
  }
  // 99991663/99991664 are "token invalid/expired": worth exactly one retry.
  if ((upload?.code === 99991663 || upload?.code === 99991664) && attempt === 0) {
    return feishuSendFile({ appId, appSecret, openId, fileName, bytes, attempt: 1 })
  }
  const fileKey = upload?.data?.file_key
  if (upload?.code !== 0 || typeof fileKey !== 'string') {
    throw attachmentError('feishu-upload-failed', `upload rejected (code ${upload?.code}: ${upload?.msg ?? uploadResponse.status})`)
  }
  const send = await postJson(
    `${FEISHU_BASE}/im/v1/messages?receive_id_type=open_id`,
    {
      receive_id: openId,
      msg_type: 'file',
      content: JSON.stringify({ file_key: fileKey }),
    },
    { authorization: `Bearer ${token}` },
  )
  if (send.parsed?.code !== 0) {
    throw attachmentError('feishu-send-failed', `file message rejected (code ${send.parsed?.code}: ${send.parsed?.msg ?? send.status})`)
  }
  return fileKey
}

/** AES-ECB ciphertext size the Weixin CDN expects (PKCS#7 padded to 16 bytes). */
const aesEcbPaddedSize = (size) => Math.ceil((size + 1) / 16) * 16

/**
 * Upload one file to the Weixin CDN and send it as a `file_item` message.
 *
 * The protocol requires the recipient's context token, which only exists after
 * that person has messaged the bot — without one this throws `no-context-token`
 * and the caller reports text only.
 */
const weixinSendFile = async ({ baseUrl, token, toUserId, contextToken, fileName, bytes }) => {
  if (nodeCrypto === null) throw attachmentError('no-crypto', 'node:crypto unavailable')
  const { createCipheriv, createHash, randomBytes, randomUUID } = nodeCrypto
  const fileKey = randomBytes(16).toString('hex')
  const aesKey = randomBytes(16)
  const ciphertextSize = aesEcbPaddedSize(bytes.byteLength)

  const upload = await postJson(new URL('ilink/bot/getuploadurl', baseUrl).href, {
    filekey: fileKey,
    media_type: 3,
    to_user_id: toUserId,
    rawsize: bytes.byteLength,
    rawfilemd5: createHash('md5').update(bytes).digest('hex'),
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
    base_info: { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' },
  }, weixinHeaders(token))
  if (upload.parsed?.ret !== undefined && upload.parsed.ret !== 0) {
    throw attachmentError('weixin-upload-url-rejected', `getuploadurl rejected (ret ${upload.parsed.ret})`)
  }
  const fullUrl = typeof upload.parsed?.upload_full_url === 'string' ? upload.parsed.upload_full_url : ''
  const uploadParam = typeof upload.parsed?.upload_param === 'string' ? upload.parsed.upload_param : ''
  let uploadUrl
  if (fullUrl) {
    uploadUrl = new URL(fullUrl)
  } else if (uploadParam) {
    uploadUrl = new URL(`${WEIXIN_CDN_BASE}/upload`)
    uploadUrl.searchParams.set('encrypted_query_param', uploadParam)
    uploadUrl.searchParams.set('filekey', fileKey)
  } else {
    throw attachmentError('weixin-no-upload-url', 'getuploadurl returned no upload url')
  }
  // Only the documented CDN may receive the plaintext-derived ciphertext.
  if (uploadUrl.protocol !== 'https:' || uploadUrl.hostname !== WEIXIN_CDN_HOST) {
    throw attachmentError('weixin-untrusted-upload-url', `refusing upload to ${uploadUrl.hostname}`)
  }

  const cipher = createCipheriv('aes-128-ecb', aesKey, null)
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  const cdnResponse = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(ciphertext.length),
    },
    body: ciphertext,
    redirect: 'error',
    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
  })
  const downloadParam = cdnResponse.headers.get('x-encrypted-param')
  if (!cdnResponse.ok || !downloadParam) {
    throw attachmentError('weixin-cdn-failed', `cdn upload failed (${cdnResponse.status}${downloadParam ? '' : ', no download param'})`)
  }

  const clientId = `dsh-weixin-${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 32)}`
  const send = await postJson(new URL('ilink/bot/sendmessage', baseUrl).href, {
    msg: {
      from_user_id: '',
      to_user_id: toUserId,
      client_id: clientId,
      message_type: 2,
      message_state: 2,
      item_list: [{
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: downloadParam,
            aes_key: Buffer.from(aesKey.toString('hex')).toString('base64'),
            encrypt_type: 1,
          },
          file_name: fileName,
          len: String(bytes.byteLength),
        },
      }],
      ...(contextToken ? { context_token: contextToken } : {}),
    },
    base_info: { channel_version: WEIXIN_PROTOCOL_VERSION, bot_agent: 'DeepSeekHarness/1.1.0' },
  }, weixinHeaders(token))
  if (send.parsed?.ret !== undefined && send.parsed.ret !== 0) {
    throw attachmentError('weixin-send-rejected', `sendmessage rejected (ret ${send.parsed.ret})`)
  }
  return clientId
}

/** The iLink header set: app identity, a random client nonce, and the bot token. */
function weixinHeaders(token) {
  const nonce = nodeCrypto === null
    ? String(Date.now())
    : String(nodeCrypto.randomBytes(4).readUInt32BE(0))
  return {
    'iLink-App-Id': 'bot',
    'iLink-App-ClientVersion': String((2 << 16) | (4 << 8) | 6),
    'content-type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': Buffer.from(nonce, 'utf8').toString('base64'),
    authorization: `Bearer ${token}`,
  }
}

export async function apply(ctx, config) {
  const options = { ...DEFAULTS }
  const log = typeof ctx?.logger === 'function' ? ctx.logger('completion-notifier') : (ctx?.logger ?? console)

  /** Append one line to the delivery trail; tracing must never throw. */
  const trace = async (line) => {
    if (fsPromises === null) return
    const path = options.tracePath || DEFAULT_TRACE_PATH
    try {
      const stamp = `${new Date().toISOString()} ${line}\n`
      // Keep the trail bounded: past running for weeks it stays a few hundred KB.
      const info = await fsPromises.stat(path).catch(() => null)
      if (info !== null && info.size > TRACE_MAX_BYTES) {
        const tail = await fsPromises.readFile(path, 'utf8').catch(() => '')
        await fsPromises.writeFile(path, tail.slice(-Math.floor(TRACE_MAX_BYTES / 2)), 'utf8')
      }
      await fsPromises.appendFile(path, stamp, 'utf8')
    } catch {
      // A log write failure must never affect delivery.
    }
  }

  // Fill from the Loader's row config without trusting its shape. Volatile
  // fields arrive as live references: reading them now would freeze whatever the
  // value happened to be at mount, so they are re-read in refresh() instead.
  const raw = config ?? {}
  const readOptions = () => {
    for (const key of Object.keys(DEFAULTS)) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
      const value = liveValue(raw[key])
      if (value !== undefined && value !== null) options[key] = value
    }
    return options
  }
  readOptions()
  if (options.enabled === false) {
    log.info?.('disabled by config; no turn will be reported')
    return
  }

  /** Per-session turn scratch: what the running turn has said and touched. */
  const scratch = new Map()
  /** `${sessionId}:${turn}` already reported, so a replayed event cannot double-send. */
  const reported = new Set()

  /**
   * Who carries each channel and who receives it.
   *
   * A blank botId / recipient means "use this profile's own": the bot comes from
   * `ctx.dshIm.listBots()`, the recipient from that bot's integration config (its
   * owner id). Any filled-in value wins and pins one specific chat. That is what
   * lets this bundle mount usefully on a fresh profile with an empty config.
   */
  const routes = {
    feishu: { botId: options.botId, openId: options.openId },
    weixin: { botId: options.weixinBotId, toUserId: options.weixinToUserId },
  }

  /**
   * The channels one finished turn goes to. Feishu and Weixin carry different
   * route shapes (openId vs toUserId) and different markup support, so each entry
   * owns its own target id and format; a failure on one must not stop the other.
   *
   * The list is rebuilt by syncChannels() before every delivery: a GUI edit to
   * weixinEnabled or one of the formats is a live write, and the previous mount
   * built this list once.
   */
  const buildChannels = () => {
    const list = [
      {
        key: 'feishu',
        botId: routes.feishu.botId,
        targetId: options.targetId,
        format: options.format,
        markdown: options.format === 'markdown',
        target: () => ({
          targetId: options.targetId,
          name: '对话完成提醒',
          kind: 'user',
          route: { openId: routes.feishu.openId },
        }),
      },
    ]
    if (options.weixinEnabled) {
      list.push({
        key: 'weixin',
        botId: routes.weixin.botId,
        targetId: options.weixinTargetId,
        format: options.weixinFormat,
        markdown: options.weixinFormat === 'markdown',
        target: () => ({
          targetId: options.weixinTargetId,
          name: '对话完成提醒（微信）',
          kind: 'user',
          route: { toUserId: routes.weixin.toUserId },
        }),
      })
    }
    return list
  }
  let channels = buildChannels()

  /** Targets already confirmed (or known to exist) since this mount. */
  const ready = new Set()

  /**
   * Re-read the live config and rebuild whatever was derived from it.
   *
   * Called before every delivery, so a value edited in the GUI applies to the
   * next conversation that ends — without remounting, which would drop the
   * targets already confirmed and the trail of what has been reported.
   */
  const refresh = () => {
    const before = `${options.targetId}|${options.format}|${options.weixinEnabled}|${options.weixinTargetId}|${options.weixinFormat}|${options.botId}|${options.openId}|${options.weixinBotId}|${options.weixinToUserId}`
    readOptions()
    const after = `${options.targetId}|${options.format}|${options.weixinEnabled}|${options.weixinTargetId}|${options.weixinFormat}|${options.botId}|${options.openId}|${options.weixinBotId}|${options.weixinToUserId}`
    if (before === after) return false
    // A changed route or target id invalidates every derived fact: the ids the
    // loop below would send to are no longer the ones we confirmed.
    routes.feishu = { botId: options.botId || routes.feishu.botId, openId: options.openId || routes.feishu.openId }
    routes.weixin = {
      botId: options.weixinBotId || routes.weixin.botId,
      toUserId: options.weixinToUserId || routes.weixin.toUserId,
    }
    channels = buildChannels()
    ready.clear()
    attachmentSenders.clear()
    void trace(`config changed; channels=${channels.map((channel) => channel.key).join('+')} title=${options.cardTitle}`)
    return true
  }

  /**
   * Fill in whatever the config left blank, and hand the result to the channels.
   *
   * Discovery is *entry-first*, and deliberately so: the app id, the secret
   * reference and the owner id all live on one entry of the channel's integration
   * file, and mixing an id from one entry with an owner from another would address
   * a chat with credentials that cannot reach it. So one entry is chosen — the
   * configured bot, else a bot the Host reports as loaded, else the first one —
   * and bot id *and* receiver are both taken from that same entry.
   *
   * Re-run whenever a channel still has no bot: right after a Host restart the
   * delivery accounts are not registered yet, and that must not permanently
   * disable a channel.
   */
  const resolveRoutes = async () => {
    let bots = []
    try {
      const list = await ctx.dshIm.listBots()
      bots = Array.isArray(list) ? list : []
    } catch {
      bots = []
    }
    const loadedBotOf = (channelKey) =>
      bots.find((bot) => bot?.channel === channelKey && typeof bot.botId === 'string')?.botId ?? ''

    let changed = false
    /** Pick one account entry, preferring ids that are pinned or actually loaded. */
    const pickEntry = (entries, idOf, pinned, loaded) =>
      entries.find((entry) => idOf(entry) === pinned)
      ?? entries.find((entry) => idOf(entry) === loaded)
      ?? entries[0]

    const feishu = await readJsonFile(`${DSH_HOME}\\${FEISHU_CONFIG}`)
    const feishuEntries = Array.isArray(feishu?.bots) ? feishu.bots : []
    if (!routes.feishu.botId) {
      const entry = pickEntry(feishuEntries, (item) => item?.id, options.botId, loadedBotOf('feishu'))
      const candidate = entry?.id ?? loadedBotOf('feishu')
      if (candidate) {
        routes.feishu.botId = candidate
        changed = true
      }
    }
    if (!routes.feishu.openId) {
      const entry = pickEntry(feishuEntries, (item) => item?.id, routes.feishu.botId, '')
      routes.feishu.openId = entry?.ownerOpenIds?.[0] ?? ''
    }

    const weixin = await readJsonFile(`${DSH_HOME}\\${WEIXIN_CONFIG}`)
    const weixinEntries = Array.isArray(weixin?.accounts) ? weixin.accounts : []
    if (!routes.weixin.botId) {
      const entry = pickEntry(weixinEntries, (item) => item?.botId, options.weixinBotId, loadedBotOf('weixin'))
      const candidate = entry?.botId ?? loadedBotOf('weixin')
      if (candidate) {
        routes.weixin.botId = candidate
        changed = true
      }
    }
    if (!routes.weixin.toUserId) {
      const entry = pickEntry(weixinEntries, (item) => item?.botId, routes.weixin.botId, '')
      routes.weixin.toUserId = entry?.ownerUserId ?? ''
    }

    if (changed) {
      // A newly discovered bot invalidates "this target exists" — it belonged to
      // whatever bot id we had before, which may have been nothing at all.
      ready.clear()
      // Credential lookups are keyed by bot too, so they go stale with it.
      attachmentSenders.clear()
      void trace(`routes: feishu=${routes.feishu.botId || '(none)'} → ${routes.feishu.openId || '(no receiver)'}, weixin=${routes.weixin.botId || '(none)'} → ${routes.weixin.toUserId || '(no receiver)'}`)
    }
    // Channels always read their bot from the resolved route, so a value that
    // came straight from config is picked up on the first call too.
    for (const channel of channels) channel.botId = routes[channel.key].botId
    return routes
  }
  /**
   * Where each channel's real-file path gets its credentials.
   *
   * Resolved once per mount and cached: the bot's own integration config is the
   * only place that knows the app id / token reference, and it does not change
   * while the plugin is mounted.
   */
  const attachmentSenders = new Map()
  const senderFor = async (channel) => {
    if (attachmentSenders.has(channel.key)) return attachmentSenders.get(channel.key)
    let sender = null
    if (channel.key === 'feishu') {
      const config = await readJsonFile(`${DSH_HOME}\\${FEISHU_CONFIG}`)
      const bot = (config?.bots ?? []).find((entry) => entry?.id === channel.botId)
      if (bot?.appId && bot?.secretRef && routes.feishu.openId) {
        sender = { kind: 'feishu', appId: bot.appId, secretRef: bot.secretRef, openId: routes.feishu.openId }
      }
    } else if (channel.key === 'weixin') {
      const config = await readJsonFile(`${DSH_HOME}\\${WEIXIN_CONFIG}`)
      const account = (config?.accounts ?? []).find((entry) => entry?.botId === channel.botId)
      if (account?.tokenRef && routes.weixin.toUserId) {
        sender = {
          kind: 'weixin',
          baseUrl: account.baseUrl,
          tokenRef: account.tokenRef,
          toUserId: routes.weixin.toUserId,
          statePath: `${DSH_HOME}\\integrations\\dsh-weixin\\accounts\\${channel.botId}\\state.json`,
        }
      }
    }
    attachmentSenders.set(channel.key, sender)
    if (sender === null) void trace(`attachments unavailable ${channel.key}: no integration account`)
    return sender
  }

  /**
   * Send one artifact as a real file on one channel.
   *
   * Returns a short outcome for the trail. Every failure is contained: a file
   * that cannot be attached must not cost the reader the card that already
   * arrived — the path in that card is still the fallback.
   */
  const sendAttachment = async (channel, path, info) => {
    if (fsPromises === null) return 'no-fs'
    const sender = await senderFor(channel)
    if (sender === null) return 'no-sender'
    const name = baseName(path)
    let bytes
    try {
      bytes = await fsPromises.readFile(path)
    } catch (error) {
      return `read-failed ${error?.code ?? ''}`
    }
    try {
      if (sender.kind === 'feishu') {
        const secret = await readSecret(ctx, sender.secretRef)
        if (!secret) return 'no-secret'
        await feishuSendFile({
          appId: sender.appId,
          appSecret: secret,
          openId: sender.openId,
          fileName: name,
          bytes,
        })
        return `sent ${formatBytes(bytes.length)}`
      }
      const token = await readSecret(ctx, sender.tokenRef)
      if (!token) return 'no-token'
      const state = await readJsonFile(sender.statePath)
      const contextToken = state?.contextTokens?.users?.[sender.toUserId]?.token ?? ''
      if (!contextToken) return 'no-context-token'
      await weixinSendFile({
        baseUrl: sender.baseUrl,
        token,
        toUserId: sender.toUserId,
        contextToken,
        fileName: name,
        bytes,
      })
      return `sent ${formatBytes(bytes.length)}`
    } catch (error) {
      return `FAILED ${error?.code ?? error?.name ?? 'unknown'} ${error?.message ?? ''}`.trim()
    }
  }

  const scratchFor = (sessionId) => {
    let state = scratch.get(sessionId)
    if (state === undefined) {
      state = { turn: undefined, task: '', answer: '', toolPaths: [], startedAt: undefined }
      scratch.set(sessionId, state)
    }
    return state
  }

  /** Create one delivery target; a duplicate key is the success case. */
  const ensureTarget = async (channel) => {
    if (!channel.botId) await resolveRoutes()
    if (!channel.botId) {
      void trace(`target skipped ${channel.key}: no bot configured or discoverable`)
      return false
    }
    if (ready.has(channel.key)) return true
    try {
      await ctx.dshIm.createTarget(channel.botId, channel.target())
      log.info?.(`created delivery target ${channel.key}/${channel.targetId}`)
      void trace(`target created ${channel.key}/${channel.targetId}`)
    } catch (error) {
      const code = error?.code ?? error?.name ?? 'unknown-error'
      // An existing target is fine; an invalid one may still be sendable if it was
      // created with a shape this plugin cannot re-derive, so let send() decide.
      if (code !== 'target-conflict' && code !== 'invalid-target') {
        log.warn?.(`target ${channel.key} unavailable (${code}); retrying on the next turn`)
        void trace(`target FAILED ${channel.key}/${channel.targetId} ${code}: ${error?.message ?? ''}`)
        return false
      }
      void trace(`target already present ${channel.key}/${channel.targetId} (${code})`)
    }
    ready.add(channel.key)
    return true
  }

  /**
   * Which conversation (if any) this Session was started from.
   *
   * Cached per session: the lookup walks every bot's persisted state, and one
   * session's origin never changes mid-life.
   */
  const imSessions = new Map()
  const originOf = async (session) => {
    if (imSessions.has(session.id)) return imSessions.get(session.id)
    let described = null
    try {
      described = await ctx.dshIm.describeConversation(session.id)
    } catch {
      described = null
    }
    imSessions.set(session.id, described ?? null)
    return described ?? null
  }

  /**
   * Why this turn must not be reported, or '' to proceed.
   *
   * The interesting rule is the echo guard: a conversation that came in through
   * Feishu must not be reported back into that same Feishu chat — the user already
   * sees the answer there, so the card would just duplicate it. Sending it to the
   * *other* channel is exactly what is wanted, so the check is per destination.
   */
  const skipReasonOf = async (session, channel) => {
    if (options.skipSessionIds.includes(session.id)) return 'listed in skipSessionIds'
    if (options.skipSubagents && session.header?.origin === 'subagent') return 'subagent session'
    const origin = await originOf(session)
    if (options.skipImSessions && origin) {
      return `IM conversation (${origin.channel}; dsh-im already reports it)`
    }
    if (options.skipSameChannel && origin && origin.channel === channel.key) {
      return `same chat it came from (${origin.channel})`
    }
    return ''
  }

  /** Deliver one card; a delivery failure must never disturb the session. */
  const deliver = async (session, event) => {
    // Apply any GUI edit made since the last card before reading a single option.
    refresh()
    if (options.enabled === false) {
      void trace(`skip ${session.id} turn ${event.data?.turn ?? 0}: disabled by config`)
      return
    }
    const turn = event.data?.turn ?? 0
    const reason = event.data?.reason
    const kind = reason?.kind
    if (!options.notifyOn.includes(kind)) {
      void trace(`skip ${session.id} turn ${turn}: reason ${kind} not in notifyOn`)
      return
    }
    const dedupeKey = `${session.id}:${turn}`
    if (reported.has(dedupeKey)) return
    reported.add(dedupeKey)
    if (reported.size > 2000) reported.clear()

    const state = scratch.get(session.id) ?? { task: '', answer: '', toolPaths: [] }
    // Files the turn actually wrote come first: they are the most trustworthy
    // artifacts. Paths merely mentioned in prose follow, de-duplicated against them.
    const written = []
    const mentioned = []
    const seenWritten = new Set()
    for (const path of state.toolPaths) {
      if (!path || seenWritten.has(path)) continue
      seenWritten.add(path)
      written.push(path)
    }
    const pushMention = (path) => {
      if (!path) return
      mentioned.push(path)
    }
    collectPaths(state.task, pushMention)
    collectPaths(state.answer, pushMention)
    const artifacts = dedupePaths([...written, ...mentioned])

    let title = ''
    try {
      title = ctx.sessionTitle?.get?.(session)?.title ?? ''
    } catch {
      title = ''
    }
    // A brand-new session is named by the model *after* its first turn ends, so
    // reading the title the instant turn/end fires usually finds nothing. Wait a
    // little rather than printing "（未命名对话）" for a session that is about to
    // have a perfectly good name — but never hold the card hostage to it.
    if (!title && options.titleWaitMs > 0 && options.titleWaitSteps > 0) {
      for (let attempt = 0; attempt < options.titleWaitSteps; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, options.titleWaitMs))
        try {
          title = ctx.sessionTitle?.get?.(session)?.title ?? ''
        } catch {
          title = ''
        }
        if (title) break
      }
    }

    const origin = await originOf(session)
    // A scheduled turn is recognisable by its envelope, which is also what tells
    // the reader the trigger was the clock rather than a person.
    const scheduled = /^\s*\[SCHEDULE REMINDER\]/i.test(String(state.task ?? ''))
    const source = { described: origin, scheduled }

    // Resolve every reported path once: a name plus size reads far better than a
    // raw path, and a path that no longer exists is worth flagging as stale.
    const shown = artifacts.slice(0, options.maxArtifacts)
    const artifactInfo = await Promise.all(shown.map((path) => inspectArtifact(path)))
    const endedAt = new Date()
    const durationMs = typeof state.startedAt === 'number' ? endedAt.getTime() - state.startedAt : undefined

    try {
      for (const channel of channels) {
        const skipReason = await skipReasonOf(session, channel)
        if (skipReason) {
          void trace(`skip ${channel.key} ${session.id} turn ${turn}: ${skipReason}`)
          continue
        }
        const text = renderCard({
          title,
          turn,
          reason,
          task: state.task,
          answer: state.answer,
          artifacts,
          artifactInfo,
          cwd: session.header?.cwd,
          durationMs,
          endedAt,
          source,
          options,
          markdown: channel.markdown,
        })
        try {
          if (!(await ensureTarget(channel))) {
            void trace(`send skipped ${channel.key} ${session.id} turn ${turn}: no delivery target`)
            continue
          }
          await ctx.dshIm.send(channel.botId, channel.targetId, text, { format: channel.format })
          log.info?.(`reported ${session.id} turn ${turn} (${kind}) via ${channel.key}`)
          void trace(`sent ${channel.key} ${session.id} turn ${turn} (${kind}) artifacts=${artifacts.length}`)
          void trace(`card ${channel.key} ${session.id}:${turn} :: ${text.replace(/\n/g, ' | ').slice(0, 800)}`)
        } catch (error) {
          const code = error?.code ?? error?.name ?? 'unknown-error'
          // Weixin's `delivery-failed` is iLink refusing the send outright, and the
          // usual cause is the conversation window rather than this plugin.
          const hint = channel.key === 'weixin' && code === 'delivery-failed'
            ? ' (iLink refused: the chat needs a fresh message from the recipient)'
            : ''
          log.warn?.(`delivery failed on ${channel.key} for ${session.id} turn ${turn}: ${code}`)
          void trace(`send FAILED ${channel.key} ${session.id} turn ${turn}: ${code} ${error?.message ?? ''}${hint}`)
          // Force a re-create attempt next time; a deleted target must heal itself.
          ready.delete(channel.key)
          // The card is the only place the paths appear, so stop here rather than
          // attaching files whose names the reader cannot connect to a conversation.
          continue
        }
        if (!options.attachFiles) continue
        // Attach the real files after the card: the card names them, the files
        // follow. Directories and vanished paths are skipped — there is nothing
        // to upload — and the card already flagged them.
        const allowedExtensions = allowedExtensionsOf(options.attachTypes)
        let attached = 0
        for (let index = 0; index < shown.length; index += 1) {
          if (attached >= options.maxAttachments) {
            void trace(`attach stop ${channel.key}: hit maxAttachments=${options.maxAttachments}`)
            break
          }
          const info = artifactInfo[index] ?? {}
          if (info.exists === false || info.isDir === true) continue
          if (allowedExtensions) {
            const extension = extOf(shown[index])
            if (!allowedExtensions.has(extension)) {
              void trace(`attach skip ${channel.key} ${baseName(shown[index])}: type "${extension || '(none)'}" not allowed`)
              continue
            }
          }
          if (typeof info.size === 'number' && info.size > options.maxAttachBytes) {
            void trace(`attach skip ${channel.key} ${baseName(shown[index])}: ${formatBytes(info.size)} > ${formatBytes(options.maxAttachBytes)}`)
            continue
          }
          const outcome = await sendAttachment(channel, shown[index], info)
          attached += 1
          void trace(`attach ${channel.key} ${session.id}:${turn} ${baseName(shown[index])}: ${outcome}`)
        }
      }
    } finally {
      scratch.delete(session.id)
    }
  }

  const onSessionEvent = (session, event) => {
    if (session === undefined || event === undefined) return
    switch (event.type) {
      case 'turn/start': {
        scratch.set(session.id, {
          turn: event.data?.turn,
          task: '',
          answer: '',
          toolPaths: [],
          startedAt: Date.now(),
        })
        return
      }
      case 'user/message': {
        const state = scratchFor(session.id)
        if (state.task) return
        const content = event.data?.content
        if (Array.isArray(content)) {
          state.task = content
            .filter((block) => block?.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
            .trim()
        }
        return
      }
      case 'assistant/message': {
        const state = scratchFor(session.id)
        const blocks = event.data?.message?.content
        const answer = answerTextOf(blocks)
        if (answer) state.answer = answer
        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block?.type === 'tool-call' && WRITE_TOOLS.has(String(block.name))) {
              const path = pathInToolArguments(block.arguments)
              if (path) state.toolPaths.push(path)
            }
          }
        }
        return
      }
      case 'tool/call': {
        const state = scratchFor(session.id)
        if (WRITE_TOOLS.has(String(event.data?.name))) {
          const path = pathInToolArguments(event.data?.arguments)
          if (path) state.toolPaths.push(path)
        }
        return
      }
      case 'turn/end': {
        // Delivery is async and must never block the session's own event pump.
        void deliver(session, event).catch((error) => {
          log.warn?.(`report crashed: ${error?.message ?? error}`)
        })
        return
      }
      default:
        return
    }
  }

  // Create every delivery target eagerly: a turn that is skipped (an IM
  // conversation reporting on itself) must not be the reason a target never exists.
  void (async () => {
    // Discovery first: with an empty config the bot ids only exist after this.
    await resolveRoutes().catch(() => {})
    for (const channel of channels) {
      await ensureTarget(channel).catch((error) => {
        log.warn?.(`could not prepare the ${channel.key} target: ${error?.message ?? error}`)
      })
    }
  })()

  ctx.on('session/event', onSessionEvent, { global: true })
  log.info?.(`watching every Session; finished turns go to ${channels.map((c) => c.key).join('+')}`)
  void trace(`mounted; channels=${channels.map((c) => `${c.key}:${c.botId || '(auto)'}/${c.targetId}`).join(', ')}, title=${options.cardTitle || DEFAULT_CARD_TITLE}`)

  // Which channels the Host actually exposes decides whether a Weixin target is
  // even reachable; record it once per mount instead of guessing.
  void (async () => {
    try {
      const bots = await ctx.dshIm.listBots()
      const seen = (Array.isArray(bots) ? bots : [])
        .map((bot) => `${bot?.botId ?? '?'}(${bot?.channel ?? '?'})`)
        .join(', ')
      void trace(`bots: ${seen || '(none)'}`)
    } catch (error) {
      void trace(`listBots FAILED ${error?.code ?? error?.message ?? 'unknown-error'}`)
    }
  })()
}
