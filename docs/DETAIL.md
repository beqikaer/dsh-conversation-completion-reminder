# 对话完成提醒

任意一个对话结束一轮（`turn/end`）时，本插件通过已接入的 IM 机器人**主动**把这一轮的结果摘要与文件产物，同时推送到飞书和微信。

## 为什么需要它

基于定时轮询（schedule + 让模型在最终回复里写汇报）的方案有两个绕不开的问题：

- 会话双向同步会把模型的最终回复原样推送，没变化也会推空占位文字，造成刷屏。
- 每分钟轮询有约 1 分钟延迟，且反复触发"重复工具调用"守卫。

本插件直接监听会话的持久事件 `turn/end`，再调用 `ctx.dshIm.send()` 主动投递。消息不经过模型的最终回复，因此不触发会话同步，既不刷屏也没有轮询延迟。

## 行为

- 每轮结束按 `notifyOn` 判断：默认只报 `completed`、`error`、`max-tokens`；中止、阻塞、中断、分叉不推送。
- 跳过子代理会话（`header.origin === 'subagent'`）。
- **同通道不回声**：一轮若来自飞书某个机器人，就不往同一个飞书机器人回推（提问的人已经在该聊天里看到答案），但仍会推到微信；微信来源同理。这条规则回答的是"谁已经知道了"，比"是 IM 会话就一律不推"精确得多。
- 推送内容：固定标题（由 `cardTitle` 配置，默认「信息提醒」）、来源（哪个通道的哪个机器人 / 定时任务 / 桌面端）、时间与耗时、会话名（标题优先，没有标题用任务首行）、结论（完成/出错/超长）、轮次、完整工作目录、任务全文、结果摘要、产物清单（文件名 + 大小 + 所在目录）、以及出错时的错误信息。
- 产物来源两处：该轮写文件类工具调用（write/edit/apply_patch 等）的 `file_path`，以及任务文本、回答文本里出现的绝对路径。写文件调用记录的路径排在前面。
- 同一会话同一轮次只推一次（内部去重集合），事件重放不会重复发送。
- **两个通道互相独立**：飞书失败不影响微信，反之亦然；某个通道失败只会让它下一次重新尝试创建目标。

## 卡片版式

按手机上一眼能扫的顺序排列：先说这是哪来的提醒，再说是谁发起的、什么时候、哪个对话、第几轮、在哪个目录，最后是任务、结果和产物。

```
✅ 信息提醒
──────────────

⏰ 来自 定时任务
🕒 13:27 · 用时 4 秒
🗂 会话 在 E:\~Ai\Harness\im 目录下创建文件 final-card.t…
🔁 第 1 轮 · ✅ 完成
📁 E:\~Ai\Harness\im

📝 任务
在 E:\~Ai\Harness\im 目录下创建文件 final-card.txt，内容写"最终卡片模板验证"。然后用一句话回复该文件的完整路径。

💬 结果
已在 `E:\~Ai\Harness\im\final-card.txt` 创建该文件，内容为"最终卡片模板验证"。

📦 产物 1 个
1. final-card.txt · 24 B
   E:\~Ai\Harness\im
```

几条取舍：

