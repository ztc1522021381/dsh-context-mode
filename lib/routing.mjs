/**
 * Pure routing logic for dsh-context-mode — no Cordis, no DSH services,
 * no dependencies. Everything here is a pure function so the self-test can
 * import it under a bare Node runtime, and so the plugin entry stays thin.
 *
 * The rules mirror context-mode's hooks/core/routing.mjs (which targets
 * Claude Code's PreToolUse) and its configs/claude-code/CLAUDE.md routing
 * block, adapted to DSH's tool names.
 *
 * @module dsh-context-mode/routing
 */

/* ------------------------------------------------------------------ */
/* 结构性安全表                                                        */
/* ------------------------------------------------------------------ */

/**
 * 结构性输出有界的 shell 命令 —— 照搬 context-mode 的 SAFE_COMMAND_PATTERNS
 * （hooks/core/routing.mjs）。命中即放行，不再劝。
 *
 * 这份表是 context-mode 调优过的结果：pwd/whoami/uname/id/date/echo/printf
 * 这类一行输出，以及 cd/mkdir/touch/mv/cp/rm/ln 的静默成功模式，还有
 * `ls`（非递归）、`git status` 等只读 git 子命令。`mv/cp/rm/ln` 明确排除
 * `-v` / `--verbose`：verbose 模式下每个文件打一行，大树能刷屏。
 */
