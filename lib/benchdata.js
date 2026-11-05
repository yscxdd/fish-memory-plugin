// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

/**
 * benchdata.js — 中文检索对照的题库（v0.62.0）。
 *
 * 单独拎出来是因为**数据不该带副作用**：`scripts/retrieval-bench.mjs` 一 import 就跑整套跑分
 * （还要动态 import 第三方包），测试没法复用它。这里只有纯数据。
 *
 * 30 条记忆 × 20 道题，三档：`kw` 关键词 / `sent` 短句 / `para` 换说法。
 * `para` 那档才是真难点——同义改写，两套引擎都会摔。
 */

export const MEMORIES = [
  { id: 'M1', text: '今天在广州下雨，她说记得带伞。' },
  { id: 'M2', text: '他说关节不舒服，下雨天更疼。' },
  { id: 'M3', text: '约了周六下午见面，后来改成周日下午。' },
  { id: 'M4', text: '他去体检了，报告说血脂偏高。' },
  { id: 'M5', text: '邻居搬走了，楼下的阿姨换了人。' },
  { id: 'M6', text: '他把那辆旧车处理掉了，说要换电车。' },
  { id: 'M7', text: '她答应过不催他，让他自己想清楚。' },
  { id: 'M8', text: '他说最怕被丢下，所以一直不敢先挂电话。' },
  { id: 'M9', text: '她说喜欢海，但不喜欢人多的沙滩。' },
  { id: 'M10', text: '他连着三天加班到十一点。' },
  { id: 'M11', text: '她妈妈住院了，是胆结石手术。' },
  { id: 'M12', text: '他跟我道歉了，为那天突然沉默的事。' },
  { id: 'M13', text: '她想去海边过生日，说想安安静静待一天。' },
  { id: 'M14', text: '他把阳台的绿萝搬到客厅，说太晒了。' },
  { id: 'M15', text: '她说最近睡不好，凌晨三四点会醒。' },
  { id: 'M16', text: '他答应下周三陪她去看医生。' },
  { id: 'M17', text: '她换工作了，从设计转去做运营。' },
  { id: 'M18', text: '他说老家的房子要翻修，预算还没谈拢。' },
  { id: 'M19', text: '她养的那只橘猫叫团子，特别黏人。' },
  { id: 'M20', text: '他说这次不想再从头解释一遍。' },
  { id: 'M21', text: '她怕打雷，雷雨夜会失眠。' },
  { id: 'M22', text: '他把咖啡戒了，改喝温水。' },
  { id: 'M23', text: '她小时候在外婆家长大，外婆会做糖水。' },
  { id: 'M24', text: '他说等忙完这阵子，带她去看海。' },
  { id: 'M25', text: '她的生日是十一月十一号。' },
  { id: 'M26', text: '他在学做菜，第一个学会的是番茄炒蛋。' },
  { id: 'M27', text: '她说不想被安慰，只想有人听她说完。' },
  { id: 'M28', text: '他上次感冒拖了两周才好。' },
  { id: 'M29', text: '她想养一只狗，但怕照顾不好。' },
  { id: 'M30', text: '他答应春节回广州一起吃饭。' },
]

export const QUERIES = [
  { q: '关节', expect: 'M2', kind: 'kw' },
  { q: '体检', expect: 'M4', kind: 'kw' },
  { q: '橘猫', expect: 'M19', kind: 'kw' },
  { q: '绿萝', expect: 'M14', kind: 'kw' },
  { q: '胆结石', expect: 'M11', kind: 'kw' },
  { q: '他关节不舒服', expect: 'M2', kind: 'sent' },
  { q: '我们约的哪天见面', expect: 'M3', kind: 'sent' },
  { q: '他最近总加班', expect: 'M10', kind: 'sent' },
  { q: '她妈妈做手术', expect: 'M11', kind: 'sent' },
  { q: '那只猫叫什么', expect: 'M19', kind: 'sent' },
  { q: '她生日几月几号', expect: 'M25', kind: 'sent' },
  { q: '他说怕被丢下', expect: 'M8', kind: 'sent' },
  { q: '下雨天他身体不舒服', expect: 'M2', kind: 'para' },
  { q: '改时间那件事', expect: 'M3', kind: 'para' },
  { q: '体检结果不太好', expect: 'M4', kind: 'para' },
  { q: '他道歉了', expect: 'M12', kind: 'para' },
  { q: '她睡不好觉', expect: 'M15', kind: 'para' },
  { q: '搬走的那家邻居', expect: 'M5', kind: 'para' },
  { q: '他旧车卖了', expect: 'M6', kind: 'para' },
  { q: '她换了行业', expect: 'M17', kind: 'para' },
]
