# 发布 / 上架

三条路，按「今天就能被装」到「进入官方市场」排序。

## 1. 发 npm（今天就能用）

```powershell
cd E:\~Ai\Harness\im\release\dsh-conversation-completion-reminder
npm login
npm publish            # publishConfig 已写 public
npm view dsh-conversation-completion-reminder version
```

别人这样装：

```powershell
dsh plugin --profile desktop add dsh-conversation-completion-reminder
```

或者 **Settings → Plugins → Add plugin** 填包名。包里有预构建产物，安装时不会触发 `allowBuilds` 审批。

> 打 `v*` tag 会触发 `.github/workflows/publish.yml`（带 npm provenance），用之前先在仓库 secrets 里配 `NPM_TOKEN`。

## 2. 进官方目录：awesome-dsh-plugin（真正的「上架」）

市场列表来自 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)，站点和 DSH 内市场都会自动收录，通常 1 天内生效。

1. Fork 那个仓库，新建 `data/plugins/beqikaer__dsh-conversation-completion-reminder.yml`，内容就是本仓库根目录的 [`awesome-entry.yml`](../awesome-entry.yml)。
2. 发一个 PR（一个 PR 最多 3 条）。

审阅会卡这些点，都已经满足，别改坏：

- `package.json` 里有 `dsh.bundle`（只写 `dsh.client` 会被直接拒）。
- 仓库至少建满 24 小时、带 `dsh-plugin` topic。
- 描述要和代码对得上，不写「最好用」这类形容词。
- 图标必须是 GitHub 上的**栅格**图（`assets/icon-180.png`），SVG 会被拒。
- 已发 npm 的包，`repository` 字段必须指回这个仓库；条目里不要手写 `npm:` 键。
- 截图放自己仓库根目录的 `screenshots.json`（1–8 张，GitHub https 绝对地址），条目里不写截图。

合并后只改自己那一个文件，不要动自动生成的 README。

## 3. 自建索引（不用等审阅，但要开实验性 bundle）

本仓库根目录的 `index.json` 是 format-1 市场索引，已用 `@deepseek-ai/dsh-plugin-market-index` 的真实校验器跑过（`icon` 是内联 data URL，7 KiB，未超 32 KiB 上限；安装参数解析为 `dsh-conversation-completion-reminder@1.0.0`）。

用法：

1. 把 `index.json` 放到任一公网 https 地址。推荐 GitHub Pages：仓库 **Settings → Pages → Deploy from a branch → main / (root)**，得到
   `https://beqikaer.github.io/dsh-conversation-completion-reminder/index.json`
   ；国内可用 jsDelivr 镜像 `https://cdn.jsdelivr.net/gh/beqikaer/dsh-conversation-completion-reminder@main/index.json`（有缓存延迟）。
2. 启用实验性市场 bundle `@deepseek-ai/dsh-experimental-plugin-market-bundle`（它挂载 `plugin-market` 服务并加一个 Discover 页；默认 profile 不带这个 bundle）。加进 profile 的 `dsh.profile.bundles` 后重载。
3. 在该 Discover 页的索引设置里填入上面的 URL，或直接写进 patch：

```yaml
- id: plugin-market
  config:
    indexes:
      - https://beqikaer.github.io/dsh-conversation-completion-reminder/index.json
```

注意：DSH 自带的 dshmarket（第三方市场插件）不读这种索引，它只读 awesome-dsh-plugin 的目录。所以这条路是给「官方市场机制 + 自建源」用的，不是替代第 2 步。

索引没有签名：条目里的名称和版本只是索引的声明，真正装什么由包自己的 manifest 决定。
