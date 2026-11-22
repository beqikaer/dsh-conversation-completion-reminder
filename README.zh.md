# dsh-conversation-completion-reminder / 对话完成提醒

一轮对话结束时，通过**飞书或微信**推一张卡片：任务标题、截断后的最终回答、这一轮产出的文件路径（可选连文件一起发）。不用轮询，也不需要额外的机器人凭据——它复用你 profile 里已经接好的 IM 集成。

长任务往往在你看别处的时候结束。这个 bundle 让结果来找你，而不是你反复刷会话列表。

## 它做什么

- **宿主侧**（`index.js`）监听轮次结束（默认 `completed`、`error`、`max-tokens`），渲染卡片，再经 `dsh-feishu` / `dsh-weixin` 送出——就是平时跟你说话的那个机器人。
- **浏览器侧**（`client.js`）在左侧 **Settings** 里加一个 **对话完成提醒** 区块，五组表单：开关 / 飞书 / 微信 / 卡片内容 / 推送时机。

除了走你自己接的机器人发那张卡片，不向外发任何东西。

## 要求

- DSH desktop **0.2.2-rc.1 ≤ 版本 < 0.3.0-0**（`engines.dsh`）。
- **Integrations** 里至少接好一个飞书机器人或微信账号。一个都没接时插件保持启用，但每次投递都会被跳过，原因写进日志。

## 安装

```powershell
dsh plugin --profile desktop add dsh-conversation-completion-reminder
```

或者：**Settings → Plugins → Add plugin** 粘贴包名，启用 `completion-notifier` 行，然后刷新一次窗口。

patch 以 `config: {}` 插入这一行——默认走自动发现，不配置也能用。

发布与上架说明（npm、目录条目、自建索引）见 [docs/PUBLISH.md](docs/PUBLISH.md)。

## 配置

打开 **Settings → 对话完成提醒**。ID 留空即自动发现：机器人来自 `ctx.dshIm.listBots()`，接收人来自该机器人自己的集成配置（它的 owner）。填上则固定某一个会话。

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `botId` / `openId` | `''`（自动） | 飞书机器人与接收人 |
| `targetId` | `tgt_completion_notifier` | 飞书投递目标键 |
| `format` | `markdown` | 飞书卡片正文格式（`markdown` / `plain`） |
| `weixinEnabled` | `true` | 同时推微信 |
| `weixinBotId` / `weixinToUserId` | `''`（自动） | 微信账号与接收人 |
| `weixinFormat` | `plain` | 微信正文格式 |
| `cardTitle` | `信息提醒` | 每张卡片的标题 |
| `maxTaskChars` | `2000` | 任务文本上限（默认完整显示） |
| `maxAnswerChars` | `1200` | 回答文本上限 |
| `maxArtifacts` | `12` | 列出多少个产物路径 |
| `attachFiles` | `true` | 连产物文件一起发，而不只是路径 |
| `maxAttachments` | `5` | 单轮上传上限 |
| `maxAttachBytes` | `20971520` | 超过只报路径 |
| `attachTypes` | `png jpg jpeg gif webp bmp svg pdf txt md csv json yaml yml log doc docx xls xlsx ppt pptx zip 7z tar gz` | 允许上传的扩展名；**留空表示不限制** |
| `titleWaitMs` / `titleWaitSteps` | `400` / `3` | 短暂等待会话标题生成 |
| `skipSubagents` | `true` | 不报子代理的轮次 |
| `skipSameChannel` | `true` | 不把结果推回刚刚说话的那个会话 |
| `skipImSessions` | `false` | 丢弃所有来自 IM 的会话 |
| `skipSessionIds` | `[]` | 忽略的会话 id |
| `notifyOn` | `completed, error, max-tokens` | 哪些结束状态发卡片 |
| `tracePath` | `$DSH_HOME/completion-notifier.log` | 投递轨迹日志 |

### 关于接收人 ID

`open_id` 是**按飞书应用隔离**的：同一个人在「信息提醒」和「文档助手」下是两个不同的 `ou_…`。DSH 在对方第一次给机器人发消息时拿到它，并记进 `%USERPROFILE%\.dsh\integrations\dsh-feishu\bots\<bot_id>\state.json` 的 `p2p:<open_id>`。要给其他人推送：让对方先给机器人发一句话，或用 `POST /open-apis/contact/v3/users/batch_get_id`（需要通讯录权限与可用范围）换。从别的机器人那里抄来的 ID 用不了。

## 已知限制

- **微信要求对方最近说过话**：iLink 会拒绝已经冷掉的会话（`delivery-failed`）。让对方给机器人发一条消息，下一张卡片就能送达。
- 微信是纯文本；飞书是 markdown 卡片。
- 接了多个机器人又没固定 `botId` 时，自动发现取第一个加载的。

## 卸载

在 **Settings → Plugins** 里禁用或删除 `completion-notifier` 行即可。配置值留在 profile 的 patch 里，删掉也还在。

## 许可

MIT
