# Guarded Actions

**已经决定的下一步，不必再问一遍模型。**

A Claude Code plugin for receipt-guarded execution of already-decided actions.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Plugin 1.2.0](https://img.shields.io/badge/plugin-1.2.0-2563eb.svg)](CHANGELOG.md)
[![Claude Code Mod](https://img.shields.io/badge/Claude_Code-Mod-555.svg)](#兼容性)

Guarded Actions 让 Claude 一次声明已经确定的后续动作，插件根据**真实工具回执**决定是否直接执行。无需重新启动 Agent，不引入额外模型，也不修改 Claude Code 源码。

例如，模型已经决定「构建成功后运行测试」：插件可以在构建完成后直接派发测试，省掉中间那次重复决策；遇到失败、新信息或不明确的状态，再交回模型。

> **先读这两点：**
> - **不限制 Claude Code 版本号。** 需要宿主提供 Mod、`turn.step` 和原生工具接口；版本号仅用于诊断，不作为开启或执行条件。
> - **默认关闭，按需开启。** 小样本中，构建测试链平均减少 18.97% 总 token，但五类任务混合后总 token 增加 8.58%。它不是适合所有任务的“省 token 开关”。[查看完整测量](VERIFICATION.md)

[安装](#安装) · [快速使用](#快速使用) · [适用场景](#什么时候值得开启) · [工作原理](#工作原理) · [实测结果](#实测结果) · [安全边界](#安全与数据边界) · [开发](#开发与测试)

## 安装

### 在 Claude Code 中安装

```text
/plugin install guarded-actions --marketplace edifierx666/guarded-actions
```

也可以分两步安装：

```text
/plugin marketplace add edifierx666/guarded-actions
/plugin install guarded-actions@edifierx666-guarded-actions
```

### 在终端安装

```bash
claude plugin install guarded-actions --marketplace edifierx666/guarded-actions
```

安装后重新启动 Claude Code，或在当前会话执行 `/reload-plugins`。在 `/plugin` 的 Installed 页面确认插件已启用。

**不需要 `npm install`、单独的 API Key、MCP server 或后台 daemon。** 插件使用当前会话的模型与工具。Node.js 24+ 只用于开发测试，不是插件运行前置条件。

### 兼容性

| 项目 | 当前范围 |
| --- | --- |
| Claude Code | 不设置版本号门禁；需要 Mod 与原生工具接口 |
| 已实测环境 | macOS arm64，Claude Code CLI 2.1.316、2.1.317 |
| 工具 | 原生 `Read`、前台 `Bash` |
| 会话 | 当前主会话、当前用户轮次 |
| 尚未实测 | 其他版本组合、其他操作系统、Desktop、VS Code |

无需降级或匹配某个版本号。`claude --version` 仅用于问题诊断；新版本不会仅因版本号不同被拒绝开启。若宿主缺少必要接口，或原生执行证据无法核验，仍不能绕过宿主限制或把未知结果当成成功。

## 快速使用

**1. 在需要执行任务的项目中打开 Claude Code，开启插件的执行模式：**

```text
/guarded on
```

**2. 正常描述任务：**

```text
运行这个项目已确定的构建命令，成功后运行相关测试。
如果两个命令和参数现在都已确定，就提交一个 guarded-actions 计划。
失败时停止后续步骤，保留原始错误，不要自动重试。
```

模型会自行判断是否能提交计划，用户不必手写 JSON。插件只接受已经确定且确实需要的动作，不替模型解释未知结果。

**3. 查看执行情况，完成后按需关闭：**

```text
/guarded status
/guarded off
```

| 命令 | 行为 |
| --- | --- |
| `/guarded on` | 开启当前会话的动作复用，不检查版本号、不修改权限 |
| `/guarded status` | 查看计划状态、模型请求、首次分发、后续替代、回退原因和 usage |
| `/guarded off` | 停止派发尚未执行的动作，不擅自终止已经交给宿主管理的工具 |

**插件已安装**和**执行模式已开启**是两回事。安装使命令可用；默认每个新会话仍需主动开启。清空或切换会话后不会恢复旧计划，统计也按会话重置。

### 新会话自动开启

在 `/config` 的插件配置里把 **Enable on session start**（`enableOnStart`）设为开启，每个新会话以及清空后的会话都会自动处于开启状态，无需再输入 `/guarded on`。修改后插件会自动重载。`/guarded off` 仍可在当前会话内临时关闭；`/guarded status` 中的 `enableOnStart` 显示当前配置值。默认值为 `false`，与旧版本行为一致。

## 什么时候值得开启？

| 场景 | 建议 | 原因 |
| --- | --- | --- |
| 构建 → 成功后运行固定测试 | 适合 | 下一动作已确定，只需检查前置结果 |
| 多步串行检查，命令与参数都已确定 | 可评估 | 有机会省掉中间的模型请求 |
| 多个相互独立、原生可批量读取的文件 | 通常不适合 | 模型本来就可能在一次响应中发出全部工具调用 |
| 读文件后才能决定下一步 | 不适合 | 需要解释新信息，不能提前固定参数 |
| 普通问答、计算、单个工具动作 | 不适合 | 没有可复用的后续决策，说明与计划只增加开销 |
| 经常在第一步失败的流程 | 收益可能为负 | 计划已经生成，但没有后续调用可以省掉 |

不要为了凑计划添加检查、探测或无意义的命令。优先使用宿主已有的批量工具能力；只有确实需要**根据成功回执顺序执行**的动作才考虑本插件。

## 工作原理

1. **模型声明计划。** 当前模型调用通过本地 `commit_plan` 工具提交 2–8 个动作，包含完整参数、依赖和条件。
2. **插件绑定原始决策。** 校验结构，并将提交参数与模型原始输出、最终会话记录核对，防止同一个调用 ID 下的计划被改写。
3. **在下一次请求前选择路径。** `turn.step` 有唯一可执行动作时输出原生工具调用，不再请求模型；没有安全延续时走原模型。
4. **宿主执行。** 每个动作仍经过原生权限、沙箱和执行逻辑，插件不自行启动 shell。
5. **真实回执推进图。** 核对调用 ID、工具、参数、原生事件、返回结果与会话记录后，才允许后续动作执行。
6. **结束或回退。** 图耗尽、失败、取消、状态未知或要求变化时停止旧图。最终回答和业务正确性判断仍由模型完成。

`mcp__guarded-actions__commit_plan` 是 Mod 注册的**本地工具名称**，不表示部署了外部 MCP 服务。提交计划不执行命令，也不等于用户授权。

### 执行契约

- 计划最多 8 个节点、16 KiB JSON；节点 ID 唯一，依赖只能指向更早节点。
- 只支持 `Read` 和前台 `Bash`；参数提交后冻结，不填充未来输出，不执行任意条件脚本。
- 根节点条件为 `start`，其他节点只在前置动作被确认为 `succeeded` 时可执行。
- 每个决策点只派发唯一符合条件的动作；有歧义就回模型。
- 一次模型响应只能提交一个计划，不能同时夹带其他工具动作。
- 同一计划实例的节点最多派发一次；不自动重试，不跨重启重放。
- 只对已适配的文本 Read 结果继续执行；图片、PDF、自动截断等结果保守回退。
- Bash 后台化、超时、中断、失败或缺失回执都不视为成功。

<details>
<summary>查看计划格式示例</summary>

下面只演示协议。命令必须来自真实项目，不能在不匹配的项目中照搬。

```json
{
  "schemaVersion": 1,
  "nodes": [
    {
      "id": "build",
      "after": null,
      "tool": "Bash",
      "arguments": { "command": "npm run build", "timeout": 120000 },
      "when": "start"
    },
    {
      "id": "test",
      "after": "build",
      "tool": "Bash",
      "arguments": { "command": "npm test", "timeout": 120000 },
      "when": "succeeded"
    }
  ]
}
```

</details>

## 实测结果

在 Claude Code 2.1.316、macOS arm64 上使用真实模型与原生工具，五类固定任务各做两轮开／关对照，共 20 次任务执行。两组都加载插件，区别是执行模式关闭或开启；完整统计包括输入、输出、缓存读取、缓存写入、计划生成、失败和最终回答。

| 场景 | 模型请求：关闭 → 开启 | 平均总 token：关闭 → 开启 | token 变化 |
| --- | ---: | ---: | ---: |
| 构建成功 → 验证 | 3 → 2 | 12,270.5 → 9,943 | **−18.97%** |
| 首步失败 | 2 → 2 | 8,076.5 → 9,852.5 | +21.99% |
| 下一路径事先未知 | 3 → 3 | 12,085.5 → 14,152.5 | +17.10% |
| 不需要工具的计算 | 1 → 1 | 3,754 → 4,450 | +18.54% |
| 两个独立文件读取 | 2 → 2 | 8,320 → 9,927.5 | +19.32% |

**混合样本总计：89,013 → 96,651 token，增加 8.58%。** 因此默认关闭，不推荐常驻开启。

这是工程烟测，不是大规模 benchmark，也不足以保证泛化收益。缓存冷热影响实际费用；省 token 不等于按同比例省钱或提速。完整方法、负样本和逐次数据均公开：

- [验证说明与局限](VERIFICATION.md)
- [20 次对照测量](verification-results.json)
- [原生失败、拒绝、取消与超时证据](verification-native.json)
- [安全修正后的最终真实模型烟测](verification-final.json)

### 如何读 `/guarded status`

| 字段 | 含义 |
| --- | --- |
| `enabled` / `version` | 当前执行模式与宿主版本信息；版本号不参与执行判断 |
| `modelRequests` | 主会话向下游模型处理链转交的请求次数，不包含 SDK 内部重试计数 |
| `authorRequests` | 提交有效计划的模型响应数 |
| `initialDispatches` | 根动作分发数；**不算节省** |
| `continuationDispatches` | 工具反馈后派发的预存后续动作数 |
| `certifiedSubstitutions` | 通过原生执行证据核验的后续替代数；不是任务成功率或固定 token 节省量 |
| `unknownUsageRequests` | 用量缺失或不完整的请求，不能按零消耗处理 |
| `usage` | 普通输入、输出、缓存读取、缓存写入四个独立计数桶 |
| `plan` / `outcomes` / `fallbacks` | 当前或最后计划状态、执行结果、停止原因 |

## 安全与数据边界

**少一次推理，不应少一道权限检查。**

- 不自动批准工具，不开启 `bypassPermissions`，不修改用户权限配置。
- 不通过插件自己的进程执行能力绕过宿主 Bash，不让计划授权后续动作。
- 权限拒绝、用户取消、未知状态后停止旧图，不自动换工具或重试。
- 新用户输入、目录变化、压缩、会话切换、重载、关闭会使未派发计划失效。
- 执行状态保存在会话内存；不持久化可重放计划，不发送插件遥测。
- 任务内容与工具结果仍按宿主原有方式进入模型上下文和会话记录；本插件不改变提供方的数据处理规则。
- 其他插件可以改写处理链。本插件对可观察到的不一致停止复用，但**不是对任意第三方插件的隔离或安全认证**。

“执行证据成立”只意味着记录对应、指定模型请求被替代，不证明命令一定正确或业务任务已经完成。

## 更新、关闭与卸载

获取发布的新版本：

```bash
claude plugin update guarded-actions@edifierx666-guarded-actions
```

只停止当前会话的动作复用，用 `/guarded off`。要停用整个插件或卸载：

```bash
claude plugin disable guarded-actions@edifierx666-guarded-actions
claude plugin uninstall guarded-actions@edifierx666-guarded-actions
```

如果也不再需要这个 marketplace：

```bash
claude plugin marketplace remove edifierx666-guarded-actions
```

## 常见问题

**升级 Claude Code 后需要等待插件放行版本号吗？** 不需要。1.1.0 起已经删除版本号门禁。若仍看到 `supported host 2.1.316`，请运行 `claude plugin update guarded-actions@edifierx666-guarded-actions`，然后重启或 `/reload-plugins`。

**为什么找不到 `/guarded`？** 确认 `/plugin` 中插件已启用，然后重新启动或执行 `/reload-plugins`。组织策略、`--safe-mode` 或关闭 hooks 的配置也可能阻止 Mod 加载。

**为什么开启了却没有计划？** 下一步可能还需要推理、只有一个动作、工具不受支持，或者原生批量调用已经更合适。不生成计划是正常情况。

**失败后插件会自动修复吗？** 不会。它保留真实错误并交回原模型；是否修改与如何修复仍由原模型按用户要求决定。

**能用于子 Agent、跨会话工作流或后台长任务吗？** 当前不能。它只复用主会话当前轮次内的确定动作，不做后台轮询和跨会话续跑。

**能用在其他模型上吗？** 插件不新增模型请求，也不指定模型；但不同提供方、工具输出和缓存行为仍需独立验证。公开测量不代表所有模型都有相同效果。

## 开发与测试

```bash
git clone https://github.com/edifierx666/guarded-actions.git
cd guarded-actions
npm test
claude plugin test .
claude plugin validate --strict .
```

纯模块测试需要 Node.js 24+。宿主 Hook 测试需要 Claude Code Mod 测试接口；无第三方运行时依赖，无需 `npm install`。

要从本地源码加载，在目标工作项目运行：

```bash
claude --plugin-dir /absolute/path/to/guarded-actions
```

交互式加载会在 `.claude-plugin/types/` 生成当前宿主的类型声明。该目录已被 git 忽略，不随发布携带本机生成文件。有 TypeScript 编译器时，可在生成声明后执行 `tsc -p tsconfig.json`。

| 文件 | 职责 |
| --- | --- |
| `.claude-plugin/plugin.json` | 插件身份与版本 |
| `.claude-plugin/marketplace.json` | 可安装的公开 marketplace 条目 |
| `hooks/register.ts` | 静态可分析的原生事件注册 |
| `src/plan.ts` | 计划格式、参数与依赖校验 |
| `src/controller.ts` | 确定性状态转换与最多一次派发 |
| `src/claude-adapter.ts` | 原始计划绑定、原生回执归一化与会话状态 |
| `src/accounting.ts` | 调用与用量核算 |
| `tests/` | 核心行为和宿主 Hook 回归测试 |

发现问题请提交 [Issue](https://github.com/edifierx666/guarded-actions/issues)，附上 Claude Code 版本、操作系统、脱敏后的 `/guarded status` 与最小复现。请勿上传密钥、完整私人会话或含敏感数据的工具输出。

## 致谢与许可

思路参考 [HarnessMM: Recursive Self-Improvement for Harness Token Efficiency](https://arxiv.org/abs/2610.32813) 的 guarded decision reuse。本项目为独立实现，不是论文作者或 Anthropic 的官方发行，没有复制其研究运行器。

[MIT License](LICENSE) · [Changelog](CHANGELOG.md) · Maintained by [edifierx666](https://github.com/edifierx666)