- **标题固定由 `cardTitle` 决定**（默认「信息提醒」，习惯上就是推送机器人的名字）。这样每条通知都戴同一个名字，一眼就知道是哪来的；任务因此不再挤在标题行里，而是单独一段**完整显示**（不再截 60 字）。标题与分隔线构成一个干净的表头，**下面空一行**才开始写来源，读起来不会把表头当成内容的第一行。
- **来源单独一行**：`💬 来自 飞书 · 信息提醒` / `💬 来自 微信` / `⏰ 来自 定时任务` / `🖥 来自 桌面端`。机器人名取不到时只显示通道，不猜。
- **会话名单独一行，不显示 session id**：`session-f32f5586` 对人没有意义，GUI 侧边栏显示的是名字。新会话的名字由模型在首轮结束后再过一阵才写出来（实测约 1 分钟，那是另一次模型往返），卡片等不了那么久，所以名字还没落地时**用任务首行顶上**（截 40 字），而不是显示「未命名对话」。
- **产物列表只显示文件名和大小，完整路径拆到下一行缩进**。路径是卡片里最难读的部分，通常只需要认文件名。
- **路径会实际 `stat` 一次**：目录标 `· 目录`，不存在的标 `（未找到）`，其余显示体积。这让"提到过这个文件"和"这个文件真在"可以区分开。
- **定时任务触发的轮次会把外壳剥掉**：这种轮次的用户消息是 `[SCHEDULE REMINDER]` + `schedule_id_json` / `occurrence_at` / `reminder_prompt_json` 的机器信封，真正的指令埋在 JSON 字符串里。`tidyTask` 会解析出 `reminder_prompt_json` 里的原文作为任务，否则任务一栏全是噪音。
- **结果里如果整行只是在列举产物路径，这一行会被删掉**，因为下面已经有格式更好的产物清单；但只是顺带提到文件的正常句子保留。
- **去重**：`…\a\b\x.md` 这类相对片段若已被更长的绝对路径覆盖，不会重复列成第二个文件；大小写不同的同一个路径只留一个。
- **微信通道的换行是 CRLF**。iLink 只认 CRLF：只发 LF 时微信客户端会把整段多行消息渲染成一长行（旧卡片送出去的文本确实带着 46 个 `\n`，被客户端吞了）。`renderCard` 在 plain 分支把每个 `\n` 换成 `\r\n`；markdown 分支保持 LF，因为 `chunkMarkdownText` 会把 `\r\n` 归一回去。
- 微信通道不支持飞书 markdown 卡片，`renderCard` 用 `markdown` 开关切成【】加粗的纯文本，分隔线换成 `─`。


## 产物附件

卡片里的产物不仅可以读，还能**直接收下**：卡片发完以后，插件把每个产物作为真正的文件发到同一条聊天里，手机上点一下就是「保存 / 打开」，不用再把路径抄进资源管理器。

- 只发**真的存在且是文件**的产物：目录跳过（没什么可发的），`stat` 失败跳过（那张卡片已经标了「未找到」）。
- 每轮最多 `maxAttachments` 个（默认 5），单个超过 `maxAttachBytes`（默认 20 MB）的只报路径不发文件，避免一次生成几十张图就变成几十次上传。
- 只发 `attachTypes` 里列出的扩展名（默认图片、文档、表格、压缩包等常见类型）；不在列表里的产物仍然出现在卡片里，只是不上传。清空这个列表等于不限制类型。
- 发送顺序是**先卡片后文件**：卡片负责说明「这是什么对话、干了什么」，文件跟在后面。因此卡片发失败时这一轮就不发文件了 —— 没有卡片，收到的文件会莫名其妙。
- 单通道失败不影响另一通道；某个产物上传失败只记 `attach … FAILED …`，不影响其余产物。
- 关掉附件：`attachFiles: false`。

### 为什么不是"点开链接"

"点开链接读取"在桌面端很容易，在这里不可行：DSH 的 Web 服务只 bind 回环地址（`127.0.0.1`，端口每次启动可能不同），手机拿到的 `http://127.0.0.1/…` 指向手机自己；改成局域网 bind 要管理员权限并放开防火墙，而且出门在外还是打不开；Tailscale 虽然装了两个节点但对端离线、没有 `serve` 配置。所以走的是**发文件本体**这条路 —— 不依赖任何本机服务可达性。

### 两边的接口

| 通道 | 接口 | 凭据 |
| --- | --- | --- |
| 飞书 | `tenant_access_token/internal` → `im/v1/files`（multipart）→ `im/v1/messages`（`msg_type: file`） | `integrations/dsh-feishu/config.json` 里该 bot 的 `appId` + `secretRef` 指向的 `.credentials.yaml` 条目 |
| 微信 | `ilink/bot/getuploadurl` → CDN AES-128-ECB 上传 → `ilink/bot/sendmessage`（`file_item`） | `integrations/dsh-weixin/config.json` 里 `tokenRef` 指向的令牌 + 该用户的 `context_token` |

两个通道的 `send()`（`ctx.dshIm.send`）**只带文本**：附件通路在各个通道的 bridge 里，属于"会话内回复"路径，Host 插件够不到（dsh-im 的 `exports` 也没有开放 `src/*`）。所以这里直接说各平台自己的上传协议。

