# dsh-conversation-completion-reminder

Send a Feishu (Lark) or WeChat card **when a DSH conversation turn finishes** — the task title, a truncated final answer, and the paths (and optionally the files) the turn produced. No polling, no extra bot credentials: it rides on the IM integrations your profile already has.

A long turn usually finishes while you are looking at something else. This bundle makes the result come to you instead of you refreshing the chat list.

## What it does

- **Host half** (`index.js`) watches turn completions (`completed`, `error`, `max-tokens` by default), renders a card, and delivers it through `dsh-feishu` / `dsh-weixin` — the same bot that already talks to you.
- **Client half** (`client.js`) adds a **对话完成提醒** section to the left **Settings** page with five form groups: 开关 / 飞书 / 微信 / 卡片内容 / 推送时机.

Nothing leaves your machine except the card, which goes through the IM bot you connected yourself.

## Requirements

- DSH desktop **0.2.2-rc.1 ≤ version < 0.3.0-0** (`engines.dsh`).
- At least one connected integration under **Integrations → Feishu / WeChat**. With no bot connected the plugin stays enabled but every delivery is skipped with a reason in the trace log.

## Install

```powershell
dsh plugin --profile desktop add dsh-conversation-completion-reminder
```

Or, from the app: **Settings → Plugins → Add plugin**, paste the package name, then enable the `completion-notifier` row and reload the window once.

The bundle's patch inserts the row with `config: {}` — auto-discovery is the default, so it works before you configure anything.

Publishing notes (npm, catalog entry, self-hosted index) live in [docs/PUBLISH.md](docs/PUBLISH.md).

## Configuration

Open **Settings → 对话完成提醒**. Leave the ID fields empty and the plugin discovers the bot from `ctx.dshIm.listBots()` and the recipient from that bot's own integration config (its owner). Fill them in to pin one specific chat.

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch for delivery |
| `botId` / `openId` | `''` (discover) | Feishu bot and receiver |
| `targetId` | `tgt_completion_notifier` | Delivery target key for Feishu |
| `format` | `markdown` | Feishu card body format (`markdown` / `plain`) |
| `weixinEnabled` | `true` | Also push to WeChat |
| `weixinBotId` / `weixinToUserId` | `''` (discover) | WeChat account and receiver |
| `weixinFormat` | `plain` | WeChat body format |
| `cardTitle` | `信息提醒` | Header printed on every card |
| `maxTaskChars` | `2000` | Task text budget (the task is shown whole by design) |
| `maxAnswerChars` | `1200` | Answer text budget |
| `maxArtifacts` | `12` | How many artifact paths are listed |
| `attachFiles` | `true` | Upload the artifacts themselves, not just paths |
| `maxAttachments` | `5` | Per-run upload cap |
| `maxAttachBytes` | `20971520` | Larger files are reported by path only |
| `attachTypes` | `png jpg jpeg gif webp bmp svg pdf txt md csv json yaml yml log doc docx xls xlsx ppt pptx zip 7z tar gz` | Which extensions may be uploaded; an **empty list means no filtering** |
| `titleWaitMs` / `titleWaitSteps` | `400` / `3` | Short wait for the session title to land |
| `skipSubagents` | `true` | Do not report subagent turns |
| `skipSameChannel` | `true` | Do not report a turn back into the chat that just spoke |
| `skipImSessions` | `false` | Drop every IM-originated conversation |
| `skipSessionIds` | `[]` | Session ids to ignore |
| `notifyOn` | `completed, error, max-tokens` | Which turn outcomes produce a card |
| `tracePath` | `$DSH_HOME/completion-notifier.log` | Delivery trail, one line per decision |

### About the receiver IDs

`open_id` is **scoped per Feishu app**: the same person has a different `ou_…` in every bot. DSH learns it when that person messages the bot, and records it as `p2p:<open_id>` in `%USERPROFILE%\.dsh\integrations\dsh-feishu\bots\<bot_id>\state.json`. To push to somebody else, either have them send one message to the bot first, or resolve their ID with `POST /open-apis/contact/v3/users/batch_get_id` (needs contact permission and app availability). An ID copied from another bot's config will not work.

## Known limits

- **WeChat needs a recent inbound message** from the recipient; iLink refuses a chat that has gone quiet (`delivery-failed`). Send the bot one message and the next card goes through.
- WeChat deliveries are plain text; Feishu gets a card with markdown.
- If several bots are connected and no `botId` is pinned, discovery takes the first loaded one.

## Uninstall

Disable or remove the `completion-notifier` row in **Settings → Plugins**. The settings values live in the profile's patch and survive the removal.

## License

MIT
