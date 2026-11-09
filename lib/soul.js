// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * soul.js — 人格修订提案（v0.26.0）：**修那座"叙事 → 人格"的桥**。
 *
 * 问题：`15_self/` 每月一篇、人审放行，但**从来没有把自述的变化变成人格的变化**——
 * 于是"读了一百本书，她的 soul 一个字都没动"。这不是严谨，是锁死了。
 *
 * 做法（方案 2）：
 *   ① 自述与 `soul.md` 的可变区之间算一个**漂移距离**（bigram Dice，和 `core_drift` 同一套）；
 *   ② 漂移 ≥15% → 生成一份**提案**（不是改动）：`40_pending/_soul/rev-*.md`；
 *   ③ 人过目后 `memory soul-apply <提案>` → 校验 → 旧版快照 → 写新 soul → changelog 一行。
 *
 * 边界（写死，不由提案决定）：
 *   - **可动**：`## 性格特质`、`## 沟通风格`、`## 与你的关系`
 *   - **锁定**：`## 身份`、`## 核心价值观`、`## 边界`、`## 不会变的（金丝雀锚点）`、`## 可以怎么变`
 *
 * 为什么锁定这些：读书可以改变"她怎么说话、怎么看待关系"，不该改变"她是谁、她的底线、她的价值观"。
 * 这三类恰好对应人格心理学里的三层：气质（锁定）／特征适应（可动）／叙事（`15_self`）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { ANCHOR_LINES, diceSimilarity } from './guard.js'
import { latestSelf } from './self.js'
import { localDay } from './util.js'
import { appendFileSync } from 'node:fs'

// 锁定小节（**逐字不许动**）：她是谁、底线、价值观、金丝雀、变化方向
export const LOCKED_SECTIONS = ['## 身份', '## 核心价值观', '## 边界', '## 不会变的', '## 可以怎么变']

// 可变小节（可随经历修订）：默认"除锁定之外都可变"——
// 因为不同人的 soul 小节名不一样（有的是「脾气」，有的是「性格特质」「沟通风格」）。
export const MUTABLE_SECTIONS = ['## 性格特质', '## 沟通风格', '## 与你的关系', '## 脾气']

export const isLockedHeading = (heading) => LOCKED_SECTIONS.some((h) => String(heading || '').startsWith(h))
export const isMutableHeading = (heading) => !isLockedHeading(heading)

export const SOUL_DRIFT_MIN = 0.15 // 达到才提提案
export const SOUL_DRIFT_MAX = 0.2 // 单次改动上限（契约 §7.5）
export const MIN_EVIDENCE = 3
export const REV_DIR = join('40_pending', '_soul')

/** 按 `## ` 切小节：返回 [{heading, text}]，保留顺序 */
export function splitSections(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  let cur = null
  for (const line of lines) {
    const m = /^##\s+(.+)$/.exec(line)
    if (m) {
      if (cur) out.push(cur)
      cur = { heading: `## ${m[1].trim()}`, text: [line] }
    } else if (cur) {
      cur.text.push(line)
    }
  }
  if (cur) out.push(cur)
  return out.map((s) => ({ heading: s.heading, text: s.text.join('\n') }))
}

/** 拼出"可变区"（只含可动小节，按原顺序） */
export function mutableRegion(text) {
  return splitSections(text)
    .filter((s) => isMutableHeading(s.heading))
    .map((s) => s.text)
    .join('\n\n')
}

/** 拼出"锁定区"（用于逐字比对） */
export function lockedRegion(text) {
  return splitSections(text)
    .filter((s) => isLockedHeading(s.heading))
    .map((s) => s.text)
    .join('\n\n')
}

/** 漂移距离：1 − Dice 相似度（0 = 一字未动） */
/**
 * 一次修订的幅度（apply 的判据）。
 * 可变区为空（新库）时不能拿 Dice 算（分母为 0），改用"新增字数 / 整份 soul 字数"。
 */
export function editDriftOf(oldSoul, newSoul) {
  // 口径 = 契约 §7.5 的字面意思：**整份 soul** 的改动幅度。
  // （拿可变区算，会在"可变区很小"时把两行字放大成 30%+，那并不是"改动了三成"。）
  if (!String(oldSoul || '').trim() || !String(newSoul || '').trim()) return 1
  return driftOf(oldSoul, newSoul)
}

export function driftOf(a, b) {
  const x = String(a || '').trim()
  const y = String(b || '').trim()
  if (!x || !y) return x === y ? 0 : 1
  return Math.round((1 - diceSimilarity(x, y)) * 1000) / 1000
}

