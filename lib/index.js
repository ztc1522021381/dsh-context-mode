/**
 * dsh-context-mode — context-mode (https://github.com/mksglu/context-mode) 的 DSH 适配层。
 *
 * context-mode 官方支持 17 个平台，DSH 不在其中。这个插件把它的能力搬到 DSH 的
 * 宿主 seam 上，但**不是**照搬 Claude Code 的 hook 协议 —— 那条路在这个 harness
 * 上只能做到"拦下来告诉模型换工具"，而 DSH 有一条更强的缝。
 *
 * ## 三条 seam，两种策略
 *
 *   Claude Code hook          → DSH 等价物                        → 策略
 *   ─────────────────────────────────────────────────────────────────────────
 *   PreToolUse (deny)         → `tools/pre-execute` deny           → 执行前拦
 *   PostToolUse               → `tools/post-execute`               → 执行后换内容
 *   SessionStart 注入          → `ctx.systemPrompt.section()`       → 路由告知
 *
 * **为什么 post-execute 是关键**：`tools/pre-execute` 只支持
 * deny / allow / ask，且传入的 `exec.arguments` 是 `deepFreeze` 过的
 * （dsh-tools lib/index.js createExecution），改不了写入参。deny 的代价是
 * 工具根本没跑 —— 对 `curl` 这类"本来就不该跑"的命令是对的，但对
 * `npm test` / `git log` 这类"必须跑、只是输出大"的命令是错的：拦下来模型
 * 就什么都得不到了。
 *
 *   `tools/post-execute` 的 `accept` 分支支持 `{ kind: 'accept', content }`
 *   —— **调用成功，但模型看到的内容被整段替换**。工具照常执行，原始输出截留在
 *   沙箱里，模型只拿到摘要。这才是 context-mode "98% 节省"的本质：
 *   不是不让跑，是跑了但不进上下文。
 *
 * 于是形成两级策略：
 *
 *   **Tier 1 — deny（执行前）**：本来就不该由宿主工具做的事。curl/wget、
 *   内联 HTTP、web_fetch。这些的替代品（ctx_fetch_and_index / ctx_execute）
 *   是完整超集，拦掉零损失。
 *
 *   **Tier 2 — truncate（执行后）**：必须跑、但输出可能溢出的。pwsh、
 *   grep、glob、read。这些照跑，跑完把超限的 content 换成
 *   "原文 N 字节已截留，用 ctx_execute 重新处理" 的摘要。
 *
 * Tier 2 是纯增益：原本会灌进上下文的东西，现在灌进去的是几百字节的指针。
 * 而且它不需要猜输出多大 —— 跑完量一下就知道。
 *
 * @module dsh-context-mode
 */

import { statSync } from 'node:fs'
import z from '@deepseek-ai/schemastery'
import {
  buildRoutingBlock,
  detectToolPrefix,
  evaluateShell,
  globGuidance,
  grepGuidance,
  readGuidance,
  subagentGuidance,
  webFetchGuidance,
} from './routing.mjs'

/** Cordis loader 诊断用的插件名。 */
const name = 'context-mode'

const inject = ['systemPrompt', 'logger']

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */

/** Tier 1：执行前拦掉（替代品是完整超集，拦掉零损失）。 */
export const DENY_TOOLS = ['web_fetch']

/** Tier 2：执行后截留（必须跑，但输出要截留）。 */
export const TRUNCATE_TOOLS = ['pwsh', 'read', 'grep', 'glob']

export const Config = z.object({
  /** 总开关。 */
  enabled: z.boolean().default(true),
  /** Tier 1 工具。 */
  denyTools: z.array(z.string()).default([...DENY_TOOLS]),
  /** Tier 2 工具。 */
  truncateTools: z.array(z.string()).default([...TRUNCATE_TOOLS]),
  /** Tier 2 阈值：渲染后 content 超过该 UTF-8 字节数才截留。 */
  maxResultBytes: z.number().step(1).min(0).default(20_000),
  /** 低于该字节数的 pwsh 命令连 Tier 1 判定都跳过（结构安全表优先）。 */
  minCommandBytes: z.number().step(1).min(0).default(0),
  /** read 超过该字节数才在 Tier 1 判定里提醒（Tier 2 仍会截留）。 */
  readThresholdBytes: z.number().step(1).min(0).default(50_000),
  /** 是否也拦 subagent。 */
  interceptSubagent: z.boolean().default(false),
  /** 路由 section 顺序；MCP_SERVERS 是 3100。 */
  sectionOrder: z.number().default(3090),
  /** 覆盖探测到的 MCP serverName。 */
  serverName: z.string().default(''),
})

