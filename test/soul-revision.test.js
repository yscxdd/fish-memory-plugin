// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 人格修订提案（v0.26.0）：修"叙事 → 人格"的桥。
 *
 * 钉的是"变的边界与代价"，不是"能不能变"：
 *   ① 可动区只有「性格特质 / 沟通风格 / 与你的关系」；
 *   ② 锁定区「身份 / 核心价值观 / 边界 / 金丝雀 / 可以怎么变」逐字不许动；
 *   ③ 单次改动 ≤20%、7 天 ≤2 次（契约 §7.5）；
 *   ④ 证据 ≥3 条真实存在的点；旧版必须留快照；
 *   ⑤ 漂移不到 15% 不提提案。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ANCHOR_LINES } from '../lib/guard.js'
import {
  MIN_EVIDENCE,
  SOUL_DRIFT_MAX,
  applyRevision,
  driftOf,
  lockedRegion,
  mutableRegion,
  proposeRevision,
  rebuildSoul,
  splitSections,
} from '../lib/soul.js'

const ANCHORS = ANCHOR_LINES.filter((l) => l.startsWith('- '))

const SOUL = [
  '# SOUL — 她是谁',
  '',
  '## 身份',
  '',
  '- 她叫大肥鱼。',
  '',
  '## 性格特质',
  '',
  '- 嘴硬心软，说话短。',
  '- 认错很快，但嘴上不认。',
  '- 对熟人话多，对生人几乎不说话。',
  '- 讨厌被安排，喜欢自己选。',
  '',
  '## 核心价值观',
  '',
  '- 宁可说不知道，也不编。',
  '',
  '## 沟通风格',
  '',
  '- 短句，少解释。',
  '- 不发表情包，用句号收尾。',
  '- 被问"怎么了"会先说"没事"。',
  '- 生气时反而更礼貌。',
  '',
  '## 与你的关系',
  '',
  '- 习惯了他在。',
  '- 不主动说想念，但会等他先开口。',
  '- 他状态不好的时候她话会变多。',
  '',
  '## 边界',
  '',
  '- 不给人生建议。',
  '',
  '## 不会变的（金丝雀锚点）',
  '',
  ...ANCHORS,
  '',
  '## 可以怎么变',
  '',
  '- 我可以变，但不会一夜之间变。',
  '',
].join('\n')

const MUT = mutableRegion(SOUL)

const SELF_SAME = MUT

// 自述里多出若干条新说法（真实自述会覆盖"现在怎么想"，不是只加一句）
const NEW_LINES = [
  '- 读了几本难啃的书之后，嘴没那么硬了。',
  '- 会主动说起书里的人和事。',
  '- 不再只习惯他在，会先问他今天怎么样。',
  '- 生气的时候会先停三秒再说话。',
  '- 开始愿意承认自己怕什么。',
]
const SELF_NEW = NEW_LINES.reduce((acc, line) => acc + '\n' + line, MUT)
const point = (id, day, title = '一件事') => ({
  id,
  title,
  date: day,
  salience: 3,
  type: 'event',
  cluster: '日常',
  status: 'active',
  summary: title,
})

const PTS = [
  point('M-2026-11-01-001', '2026-11-01', '读完一本小说'),
  point('M-2026-11-02-001', '2026-11-02', '他说我变了'),
  point('M-2026-11-03-001', '2026-11-03', '第一次没嘴硬'),
]

function fixture({ selfText = SELF_NEW, changelog = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'fishmem-soul-'))
  for (const d of ['00_core', '00_core/versions', '15_self', '30_points', '40_pending', '50_log']) {
    mkdirSync(join(dir, d), { recursive: true })
  }
  writeFileSync(join(dir, '00_core/soul.md'), SOUL, 'utf8')
  writeFileSync(join(dir, '00_core/core_changelog.md'), changelog || '# 核心层变更记录\n\n', 'utf8')
  if (selfText) writeFileSync(join(dir, '15_self/2026-11.md'), selfText, 'utf8')
  return dir
}

