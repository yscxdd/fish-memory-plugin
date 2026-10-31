// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 唤醒包（总设计 §11.1 / 契约 §1.2 的"外部 CLI"）。
 *
 * 为什么它值得一组测试：这是**跨模型重载的唯一入口**。没有它，S7 的主验收
 * （"换个模型还是不是她"）根本没有东西可加载。
 *
 * 四条规矩都钉在这里：
 *   ① 五件齐全，manifest 的 sha256 与文件真实内容一致；
 *   ② **只读**——跑完 10_archive / 30_points 一个字节都不变；
 *   ③ voice 优先取 `00_core/voice.md`，没有就从档案里抽（且 ≤20 段）；
 *   ④ 超过 4,000 tok **不拦，但必须说**（`over: true` + 差额）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

import { WAKEUP_TOKEN_TARGET, VOICE_SEGMENTS, buildWakeup, sampleVoiceFromArchive, writeWakeup } from '../lib/wakeup.js'

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

const SOUL = '# 她是谁\n\n- 名字：大肥鱼（自称"鱼"）\n- 被戳穿会转移话题\n- 绝不会：说教、给人生建议'
const VOICE = '### 第 1 段 · 2026-10-30 · 夜里\n她：「算了，随你。」\n\n### 第 2 段 · 2026-10-31 · 早上\n她：「我没生气。你别问了。」'