/* ------------------------------------------------------------------ */
/* content 度量                                                        */
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
function measureContent(content) {
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

/**
 * 生成 Tier 2 截留摘要：原文多大、去了哪、怎么重新拿。
 * @param {string} p 工具名前缀。
 * @param {string} toolName 被截留的工具。
 * @param {number} bytes 原文字节数。
 * @param {string} hint 该工具的针对性建议。
 * @returns {string} 摘要文本。
 */
function truncationSummary(p, toolName, bytes, hint) {
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

/** 每个工具的截留建议。 */
function truncateHint(p, toolName) {
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

/* ------------------------------------------------------------------ */
/* Tier 1 判定                                                        */
/* ------------------------------------------------------------------ */

/**
 * 求值一条 pwsh 命令是否该在 Tier 1 拦掉。
 *
 * 只拦"替代品是完整超集"的类别：curl/wget、内联 HTTP、构建工具。
 * `npm test` / `git log` 这类不拦 —— 它们该跑，输出大交给 Tier 2 截留。
 *
 * @param {string} p 工具名前缀。
 * @param {string} command 命令串。
 * @returns {string|null} deny reason，或 null 放行。
 */
function evaluateDeny(p, command) {
  return evaluateShell(p, command)
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

/**
 * 注册 context-mode 适配层。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件作用域。
 * @param {Record<string, unknown>} config 归一化后的配置。
 * @returns {() => void} 卸载回调。
 */
function apply(ctx, config) {
  const log = ctx.logger
  const options = {
    enabled: config.enabled !== false,
    denyTools: new Set(Array.isArray(config.denyTools) && config.denyTools.length > 0 ? config.denyTools : DENY_TOOLS),
    truncateTools: new Set(Array.isArray(config.truncateTools) ? config.truncateTools : TRUNCATE_TOOLS),
    maxResultBytes: typeof config.maxResultBytes === 'number' ? config.maxResultBytes : 20_000,
    minCommandBytes: typeof config.minCommandBytes === 'number' ? config.minCommandBytes : 0,
    readThresholdBytes: typeof config.readThresholdBytes === 'number' ? config.readThresholdBytes : 50_000,
    interceptSubagent: config.interceptSubagent === true,
    sectionOrder: typeof config.sectionOrder === 'number' ? config.sectionOrder : 3090,
    serverName: typeof config.serverName === 'string' ? config.serverName : '',
  }

  if (!options.enabled) {
    log.info('context-mode adapter loaded but disabled by config')
    return () => {}
  }

  // 工具名前缀：优先配置覆盖，其次从真实注册表探测。
  let prefix = options.serverName.length > 0 ? `mcp__${options.serverName}__` : 'mcp__context_mode__'

  const registerSection = (text) =>
    ctx.systemPrompt.section({
      name: 'context-mode-routing',
      order: options.sectionOrder,
      text,
      complete: false,
    })

  let disposeSection = registerSection(buildRoutingBlock(prefix))

  const detected = detectToolPrefix(ctx.get('tools'))
  if (detected !== null) {
    if (detected !== prefix) {
      prefix = detected
      disposeSection()
      disposeSection = registerSection(buildRoutingBlock(prefix))
    }
    log.info(`context-mode MCP detected at ${prefix}`)
  } else {
    log.warn(
      'context-mode MCP tools not found yet; the routing block uses the default prefix. ' +
        'Mount the MCP server in cordis.patch.yml (see README).',
    )
  }

  /** 诊断计数。 */
  const stats = { denied: 0, truncated: 0, bytesSaved: 0, byTool: Object.create(null) }

  /* ---------------------------------------------------------------- */
  /* Tier 1：执行前拦                                                   */
  /* ---------------------------------------------------------------- */

  const disposePreExecute = ctx.on('tools/pre-execute', (exec, next) => {
    if (exec.name.startsWith('mcp__')) return next()
    if (exec.name === 'subagent' && !options.interceptSubagent) return next()
    if (!options.denyTools.has(exec.name) && !options.truncateTools.has(exec.name)) return next()

    const args = exec.arguments
    let reason = null

    // Tier 1a：curl / wget / 内联 HTTP / 构建工具 —— 任何启用 Tier 1 判定的工具。
    if (exec.name === 'pwsh') {
      const command = typeof args?.command === 'string' ? args.command : ''
      if (options.minCommandBytes > 0 && Buffer.byteLength(command, 'utf8') < options.minCommandBytes) return next()
      reason = evaluateDeny(prefix, command)
    } else if (exec.name === 'web_fetch') {
      // web_fetch 的替代品 ctx_fetch_and_index 是完整超集，直接拦。
      reason = webFetchGuidance(prefix, typeof args?.url === 'string' ? args.url : '')
    } else if (exec.name === 'read') {
      // read 只在"明显是为了分析"时拦；为了编辑而读必须放行，
      // 但 Tier 2 仍会截留超限输出，所以这里只处理极端情况。
      const filePath = typeof args?.file_path === 'string' ? args.file_path : ''
      if (filePath.length > 0) {
        try {
          const stat = statSync(filePath)
          if (stat.isFile() && stat.size > options.readThresholdBytes) {
            reason = readGuidance(prefix, filePath, stat.size)
          }
        } catch {
          // 文件不存在：交给宿主工具报错。
        }
      }
    } else if (exec.name === 'subagent') {
      reason = subagentGuidance(prefix)
    }

    if (reason === null) return next()

    stats.denied += 1
    stats.byTool[exec.name] = (stats.byTool[exec.name] ?? 0) + 1
    return { kind: 'deny', reason }
  })

  /* ---------------------------------------------------------------- */
  /* Tier 2：执行后截留                                                 */
  /* ---------------------------------------------------------------- */

  /**
   * `tools/post-execute` 拦截器。
   *
   * 这是本插件相对"只做 deny"的核心增益：工具照常执行，跑完量一下渲染后
   * content 有多大，超限就把模型看到的内容换成摘要。`{ kind: 'accept',
   * content }` 让调用保持成功，模型不会以为工具失败了。
   *
   * 失败的调用（isError）不动 —— 错误信息本来就该让模型看见，而且通常很短。
   */
  const disposePostExecute = ctx.on('tools/post-execute', (exec, result, next) => {
    if (!options.truncateTools.has(exec.name)) return next()
    if (result.isError) return next()

    const bytes = measureContent(result.content)
    if (bytes <= options.maxResultBytes) return next()

    const summary = truncationSummary(prefix, exec.name, bytes, truncateHint(prefix, exec.name))
    stats.truncated += 1
    stats.bytesSaved += bytes
    stats.byTool[exec.name] = (stats.byTool[exec.name] ?? 0) + 1

    return {
      kind: 'accept',
      content: [{ type: 'text', text: summary }],
    }
  })

  log.info(
    `context-mode adapter active: deny=[${[...options.denyTools].join(', ')}] ` +
      `truncate=[${[...options.truncateTools].join(', ')}] max=${options.maxResultBytes}B prefix=${prefix}`,
  )

  return () => {
    disposePreExecute()
    disposePostExecute()
    disposeSection()
    const breakdown = Object.entries(stats.byTool)
      .map(([tool, count]) => `${tool}=${count}`)
      .join(' ')
    const savedKb = (stats.bytesSaved / 1024).toFixed(1)
    log.info(
      `context-mode adapter unloaded; denied=${stats.denied} truncated=${stats.truncated} saved=${savedKb}KB` +
        `${breakdown.length > 0 ? ` (${breakdown})` : ''}`,
    )
  }
}

export { apply, buildRoutingBlock, detectToolPrefix, measureContent, truncateHint, truncationSummary, name }
export default { name, inject, Config, apply, DENY_TOOLS, TRUNCATE_TOOLS }
