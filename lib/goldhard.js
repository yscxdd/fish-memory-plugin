// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * 难题组（v0.50.0，C1 的小步）——**一把会输的尺子**。
 *
 * 为什么要有：主金标 20/20、pass^4 也 100%。饱和的尺子测不出任何改进，
 * 也测不出"上周三的时间窗到底生效没"。
 *
 * 四类题，对应 `goldset.js` 顶部自己列过的那四个缺口：
 *   ① 同义改述（关节 / 膝盖）——别名（`memory alias`）该救回来的
 *   ② 相对时间（上周三 / 最近三天）——v0.49.0 的时间窗该救回来的
 *   ③ 否定（不讨厌）——字面最容易读反的一类
 *   ④ 指代（上次那个 / 之前说的）——最依赖上下文的一类
 *
 * 每题可以带 `mustNot`：命中它算失败（否定类就靠这个）。
 * 现在的水平大概是 40%–70%——**这个数字才是真实水平**，主金标的 20/20 不是。
 */

/**
 * 相对 now 的日期（让题目不随真实日期漂移）。
 *
 * **必须按本地日期格式化**：早先写成 `toISOString().slice(0,10)`，
 * 凌晨跑的时候会把 10-01 写成 09-30（差 8 小时），
 * 于是"上个月"的窗口把 T3 挡在外面，同一份题在夜里和白天的结果不一样——
 * 尺子自己会漂，那它测什么都不算数。
 */
function dateOffset(now, days) {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function point(id, title, summary, date, tags = [], cluster = '日常') {
  return { id, title, summary, date, tags, cluster, salience: 3, type: 'event', status: 'active', source: [], links: [] }
}

/**
 * 造难题组（日期相对 now，所以不会过期）
 * @param {Date} now
 */
export function buildHardSet(now = new Date()) {
  const D = (n) => dateOffset(now, n)

  const points = [
    // ① 同义改述
    point('H1', '他膝盖疼得下不了楼', '这几天膝盖不好，走楼梯都费劲', D(-20), ['身体'], '健康'),
    point('H2', '去拿体检报告', '周三去医院拿报告，顺路买了药', D(-14), ['医院'], '健康'),
    point('H3', '小陈搬走了', '楼下邻居搬去别的区了', D(-30), ['邻居'], '日常'),
    point('H4', '他把车卖了', '换成了电动车通勤', D(-25), ['车'], '日常'),

    // ② 相对时间：同主题、不同时间三条
    point('T1', '上周三去医院看牙', '牙疼了三天才去', D(-8), ['医院', '牙'], '健康'),
    point('T2', '昨天又跑了一趟医院', '陪他复查，排了两小时', D(-1), ['医院'], '健康'),
    point('T3', '上个月那次体检', '花了半天，结果还行', D(-35), ['医院', '体检'], '健康'),

    // ③ 否定
    point('N1', '我不讨厌香菜', '他说闻着还行，吃着也可以', D(-10), ['吃'], '饮食'),
    point('N2', '他讨厌香菜', '闻到就皱眉，挑出来', D(-40), ['吃'], '饮食'),

    // ④ 指代
    point('R1', '之前说的那个体检', '约在市一医院，周四上午', D(-18), ['体检'], '健康'),
    point('R2', '那次聊到的房子', '在江边，租金贵一点', D(-22), ['房子'], '日常'),
  ]

  const queries = [
    // ① 同义改述：字面几乎不重合，靠别名才能救
    { query: '关节不舒服', expect: 'H1', category: '同义' },
    { query: '医院的检查结果', expect: 'H2', category: '同义' },
    { query: '邻居搬走', expect: 'H3', category: '同义' },
    { query: '他把车处理了', expect: 'H4', category: '同义' },

    // ② 相对时间：三条同主题，必须靠时间窗挑出对的那条
    { query: '上周三去医院那事', expect: 'T1', category: '时序', mustNot: ['T2', 'T3'] },
    { query: '最近三天去医院了吗', expect: 'T2', category: '时序', mustNot: ['T1'] },
    { query: '上个月那次体检怎么样', expect: 'T3', category: '时序', mustNot: ['T2'] },

    // ③ 否定：问"讨厌香菜吗"，答的必须是不讨厌那条
    { query: '我讨厌香菜吗', expect: 'N1', category: '否定', mustNot: ['N2'] },

    // ④ 指代：靠"之前/那次"落在正确主题上
    { query: '之前说的那个体检在哪', expect: 'R1', category: '指代' },
    { query: '那次聊到的房子', expect: 'R2', category: '指代' },
  ]

  return { points, queries }
}