微信的下载参数在 CDN 响应的 **`x-encrypted-param` 响应头**里，不在 body 中；`file_item.len` 是**明文**字节数，`filesize` 才是填充后的密文长度。这两个地方弄错都会得到 `ret: -2 prepare failed`。

## 依赖

只有一样东西是**必须**的：dsh-im 插件提供的宿主服务 `dshIm`。

```js
export const inject = ['dshIm']
```

用到的全部接口就四个：

| 接口 | 用途 |
| --- | --- |
| `ctx.dshIm.listBots()` | 自动发现哪个通道有可用机器人 |
| `ctx.dshIm.createTarget(botId, target)` | 建立投递目标（已存在按成功处理） |
| `ctx.dshIm.send(botId, targetId, text, { format })` | 发卡片正文 |
| `ctx.dshIm.describeConversation(sessionId)` | 判断这一轮是不是从某个 IM 聊天发起的（用于同通道不回声） |

另外三个是 DSH 宿主自带的，不属于任何插件：`ctx.on('session/event', …, { global: true })`（收全站 `turn/end`）、`ctx.sessionTitle.get(session)`（取会话名）、`ctx.credentials.resolve(ref)`（取机器人密钥）。

**不依赖 dsh-im 的任何内部模块。** 附件是直接跟飞书开放平台、微信 iLink 协议对话发出去的（见「产物附件」），既不 import dsh-im 的 `src/*`（它的 `exports` 也没开放），也不依赖它的 bridge。

除此之外只读本机几个配置文件（不写）：

| 文件 | 读什么 |
| --- | --- |
| `$DSH_HOME/integrations/dsh-feishu/config.json` | `bots[].id`、`appId`、`secretRef`、`ownerOpenIds[0]` |
| `$DSH_HOME/integrations/dsh-weixin/config.json` | `accounts[].botId`、`tokenRef`、`ownerUserId`、`baseUrl` |
| `$DSH_HOME/integrations/dsh-weixin/accounts/<botId>/state.json` | `contextTokens.users[<toUserId>].token` |
| `$DSH_HOME/.credentials.yaml` | `refs:` 段（`ctx.credentials` 拿不到时的兜底） |

`$DSH_HOME` 取环境变量，没有就退回 `~/.dsh`。

## 通道与账号

机器人、接收人、目标 ID **全部可配**，代码里没有写死任何账号：

| 配置项 | 飞书 / 微信 | 含义 |
| --- | --- | --- |
| `botId` | 飞书 | `integrations/dsh-feishu/config.json` 里的 `bots[].id` |
| `openId` | 飞书 | 接收人 Open ID，通常就是该 bot 的 `ownerOpenIds[0]` |
| `weixinBotId` | 微信 | `integrations/dsh-weixin/config.json` 里的 `accounts[].botId` |
| `weixinToUserId` | 微信 | 接收人 id，通常就是该账号的 `ownerUserId` |
| `targetId` / `weixinTargetId` | 两者 | 投递目标别名，默认 `tgt_completion_notifier` / `tgt_completion_notifier_wx` |
| `cardTitle` | 两者 | 卡片顶部固定的名字，默认「信息提醒」 |
| `tracePath` | 两者 | 追踪日志路径，默认 `$DSH_HOME/completion-notifier.log` |

**留空 = 自动发现。** 四个账号字段都空着也能跑：挂载时先从 `ctx.dshIm.listBots()` 找已加载的机器人，再回落到集成配置文件的第一条，然后**从同一个条目**同时取机器人 id 和接收人 id。

按条目配对是刻意的：`appId`、`secretRef`、`ownerOpenIds` 都长在同一条 config 记录上，拿 A 条的机器人配 B 条的接收人，密钥就够不到那个聊天。所以选择顺序是「配置指定 → 宿主已加载 → 第一条」，然后整条一起用。

`cordis.patch.yml` 里的 `config:` 填了就钉住具体聊天，留空就自动发现。同一条 patch 因此既能带着本机账号跑，也能原样拷到新机器上跑。

## 可视化配置

不用改文件，直接在界面里改。有两个入口：

1. **插件页**：左侧 **Plugins** → 找到 `dsh-conversation-completion-reminder` → 展开包详情，点行名 **`completion-notifier`**（行名右边有个 `›`）。
2. **设置菜单**：左侧 **Settings** 里会出现「对话完成提醒」区块，展示同一套表单。

