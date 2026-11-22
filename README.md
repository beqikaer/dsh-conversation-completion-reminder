# dsh-conversation-completion-reminder · 对话完成提醒

一轮对话跑完，飞书或微信自动收到一张卡片：来自哪个入口、第几轮、跑在哪个文件夹、任务是什么、结果如何、产出了哪些文件。

长任务常常在你切去忙别的事情之后才结束，盯着会话列表往往等不到头。装上它，让结果自己找上门。

[English](README.en.md) · 简体中文

## 卡片长什么样

```
🔔 信息提醒
---
💬 来自 飞书 · 信息提醒
🕒 16:03 · 用时 3分42秒
🗂 会话 重构支付回调的重试逻辑
🔁 第 4 轮 · ✅ 完成
📁 E:\work\pay

📝 任务
把支付回调的重试逻辑改成指数退避，并补一个超时用例

💬 结果
已完成。重试封装进 src/pay/retry.ts，退避上限 30 秒……

📦 产物 2 个
1. retry.ts · 4.1 KB
   E:\work\pay\src\pay
2. retry.md · 812 B
   E:\work\pay\docs
```

飞书是 markdown 卡片，微信是等价的纯文本版本（微信要求 CRLF，已处理）。

## 它怎么工作

- **宿主侧**（`index.js`）订阅轮次结束事件，默认处理 `completed`、`error`、`max-tokens` 三种结局，渲染上面那张卡片，再经 `dsh-feishu` / `dsh-weixin` 送出去——用的就是平时跟你对话的那个机器人。
- **浏览器侧**（`client.js`）在左侧 **Settings** 里加一个「对话完成提醒」区块，五组表单：开关 / 飞书 / 微信 / 卡片内容 / 推送时机。
- 除了那张卡片，不向外发任何东西；卡片走的是你自己已经连好的机器人。

## 要求

- DSH desktop **0.2.2-rc.1 ≤ 版本 < 0.3.0-0**（`engines.dsh`）。
- **Integrations** 里至少接好一个飞书机器人或微信账号。一个都没接时插件保持启用，但每次投递都会被跳过，原因写进轨迹日志。

## 安装

```powershell
dsh plugin --profile desktop add dsh-conversation-completion-reminder
```

或者在应用里：**Settings → 插件 → 添加插件**，粘贴包名，启用 `completion-notifier` 行，然后刷新窗口一次。

bundle 自带的 patch 以 `config: {}` 插入这一行，默认走自动发现，什么都不配也能用。

## 快速上手

1. 装好、启用、刷新窗口。
2. 打开 **Settings → 对话完成提醒**，ID 字段先留空（自动发现＝机器人自己的 owner 私聊）。
3. 回会话里跑一轮稍长的任务。
4. 卡片应该就到了。没到就看 `tracePath` 指向的日志，每次投递与否都有一行原因。

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
| `maxTaskChars` | `2000` | 任务文本上限 |
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
| `tracePath` | `$DSH_HOME/completion-notifier.log` | 投递轨迹，每次决策一行 |

### 接收人 ID 从哪来

`open_id` 是**按飞书应用隔离**的：同一个人在「信息提醒」和「文档助手」两个机器人下是两个不同的 `ou_…`。DSH 在对方第一次给这个机器人发消息时拿到它，记进：

```
%USERPROFILE%\.dsh\integrations\dsh-feishu\bots\<bot_id>\state.json
```

形如 `"p2p:ou_…": "session-…"`。

要给其他人推送，两条路：让对方先给机器人发一句话（最省事，DSH 自动记下来），或者用 `POST /open-apis/contact/v3/users/batch_get_id` 拿手机号/邮箱换（需要通讯录权限和应用可用范围）。从别的机器人配置里抄来的 ID 用不了。

## 常见问题

**微信收不到。** iLink 会拒绝已经冷掉的会话（日志里是 `delivery-failed`，原话是 the chat needs a fresh message from the recipient）。让对方给机器人发一条消息，下一张卡片就通了。

**太吵。** 把 `notifyOn` 缩到只剩 `completed`；或者打开 `skipSubagents`、`skipImSessions`；也可以让 `skipSameChannel` 保持开启，避免给正在说话的会话再推一遍。

**不想发文件，只要路径。** 关掉 `attachFiles`，或调小 `maxAttachments` / `maxAttachBytes`。

**只想传某几类产物。** 改 `attachTypes`（逗号分隔的扩展名）；留空表示不限制。

**接了多个机器人。** 自动发现取第一个加载的，想固定就填 `botId`。

**卡片标题想换。** 改 `cardTitle`。

## 卸载

在 **Settings → 插件**里禁用或删除 `completion-notifier` 行即可。配置值留在 profile 的 patch 里，删掉插件也还在。

## 更多

- [docs/DETAIL.md](docs/DETAIL.md)：实现细节、字段语义、投递链路。
- [docs/PUBLISH.md](docs/PUBLISH.md)：npm 发布、目录收录、自建索引三条分发路线。

## 许可

MIT