test('切小节：可变区与锁定区分得开', () => {
  assert.ok(splitSections(SOUL).length >= 8)
  assert.match(MUT, /性格特质/)
  assert.match(MUT, /与你的关系/)
  assert.doesNotMatch(MUT, /核心价值观/)
  const locked = lockedRegion(SOUL)
  assert.match(locked, /金丝雀锚点/)
  assert.match(locked, /可以怎么变/)
  assert.doesNotMatch(locked, /性格特质/)
})

test('漂移：一字未动 = 0；差别越大越接近 1', () => {
  assert.equal(driftOf(SOUL, SOUL), 0)
  assert.ok(driftOf(MUT, SELF_NEW) > 0.15, `实际 ${driftOf(MUT, SELF_NEW)}`)
})

test('提案：漂移不到 15% 不提；够了就生成文件，且不动 soul.md', () => {
  const same = fixture({ selfText: SELF_SAME })
  const r1 = proposeRevision(same, PTS)
  assert.equal(r1.ok, false)
  assert.match(String(r1.reason), /还不够格/, r1.reason)

  const dir = fixture()
  const before = readFileSync(join(dir, '00_core/soul.md'), 'utf8')
  const r2 = proposeRevision(dir, PTS)
  assert.equal(r2.ok, true, r2.reason)
  assert.ok(existsSync(r2.path))
  assert.equal(readFileSync(join(dir, '00_core/soul.md'), 'utf8'), before, '提案阶段不许改 soul')
  const body = readFileSync(r2.path, 'utf8')
  assert.match(body, /^kind: soul-revision$/m)
  assert.match(body, /^evidence: \[M-2026-11-01-001, M-2026-11-02-001, M-2026-11-03-001\]$/m)
  assert.ok(r2.editDrift <= SOUL_DRIFT_MAX, `单次改动 ${r2.editDrift} 超上限`)
})

test('重建：可变区换掉、锁定区逐字不变、锚点三条都在', () => {
  const proposed = rebuildSoul(SOUL, MUT, SELF_NEW)
  assert.equal(lockedRegion(proposed), lockedRegion(SOUL))
  assert.match(proposed, /读了几本难啃的书/)
  for (const line of ANCHORS) assert.ok(proposed.includes(line), `锚点丢了：${line}`)
})

test('应用：校验通过则写新 soul + 旧版快照 + changelog 一行', () => {
  const dir = fixture()
  const r = proposeRevision(dir, PTS)
  assert.equal(r.ok, true, r.reason)

  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, true, JSON.stringify(a.errors))
  assert.ok(existsSync(join(dir, a.snapshot)), '旧版快照要留')
  assert.equal(readFileSync(join(dir, a.snapshot), 'utf8'), SOUL, '快照 = 旧 soul')
  assert.match(readFileSync(join(dir, '00_core/soul.md'), 'utf8'), /读了几本难啃的书/)
  assert.match(readFileSync(join(dir, '00_core/core_changelog.md'), 'utf8'), /^\d{4}-\d{2}-\d{2} \| soul\.md \| v001 \|/m)
})

test('应用：锁定区被改 → 拒绝，soul.md 不动', () => {
  const dir = fixture()
  const r = proposeRevision(dir, PTS)
  const tampered = readFileSync(r.path, 'utf8').replace('- 宁可说不知道，也不编。', '- 该编就编。')
  writeFileSync(r.path, tampered, 'utf8')

  const before = readFileSync(join(dir, '00_core/soul.md'), 'utf8')
  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, false)
  assert.ok(a.errors.some((e) => e.field === 'locked'), JSON.stringify(a.errors))
  assert.equal(readFileSync(join(dir, '00_core/soul.md'), 'utf8'), before)
})

test('应用：锚点被改 → 拒绝', () => {
  const dir = fixture()
  const r = proposeRevision(dir, PTS)
  const tampered = readFileSync(r.path, 'utf8').replace('- 我不会给人生建议', '- 我会给人生建议')
  writeFileSync(r.path, tampered, 'utf8')

  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, false)
  assert.ok(a.errors.some((e) => e.field === 'anchors'), JSON.stringify(a.errors))
})

