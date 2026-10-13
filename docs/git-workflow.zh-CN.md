# DBX Git 提交、推送与上游同步说明

本文适用于 Windows PowerShell 和本地仓库 `E:\github\dbx`。按步骤执行，前一步失败时先处理错误，不继续提交或推送。

## 1. 当前仓库和几个概念

2026-10-10 编写本文时核对的配置如下，后续以 `git remote -v` 和 `git branch --show-current` 的实际输出为准。

| 项目 | 当前值 | 用途 |
| --- | --- | --- |
| 本地目录 | `E:\github\dbx` | 修改代码、检查和提交 |
| 当前分支 | `codex/query-multi-sort` | 保存当前功能改动 |
| `origin` | `https://github.com/wushuang3625/dbx.git` | 你的仓库，日常推送到这里 |
| `upstream` | `https://github.com/t8y2/dbx.git` | 原项目，获取它的更新 |

- **工作区**：你正在修改的文件，修改后不会自动上传。
- **暂存区**：通过 `git add` 选出的改动，下一次提交只包含这里的内容。
- **提交（commit）**：把暂存区保存为本地历史记录，不会上传到 GitHub。
- **推送（push）**：把本地提交上传到指定远端分支。
- **合并（merge）**：把另一条分支的历史合入当前分支。
- **PR**：请求把一个分支合入另一个分支；推送分支并不等于它已经进入 `main`。

修改远端地址不会修改分支、提交历史或代码，也不会改变 DBX 应用内的自动更新地址。

## 2. 提交前先检查

```powershell
cd E:\github\dbx
git branch --show-current
git remote -v
git status --short
git diff --stat
git diff
git diff --cached
git diff --check
```

常见状态：` M` 表示已跟踪文件有尚未暂存的修改；`M ` 表示修改已经暂存；`??` 表示新文件尚未被 Git 跟踪。新文件不会出现在普通 `git diff` 中，需要单独打开阅读，暂存后再用 `git diff --cached` 查看。

确认文件都属于这次任务，不包含密码、Token、连接配置、真实数据库数据或构建产物。按功能选择文件，避免直接使用 `git add .` 把其他任务的改动一起提交。

本次功能主要涉及前端，可先执行：

```powershell
pnpm check
pnpm --dir docs content:check
```

`pnpm check` 包含连接类型只读校验、前端格式、lint、类型检查和根 Vitest 配置选中的测试，不等于 Rust、所有独立 package 或完整安装包构建通过。当前根 Vitest 配置包含 `packages/app-tests/*.test.ts`；实际布局和交互还需要在浏览器或桌面端验证。

检查期间如果修改或生成了文件，重新查看 diff。本文列出的检查是操作步骤，不代表已经执行或通过。详细规则见 [PR 提交与 CI 核查](testing/pr-preflight.md)。

2026-10-10 本机另行运行文档站内容检查时，脚本将现有 MDX 页面的 CRLF 换行误判为 `missing frontmatter`：它只匹配 `---\n`，而文件使用 `---\r\n`。这次检查失败，不能记为通过，也不应据此批量删除或重建页面。本文是 `docs/` 下的内部 Markdown 说明，不属于该脚本扫描的 `docs/content/docs/*.mdx`；本文的路径、链接、代码围栏和空白检查已单独完成。

## 3. 当前改动建议分成两个功能提交

下面的文件清单对应编写本文时的本地改动。以后新增、删除或调整文件时，先核对清单，再暂存。执行前如果暂存区已有其他任务的文件，先整理暂存区。

### 3.1 提交当前页多列排序

改动内容：

- 点按排序按钮默认对当前页排序，循环切换升序、降序和取消。
- `Alt` 点按追加、调整或移除排序列，保留其他列的顺序，并显示优先级。
- 普通视图和转置视图支持相同操作，数据库排序仍可从菜单选择。
- 标签页和结果缓存保存多列排序状态，保持行、Mongo 文档及大字段对应关系。
- 调整表头宽度，更新相关测试及中英文数据网格说明。

暂存这些文件：

