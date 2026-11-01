# ds-pstack

把 [cursor/plugins](https://github.com/cursor/plugins) 里 `pstack/` 的**全套 58 个 skill**（`poteto-mode` + 57 个）原样搬进 DeepSeek Harness（DSH），并注册成一个运行时 skill provider。

- **正文零改动**：`skills/` 逐字节 vendor，不插指针、不改 frontmatter、不改工具名。
- **适配在运行时和文档里做**：`lib/` 提供 provider，`docs/harness/dsh.md` 提供 Cursor → DSH 的六张映射表。
- **可校验**：`skills.manifest.json` 记录 535 个文件的 sha256，`scripts/check-vendor.mjs` 一条命令重算。
- **上游升级成本低**：重新 `cp -r` 上游 `pstack/skills`，重算 manifest 即可。

## 安装

本包是标准 DSH npm bundle 插件（`cordis.patch.yml` + `dsh.bundle.patch`）。发布或在本地打包后，用 DSH 的插件管理入口装进某个 profile：

```sh
dsh plugin --profile <profile> add /path/to/ds-pstack-0.1.0.tgz
```

装完重启 `dsh web`。**本仓库不负责把它装进任何现有 profile。** 加载是否成功可以用：

```sh
dsh --profile <profile> --dump-config | grep -A2 ds-pstack
```

输出里出现 `id: ds-pstack` / `name: ds-pstack` 即 bundle patch 已合入；若启动时 stderr 出现 `skipping profile bundle "ds-pstack"`，说明没加载上，原因就在该行后面。

## 运行时行为

`lib/index.js` 只做一件事：

```js
export const name = 'ds-pstack'
export const inject = ['skills']
export function apply(ctx) {
  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider()))
}
```

provider 运行时扫描 `skills/*/SKILL.md`，每个 skill 返回：

| 字段 | 值 |
| --- | --- |
| `name` / `description` | 上游原值 |
| `whenToUse` | 从 description 的 `Use for ...` 句尾拆出；拆不出就省略（58 个里 25 个有） |
| `source` / `provider` | `runtime` / `ds-pstack` |
| `rank` | `900`（低于项目级 100/200，不遮蔽用户 skill） |
| `resourceBase` | `{ kind: 'directory', path: 'skills/<name>' }` |
| `invocation` | `{ modelInvocable: true, userInvocable: true }` |
| `metadata.upstream` | 上游仓库、路径、SHA，以及原 `disable-model-invocation` / `paths` / `icon` / `color` |
| `content` | 正文前置一行 DSH 适配说明，其余原样 |

`resourceBase` 是 playbook 能被读到的关键：DSH 的 `skill` 工具没有子路径参数，模型拿到 base directory 后用 `read` 读 `skills/poteto-mode/playbooks/feature.md`。

### 有意的语义偏离

上游 57 个 skill 带 `disable-model-invocation: true`。DSH 的 `skill` 工具是模型加载 skill 的唯一通道，照搬会把 `poteto-mode` 的路由链全部切断，因此 provider 统一返回 `modelInvocable: true`。上游原值保留在 `metadata.upstream.disableModelInvocation` 里，`skills/` 一个字节没改。详见 [`docs/harness/dsh.md`](docs/harness/dsh.md) 末尾「语义映射说明」。

## 目录

```
package.json
cordis.patch.yml
lib/index.js          # 插件入口
lib/provider.js       # createSkillProvider()
lib/frontmatter.js    # 最小 YAML frontmatter 解析
skills/               # 上游 58 个 skill 目录，535 文件，逐字节 vendor
docs/harness/dsh.md   # Cursor → DSH 适配指南（六张表 + 语义说明）
skills.manifest.json  # 每个 vendor 文件的 sha256
scripts/check-vendor.mjs  # 校验 vendor 未被改动
scripts/smoke.mjs         # 不装 profile 的 provider 冒烟测试
LICENSE               # 上游 MIT 原文（Copyright (c) 2026 Lauren Tan）
NOTICE                # 来源、pin SHA、vendor / 新增边界
```

## 校验

```sh
# vendor 完整性：535 个文件 hash + 与上游 checkout 逐字节比对
node scripts/check-vendor.mjs --source /path/to/cursor/plugins/pstack/skills

# provider 冒烟：58 条候选、抽样正文、resourceBase、frontmatter 解析
node scripts/smoke.mjs

# 打包内容
npm pack --dry-run
```

## 许可

`skills/` 来自 `cursor/plugins@pstack@ae5650fe`，MIT，Copyright (c) 2026 Lauren Tan，未作修改。
`lib/`、`docs/`、`scripts/` 及构建文件为本项目新增，同样 MIT。完整归属见 [NOTICE](NOTICE)。
