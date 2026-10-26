/**
 * Offline self-test for dsh-context-mode's routing rules.
 *
 * Two tiers, two kinds of assertion:
 *
 *   Tier 1 (evaluateDeny) — "must not run on the host shell at all":
 *     curl/wget flooding stdout, inline HTTP, build tools. These assert a
 *     deny reason naming the replacement.
 *
 *   Tier 2 (post-execute truncation) — "must run, but its output must not
 *     enter context": npm test, git log, cat big.log. These assert
 *     evaluateDeny returns null (the command IS allowed to run) and that
 *     measureContent/truncationSummary handle the oversized result.
 *
 * This file deliberately imports only `lib/routing.mjs` — the pure module with
 * no dependencies. `lib/index.js` (the Cordis plugin) needs schemastery, which
 * only resolves inside a DSH profile; its shape is covered by
 * `probe-plugin.mjs` under the DSH runtime.
 *
 * Usage:  node selftest.mjs
 *         node selftest.mjs -v
 */

import {
  buildRoutingBlock,
  detectToolPrefix,
  evaluateDeny,
  evaluateShell,
  globGuidance,
  grepGuidance,
  isStructurallyBounded,
  measureContent,
  readGuidance,
  stripQuotedContent,
  subagentGuidance,
  truncateHint,
  truncationSummary,
  webFetchGuidance,
} from './lib/routing.mjs'

const PREFIX = 'mcp__context_mode__'

let passed = 0
let failed = 0
const failures = []

const verbose = process.argv.includes('-v') || process.argv.includes('--verbose')

/**
 * @param {string} label case name
 * @param {string} command shell command under test
 * @param {'deny'|'allow'} expected Tier-1 outcome
 * @param {string} [expectedHint] substring the deny reason must contain
 */
function deny(label, command, expected, expectedHint) {
  const reason = evaluateDeny(PREFIX, command)
  const actual = reason === null ? 'allow' : 'deny'
  const ok =
    actual === expected && (expected === 'allow' || expectedHint === undefined || reason.includes(expectedHint))
  if (ok) {
    passed++
    if (verbose) console.log(`  ok   ${label}`)
  } else {
    failed++
    const detail = actual === 'deny' ? `reason=${JSON.stringify(reason.slice(0, 120))}` : 'reason=null'
    failures.push(`${label}: expected ${expected}${expectedHint ? ` (hint ${JSON.stringify(expectedHint)})` : ''}, got ${actual} (${detail})`)
  }
}