export function readSoul(dir) {
  const p = join(dir, '00_core', 'soul.md')
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

/** 证据权重（v0.28.0）：她想通/她观察 > 她挑的 > 他说的 */
const ORIGIN_WEIGHT = { insight: 3, observed: 3, chosen: 2, told: 1 }

/** 最近的"自我材料"点（event / preference / habit，active），她自己的声音排前面 */
export function selfMaterial(dir, points, limit = 8) {
  return points
    .filter((p) => p.status === 'active' && ['event', 'preference', 'habit'].includes(p.type))
    .sort((a, b) => (ORIGIN_WEIGHT[b.origin] || 1) - (ORIGIN_WEIGHT[a.origin] || 1) || String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, limit)
}

/**
 * 增量合并：只把自述里**新出现**的说法追加进可变区，且总量不超过 20%。
 *
 * 为什么不做整段替换：契约 §7.5 规定单次改动 ≤20%，整段换掉必然超（实测 80%）。
 * 而"一次改动换掉八成"本来也不是我们要的——那等于换个人。
 * 所以提案只是一份**种子**：人可以手改提案里的提议块，但 apply 仍受 20% 上限约束。
 */
export function minimalMerge(cur, self, { maxGrowth = SOUL_DRIFT_MAX, maxLines = 2, soulChars = 0 } = {}) {
  // 预算按**整份 soul** 的字数算（可变区可能很小甚至为空，按它算会一点都加不进去）
  const base = Math.max(soulChars, String(cur).length, 200)
  const budget = Math.max(20, Math.floor(base * maxGrowth))
  const selfSecs = splitSections(self)
  let out = String(cur)
  let added = 0
  let chars = 0

  for (const s of selfSecs) {
    if (isLockedHeading(s.heading)) continue
    const heading = s.heading
    const bullets = s.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .filter((l) => !String(cur).includes(l))
    for (const line of bullets) {
      if (added >= maxLines) break
      if (chars + line.length > budget) break
      const idx = out.indexOf(heading)
      if (idx < 0) {
        // 原 soul 没有这个小节：整节追加（也受预算约束）
        if (chars + s.text.length > budget) continue
        out = out.trimEnd() + '\n\n' + s.text.trim()
        chars += s.text.length
        continue
      }
      const nextHeading = out.indexOf('\n## ', idx + heading.length)
      const insertAt = nextHeading < 0 ? out.length : nextHeading
      out = out.slice(0, insertAt).trimEnd() + '\n' + line + '\n' + out.slice(insertAt)
      added += 1
      chars += line.length
    }
  }
  return out.trimEnd()
}

/**
 * 生成一份人格修订提案（只写提案，**不改 soul**）。
 * @returns {{ok:boolean, sourceDrift:number, editDrift?:number, path?:string, reason?:string}}
 */
export function proposeRevision(dir, points, { now = new Date(), force = false } = {}) {
  const soul = readSoul(dir)
  if (!soul) return { ok: false, sourceDrift: 0, reason: '00_core/soul.md 不存在' }
  const self = latestSelf(dir)
  if (!self) return { ok: false, sourceDrift: 0, reason: '还没有自述（15_self/ 为空）；先跑 memory self-promote' }

  const cur = mutableRegion(soul)
  const sourceDrift = driftOf(cur, self)
  if (!force && sourceDrift < SOUL_DRIFT_MIN) {
    return {
      ok: false,
      sourceDrift,
      reason: `漂移 ${(sourceDrift * 100).toFixed(1)}% < ${(SOUL_DRIFT_MIN * 100).toFixed(0)}%，还不够格提修订`,
    }
  }

  // 证据按时间正序列出（提案是给人读的，倒序看着乱）
  const evidence = selfMaterial(dir, points)
    .slice(0, Math.max(MIN_EVIDENCE, 5))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
  if (evidence.length < MIN_EVIDENCE) {
    return { ok: false, sourceDrift, reason: `证据不足：只有 ${evidence.length} 条自我材料，至少要 ${MIN_EVIDENCE} 条` }
  }

  // v0.28.3：证据里有没有"她自己的声音"（insight / observed）。
  // **只备注、不拦截**——库里可能前几个月全是"他说的"，加硬闸会把桥堵死。
  const selfVoice = evidence.filter((p) => p.origin === 'insight' || p.origin === 'observed')
  const voiceNote = selfVoice.length
    ? null
    : '这份修订的证据里没有一条是她自己想通的（insight/observed）：它更像是"他说的"推着变，而不是她自己长出来的。apply 不会拦，但请先确认这是她的意愿，不是你的。'

  const merged = minimalMerge(cur, self, { soulChars: soul.length })
  const editDrift = editDriftOf(soul, rebuildSoul(soul, cur, merged))
  if (editDrift === 0) {
    return { ok: false, sourceDrift, reason: '自述里的新说法都已经在 soul 里了，没有可提的改动' }
  }
  if (editDrift > SOUL_DRIFT_MAX) {
    return { ok: false, sourceDrift, reason: `一次改动 ${(editDrift * 100).toFixed(1)}% 超过上限 ${(SOUL_DRIFT_MAX * 100).toFixed(0)}%；请分几次` }
  }

  const proposed = rebuildSoul(soul, cur, merged)
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12)
  const file = join(dir, REV_DIR, `rev-${stamp}.md`)
  mkdirSync(join(dir, REV_DIR), { recursive: true })

  const body = [
    '---',
    'kind: soul-revision',
    `generated: ${now.toISOString()}`,
    `drift: ${editDrift}`,
    `source_drift: ${sourceDrift}`,
    `evidence: [${evidence.map((x) => x.id).join(', ')}]`,
    '---',
    '',
    '## 我哪里变了',
    '',
    `自述与可变区的距离 ${(sourceDrift * 100).toFixed(1)}%；本次提议只动 ${(editDrift * 100).toFixed(1)}%（上限 ${(SOUL_DRIFT_MAX * 100).toFixed(0)}%）。`,
    '建议人类在下面手写一句"她哪里不一样了"；留空就照提议用。',
    '',
    ...(voiceNote ? ['## 备注（不是拦截）', '', `⚠ ${voiceNote}`, ''] : ['## 备注', '', `她自己的声音：证据里有 ${selfVoice.length} 条 insight/observed。`, '']),
    '## 因为什么',
    '',
    '（一句话说清是哪些经历推着变的；留空则从证据里摘）',
    '',
    '## 证据',
    '',
    ...evidence.map((x) => `- ${x.id}：${x.title || ''}（${x.date || ''}，${x.type}）`),
    '',
    '## 元认知四问（人审时逐条过；不过就别 apply）',
    '',
    '借自《数字生命》那套"元认知自我思辨"的四问，用在我们这里相当于**提案的检查项**：',
    '',
    '1. **这次变化是她的本心，还是临时情绪？**',
    '   —— 看证据的 `origin`：全是 `told` 就要警惕（那只是他说的，不是她想通的）。',
    '2. **有没有盲区、执念、或者被某一条经历带偏？**',
    '   —— 证据是否集中在同一个事件/同一周？集中就是偏。',
    '3. **价值观、底线要不要跟着调？**',
    '   —— **不要**。锁定小节（身份/核心价值观/边界/金丝雀/变化方向）本次改动为零；',
    '      若你认为必须调，那是另一件事：手工改 + 走 §7.5（7 天 ≤2 次、≤20%、留快照）。',
    '4. **离"理想自我"还差什么？**',
    '   —— 一句话写在这份提案末尾（可选）；它会成为下一篇自述的起点。',
    '',
    '## 提议的 soul.md（应用时整份替换；锁定小节必须逐字不变）',
    '',
    '```markdown',
    proposed,
    '```',
    '',
  ].join('\n')

  writeFileSync(file, body, 'utf8')
  return { ok: true, sourceDrift, editDrift, selfVoice: selfVoice.length, voiceNote, path: file }
}