export const SAFE_COMMAND_PATTERNS = [
  /^pwd$/,
  /^whoami$/,
  /^hostname(?:\s+-[a-zA-Z]+)?$/,
  /^uname(?:\s+-[a-zA-Z]+)?$/,
  /^id(?:\s+\S+)?$/,
  /^date(?:\s+[^\r\n]+)?$/,
  /^echo\s/,
  /^printf\s/,
  /^which\s+\S+(?:\s+\S+)*$/,
  /^type\s+\S+(?:\s+\S+)*$/,
  /^command\s+-v\s+\S+(?:\s+\S+)*$/,
  /^readlink(?:\s+[^\r\n]+)?$/,
  /^basename(?:\s+[^\r\n]+)?$/,
  /^dirname(?:\s+[^\r\n]+)?$/,
  /^realpath(?:\s+[^\r\n]+)?$/,
  /^cd(?:\s+[^\r\n]+)?$/,
  /^mkdir(?:\s+[^\r\n]+)?$/,
  /^touch\s+[^\r\n]+$/,
  // mv/cp/rm/ln：拒绝任何位置的 `-v` / `--verbose`（含 -vf 这类捆绑短选项）。
  // lookahead 用 `\s-v` 与 `\s--verbose` 两条：`--verbose` 不以 `-v` 开头匹配到，
  // 必须显式列出，否则 `cp --verbose a b` 会被静默放行。
  /^mv(?![^\n]*\s-v)(?![^\n]*\s--verbose)(?:[^\n]*)$/,
  /^cp(?![^\n]*\s-v)(?![^\n]*\s--verbose)(?:[^\n]*)$/,
  /^rm(?![^\n]*\s-v)(?![^\n]*\s--verbose)(?:[^\n]*)$/,
  /^ln(?![^\n]*\s-v)(?![^\n]*\s--verbose)(?:[^\n]*)$/,
  // ls：拒绝 -R / --recursive。
  /^ls(?![^\n]*\s-R)(?![^\n]*\s--recursive)(?:\s+[^\r\n]+)?$/,
  /^git\s+status(?:\s+[^\r\n]+)?$/,
  /^git\s+rev-parse(?:\s+[^\r\n]+)?$/,
  /^git\s+remote(?:\s+-v|\s+show\s+\S+)?$/,
  /^git\s+branch(?:\s+[^\r\n]+)?$/,
  /^git\s+config\s+--get(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--stat(?:\s+[^\r\n]+)?$/,
  /^git\s+diff\s+--name-only(?:\s+[^\r\n]+)?$/,
  /^git\s+stash\s+list$/,
  /^git\s+tag(?:\s+-l(?:\s+[^\r\n]+)?)?$/,
  /^git\s+log\s+-\d{1,2}(?:\s+[^\r\n]+)?$/,
  /(?:\||\s)--version(?:\s|$)/,
]

/**
 * 单短选项版本探测（`python3 -V`、`java -version` 之外的惯例），输出一行。
 *
 * 刻意与上面的扁平表分开：`mv/cp/rm/ln -v` 是 verbose（每文件一行，会刷屏），
 * 必须先被拒绝；把 `-V` 放进 `.some()` 表会让它抢先匹配，`mv -v a b` 被放行。
 *
 * 只在**文件操作之外**的命令上成立，所以显式排除 mv/cp/rm/ln/touch。
 *
 * @param {string} trimmed 已 trim 的命令串。
 * @returns {boolean} 是否是版本探测调用。
 */
function isVersionProbe(trimmed) {
  const head = /^(\S+)/.exec(trimmed)?.[1] ?? ''
  const base = head.replace(/^.*[\\/]/, '') // ./gradlew → gradlew
  if (FILE_OPS.has(base)) return false
  return new RegExp(`^${escapeRegExp(head)}\\s+-[Vv](?:\\s|$)`).test(trimmed)
}

/** 需要排除出版本探测的文件操作（它们的 `-v` 是 verbose，不是 version）。 */
const FILE_OPS = new Set(['mv', 'cp', 'rm', 'ln', 'touch', 'mkdir'])

/** @param {string} text @returns {string} */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Shell 控制操作符：任一出现即视为「可组合」，不再信任安全表。
 * 单 `&`（后台）刻意排除 —— 它不会把两个命令的输出混在一起；
 * `&&` 才是顺序执行。
 */
const SHELL_CONTROL_OPERATORS = /[|\n\r]|\$\(|>\||>=|>>|<\(|&&|\|\||;;|;/

/** curl / wget 检测：只看命令 token，不看引号里的文本。 */
const CURL_WGET_RE = /(?:^|\s|&&|\|\||;)(?:curl|wget)\s/i

/**
 * 去掉 heredoc  body（保留 `cat <<EOF` 的头部）。
 *
 * 与 {@link stripQuotedContent} 分开：内联 HTTP 判定需要"剥掉 heredoc 但
 * **保留引号内容**"的中间形态 —— `cat <<EOF\nrequests.get("http://x")\nEOF`
 * 是把代码写进文件，不是执行它，必须放行；而 `node -e "fetch('http://x')"`
 * 的调用在引号内，必须拦住。两者对"剥到什么程度"的要求正好相反。
 *
 * @param {string} command 原始命令。
 * @returns {string} 去掉 heredoc body 的串。
 */
function stripHeredocs(command) {
  return command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1/g, '')
}

/**
 * 内联 HTTP 检测：fetch( / requests.get( / http.get( / http.request(。
 *
 * 写成谓词而不是 `/a|b|c/.test()` —— 后者在 JS 里 `re1 | re2 | re3` 会先求值
 * 为 re3（按位或把对象转成 0/NaN），是经典的静默失效坑。
 *
 * 在"剥掉 heredoc、保留引号"的串上求值：命令引号里的代码要看见，
 * heredoc 里的文件内容要忽略。
 *
 * @param {string} value 原始命令串。
 * @returns {boolean} 是否含内联 HTTP 调用。
 */
function hasInlineHttp(value) {
  const code = stripHeredocs(value)
  return (
    /fetch\s*\(\s*['"](?:https?:)?\/\//i.test(code) ||
    /requests\s*\.\s*(?:get|post|put)\s*\(/i.test(code) ||
    // `require('http').get(` —— 模块名后面隔着引号和括号，不能只写 `http.get(`。
    /(?:require\s*\(\s*['"](?:https?|node:https?)['"]\s*\)|['"](?:https?|node:https?)['"])\s*\)?\s*\.\s*(?:get|request)\s*\(/i.test(code) ||
    /https?\s*\.\s*(?:get|request)\s*\(/i.test(code)
  )
}

/** 构建工具：gradle / maven / sbt。verbose 输出必须留在沙箱里（Issue #38 / #406）。 */
const BUILD_TOOL_RE = /(?:^|\s|&&|\|\||;)(?:\.?\.?\/?(?:gradlew?|mvnw?|sbt)|gradle|maven|mvn)(?:\s|$)/i

/**
 * 与 context-mode 的 SAFE_COMMAND_PATTERNS 等价的判定。
 * 保守方向：任何管道/链式/命令替换都判为不安全。
 * @param {string} command 原始 shell 命令串。
 * @returns {boolean} 输出是否有界。
 */
export function isStructurallyBounded(command) {
  if (!command) return false
  const trimmed = command.trim()
  if (SHELL_CONTROL_OPERATORS.test(trimmed)) return false
  if (SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(trimmed))) return true
  // 版本探测放最后：它宽到会吃掉 `mv -v`，而 verbose 的文件操作必须先被拒。
  return isVersionProbe(trimmed)
}

/**
 * 去掉 heredoc 与引号内容，避免 `gh issue edit --body "text with curl in it"`
 * 这类误判（context-mode Issue #63）。
 * @param {string} command 原始命令。
 * @returns 只剩命令 token 的字符串。
 */
export function stripQuotedContent(command) {
  return command
    .replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\s*\1/g, '')
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, '""')
}

/* ------------------------------------------------------------------ */
/* 引导文案                                                            */
/* ------------------------------------------------------------------ */

/** curl / wget 拦截文案。 */
export function curlGuidance(p) {
  return (
    `context-mode: curl/wget redirected. Call ${p}ctx_fetch_and_index(url, source) to fetch and index the page, ` +
    `then ${p}ctx_search(queries) to query it — the raw body stays in storage instead of entering your conversation. ` +
    `Or call ${p}ctx_execute(language: "javascript", code) when you want to derive the answer in one round trip ` +
    `(parse, extract, count) without persisting the response. Both have full network access. ` +
    `Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENOTFOUND).`
  )
}

/** 内联 HTTP 拦截文案。 */
export function inlineHttpGuidance(p) {
  return (
    `context-mode: inline HTTP redirected. Call ${p}ctx_execute(language, code) to fetch, derive your answer in code, ` +
    `and console.log() only the result — the raw response body stays in the sandbox instead of entering your conversation. ` +
    `Full network access. Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENOTFOUND).`
  )
}

/** 构建工具拦截文案。 */
export function buildToolGuidance(p) {
  return (
    `context-mode: build tool redirected. Call ${p}ctx_execute(language: "shell", code: "<cmd> 2>&1 | tail -30") ` +
    `to run the build and print only its tail — the verbose build log stays in the sandbox instead of entering your conversation. ` +
    `For more targeted output, replace "tail -30" with "grep -E '(error|warning|FAIL|…)'" or similar, ` +
    `so only the lines that matter come back.`
  )
}

/** pwsh 通用拦截文案（非上述确定类别时）。 */
export function genericShellGuidance(p, command) {
  return (
    `context-mode: this command may produce large output. ` +
    `Call ${p}ctx_batch_execute(commands: [{label, command}], queries: [...]) to run it and get a searchable index back in one call, ` +
    `or ${p}ctx_execute(language: "shell", code) when you want to pipe/filter the output yourself. ` +
    `Only your console.log() output enters the conversation. ` +
    `Command summary: ${command.slice(0, 200)}`
  )
}

/** read 拦截文案。 */
export function readGuidance(p, filePath, size) {
  return (
    `context-mode: reading "${filePath}" (${size} bytes) is likely to flood the context window. ` +
    `Call ${p}ctx_execute_file(path, language, code) to process the file in the sandbox — ` +
    `only your console.log() output enters the conversation. ` +
    `If you are reading in order to EDIT this file, ignore this notice and read it directly.`
  )
}

/** web_fetch 拦截文案。 */
export function webFetchGuidance(p, url) {
  return (
    `context-mode: web_fetch redirected. Call ${p}ctx_fetch_and_index(url: "${url}", source: "...") to fetch and index the page, ` +
    `then ${p}ctx_search(queries: [...]) to query the indexed content — the raw page bytes stay in storage ` +
    `instead of entering your conversation. Or call ${p}ctx_execute(language, code) when you want to derive your answer ` +
    `in one round trip (parse, extract, count) without persisting the response. Both have full network access. ` +
    `Retry the same call on a transient DNS error (EAI_AGAIN, ETIMEDOUT, ENOTFOUND).`
  )
}

/** grep 拦截文案。 */
export function grepGuidance(p) {
  return (
    `context-mode: grep may flood the context window. ` +
    `Call ${p}ctx_execute(language: "javascript", code) to filter and count in the sandbox ` +
    `(read files with fs, match with RegExp, console.log() only the aggregate) — ` +
    `the matching lines stay in the sandbox instead of entering your conversation.`
  )
}

/** glob 拦截文案。 */
export function globGuidance(p) {
  return (
    `context-mode: glob may flood the context window on a large tree. ` +
    `Call ${p}ctx_execute(language: "javascript", code) to walk the tree with fs.readdirSync and console.log() only the aggregate.`
  )
}

/** subagent 拦截文案。 */
export function subagentGuidance(p) {
  return (
    `context-mode: subagent prompts receive the routing block automatically. ` +
    `When the subagent's result would be large, prefer ${p}ctx_batch_execute(commands, queries) inside the subagent ` +
    `so the returned findings stay small.`
  )
}

/* ------------------------------------------------------------------ */
/* 命令判定                                                            */
/* ------------------------------------------------------------------ */

/**
 * curl / wget 是否危险（会把正文写进 stdout）。
 *
 * 放行条件全部满足才安全：下载到文件 + 静默 + 非 verbose + 非 stdout 别名。
 * 与 context-mode 的 carve-out 一致。
 *
 * @param {string} segment 单段命令（已按 && / || / ; 切开）。
 * @returns {boolean} 该段是否危险。
 */
function isDangerousCurlSegment(segment) {
  const s = segment.trim()
  if (!/(?:^|\s)(?:curl|wget)\s/i.test(s)) return false
  const isCurl = /\bcurl\b/i.test(s)
  const isWget = /\bwget\b/i.test(s)
  const hasFileOutput = isCurl
    ? /\s(?:-o|--output)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s)
    : /\s(?:-O|--output-document)\s/.test(s) || /\s*>\s*/.test(s) || /\s*>>\s*/.test(s)
  if (!hasFileOutput) return true
  // stdout 别名：-o - 、-o /dev/stdout、-O -
  if (isCurl && /\s(?:-o|--output)\s+(?:-|\/dev\/stdout)(?:\s|$)/.test(s)) return true
  if (isWget && /\s(?:-O|--output-document)\s+(?:-|\/dev\/stdout)(?:\s|$)/.test(s)) return true
  // verbose/trace 会把进度与调试信息打到 stderr —— 那也是上下文。
  if (/\s(?:-v|--verbose|--trace|-[a-zA-Z]*v[a-zA-Z]*)\b/.test(s)) return true
  // 必须静默，否则进度条刷屏。
  const isSilent = isCurl ? /\s(?:-s|--silent)\b/.test(s) : /\s(?:-q|--quiet)\b/.test(s)
  if (!isSilent) return true
  return false
}

/**
 * Tier 1 判定：这条命令是否**根本不该由宿主 shell 跑**。
 *
 * 只覆盖三类，判据是"替代品是完整超集，拦掉零损失"：
 *   1. curl / wget 把正文写进 stdout —— `ctx_fetch_and_index` 做得更好
 *      （还顺带索引，可事后检索）。
 *   2. 内联 HTTP（node -e / python -c 里的 fetch/requests）——
 *      `ctx_execute` 是同一件事且只回 stdout。
 *   3. 构建工具（gradle/maven/sbt）—— verbose 日志该进沙箱。
 *
 * **刻意不覆盖** `npm test` / `git log` / `cat big.log` 这类"必须跑、只是输出
 * 大"的命令。它们的输出有真实价值，拦下来模型就什么都得不到了；这些交给
 * Tier 2（`tools/post-execute` 截留），跑完把超限内容换成摘要。
 * 这就是"无感矫正"在 DSH 上的正确形态。
 *
 * @param {string} p 工具名前缀。
 * @param {string} command 命令串。
 * @returns {string|null} deny reason，或 null 放行给 Tier 2。
 */
export function evaluateDeny(p, command) {
  if (typeof command !== 'string' || command.length === 0) return null
  // 两类判定用不同的输入，这不是疏漏：
  //
  //   curl/wget 与构建工具 —— 在剥离引号后的串上判。它们的命令 token 在引号
  //   之外，剥掉引号内容能避免 `gh issue edit --body "use curl"` 误判
  //   （context-mode Issue #63）。
  //
  //   内联 HTTP —— 必须在**原始串**上判。`node -e "fetch('http://x')"` 的
  //   调用恰恰在引号内部，剥离后正好被藏起来。这里宁可误报（把引号里提到
  //   fetch( 的普通命令也拦下）不可漏报 —— 漏报的代价是几十 KB 原文进上下文。
  const stripped = stripQuotedContent(command)

  // 1) curl / wget：逐段判定，任一危险段即拦。
  if (CURL_WGET_RE.test(stripped)) {
    const segments = stripped.split(/\s*(?:&&|\|\||;)\s*/)
    if (segments.some(isDangerousCurlSegment)) return curlGuidance(p)
  }

  // 2) 内联 HTTP：node -e / python -c 里的 fetch/requests。
  //    传原始串：hasInlineHttp 自己会剥掉 heredoc 但保留引号内容，
  //    因为 `node -e "fetch('http://x')"` 的调用恰恰在引号内部。
  if (hasInlineHttp(command)) return inlineHttpGuidance(p)

  // 3) 构建工具。
  if (BUILD_TOOL_RE.test(stripped)) return buildToolGuidance(p)

  return null
}

/**
 * 兼容旧名的别名。历史语义是"这条命令该不该提醒"，在两级策略下
 * Tier 1 只包含"根本不该跑"的类别，其余交给 Tier 2 截留。
 * @param {string} p @param {string} command @returns {string|null}
 */
export function evaluateShell(p, command) {
  return evaluateDeny(p, command)
}

/* ------------------------------------------------------------------ */
/* Tier 2：content 度量与截留摘要                                       */
/* ------------------------------------------------------------------ */

/**
 * 量一段渲染后 content 的 UTF-8 字节数。
 *
 * `tools/post-execute` 的 `content` 是 `[{ type: 'text', text }]` 形态
 * （见 dsh-tools 的 failureMessageFromContent / materializePresentation）。
 * 只累加 text 块；图片等富块按固定权重估，宁可高估不可漏。
 *
 * @param {readonly unknown[] | undefined} content
 * @returns {number} 字节数
 */
export function measureContent(content) {
  if (!Array.isArray(content)) return 0
  let bytes = 0
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = block.type
    if (type === 'text' && typeof block.text === 'string') {
      bytes += Buffer.byteLength(block.text, 'utf8')
    } else if (type === 'image') {
      // 图片不进文本上下文，但占附件预算；给一个保守权重。
      bytes += 4096
    } else {
      bytes += 256
    }
  }
  return bytes
}

/** 每个工具的截留建议。 */
export function truncateHint(p, toolName) {
  switch (toolName) {
    case 'read':
      return `You were reading a file. Call ${p}ctx_execute_file(path, language, code) to process it in the sandbox — only your console.log() output enters the conversation. If you were reading in order to EDIT, re-read the specific range you need.`
    case 'grep':
      return `You were searching. Call ${p}ctx_execute(language: "javascript", code) to walk the files with fs, match with RegExp, and console.log() only the aggregate (counts, file lists, matched lines you actually need).`
    case 'glob':
      return `You were listing files. Call ${p}ctx_execute(language: "javascript", code) to walk the tree with fs.readdirSync and console.log() only the aggregate.`
    case 'pwsh':
      return `You ran a shell command. Call ${p}ctx_batch_execute(commands: [{label, command}], queries: [...]) to run it and get a searchable index back, or ${p}ctx_execute(language: "shell", code) to pipe/filter the output yourself.`
    default:
      return `Re-run the work through ${p}ctx_execute(language, code) so only the answer enters your context.`
  }
}

/**
 * 生成 Tier 2 截留摘要：原文多大、去了哪、怎么重新拿。
 * @param {string} p 工具名前缀。
 * @param {string} toolName 被截留的工具。
 * @param {number} bytes 原文字节数。
 * @param {string} hint 该工具的针对性建议。
 * @returns {string} 摘要文本。
 */
export function truncationSummary(p, toolName, bytes, hint) {
  const kb = (bytes / 1024).toFixed(1)
  return (
    `context-mode: ${toolName} produced ${kb} KB of output, which was truncated before it reached your context window. ` +
    `The full output still exists — re-derive what you need without pulling it in:\n\n` +
    `${hint}\n\n` +
    `General pattern: call ${p}ctx_execute(language: "javascript", code) to read and process the source in the sandbox, ` +
    `and console.log() only the answer. For shell work, ${p}ctx_batch_execute(commands: [{label, command}], queries: [...]) ` +
    `runs the command and returns a searchable index instead of the raw text.`
  )
}

/**
 * 探测 context-mode 的 MCP 工具是否已注册，返回它的工具名前缀。
 *
 * 从真实注册表读，不猜：serverName 由 profile 的 `dsh-mcp-client` 配置决定，
 * 可能是 `context-mode` / `ctx` / 任何名字。命名规则见 dsh-mcp-client
 * README：`mcp__<serverName>__<rawName>`。
 *
 * 同时接受 ToolRuntime 服务（有 `list()`）和直接的工具名数组，
 * 后者让自测与一次性脚本不必造一个假服务。
 *
 * @param {unknown} tools ToolRuntime 服务、工具名数组，或任何有 `list()` 的对象。
 * @returns {string|null} 形如 `mcp__context_mode__` 的前缀，或 null。
 */
export function detectToolPrefix(tools) {
  if (tools === undefined || tools === null) return null
  let list
  if (Array.isArray(tools)) {
    list = tools
  } else {
    try {
      list = typeof tools.list === 'function' ? tools.list() : []
    } catch {
      return null
    }
  }
  if (!Array.isArray(list)) return null
  for (const entry of list) {
    const toolName = typeof entry === 'string' ? entry : entry?.name
    if (typeof toolName !== 'string') continue
    const match = /^mcp__(.+?)__(?:ctx_execute|ctx_batch_execute|ctx_execute_file|ctx_index|ctx_search|ctx_fetch_and_index)$/.exec(toolName)
    if (match !== null) return `mcp__${match[1]}__`
  }
  return null
}

/* ------------------------------------------------------------------ */
/* 路由 section                                                        */
/* ------------------------------------------------------------------ */

/**
 * 主路由块。内容对齐 context-mode 的 configs/claude-code/CLAUDE.md，
 * 工具名换成 DSH 实际注册的 `mcp__<server>__ctx_*`。
 *
 * 官方把 `Think in Code` 放在最前是有意的：这是四个收益里最大的一个，
 * 也是唯一模型无法自己摸索出来的范式。
 *
 * @param {string} p 工具名前缀。
 * @returns {string} 系统提示 section 文本。
 */
export function buildRoutingBlock(p) {
  return `# context-mode — MANDATORY routing rules

context-mode MCP tools are registered as ${p}ctx_*. These rules protect the context window from flooding. One unrouted command dumps 56 KB into context.

## Think in Code — MANDATORY

When you must analyze / count / filter / compare / search / parse / transform data: **write code** and call ${p}ctx_execute(language, code), then console.log() only the answer. Do NOT read raw data into context. PROGRAM the analysis, not COMPUTE it. Pure JavaScript — Node.js built-ins only (fs, path, child_process). try/catch, handle null/undefined. One script replaces ten tool calls.

## BLOCKED — do NOT attempt

### curl / wget — BLOCKED
Intercepted and rejected. Do NOT retry.
Use: ${p}ctx_fetch_and_index(url, source), or ${p}ctx_execute(language: "javascript", code: "const r = await fetch(...)").

### Inline HTTP — BLOCKED
fetch('http, requests.get(, requests.post(, http.get(, http.request( — intercepted. Do NOT retry.
Use: ${p}ctx_execute(language, code) — only stdout enters context.

### web_fetch — BLOCKED
Use: ${p}ctx_fetch_and_index(url, source), then ${p}ctx_search(queries).

## REDIRECTED — use the sandbox

### pwsh (unbounded output)
pwsh ONLY for: git, mkdir, rm, mv, cd, ls, npm install, pip install.
Otherwise: ${p}ctx_batch_execute(commands, queries) or ${p}ctx_execute(language, code).

### read (for analysis)
Reading in order to **edit** → read is correct. Reading to **analyze / explore / summarize** → ${p}ctx_execute_file(path, language, code).

### grep — may flood context
Use ${p}ctx_execute(language: "javascript", code: "...") in the sandbox for portable filtering and counting.

## Tool selection

0. **MEMORY**: ${p}ctx_search(sort: "timeline") — after a resume, check prior context before asking the user.
1. **GATHER**: ${p}ctx_batch_execute(commands, queries) — runs all commands, auto-indexes, returns search. ONE call replaces 30+. Each entry: {label: "header", command: "..."}.
2. **FOLLOW-UP**: ${p}ctx_search(queries: ["q1", "q2"]) — all questions as one array, ONE call.
3. **PROCESSING**: ${p}ctx_execute(language, code) | ${p}ctx_execute_file(path, language, code) — sandbox, only stdout enters context.
4. **WEB**: ${p}ctx_fetch_and_index(url, source), then ${p}ctx_search(queries) — raw HTML never enters context.
5. **INDEX**: ${p}ctx_index(content, source) — store in FTS5 for later search.

## Parallel I/O batches

For multi-URL fetches or multi-API calls, **always** pass concurrency: N (1-8):
- ${p}ctx_batch_execute(commands: [3+ network commands], concurrency: 5) — gh, dig, docker inspect, multi-region cloud queries
- ${p}ctx_fetch_and_index(requests: [{url, source}], concurrency: 5) — multi-URL batch fetch

Use concurrency 4-8 for I/O-bound work. Keep concurrency 1 for CPU-bound work (test, build, lint) or commands sharing state (ports, lock files, same-repo writes).

## Output

Write artifacts to FILES — never inline. Return: file path + a one-line description.
Use descriptive source labels for ${p}ctx_search(source: "label").

## Session continuity

Skills, roles, and decisions persist for the whole session. Do not abandon them as the conversation grows.

## Memory

Session history is persistent and searchable. On resume, search BEFORE asking the user:

| Need | Command |
|---|---|
| What were we working on? | ${p}ctx_search(queries: ["summary"], source: "compaction", sort: "timeline") |
| What was the first request? | ${p}ctx_search(queries: ["prompt"], source: "user-prompt", sort: "timeline") |
| What did we decide? | ${p}ctx_search(queries: ["decision"], source: "decision", sort: "timeline") |
| What NOT to repeat? | ${p}ctx_search(queries: ["rejected"], source: "rejected-approach") |
| What constraints exist? | ${p}ctx_search(queries: ["constraint"], source: "constraint") |

DO NOT ask "what were we working on?" — SEARCH FIRST.
If search returns 0 results, proceed as a fresh session.

## ctx commands

Type these in chat; the model calls the matching MCP tool:

| Command | Action |
|---|---|
| ctx stats | Call ${p}ctx_stats, display full output verbatim |
| ctx doctor | Call ${p}ctx_doctor, run the returned shell command, display as a checklist |
| ctx upgrade | Call ${p}ctx_upgrade, run the returned shell command, display as a checklist |
| ctx purge | Call ${p}ctx_purge with confirm: true. Warns before wiping the knowledge base |

After /clear or /compact: the knowledge base and session stats are preserved. Use ctx purge to start fresh.`
}