两个入口背后是同一个 `ConfigPage` 组件，保存后都热生效。

配置页右侧固定挂着一块「这些 ID 从哪来」的说明：飞书的 `bot_…` / `ou_…` 和微信的 `wx_…` / `…@im.wechat` 分别对应 `%USERPROFILE%\.dsh\integrations\dsh-feishu\config.json` 的 `bots[].id`、`bots[].ownerOpenIds[0]` 和 `dsh-weixin\config.json` 的 `accounts[].botId`、`accounts[].ownerUserId`，两条路径都能一键复制；页头还有「收起 ID 说明」可以把它折叠掉（窗口窄的时候这块会自动落到表单下方）。

`open_id` 是**按应用隔离**的用户标识：同一个人在「信息提醒」和「文档助手」两个飞书应用下是两个不同的 `ou_…`。DSH 是在这个人第一次给机器人发消息时拿到它的——`integrations\dsh-feishu\bots\<bot_id>\state.json` 里的 `sessions` 就是以 `p2p:ou_…` 为键，同时这个人被记为 `ownerOpenIds`。所以给非 owner 推送时，要填的是**同一个应用下**对方的 `open_id`，不是从另一个机器人那儿抄来的值。

保存是**热生效**的：`turn/end` 之后插件会重读一次配置（`refresh()`），发现变化就重建投递通道并清掉旧的目标缓存，日志里会出现一行 `config changed; channels=… title=…`。不重启 Harness，也不丢已创建的投递目标和本轮去重记录。

**能改哪些由 `.volatile()` 决定。** 宿主的设置表单只收录标了 volatile 的字段——一个字段都没标，这个插件根本不会出现在设置文档里（`dsh-settings` 的 `describe()` 遇到空 volatile 子树直接返回 `[]`）。所以 `index.js` 里除 `skipSessionIds`、`notifyOn` 两个数组外全部标了 volatile。这两个数组故意不标：它们在文件里手写更省事，走表单往返反而容易出错。

两个实现细节值得记下来，改这个插件时会再撞上：

- **读取 volatile 字段必须 `.get()`。** 声明了 `.volatile()` 的字段解析出来不是值，而是 `{ get() }` 活引用——直接当字符串用会拿到 `[object Object]`。`index.js` 用 `isLiveRef()` / `liveValue()` 两个小函数统一处理，并且把读取从挂载时一次改成每次 `deliver()` 前重读，否则配置改了也看不见。
- **peer 依赖要用 `createRequire` 锚定 profile 目录。** 这个 bundle 是用 `link:` 装进 profile 的，Node 按真实路径（`E:\~Ai\Harness\im\completion-notifier-plugin`）找 `node_modules`，那里没有 `@deepseek-ai/schemastery`，裸 `import()` 必然 `ERR_MODULE_NOT_FOUND`——而 `catch` 一吞，`Config` 就成了 `undefined`，配置页永远空白且不报错。`importPeer()` 依次尝试 `DSH_PROFILE_DIR`、`$DSH_HOME/profiles/$DSH_PROFILE`、`~/.dsh/profiles/desktop`，用 `createRequire(dir + '/package.json')` 解析到 profile 里那一份 schemastery。

`client.js` 侧的约定：注册的是 `plugins.row.config` 槽，key 是 `包名#rowId`（`dsh-conversation-completion-reminder#completion-notifier`）。**rowId 必须等于 patch 里 `insert[].id`**，因为宿主取表单时用 `formFor(rowId)`，而命名空间就是 entry id；两者不一致，页面上永远拿不到 form。`inject` 只声明 `['slots', 'locale']`——**读一个没在 `inject` 里声明的服务会直接抛 `cannot get property "..." without inject`**，这个异常从 `apply` 冒出去会让整个 boot entry 变成 inactive，区块完全不出现；所以配置服务（`configForms`）一律用 `ctx.get()` 探测，`locale` 则声明出来。

## 配置

配置项由 `Config` 暴露，默认值写在 `index.js` 的 `DEFAULTS`；可在上面的可视化配置页里改，也可以直接写进 `cordis.patch.yml` 的 `config:`：

