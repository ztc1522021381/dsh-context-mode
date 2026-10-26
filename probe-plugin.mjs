/**
 * Plugin-shape probe for dsh-context-mode, run under the DSH runtime so
 * `@deepseek-ai/schemastery` resolves.
 *
 * Exercises the two tiers against a fake ToolRuntime / systemPrompt, without
 * booting a real profile:
 *
 *   Tier 1  — `tools/pre-execute` returns `{ kind: 'deny', reason }` for
 *             curl/wget, inline HTTP, build tools, and web_fetch.
 *   Tier 2  — `tools/post-execute` returns `{ kind: 'accept', content }`
 *             when a successful result exceeds `maxResultBytes`, and passes
 *             small or failed results through untouched.
 *
 * Usage (DSH runtime node):
 *   node probe-plugin.mjs
 */

import plugin from './lib/index.js'
import { measureContent } from './lib/routing.mjs'

const { Config, apply, DENY_TOOLS, TRUNCATE_TOOLS } = plugin

let passed = 0
let failed = 0
const failures = []
const verbose = process.argv.includes('-v') || process.argv.includes('--verbose')

function eq(label, value, expected) {
  if (value === expected) {
    passed++
    if (verbose) console.log(`  ok   ${label}`)
  } else {
    failed++
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`)
  }
}

console.log('dsh-context-mode plugin probe\n')

/* ---------------------------------------------------------------- */
/* Config defaults                                                  */
/* ---------------------------------------------------------------- */

console.log('config defaults')

const c = Config({})
eq('enabled', c.enabled, true)
eq('denyTools', JSON.stringify(c.denyTools), JSON.stringify(['web_fetch']))
eq('truncateTools', JSON.stringify(c.truncateTools), JSON.stringify(['pwsh', 'read', 'grep', 'glob']))
eq('maxResultBytes', c.maxResultBytes, 20000)
eq('minCommandBytes', c.minCommandBytes, 0)
eq('readThresholdBytes', c.readThresholdBytes, 50000)
eq('interceptSubagent', c.interceptSubagent, false)
eq('sectionOrder', c.sectionOrder, 3090)
eq('serverName', c.serverName, '')
eq('exported DENY_TOOLS', JSON.stringify([...DENY_TOOLS]), JSON.stringify(['web_fetch']))
eq('exported TRUNCATE_TOOLS', JSON.stringify([...TRUNCATE_TOOLS]), JSON.stringify(['pwsh', 'read', 'grep', 'glob']))

/* ---------------------------------------------------------------- */
/* Fake harness                                                     */
/* ---------------------------------------------------------------- */

console.log('two-tier behavior')

/** @type {Record<string, Array<(exec: any, next: any) => any>>} */
const listeners = { 'tools/pre-execute': [], 'tools/post-execute': [] }

const sections = []
const logs = []

const ctx = {
  logger: {
    info: (m) => logs.push(['info', m]),
    warn: (m) => logs.push(['warn', m]),
  },
  get: (service) => (service === 'tools' ? { list: () => [{ name: 'mcp__context_mode__ctx_execute' }, { name: 'pwsh' }] } : undefined),
  on: (event, handler) => {
    if (!(event in listeners)) listeners[event] = []
    listeners[event].push(handler)
    return () => {
      listeners[event] = listeners[event].filter((h) => h !== handler)
    }
  },
  systemPrompt: {
    section: (s) => {
      sections.push(s)
      return () => {
        const i = sections.indexOf(s)
        if (i >= 0) sections.splice(i, 1)
      }
    },
  },
}

const dispose = apply(ctx, { ...c })

/** @param {string} tool @param {Record<string, unknown>} args */
function pre(tool, args = {}) {
  const exec = { name: tool, arguments: args }
  const next = () => ({ kind: 'allow' })
  return listeners['tools/pre-execute'][0](exec, next)
}

/** @param {string} tool @param {any} result */
function post(tool, result) {
  const exec = { name: tool, arguments: {} }
  const next = () => ({ kind: 'accept' })
  return listeners['tools/post-execute'][0](exec, result, next)
}

/* ---------------------------------------------------------------- */
/* Routing section                                                  */
/* ---------------------------------------------------------------- */

console.log('routing section')

eq('one section registered', sections.length, 1)
eq('section name', sections[0].name, 'context-mode-routing')
eq('section order', sections[0].order, 3090)
eq('section not complete', sections[0].complete, false)
eq('section uses detected prefix', sections[0].text.includes('mcp__context_mode__ctx_execute'), true)
eq('prefix detected from registry', logs.some(([, m]) => m.includes('MCP detected at mcp__context_mode__')), true)

/* ---------------------------------------------------------------- */
/* Tier 1                                                           */
/* ---------------------------------------------------------------- */

console.log('tier 1 — deny before execution')

eq('curl denied', pre('pwsh', { command: 'curl https://x' }).kind, 'deny')
eq('curl reason names replacement', pre('pwsh', { command: 'curl https://x' }).reason.includes('ctx_fetch_and_index'), true)
eq('inline http denied', pre('pwsh', { command: `node -e "fetch('http://x')"` }).kind, 'deny')
eq('gradlew denied', pre('pwsh', { command: './gradlew build' }).kind, 'deny')
eq('web_fetch denied', pre('web_fetch', { url: 'https://x' }).kind, 'deny')
eq('web_fetch reason names replacement', pre('web_fetch', { url: 'https://x' }).reason.includes('ctx_fetch_and_index'), true)

eq('npm test allowed to run', pre('pwsh', { command: 'npm test' }).kind, 'allow')
eq('git log allowed to run', pre('pwsh', { command: 'git log --oneline' }).kind, 'allow')
eq('pwd allowed', pre('pwsh', { command: 'pwd' }).kind, 'allow')
eq('mcp tool never denied', pre('mcp__context_mode__ctx_execute', { language: 'javascript', code: 'x' }).kind, 'allow')
eq('unlisted tool untouched', pre('edit', { file_path: 'a.ts' }).kind, 'allow')
eq('subagent allowed by default', pre('subagent', { prompt: 'x' }).kind, 'allow')

/* ---------------------------------------------------------------- */
/* Tier 2                                                           */
/* ---------------------------------------------------------------- */

console.log('tier 2 — truncate after execution')

const big = [{ type: 'text', text: 'x'.repeat(30_000) }]
const small = [{ type: 'text', text: 'x'.repeat(100) }]

const bigDecision = post('pwsh', { isError: false, content: big, value: 'ignored' })
eq('oversized result accepted (not an error)', bigDecision.kind, 'accept')
eq('oversized content replaced', bigDecision.content.length, 1)
eq('replacement is a text block', bigDecision.content[0].type, 'text')
eq('replacement states the size', bigDecision.content[0].text.includes('29.3 KB'), true)
eq('replacement names ctx_batch_execute', bigDecision.content[0].text.includes('ctx_batch_execute'), true)
eq('replacement is far smaller than the original', measureContent(bigDecision.content) < 2000, true)

eq('small result untouched', post('pwsh', { isError: false, content: small, value: 1 }).kind, 'accept')
eq('small result keeps its content', post('pwsh', { isError: false, content: small, value: 1 }).content, undefined)

const errDecision = post('pwsh', { isError: true, content: big, error: { message: 'boom' } })
eq('failed result passes through', errDecision.kind, 'accept')
eq('failed result keeps its content', errDecision.content, undefined)

eq('untooled-listed tool untouched', post('edit', { isError: false, content: big, value: 1 }).kind, 'accept')

const readDecision = post('read', { isError: false, content: big, value: 'file text' })
eq('read oversized truncated', readDecision.kind, 'accept')
eq('read replacement names ctx_execute_file', readDecision.content[0].text.includes('ctx_execute_file'), true)

const grepDecision = post('grep', { isError: false, content: big, value: 'matches' })
eq('grep oversized truncated', grepDecision.kind, 'accept')
eq('grep replacement names ctx_execute', grepDecision.content[0].text.includes('ctx_execute'), true)

/* ---------------------------------------------------------------- */
/* Threshold boundary                                               */
/* ---------------------------------------------------------------- */

console.log('threshold boundary')

const atCap = [{ type: 'text', text: 'y'.repeat(20_000) }]
eq('exactly at cap passes through', post('pwsh', { isError: false, content: atCap, value: 1 }).kind, 'accept')
eq('exactly at cap keeps content', post('pwsh', { isError: false, content: atCap, value: 1 }).content, undefined)

const overCap = [{ type: 'text', text: 'y'.repeat(20_001) }]
eq('one byte over is truncated', post('pwsh', { isError: false, content: overCap, value: 1 }).content !== undefined, true)

/* ---------------------------------------------------------------- */
/* Disposal                                                         */
/* ---------------------------------------------------------------- */

console.log('disposal')

eq('both listeners registered', listeners['tools/pre-execute'].length + listeners['tools/post-execute'].length, 2)
dispose()
eq('listeners removed on dispose', listeners['tools/pre-execute'].length + listeners['tools/post-execute'].length, 0)
eq('section removed on dispose', sections.length, 0)
eq('unload logged the tallies', logs.some(([, m]) => m.includes('adapter unloaded')), true)

/* ---------------------------------------------------------------- */
/* Disabled config                                                  */
/* ---------------------------------------------------------------- */

console.log('disabled config')

const ctx2 = { ...ctx, logger: { info: () => {}, warn: () => {} } }
const dispose2 = apply(ctx2, { ...c, enabled: false })
eq('no listener when disabled', listeners['tools/pre-execute'].length + listeners['tools/post-execute'].length, 0)
eq('no section when disabled', sections.length, 0)
dispose2()

/* ---------------------------------------------------------------- */
/* summary                                                          */
/* ---------------------------------------------------------------- */

console.log('')
if (failures.length > 0) {
  console.log(`${failed} failure(s):`)
  for (const line of failures) console.log(`  FAIL ${line}`)
}
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