/** @param {string} label @param {unknown} value @param {unknown} expected */
function eq(label, value, expected) {
  if (value === expected) {
    passed++
    if (verbose) console.log(`  ok   ${label}`)
  } else {
    failed++
    failures.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(value)}`)
  }
}

console.log('dsh-context-mode selftest\n')

/* ---------------------------------------------------------------- */
/* 0. plugin surface                                                */
/* ---------------------------------------------------------------- */

console.log('tier defaults — see probe-plugin.mjs')

// The tier lists and Config defaults live in lib/index.js, which needs
// schemastery and therefore only resolves under a DSH runtime. Assert the
// semantics that routing.mjs can prove on its own: Tier 1 lets a build/command
// through (so Tier 2 can truncate it) and Tier 2's helpers exist.
eq('evaluateShell aliases evaluateDeny', evaluateShell(PREFIX, 'curl https://x') !== null, true)
eq('npm test reaches tier 2 (not denied)', evaluateDeny(PREFIX, 'npm test'), null)
eq('measureContent is exported', typeof measureContent, 'function')
eq('truncationSummary is exported', typeof truncationSummary, 'function')

/* ---------------------------------------------------------------- */
/* 1. Tier 1: curl / wget                                           */
/* ---------------------------------------------------------------- */

console.log('tier 1 — curl / wget')

deny('bare curl to stdout', 'curl https://example.com/api', 'deny', 'ctx_fetch_and_index')
deny('curl with pipe', 'curl https://example.com | jq .', 'deny', 'ctx_fetch_and_index')
deny('curl in chain', 'cd /tmp && curl https://example.com', 'deny')
deny('wget bare', 'wget https://example.com/big.tar.gz', 'deny')
deny('curl -o stdout alias', 'curl -s -o - https://example.com', 'deny')
deny('curl -o /dev/stdout', 'curl -s -o /dev/stdout https://example.com', 'deny')
deny('curl not silent', 'curl -o out.json https://example.com', 'deny')
deny('curl quoted mention is safe', 'gh issue edit 42 --body "use curl to fetch"', 'allow')
deny('curl silent download to file', 'curl -s -o out.json https://example.com', 'allow')
deny('curl silent redirect to file', 'curl -s https://example.com > out.html', 'allow')
deny('wget quiet to file', 'wget -q -O out.tar.gz https://example.com/x.tar.gz', 'allow')
deny('wget quiet to stdout', 'wget -q -O - https://example.com', 'deny')
deny('curl heredoc mention is safe', 'cat <<EOF\nrequests.get("http://x")\nEOF', 'allow')

/* ---------------------------------------------------------------- */
/* 2. Tier 1: inline HTTP + build tools                             */
/* ---------------------------------------------------------------- */

console.log('tier 1 — inline HTTP, build tools')

deny('node -e fetch', 'node -e "fetch(\'http://x\').then(r=>r.text()).then(console.log)"', 'deny', 'ctx_execute')
deny('python requests.get', 'python -c "import requests; print(requests.get(\'https://x\').text)"', 'deny')
deny('http.get in node -e', 'node -e "require(\'http\').get(\'http://x\',r=>r.on(\'data\',d=>console.log(d)))"', 'deny')
deny('gradlew build', './gradlew build', 'deny', 'ctx_execute')
deny('mvn package', 'mvn package -DskipTests', 'deny')
deny('sbt compile', 'sbt compile', 'deny')
deny('gradle wrapper in quoted text', 'echo "run gradlew build"', 'allow')
// heredoc 里写 HTTP 代码是"落盘"，不是"执行" —— 必须放行给 Tier 2。
deny('heredoc writing http code is allowed', 'cat <<EOF\nrequests.get("http://x")\nEOF', 'allow')
deny('heredoc writing fetch is allowed', 'cat <<EOF\nfetch("https://x")\nEOF', 'allow')
// 但引号里的 node -e 代码要拦住 —— 调用在引号内，剥引号正好会藏掉它。
deny('quoted node -e fetch is denied', `node -e "fetch('http://x')"`, 'deny', 'ctx_execute')

/* ---------------------------------------------------------------- */
/* 3. Tier 2: commands that MUST run                                 */
/* ---------------------------------------------------------------- */

console.log('tier 2 — must run, output truncated')

// These are the whole point of the two-tier split: Tier 1 lets them through,
// Tier 2 truncates the oversized result afterwards.
deny('npm test runs', 'npm test', 'allow')
deny('git log runs', 'git log --oneline -50', 'allow')
deny('cat large log runs', 'cat huge.log', 'allow')
deny('find runs', 'find . -name "*.ts"', 'allow')
deny('docker ps runs', 'docker ps -a', 'allow')
deny('python script runs', 'python analyze.py', 'allow')
deny('npm run build runs', 'npm run build', 'allow')

/* ---------------------------------------------------------------- */
/* 4. Tier 2: content measurement + summary                          */
/* ---------------------------------------------------------------- */

console.log('tier 2 — measurement and summary')

eq('measureContent counts text', measureContent([{ type: 'text', text: 'hello' }]), 5)
eq('measureContent sums blocks', measureContent([{ type: 'text', text: 'abc' }, { type: 'text', text: 'de' }]), 5)
eq('measureContent counts UTF-8 bytes', measureContent([{ type: 'text', text: '上下' }]), 6)
eq('measureContent weights images', measureContent([{ type: 'image' }]), 4096)
eq('measureContent tolerates junk', measureContent([null, 42, 'x', undefined]), 0)
eq('measureContent tolerates undefined', measureContent(undefined), 0)

const summary = truncationSummary(PREFIX, 'pwsh', 20480, truncateHint(PREFIX, 'pwsh'))
eq('summary states the size', summary.includes('20.0 KB'), true)
eq('summary names the replacement', summary.includes('mcp__context_mode__ctx_batch_execute'), true)
eq('summary keeps the general pattern', summary.includes('ctx_execute'), true)

for (const tool of ['read', 'grep', 'glob', 'pwsh']) {
  eq(`${tool} hint names a replacement`, truncateHint(PREFIX, tool).includes(PREFIX), true)
}
eq('unknown tool falls back', truncateHint(PREFIX, 'mystery').includes('ctx_execute'), true)

// Threshold semantics: at or under the cap the result is left alone.
const small = [{ type: 'text', text: 'x'.repeat(100) }]
eq('small result passes the cap', measureContent(small) <= 20000, true)

/* ---------------------------------------------------------------- */
/* 5. helpers                                                       */
/* ---------------------------------------------------------------- */

console.log('helpers')

eq('stripQuotedContent removes double quotes', stripQuotedContent('gh pr create --body "curl this"'), 'gh pr create --body ""')
eq('stripQuotedContent removes single quotes', stripQuotedContent("echo 'curl x'"), "echo ''")
eq('stripQuotedContent removes heredoc', stripQuotedContent('cat <<EOF\nrequests.get("http://x")\nEOF'), 'cat ')
eq('isStructurallyBounded pwd', isStructurallyBounded('pwd'), true)
eq('isStructurallyBounded piped', isStructurallyBounded('pwd | cat'), false)
eq('isStructurallyBounded chained', isStructurallyBounded('pwd && ls'), false)
eq('isStructurallyBounded substitution', isStructurallyBounded('echo $(pwd)'), false)
eq('isStructurallyBounded semicolon', isStructurallyBounded('pwd; ls'), false)
eq('isStructurallyBounded empty', isStructurallyBounded(''), false)
eq('isStructurallyBounded mv -v', isStructurallyBounded('mv -v a b'), false)
eq('isStructurallyBounded mv silent', isStructurallyBounded('mv a b'), true)
eq('isStructurallyBounded ls -R', isStructurallyBounded('ls -R'), false)
eq('isStructurallyBounded cp --verbose', isStructurallyBounded('cp --verbose a b'), false)
eq('isStructurallyBounded python3 -V', isStructurallyBounded('python3 -V'), true)

/* ---------------------------------------------------------------- */
/* 6. routing block + prefix detection                              */
/* ---------------------------------------------------------------- */

console.log('routing block')

const block = buildRoutingBlock('mcp__context_mode__')
eq('block mentions Think in Code', block.includes('Think in Code'), true)
eq('block mentions ctx_execute', block.includes('mcp__context_mode__ctx_execute'), true)
eq('block mentions ctx_fetch_and_index', block.includes('mcp__context_mode__ctx_fetch_and_index'), true)
eq('block mentions ctx_batch_execute', block.includes('mcp__context_mode__ctx_batch_execute'), true)
eq('block mentions ctx_execute_file', block.includes('mcp__context_mode__ctx_execute_file'), true)
eq('block mentions ctx_search', block.includes('mcp__context_mode__ctx_search'), true)
eq('block mentions ctx_index', block.includes('mcp__context_mode__ctx_index'), true)
eq('block has no unresolved template', /\$\{p\}/.test(block), false)
eq('block is non-trivial length', block.length > 2000, true)

const custom = buildRoutingBlock('mcp__ctx__')
eq('block honors custom prefix', custom.includes('mcp__ctx__ctx_execute'), true)

eq('detectToolPrefix finds the server', detectToolPrefix([{ name: 'read' }, { name: 'mcp__context_mode__ctx_execute' }, { name: 'mcp__context_mode__ctx_search' }]), 'mcp__context_mode__')
eq('detectToolPrefix finds a renamed server', detectToolPrefix([{ name: 'mcp__ctx__ctx_batch_execute' }]), 'mcp__ctx__')
eq('detectToolPrefix returns null without context-mode', detectToolPrefix([{ name: 'read' }, { name: 'pwsh' }]), null)
eq('detectToolPrefix tolerates a bare string list', detectToolPrefix(['read', 'mcp__cm__ctx_index']), 'mcp__cm__')
eq('detectToolPrefix tolerates undefined', detectToolPrefix(undefined), null)
eq('detectToolPrefix tolerates a throwing list()', detectToolPrefix({ list() { throw new Error('x') } }), null)

/* ---------------------------------------------------------------- */
/* 7. per-tool guidance strings                                     */
/* ---------------------------------------------------------------- */

console.log('per-tool guidance')

for (const [label, text, needle] of [
  ['read', readGuidance(PREFIX, 'src/big.ts', 120000), 'ctx_execute_file'],
  ['web_fetch', webFetchGuidance(PREFIX, 'https://example.com'), 'ctx_fetch_and_index'],
  ['grep', grepGuidance(PREFIX), 'ctx_execute'],
  ['glob', globGuidance(PREFIX), 'ctx_execute'],
  ['subagent', subagentGuidance(PREFIX), 'ctx_batch_execute'],
]) {
  eq(`${label} guidance names its replacement`, text.includes(PREFIX + needle), true)
}

eq('read guidance keeps the edit escape hatch', readGuidance(PREFIX, 'src/big.ts', 120000).includes('EDIT'), true)
eq('subagent guidance explains the in-subagent path', subagentGuidance(PREFIX).includes('inside the subagent'), true)

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