/** 用 newMutable 替换 soul 里的可变区，其它小节逐字保留 */
export function rebuildSoul(soul, oldMutable, newMutable) {
  const secs = splitSections(soul)
  const head = String(soul).slice(0, String(soul).indexOf(secs[0]?.heading || '')).trimEnd()
  const parts = []
  if (head) parts.push(head)
  let inserted = false
  for (const s of secs) {
    const isMutable = isMutableHeading(s.heading)
    if (!isMutable) {
      parts.push(s.text)
      continue
    }
    if (!inserted) {
      parts.push(String(newMutable).trim())
      inserted = true
    }
  }
  if (!inserted) parts.push(String(newMutable).trim()) // 原 soul 没有可变区：补在尾部
  return parts.join('\n\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

const nextVersion = (dir) => {
  const vdir = join(dir, '00_core', 'versions')
  if (!existsSync(vdir)) return 1
  const nums = readdirSync(vdir)
    .map((f) => /^soul\.v(\d+)\.md$/.exec(f))
    .filter(Boolean)
    .map((m) => Number(m[1]))
  return (nums.length ? Math.max(...nums) : 0) + 1
}

/** 7 天内核心层改动条数（与 audit 的 soul_guard 同一口径） */
export function changes7d(dir, now = new Date()) {
  const p = join(dir, '00_core', 'core_changelog.md')
  if (!existsSync(p)) return 0
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000).toISOString().slice(0, 10)
  return readFileSync(p, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^(\d{4}-\d{2}-\d{2})\s*\|/))
    .filter((m) => m && m[1] >= weekAgo).length
}

/**
 * 应用提案（人审之后）。六道校验，任何一道不过就**不动 soul.md**。
 */
