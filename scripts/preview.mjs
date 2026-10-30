// SPDX-License-Identifier: MIT
// Copyright (c) 2026 fish-memory-plugin authors

import { MemoryStore } from '../lib/store.js'
import { assemble } from '../lib/render.js'
import { bigrams, pickByEvent, rank } from '../lib/retrieve.js'
import { estTokens } from '../lib/util.js'

const dir = process.argv[2] || 'fish-memory'
const query = process.argv[3] || '晚上想吃点什么，别带香菜的'

const store = new MemoryStore(dir)
const r = assemble({
  store,
  query,
  sessionId: 'demo',
  retrieve: ({ points }) => pickByEvent(rank(points, bigrams(query), { threshold: 0.8 }), 3),
})
console.log(r.text)
console.log('\n--- 统计：', estTokens(r.text), 'tok；正文条目', r.rendered, '；丢弃', r.dropped)