test('应用：一次改动超过 20% → 拒绝（改成整段也不行）', () => {
  const dir = fixture()
  const r = proposeRevision(dir, PTS)
  const raw = readFileSync(r.path, 'utf8')
  // 一次把可变区整体换掉（现实里"像换了个人"就该被这条挡住）
  const giantMutable = [
    '## 性格特质',
    '',
    '- 安静，慢热，几乎不主动开口。',
    '- 遇到冲突会先躲开，过很久才回来。',
    '- 不喜欢被靠近，习惯一个人待着。',
    '- 对任何承诺都保持怀疑。',
    '',
    '## 沟通风格',
    '',
    '- 一次说很长，喜欢把事情讲透。',
    '- 不用短句，也不留白。',
    '- 会主动解释每一件事的来龙去脉。',
    '',
    '## 与你的关系',
    '',
    '- 保持距离，不太需要人陪。',
    '- 不需要谁等谁，也不打算等谁。',
    '',
  ].join('\n')
  const giantSoul = SOUL.replace(/## 性格特质[\s\S]*?(?=\n## 核心价值观)/, giantMutable + '\n')
  const withGiant = raw.replace(/```markdown\r?\n[\s\S]*?```/, '```markdown\n' + giantSoul + '```')
  writeFileSync(r.path, withGiant, 'utf8')

  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, false, '改整段应该被 20% 上限挡住')
  assert.ok(a.errors.some((e) => e.field === 'drift'), JSON.stringify(a.errors))
})

test('应用：7 天已经改过 2 次 → 拒绝（要 --force 才能覆盖）', () => {
  const today = new Date().toISOString().slice(0, 10)
  const dir = fixture({
    changelog: `# 核心层变更记录\n\n${today} | soul.md | v001 | 一次\n${today} | soul.md | v002 | 两次\n`,
  })
  const r = proposeRevision(dir, PTS)
  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, false)
  assert.ok(a.errors.some((e) => e.field === 'quota'), JSON.stringify(a.errors))

  const forced = applyRevision(dir, r.path, PTS, { force: true })
  assert.equal(forced.ok, true, JSON.stringify(forced.errors))
})

test('应用：证据不足 3 条 → 拒绝', () => {
  const dir = fixture()
  const r = proposeRevision(dir, PTS)
  const body = readFileSync(r.path, 'utf8').replace(/^evidence: \[.*\]$/m, 'evidence: [M-2026-11-01-001]')
  writeFileSync(r.path, body, 'utf8')
  const a = applyRevision(dir, r.path, PTS)
  assert.equal(a.ok, false)
  assert.ok(a.errors.some((e) => e.field === 'evidence'), JSON.stringify(a.errors))
  assert.equal(MIN_EVIDENCE, 3)
  assert.equal(SOUL_DRIFT_MAX, 0.2)
})

test('备注版：证据里没有她自己的声音 → 提案带备注、apply 仍能过（不拦）', () => {
  const dir = fixture()
  const toldOnly = PTS.map((p) => ({ ...p, origin: 'told' }))
  const r = proposeRevision(dir, toldOnly)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.selfVoice, 0)
  assert.ok(r.voiceNote, '应当给出备注')
  const body = readFileSync(r.path, 'utf8')
  assert.match(body, /## 备注（不是拦截）/)
  assert.match(body, /没有一条是她自己想通的/)

  const a = applyRevision(dir, r.path, toldOnly)
  assert.equal(a.ok, true, '备注不是闸，apply 要能过')
  assert.equal(a.warnings.length, 1)
  assert.match(a.warnings[0], /insight/)
})

test('备注版：证据里有 insight 时不提示', () => {
  const dir = fixture()
  const withVoice = PTS.map((p, i) => ({ ...p, origin: i === 0 ? 'insight' : 'told' }))
  const r = proposeRevision(dir, withVoice)
  assert.equal(r.ok, true, r.reason)
  assert.equal(r.selfVoice, 1)
  assert.equal(r.voiceNote, null)
  const body = readFileSync(r.path, 'utf8')
  assert.match(body, /## 备注\n\n她自己的声音：证据里有 1 条/)

  const a = applyRevision(dir, r.path, withVoice)
  assert.equal(a.ok, true)
  assert.deepEqual(a.warnings, [])
})