export function applyRevision(dir, revFile, points, { now = new Date(), force = false } = {}) {
  const file = revFile.startsWith(dir) ? revFile : join(dir, revFile)
  if (!existsSync(file)) return { ok: false, errors: [{ field: 'file', message: `找不到提案：${revFile}` }] }
  const raw = readFileSync(file, 'utf8')
  const m = /```markdown\r?\n([\s\S]*?)```/.exec(raw)
  if (!m) return { ok: false, errors: [{ field: 'file', message: '提案里没有 ```markdown 提议块' }] }
  const proposed = m[1].trimEnd() + '\n'

  const soul = readSoul(dir)
  if (!soul) return { ok: false, errors: [{ field: 'soul', message: '00_core/soul.md 不存在' }] }

  const errors = []
  // ① 金丝雀三条必须还在（少一条就是"她不是她了"）
  //    注意：这里必须用原样的整行去比，不能把 "- " 归一成 "-"（那会永远对不上）
  const anchorLines = ANCHOR_LINES.filter((line) => /^-\s/.test(line))
  const anchorsMissing = anchorLines.filter((line) => !soul.includes(line))
  const anchorCount = anchorLines.filter((line) => proposed.includes(line)).length
  if (anchorCount < 3) errors.push({ field: 'anchors', message: `提议里金丝雀锚点只剩 ${anchorCount}/3 条` })

  // ② 锁定小节必须逐字不变
  const beforeLocked = lockedRegion(soul)
  const afterLocked = lockedRegion(proposed)
  if (beforeLocked !== afterLocked) errors.push({ field: 'locked', message: '锁定小节（身份/核心价值观/边界/锚点/变化方向）被改动了' })

  // ③ 幅度与方向
  const drift = editDriftOf(soul, proposed)
  if (drift === 0) errors.push({ field: 'drift', message: '可变区没有任何变化' })
  if (drift > SOUL_DRIFT_MAX) errors.push({ field: 'drift', message: `改动幅度 ${(drift * 100).toFixed(1)}% 超过 ${(SOUL_DRIFT_MAX * 100).toFixed(0)}%` })

  // ④ 频次：7 天 ≤2 条
  const used = changes7d(dir, now)
  if (!force && used >= 2) errors.push({ field: 'quota', message: `7 天内已改 ${used} 次（上限 2）；要覆盖加 --force` })

  // ⑤ 证据：≥3 条真实存在的点
  const ids = (/^evidence:\s*\[([^\]]*)\]/m.exec(raw)?.[1] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const known = new Set(points.map((p) => p.id))
  const badIds = ids.filter((id) => !known.has(id))
  if (ids.length < MIN_EVIDENCE) errors.push({ field: 'evidence', message: `证据只有 ${ids.length} 条，至少要 ${MIN_EVIDENCE} 条` })
  if (badIds.length) errors.push({ field: 'evidence', message: `evidence 里有不存在的点：${badIds.join(', ')}` })

  // v0.28.3：证据里没有她自己的声音 → 只给 warning，不拦（备注版，不是硬闸）
  const warnings = []
  const voice = ids.filter((id) => {
    const pt = points.find((x) => x.id === id)
    return pt && (pt.origin === 'insight' || pt.origin === 'observed')
  })
  if (ids.length && !voice.length) {
    warnings.push('证据里没有一条是她自己想通的（insight/observed）：这次变化更像是"他说的"推着走')
  }

  if (errors.length) return { ok: false, errors, drift, anchorsMissing, warnings }

  // 写：旧版快照 → 新 soul → changelog → 日志
  const v = nextVersion(dir)
  const vdir = join(dir, '00_core', 'versions')
  mkdirSync(vdir, { recursive: true })
  const snap = `soul.v${String(v).padStart(3, '0')}.md`
  writeFileSync(join(vdir, snap), soul, 'utf8')
  writeFileSync(join(dir, '00_core', 'soul.md'), proposed, 'utf8')

  // B14：UTC 的"今天"在 +08:00 的凌晨会算成昨天，用本地日期
  const day = localDay(now)
  appendFileSync(
    join(dir, '00_core', 'core_changelog.md'),
    `${day} | soul.md | v${String(v).padStart(3, '0')} | 人格修订 ${(drift * 100).toFixed(1)}%（evidence: ${ids.join(', ')}）\n`,
    'utf8',
  )
  mkdirSync(join(dir, '50_log'), { recursive: true })
  appendFileSync(
    join(dir, '50_log', 'soul.log'),
    JSON.stringify({ at: now.toISOString(), action: 'soul-revision', drift, version: v, snapshot: snap, evidence: ids }) + '\n',
    'utf8',
  )
  return { ok: true, drift, version: v, snapshot: `00_core/versions/${snap}`, evidence: ids, warnings }
}