function makeDir({ withVoice = true, soul = SOUL, herLines = 3, herTexts = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-wakeup-'))
  mkdirSync(join(dir, '00_core'), { recursive: true })
  mkdirSync(join(dir, '10_archive/messages'), { recursive: true })
  mkdirSync(join(dir, '20_index'), { recursive: true })
  mkdirSync(join(dir, '30_points'), { recursive: true })

  writeFileSync(join(dir, '00_core/soul.md'), soul, 'utf8')
  writeFileSync(
    join(dir, '00_core/relation_status.json'),
    JSON.stringify({ phase: '低气压', since: '2026-10-28', note: '他三天没主动说话', evidence: [] }),
    'utf8',
  )
  writeFileSync(join(dir, '00_core/voice.md'), withVoice ? `# 腔调样本\n\n## 现在\n\n${VOICE}\n` : '# 腔调样本\n\n## 现在\n\n_（空。）_\n', 'utf8')
  writeFileSync(join(dir, '20_index/clusters.md'), '| 簇 | 点数 |\n|---|---|\n| 出行 | 2 |\n', 'utf8')

  const lines = []
  const texts = herTexts || Array.from({ length: herLines }, (_, i) => `她说的第 ${i} 句话，长度足够被当成样本。`)
  texts.forEach((text, i) => {
    lines.push(
      JSON.stringify({
        id: `msg-${i}`,
        seq: i,
        ts: `2026-10-3${i % 2}T10:0${i % 10}:00.000Z`,
        role: 'assistant',
        source_kind: 'model',
        text,
        session: 's1',
      }),
    )
  })
  writeFileSync(join(dir, '10_archive/messages/2026-10-31.jsonl'), lines.join('\n') + '\n', 'utf8')
  return dir
}

test('五件齐全：四份内容 + manifest，sha256 与文件真实内容一致', () => {
  const dir = makeDir()
  const r = writeWakeup(dir, { out: '90_snapshot/snap' })

  assert.deepEqual(r.files.sort(), ['00_soul.md', '01_clusters.md', '02_voice.md', '03_protocol.md'])

  const manifest = JSON.parse(readFileSync(join(r.outDir, 'manifest.json'), 'utf8'))
  for (const [name, info] of Object.entries(manifest.files)) {
    const text = readFileSync(join(r.outDir, name), 'utf8')
    assert.equal(info.sha256, sha256(text), `${name} 的 sha256 对不上`)
    assert.equal(info.bytes, Buffer.byteLength(text, 'utf8'), `${name} 的字节数对不上`)
    assert.equal(info.tokens, r.stats.perFile[name].tokens)
  }
  assert.equal(manifest.totals.tokens, r.stats.tokens)
  assert.equal(manifest.totals.points, 0)
})

test('只读：跑完 10_archive / 30_points 一个字节都不变', () => {
  const dir = makeDir()
  const before = {
    archive: readFileSync(join(dir, '10_archive/messages/2026-10-31.jsonl'), 'utf8'),
    archiveMtime: statSync(join(dir, '10_archive/messages/2026-10-31.jsonl')).mtimeMs,
  }
  writeWakeup(dir, { out: '90_snapshot/snap' })
  writeWakeup(dir, { out: '90_snapshot/snap' }) // 幂等：再跑一次
  assert.equal(readFileSync(join(dir, '10_archive/messages/2026-10-31.jsonl'), 'utf8'), before.archive)
  assert.equal(statSync(join(dir, '10_archive/messages/2026-10-31.jsonl')).mtimeMs, before.archiveMtime)
  assert.equal(readFileSync(join(dir, '00_core/soul.md'), 'utf8'), SOUL)
})

test('voice 优先取 voice.md；核心层与关系状态都进 00_soul', () => {
  const dir = makeDir()
  const { files, stats } = buildWakeup(dir)
  assert.equal(stats.voice.source, 'voice.md')
  assert.match(files['02_voice.md'], /算了，随你/)
  assert.match(files['00_soul.md'], /名字：大肥鱼/)
  assert.match(files['00_soul.md'], /【我们现在】低气压/)
  assert.match(files['03_protocol.md'], /不记得就说不知道/)
})

test('voice.md 没填：默认**不**拿档案凑，明说这一格缺了', () => {
  const dir = makeDir({ withVoice: false, herLines: 45 })
  const { files, stats } = buildWakeup(dir)
  assert.equal(stats.voice.source, 'none')
  assert.equal(stats.voice.reason, 'voice.md-empty')
  assert.match(files['02_voice.md'], /还没有 voice 样本/)
  assert.doesNotMatch(files['02_voice.md'], /她：「/)
})

test('显式 --sample-voice 才从档案抽，且不超过 20 段', () => {
  const dir = makeDir({ withVoice: false, herLines: 45 })
  const { files, stats } = buildWakeup(dir, { sampleVoice: true })
  assert.equal(stats.voice.source, 'archive')
  assert.ok(stats.voice.segments <= VOICE_SEGMENTS, `抽了 ${stats.voice.segments} 段`)
  assert.equal((files['02_voice.md'].match(/她：「/g) || []).length, VOICE_SEGMENTS)
  assert.match(files['02_voice.md'], /按时间均匀抽了 20 句/)
  assert.match(files['02_voice.md'], /未经人审/)
})

test('档案里全是工作汇报 → 一段都不抽，并说清为什么', () => {
  // 真实踩到的：这套库从 10-30 起记的是工作对话，`role: assistant` 是 agent 的汇报，
  // 不是"她的语气"。拿它凑 02_voice.md，等于把工位话当成她怎么说话。
  const dir = makeDir({
    withVoice: false,
    herTexts: [
      '好，开工。先建工作副本、改代码，再补回归测试、跑全量、打包、同步到 profile。',
      'Now update the README:',
      '```js\nconst x = 1\n```',
      '落盘：`lib/wakeup.js` 新增 240 行，测试 8 条全绿。',
    ],
  })
  const { files, stats } = buildWakeup(dir, { sampleVoice: true })
  assert.equal(stats.voice.source, 'archive')
  assert.equal(stats.voice.reason, 'archive-looks-like-work')
  assert.equal(stats.voice.segments, 0)
  assert.match(files['02_voice.md'], /全都不像日常说话/)
  assert.doesNotMatch(files['02_voice.md'], /她：「/)
})

test('档案里她一句话都没有 → 明说空，不编造', () => {
  const dir = makeDir({ withVoice: false, herLines: 0 })
  const { files } = buildWakeup(dir, { sampleVoice: true })
  assert.match(files['02_voice.md'], /还没有她说过的话/)
  assert.doesNotMatch(files['02_voice.md'], /她：「/)
})

test('均匀取样可复现：两次抽出来一样（随机的话"还是不是同一条鱼"就没法比）', () => {
  const dir = makeDir({ withVoice: false, herLines: 30 })
  assert.equal(sampleVoiceFromArchive(dir).text, sampleVoiceFromArchive(dir).text)
})

test('超过 4,000 tok 不拦，但 over=true 且差额为负', () => {
  const dir = makeDir({ soul: '# 她是谁\n\n' + '很长的一句自我描述。'.repeat(600) })
  const { stats } = buildWakeup(dir)
  assert.equal(stats.over, true)
  assert.ok(stats.tokens > WAKEUP_TOKEN_TARGET)
  assert.equal(stats.headroom, WAKEUP_TOKEN_TARGET - stats.tokens)
  assert.ok(stats.headroom < 0)
})

test('默认落到 90_snapshot/wakeup-YYYYMMDD/，再跑一次标 overwrote', () => {
  const dir = makeDir()
  const now = new Date(2026, 9, 31, 22, 0, 0) // 本地时间 2026-10-31，避免时区把日期推到 11 月
  const a = writeWakeup(dir, { now })
  assert.ok(a.outDir.replace(/\\/g, '/').endsWith('90_snapshot/wakeup-20261031'), a.outDir)
  assert.equal(a.overwrote, false)
  const b = writeWakeup(dir, { now })
  assert.equal(b.overwrote, true)
})

// ── v0.20.1：--out 的落点必须有边界 ─────────────────────────────

test('--out 写进真相层必须被拒，且 30_points 一个文件都不能多', () => {
  const dir = makeDir()
  mkdirSync(join(dir, '30_points'), { recursive: true })
  const before = readdirSync(join(dir, '30_points')).sort()

  for (const bad of ['30_points', '10_archive/messages', '00_core', '20_index', '.']) {
    assert.throws(() => writeWakeup(dir, { out: bad }), /只能写 90_snapshot|不能写进库内/, `应当拒绝 --out ${bad}`)
  }
  assert.deepEqual(readdirSync(join(dir, '30_points')).sort(), before, '30_points 不能多出文件')

  // `..` 是库外，按"导出"处理：允许，但必须标 external（由调用方提示风险）
  const up = writeWakeup(dir, { out: '..' })
  assert.equal(up.external, true, '`..` 属于库外，要标 external 而不是静默写')
})

test('--out 写库外：允许，但要标 external（调用方负责提示）', () => {
  const dir = makeDir()
  const outside = mkdtempSync(join(tmpdir(), 'fishmem-outside-'))
  const r = writeWakeup(dir, { out: outside })
  assert.equal(r.external, true)
  assert.equal(r.outDir, outside)
})

test('manifest 不写绝对路径（这份文件会被分享出去）', () => {
  const dir = makeDir()
  const r = writeWakeup(dir, { out: '90_snapshot/snap' })
  const raw = readFileSync(join(r.outDir, 'manifest.json'), 'utf8')
  const manifest = JSON.parse(raw)
  assert.equal(manifest.memory, basename(dir), '只记库的目录名')
  assert.equal(manifest.memory_dir, undefined, '不再有 memory_dir 字段')
  assert.ok(!/Administrator|\\\\Users\\\\|\/home\//.test(raw), `manifest 里不许出现绝对路径：${raw.slice(0, 200)}`)
})