- `botId` / `openId` / `targetId`：飞书投递的机器人、接收人 Open ID、目标别名。**留空自动发现。**
- `format`：飞书格式 `markdown`（默认）或 `plain`。
- `weixinEnabled` / `weixinBotId` / `weixinToUserId` / `weixinTargetId` / `weixinFormat`：微信通道，`weixinEnabled: false` 可整体关掉；账号字段同样**留空自动发现**。
- `cardTitle`：卡片顶部固定的名字，默认「信息提醒」。
- `tracePath`：追踪日志路径，默认 `$DSH_HOME/completion-notifier.log`。
- `maxTaskChars` / `maxAnswerChars` / `maxArtifacts`：任务、结果与产物的截断上限（两通道共用）。任务默认 2000 字，基本等于不截断。
- `attachFiles` / `maxAttachments` / `maxAttachBytes` / `attachTypes`：是否把产物作为真实文件发出、每轮上限个数、单个上限体积、允许上传的扩展名（留空＝不限制）。
- `titleWaitMs` / `titleWaitSteps`：会话名还没生成时最多等几轮、每轮多少毫秒（默认 400×3）。等不到就用任务首行代替，不会因此拖延卡片。
- `skipSubagents` / `skipSameChannel` / `skipImSessions` / `skipSessionIds`：跳过规则。`skipSameChannel` 默认 `true`（不回推给提问的那个通道），`skipImSessions` 默认 `false`（不再整体屏蔽 IM 会话，交给 `skipSameChannel` 精准判断）。
- `notifyOn`：哪些 `turn/end` 原因要推送。

## 排错

宿主没有可读的运行日志，所以插件把自己每次动作追加写到 `tracePath`（默认 `$DSH_HOME/completion-notifier.log`，本机是 `E:\~Ai\Harness\im\completion-notifier.log`）。

每行是 `ISO 时间 + 事件`，包括：

- `mounted; channels=…`：这次挂载推送哪几个通道、机器人、卡片标题。
- `routes: …`：四个账号字段解析出了什么（自动发现或配置直读）。
- `bots: …`：宿主当时暴露的 bot 与通道，用来确认微信 bot 是否在线。
- `target created` / `target already present` / `target FAILED`：目标创建情况。
- `skip …`：被跳过的轮次及原因。
- `sent <通道> …`：卡片投递成功。
- `attach <通道> …`：产物附件的结果（`sent 29 B` / `FAILED <code>` / `no-context-token` / `no-sender`）。
- `send FAILED <通道> …`：投递失败及错误码。

没有 `sent` 行说明链路上某处被跳过了，看紧邻的 `skip` 行即可。日志超过 512KB 会自动只保留后半段。

**`send FAILED weixin … delivery-failed`** 是 iLink 直接拒发，最常见的两个原因：接收者的 `context_token` 太旧（微信的会话窗口有有效期，让 TA 给 bot 发一条消息即可续期），或该会话的发送额度用尽。这不是插件参数问题，重装/重配都无用。飞书同一轮通常仍成功。

## 局限

- 依赖 `dshIm` 服务与各通道机器人处于连接状态；机器人离线时投递失败，日志记为 `send FAILED … bot-not-connected`。
- 自动发现只会挑**一个**机器人（配置指定 → 宿主已加载 → 配置文件第一条）。同一通道挂了多个机器人时，想要别的那个得显式写 `botId` / `weixinBotId`。
- 自动发现的接收人取该条目上的 owner id；要推给别人（非 owner）必须显式写 `openId` / `weixinToUserId`。
- 微信主动投递要求该 bot 与该用户之间已存在 `context_token`（即对方先给 bot 发过消息）；从未聊过的用户无法主动推送，这是微信侧的限制，不是插件能绕过的。发附件同样需要它。
- 产物路径来自文本与工具参数；`（未找到）` 只说明 stat 失败，可能是还没写完，也可能是模型随口提的路径。
- 每轮只 `stat` 前 `maxArtifacts` 个路径，超出的不检查存在性；只有其中前 `maxAttachments` 个会被真的上传。
- 只按 `turn/end` 的机器原因判断，不理解任务在语义上是否成功。
- 附件通路直连各平台 API，用的是 `.dsh` 里已有的机器人凭据；换机器人只需改 `Config`，凭据仍从 `integrations/*/config.json` 指向的条目自动取。