```powershell
$taskGridFiles = @(
  "apps/desktop/src/App.vue"
  "apps/desktop/src/components/grid/DataGrid.vue"
  "apps/desktop/src/components/grid/__tests__/DataGridTransposeSort.spec.ts"
  "apps/desktop/src/components/layout/ContentArea.vue"
  "apps/desktop/src/components/layout/querySurfaces.ts"
  "apps/desktop/src/composables/__tests__/useDataGridActions.spec.ts"
  "apps/desktop/src/composables/__tests__/useDataGridColumnResize.spec.ts"
  "apps/desktop/src/composables/useDataGridActions.ts"
  "apps/desktop/src/composables/useDataGridSort.ts"
  "apps/desktop/src/composables/useNeo4jNodeTableResult.ts"
  "apps/desktop/src/lib/__tests__/app/openTabsPersistence.spec.ts"
  "apps/desktop/src/lib/__tests__/dataGrid/dataGridSort.spec.ts"
  "apps/desktop/src/lib/__tests__/tabs/tabResultCache.spec.ts"
  "apps/desktop/src/lib/__tests__/neo4j/neo4jNodeResult.spec.ts"
  "apps/desktop/src/lib/app/openTabsPersistence.ts"
  "apps/desktop/src/lib/dataGrid/dataGridColumnWidth.ts"
  "apps/desktop/src/lib/dataGrid/dataGridSort.ts"
  "apps/desktop/src/lib/dataGrid/dataGridViewStateCache.ts"
  "apps/desktop/src/lib/tabs/tabResultCache.ts"
  "apps/desktop/src/stores/__tests__/queryStore.hiddenPrimaryKey.spec.ts"
  "apps/desktop/src/stores/__tests__/queryStore.resultViewGeneration.spec.ts"
  "apps/desktop/src/stores/queryStore.ts"
  "apps/desktop/src/types/database.ts"
  "docs/content/docs/data-grid.cn.mdx"
  "docs/content/docs/data-grid.mdx"
  "packages/app-tests/dataGridColumnWidth.test.ts"
)
git add -- $taskGridFiles
git diff --cached --stat
git diff --cached
git diff --cached --check
```

确认暂存内容后提交：

```powershell
git commit -m "feat(grid): support current-page multi-column sorting" -m "Default column sorting to the current page. Support Alt-click to preserve and update sort priorities in normal and transposed views. Persist multi-column sort state and update header widths, tests, and documentation."
```

### 3.2 提交 SQL 文件定位

改动内容：

- SQL 文件面板增加“定位当前文件”按钮。
- 展开父目录、选中文件并滚动到其位置；必要时加入所在目录。
- 未保存的查询无法定位；缺失或被筛选隐藏的文件显示提示。
- 新增定位行为测试，补齐 11 种语言文案及中英文查询编辑器说明。

暂存这些文件：

```powershell
$taskSqlFileFiles = @(
  "apps/desktop/src/components/layout/SqlFilePanel.vue"
  "apps/desktop/src/components/layout/__tests__/SqlFilePanel.locate.spec.ts"
  "apps/desktop/src/components/layout/__tests__/SqlFilePanel.locateExtended.spec.ts"
  "apps/desktop/src/i18n/locales/az.ts"
  "apps/desktop/src/i18n/locales/en.ts"
  "apps/desktop/src/i18n/locales/es.ts"
  "apps/desktop/src/i18n/locales/it.ts"
  "apps/desktop/src/i18n/locales/ja.ts"
  "apps/desktop/src/i18n/locales/ko.ts"
  "apps/desktop/src/i18n/locales/pt-BR.ts"
  "apps/desktop/src/i18n/locales/ru.ts"
  "apps/desktop/src/i18n/locales/tr.ts"
  "apps/desktop/src/i18n/locales/zh-CN.ts"
  "apps/desktop/src/i18n/locales/zh-TW.ts"
  "docs/content/docs/query-editor.cn.mdx"
  "docs/content/docs/query-editor.mdx"
)
git add -- $taskSqlFileFiles
git diff --cached --stat
git diff --cached
git diff --cached --check
```

确认暂存内容后提交：

```powershell
git commit -m "feat(sql-files): locate the active SQL file in the sidebar" -m "Expand parent folders, select the active SQL file, and scroll it into view. Handle unsaved, hidden, and missing files, and add component tests, translations, and documentation."
```

上面两段提交说明没有声称测试通过；实际运行检查后，再在 PR 或交付说明中记录结果。

### 3.3 如需提交这份操作文档

可以单独保存为一个文档提交：

```powershell
git add -- docs/git-workflow.zh-CN.md
git diff --cached
git diff --cached --check
git commit -m "docs: explain local commits and upstream synchronization"
```

### 3.4 提交后核对

每次提交后执行：

```powershell
git show --stat HEAD
git status --short
git diff
git diff --check
```

仓库的提交钩子会格式化暂存的前端文件和指定 Rust 目录，因此需要核对提交后的实际内容。钩子或检查失败时先处理错误，不跳过钩子来伪造通过。

