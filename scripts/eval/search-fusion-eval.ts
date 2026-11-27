/**
 * Offline retrieval eval for worker search: keyword leg (the real SessionSearch
 * over FTS5), vector leg (LocalEmbedder all-MiniLM-L6-v2, the model and vectors
 * Chroma's default embedding produces), today's policy (vector order, keyword
 * rows only when the vector leg is empty), and reciprocal rank fusion.
 *
 * Usage:
 *   CLAUDE_MEM_DATA_DIR=<tmp> bun scripts/eval/search-fusion-eval.ts <dataset> <data-dir>
 *   dataset: locomo | prs
 *
 * Documents are embedded the way ChromaSync indexes an observation: one
 * document per narrative and per fact, the title only when neither exists, and
 * an observation ranks by its nearest document.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { SessionSearch } from '../../src/services/sqlite/SessionSearch.js';
import { LocalEmbedder } from '../../src/services/vector/LocalEmbedder.js';

interface Doc { key: string; project: string; title: string; narrative: string | null; createdAt: number }
interface Query { project: string; text: string; relevant: string[]; group: string }

const CANDIDATES = 50;

function loadLocomo(dir: string): { docs: Doc[]; queries: Query[] } {
  const samples = JSON.parse(readFileSync(join(dir, 'locomo10.json'), 'utf8'));
  const docs: Doc[] = [];
  const queries: Query[] = [];
  samples.forEach((sample: any, index: number) => {
    const project = `locomo-${index}`;
    const conv = sample.conversation;
    for (let s = 1; conv[`session_${s}`]; s++) {
      const date = conv[`session_${s}_date_time`] ?? '';
      for (const turn of conv[`session_${s}`]) {
        const text = turn.blip_caption ? `${turn.text} [shares ${turn.blip_caption}]` : turn.text;
        docs.push({
          key: `${project}:${turn.dia_id}`, project,
          title: `${turn.speaker} on ${date}`, narrative: `${turn.speaker}: ${text}`,
          createdAt: Date.parse('2026-11-01T00:00:00Z') + docs.length * 1000,
        });
      }
    }
    for (const qa of sample.qa) {
      if (![1, 2, 3, 4].includes(qa.category) || !qa.evidence?.length) continue;
      queries.push({
        project, text: qa.question, group: `locomo-cat${qa.category}`,
        relevant: qa.evidence.flatMap((e: string) => e.split(/[;,\s]+/)).filter(Boolean).map((e: string) => `${project}:${e}`),
      });
    }
  });
  return { docs, queries };
}

// Identifier lookups: every merged claude-mem PR is one observation (title,
// body as narrative); a query is a code identifier quoted in backticks in at
// most five PRs, and the PRs whose text contains it are the relevant set.
function loadPrs(dir: string): { docs: Doc[]; queries: Query[] } {
  const prs = JSON.parse(readFileSync(join(dir, 'prs.json'), 'utf8'));
  const project = 'claude-mem-prs';
  const docs: Doc[] = prs.map((pr: any) => ({
    key: `pr-${pr.number}`, project, title: pr.title, narrative: pr.body?.trim() || null,
    createdAt: Date.parse(pr.mergedAt),
  }));
  const textOf = (doc: Doc) => `${doc.title}\n${doc.narrative ?? ''}`;
  const identifiers = new Set<string>();
  for (const doc of docs) {
    for (const match of textOf(doc).matchAll(/`([A-Za-z_][A-Za-z0-9_.]{5,40})`/g)) {
      const id = match[1];
      if (/[a-z][A-Z]|_|\./.test(id) && !/^\d/.test(id)) identifiers.add(id);
    }
  }
  const queries: Query[] = [];
  for (const id of [...identifiers].sort()) {
    const relevant = docs.filter(doc => textOf(doc).includes(id)).map(doc => doc.key);
    if (relevant.length >= 1 && relevant.length <= 5) queries.push({ project, text: id, relevant, group: 'pr-identifier' });
  }
  // A fixed, seeded sample keeps runs comparable.
  let seed = 42;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  const sampled = queries.map(q => ({ q, r: rand() })).sort((a, b) => a.r - b.r).slice(0, 600).map(x => x.q);
  return { docs, queries: sampled };
}

function chromaDocuments(doc: Doc): string[] {
  return doc.narrative ? [doc.narrative] : [doc.title];
}

async function embedAll(embedder: LocalEmbedder, texts: string[], cachePath: string): Promise<Float32Array[]> {
  const dims = embedder.dims;
  if (existsSync(cachePath)) {
    const buf = readFileSync(cachePath);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (all.length === texts.length * dims) {
      return texts.map((_, i) => all.subarray(i * dims, (i + 1) * dims));
    }
  }
  const out = new Float32Array(texts.length * dims);
  const batch = 64;
  for (let i = 0; i < texts.length; i += batch) {
    const vectors = await embedder.embed(texts.slice(i, i + batch));
    vectors.forEach((v, j) => out.set(v, (i + j) * dims));
    if ((i / batch) % 20 === 0) console.error(`embedded ${Math.min(i + batch, texts.length)}/${texts.length}`);
  }
  writeFileSync(cachePath, Buffer.from(out.buffer));
  return texts.map((_, i) => out.subarray(i * dims, (i + 1) * dims));
}

const dot = (a: Float32Array, b: Float32Array) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

export function fuseByReciprocalRank(lists: number[][], k: number): number[] {
  const score = new Map<number, number>();
  for (const list of lists) list.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (k + rank + 1)));
  return [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([id]) => id);
}

function metrics(ranked: string[], relevant: Set<string>) {
  const at = (n: number) => ranked.slice(0, n).filter(k => relevant.has(k)).length / relevant.size;
  let dcg = 0;
  ranked.slice(0, 10).forEach((k, i) => { if (relevant.has(k)) dcg += 1 / Math.log2(i + 2); });
  let idcg = 0;
  for (let i = 0; i < Math.min(10, relevant.size); i++) idcg += 1 / Math.log2(i + 2);
  const first = ranked.slice(0, 10).findIndex(k => relevant.has(k));
  return { r5: at(5), r10: at(10), ndcg10: dcg / idcg, mrr10: first < 0 ? 0 : 1 / (first + 1) };
}

async function main() {
  const [dataset, dataDir] = process.argv.slice(2);
  const { docs, queries } = dataset === 'locomo' ? loadLocomo(dataDir) : loadPrs(dataDir);
  console.error(`${dataset}: ${docs.length} documents, ${queries.length} queries`);

  const store = new SessionStore(':memory:');
  const search = new SessionSearch(store.db);
  const idByKey = new Map<string, number>();
  const keyById = new Map<number, string>();
  const sessions = new Map<string, string>();
  docs.forEach((doc, index) => {
    if (!sessions.has(doc.project)) {
      const dbId = store.createSDKSession(`content-${doc.project}`, doc.project, 'eval');
      store.ensureMemorySessionIdRegistered(dbId, `memory-${doc.project}`);
      sessions.set(doc.project, `memory-${doc.project}`);
    }
    const { id } = store.storeObservation(sessions.get(doc.project)!, doc.project, {
      type: 'discovery', title: doc.title, subtitle: null, facts: [], narrative: doc.narrative,
      concepts: [], files_read: [], files_modified: [],
    }, index + 1, 0, doc.createdAt, undefined, { skipTitleDedup: true });
    idByKey.set(doc.key, id);
    keyById.set(id, doc.key);
  });

  const embedder = new LocalEmbedder();
  const partTexts: string[] = [];
  const partOwner: number[] = [];
  docs.forEach(doc => chromaDocuments(doc).forEach(text => { partTexts.push(text); partOwner.push(idByKey.get(doc.key)!); }));
  const partVectors = await embedAll(embedder, partTexts, join(dataDir, `${dataset}-parts.f32`));
  const queryVectors = await embedAll(embedder, queries.map(q => q.text), join(dataDir, `${dataset}-queries.f32`));
  const projectOf = new Map(docs.map(doc => [idByKey.get(doc.key)!, doc.project]));

  const policies = ['vector (today)', 'keyword', 'rrf k=60', 'rrf k=5'] as const;
  const totals = new Map<string, Map<string, { n: number; r5: number; r10: number; ndcg10: number; mrr10: number }>>();
  const ftsMs: number[] = [];
  let keywordEmpty = 0;
  queries.forEach((query, qi) => {
    const best = new Map<number, number>();
    partVectors.forEach((vector, pi) => {
      const owner = partOwner[pi];
      if (projectOf.get(owner) !== query.project) return;
      const sim = dot(vector, queryVectors[qi]);
      if (sim > (best.get(owner) ?? -Infinity)) best.set(owner, sim);
    });
    const vector = [...best.entries()].sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES).map(([id]) => id);
    const t0 = performance.now();
    const keyword = search.searchObservations(query.text, { project: query.project, limit: CANDIDATES }).map(row => row.id);
    ftsMs.push(performance.now() - t0);
    if (keyword.length === 0) keywordEmpty++;
    const ranked: Record<(typeof policies)[number], number[]> = {
      'vector (today)': vector.length ? vector : keyword,
      keyword,
      'rrf k=60': fuseByReciprocalRank([vector, keyword], 60),
      'rrf k=5': fuseByReciprocalRank([vector, keyword], 5),
    };
    const relevant = new Set(query.relevant.filter(k => idByKey.has(k)));
    if (relevant.size === 0) return;
    for (const group of [query.group, 'all']) {
      if (!totals.has(group)) totals.set(group, new Map());
      for (const policy of policies) {
        const m = metrics(ranked[policy].map(id => keyById.get(id)!), relevant);
        const t = totals.get(group)!.get(policy) ?? { n: 0, r5: 0, r10: 0, ndcg10: 0, mrr10: 0 };
        t.n++; t.r5 += m.r5; t.r10 += m.r10; t.ndcg10 += m.ndcg10; t.mrr10 += m.mrr10;
        totals.get(group)!.set(policy, t);
      }
    }
  });

  ftsMs.sort((a, b) => a - b);
  console.log(`## ${dataset}: ${docs.length} documents, ${queries.length} queries`);
  console.log(`keyword leg empty for ${keywordEmpty} queries; keyword search p50 ${ftsMs[Math.floor(ftsMs.length / 2)].toFixed(2)} ms, p95 ${ftsMs[Math.floor(ftsMs.length * 0.95)].toFixed(2)} ms`);
  for (const [group, byPolicy] of [...totals.entries()].sort()) {
    console.log(`\n### ${group} (n=${byPolicy.get(policies[0])!.n})\n`);
    console.log('| policy | R@5 | R@10 | nDCG@10 | MRR@10 |\n| --- | --- | --- | --- | --- |');
    for (const policy of policies) {
      const t = byPolicy.get(policy)!;
      console.log(`| ${policy} | ${(t.r5 / t.n).toFixed(3)} | ${(t.r10 / t.n).toFixed(3)} | ${(t.ndcg10 / t.n).toFixed(3)} | ${(t.mrr10 / t.n).toFixed(3)} |`);
    }
  }
  store.close();
}

await main();
