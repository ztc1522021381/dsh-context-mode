# dsh-context-mode

[context-mode](https://github.com/mksglu/context-mode) 的 DeepSeek Harness 适配层。

context-mode 官方支持 17 个平台，DSH 不在其中。这个插件把它的能力搬到 DSH 的
宿主 seam 上，但**不是**照搬 Claude Code 的 hook 协议 —— 那条路在这个 harness
上只能做到"拦下来告诉模型换工具"。DSH 有一条更强的缝。

## 两级策略

| 层级 | 时机 | 手段 | 判据 |
|---|---|---|---|
| **Tier 1 — deny** | 执行前 | `tools/pre-execute` 返回 `{ kind: 'deny', reason }` | 这件事**根本不该由宿主工具做** |
| **Tier 2 — truncate** | 执行后 | `tools/post-execute` 返回 `{ kind: 'accept', content }` | 这件事**必须跑，但输出不该进上下文** |

### 为什么是两级，不是一级

`tools/pre-execute` 只支持 deny / allow / ask，且传入的 `exec.arguments` 是
`deepFreeze` 过的（`dsh-tools` 的 `createExecution`），改不了写入参。deny 的代价是
**工具根本没跑**。

对 `curl https://x` 这类命令，这是对的 —— 替代品 `ctx_fetch_and_index` 是完整
超集（还顺带索引，可事后检索），拦掉零损失。

但对 `npm test` / `git log` / `cat big.log`，这是错的。这些命令**必须跑**，输出有
真实价值；拦下来模型就什么都得不到了。而它们的输出恰恰是最容易灌满上下文的东西。

### Tier 2 怎么做

`tools/post-execute` 的 `accept` 分支支持 `{ kind: 'accept', content }` ——
**调用成功，但模型看到的内容被整段替换**。工具照常执行，跑完量一下渲染后
content 有多大，超限就把模型看到的内容换成摘要：

```
context-mode: pwsh produced 29.3 KB of output, which was truncated before it
reached your context window. The full output still exists — re-derive what you
need without pulling it in:

You ran a shell command. Call mcp__context_mode__ctx_batch_execute(commands:
[{label, command}], queries: [...]) to run it and get a searchable index back, or
mcp__context_mode__ctx_execute(language: "shell", code) to pipe/filter it yourself.

General pattern: call mcp__context_mode__ctx_execute(language: "javascript", code)
to read and process the source in the sandbox, and console.log() only the answer.
```

这是 context-mode "98% 节省"的本质：**不是不让跑，是跑了但不进上下文。**
而且不需要猜输出多大 —— 跑完量一下就知道。失败的调用（`isError`）不动，
错误信息本来就该让模型看见，而且通常很短。

### 默认分工

```
Tier 1 (deny)     : web_fetch
                    + pwsh 里的 curl/wget、内联 HTTP、构建工具
Tier 2 (truncate) : pwsh, read, grep, glob     (阈值 20 KB)
```

`pwsh` 同时出现在两层，但拦的东西不同：Tier 1 拦 curl/inline-HTTP/build，
其余全部放行给 Tier 2。

## 路由块

除了拦截，插件还在系统提示里注入一段 `context-mode — MANDATORY routing rules`，
内容对齐 context-mode 的 `configs/claude-code/CLAUDE.md`：`Think in Code` 范式、
工具选择顺序、并发批处理、会话连续性。工具名前缀从 `ctx.tools` 的真实注册表探测，
不硬编码 —— 你的 `serverName` 叫 `ctx` 还是 `context-mode` 都能对上。

## 安装

```bash
# 1. context-mode 本体（MCP server）
npm install -g context-mode
```

把这个包放进 profile：

```bash
cp -r dsh-context-mode ~/.dsh/profiles/desktop/_local-pkgs/
```

编辑 `~/.dsh/profiles/desktop/package.json`，加依赖和 bundle：

```json
{
  "dependencies": { "dsh-context-mode": "file:./_local-pkgs/dsh-context-mode" },
  "dsh": { "profile": { "bundles": ["...", "dsh-context-mode"] } }
}
```

`cordis.patch.yml` 随 bundle 一起应用，里面已经有两行：挂 MCP server、挂适配层。

重启 DSH。

### 路径要对

`cordis.patch.yml` 里的 `command` / `args` 必须是绝对路径，且**指向真正的入口
脚本，不是 npm 的 `.cmd` shim**：

```yaml
command: 'C:\Program Files\nodejs\node.exe'
args:
  - 'C:\Users\<user>\AppData\Roaming\npm\node_modules\context-mode\cli.bundle.mjs'
```

仓库里默认写的是 `REPLACE_ME\...` 哨兵值 —— 拿到手第一件事就是跑 `npm root -g`，
把结果填进去。两个原因：DSH 的 ACP 层硬校验 `command` 是绝对路径；
`StdioClientTransport` spawn 时不带 `shell: true`，Windows 上跑不了 `.cmd`
（ENOENT）。`failOnStartupError: false` 保证填错也不挡 DSH 启动，只是没有
ctx_* 工具 —— 届时看日志里的 `context-mode MCP tools not found yet` 警告。

## 配置

```yaml
- id: context-mode
  name: dsh-context-mode
  config:
    enabled: true
    denyTools: [web_fetch]
    truncateTools: [pwsh, read, grep, glob]
    maxResultBytes: 20000      # Tier 2 阈值
    minCommandBytes: 0         # 短命令跳过 Tier 1 判定
    readThresholdBytes: 50000  # read 的 Tier 1 提醒线（Tier 2 仍截留）
    interceptSubagent: false
    sectionOrder: 3090         # MCP_SERVERS 是 3100
    serverName: ''             # 留空 = 自动探测
```

`enabled: false` 一行回到原生行为，MCP server 仍挂着。

## 测试

```bash
node selftest.mjs          # 86 个用例：纯路由规则，无依赖
node selftest.mjs -v

# 插件形状探针（需要 DSH runtime，schemastery 在那里解析）
node probe-plugin.mjs      # 53 个用例：两级行为、阈值边界、装配与卸载
```

## 已知限制

- **Tier 1 不能改写入参** —— `exec.arguments` 是深冻结的。这是 DSH 的类型设计，
  不是疏漏。绕开它的办法就是 Tier 2：让工具跑完，再换掉模型看到的内容。
- **权限体系不互通** —— context-mode 在 Claude Code 上读 `.claude/settings.json`
  的 `permissions.deny`。DSH 用自己的权限预设，不读那个格式。
- **Tier 2 只按字节数判**，不判断内容是否有用。20 KB 的 `git diff` 和 20 KB 的
  编译日志一视同仁。要更精细就给单个工具调低 `maxResultBytes`。

## 许可

MIT。context-mode 本体是 Elastic License 2.0，与本适配层无关。