编写本文时，`crates/dbx-core/assets/database-drivers.manifest.json` 和 `src-tauri/Cargo.toml` 被状态标为修改，但内容 diff 为空，未纳入上述功能清单。如果后续出现实际内容差异，单独确认原因，不直接覆盖或还原。

## 4. 把提交推送到你的仓库

确认当前分支和推送地址：

```powershell
git branch --show-current
git remote get-url --push origin
git log -3 --oneline
git push -u origin HEAD
```

`HEAD` 表示当前分支的最新提交。在当前分支执行会推送到你的 `codex/query-multi-sort` 分支，不会直接修改远端 `main`。

如需进入自己的 `main`，在 GitHub 上向 `wushuang3625/dbx` 创建 PR：目标分支选 `main`，来源分支选 `codex/query-multi-sort`。检查完成后再合并；不要误把 PR 目标选成原项目。

以后在同一分支正常提交后可继续执行 `git push origin HEAD`。推送成功不代表 CI 通过、PR 合并或版本已经发布。

## 5. 以后合并原项目更新

### 5.1 确认两个远端

```powershell
git remote -v
```

当前已经配置 `upstream`，不要重复添加。只在新环境缺少它时执行：

```powershell
git remote add upstream https://github.com/t8y2/dbx.git
```

### 5.2 在需要更新的分支合并

先提交本地需要保留的改动，确保工作区和暂存区干净。执行下面的只读查询可以核对原项目默认分支：

```powershell
git ls-remote --symref upstream HEAD
```

下面以原项目主分支 `main` 为例；如果返回其他默认分支名，相应替换命令中的 `upstream/main`。

```powershell
git branch --show-current
git status --short
git fetch upstream
git log --oneline HEAD..upstream/main
git merge upstream/main
```

合并目标始终是当前分支。例如，在 `codex/query-multi-sort` 执行就更新这个功能分支；如需直接更新本地 `main`，应在工作区干净时先执行 `git switch main`，并确认它包含你准备保留的提交。

合并完成后查看范围，再根据上游改动选择检查：

```powershell
git log -5 --oneline
git status --short
pnpm check
```

如果上游涉及 Rust、Agent、插件或构建流程，补做相应检查，不能仅以前端检查作为全部验证。检查成功后推送到自己的仓库：

```powershell
git push origin HEAD
```

获取和合并上游代码不会向原项目写入；日常推送仍使用 `origin`。

## 6. 合并冲突和常见操作

### 合并提示冲突

1. 执行 `git status` 和 `git diff --name-only --diff-filter=U` 查看冲突文件。
2. 打开这些文件，理解双方修改，处理 `<<<<<<<`、`=======`、`>>>>>>>` 标记，保存最终需要的内容。
3. 对每个已解决文件执行 `git add -- "实际文件路径"`，把示例路径替换成真实路径。
4. 再执行 `git diff --name-only --diff-filter=U`，确认没有未解决冲突；用 `git diff --cached` 和 `git diff --cached --check` 检查合并内容。
5. 执行 `git merge --continue` 完成合并，再验证并推送。

不要一律选择“保留当前”或“保留传入”，否则可能丢失自己的功能或上游修复。

### 取消尚未完成的合并

```powershell
git merge --abort
```

该命令用于仍在进行的合并；已经完成的提交需要另行判断处理方式。合并前保持工作区干净，可减少取消合并时恢复本地改动的困难。

### 文件暂存错了，但想保留修改

```powershell
git restore --staged -- "实际文件路径"
```

这里只撤销该文件的暂存，保留工作区修改。替换路径后执行，不要省略 `--staged`。

### 推送被拒绝，因为远端有新提交

先保持工作区干净，在当前分支执行：

```powershell
git fetch origin
git log --oneline --left-right HEAD...origin/codex/query-multi-sort
git merge origin/codex/query-multi-sort
```

示例针对当前功能分支，其他分支应替换为相应的远端分支名。合并并验证后再执行 `git push origin HEAD`，不要用强推覆盖远端新增提交。

## 7. 日常操作顺序

检查改动 → 运行相关验证 → 选择文件暂存 → 检查暂存内容 → 本地提交 → 核对提交 → 推送到 `origin`。

同步原项目：提交本地改动 → 保持工作区干净 → 获取 `upstream` 更新 → 合并到当前分支 → 处理冲突 → 验证 → 推送到 `origin`。

更多仓库规则见 [贡献说明](../CONTRIBUTING.zh-CN.md) 和 [本地开发指南](local-development-guide.zh-CN.md)。
