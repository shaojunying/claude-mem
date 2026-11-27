# Worker search fusion eval, 2026-11-27

Base: thedotmack/claude-mem ad682a3. Vector leg: LocalEmbedder all-MiniLM-L6-v2 (Chroma's default model), one document per narrative, as ChromaSync indexes it. Keyword leg: SessionSearch.searchObservations. Both legs take 50 candidates per query. "vector (today)" uses keyword rows only when the vector leg is empty, as supplementEmptyCategories does.

Reproduce: download `locomo10.json` (snap-research/locomo) and `gh pr list -R thedotmack/claude-mem --state merged --limit 3000 --json number,title,body,mergedAt > prs.json` into one folder, then:

```
CLAUDE_MEM_DATA_DIR=$(mktemp -d) bun scripts/eval/search-fusion-eval.ts prs <folder>
CLAUDE_MEM_DATA_DIR=$(mktemp -d) bun scripts/eval/search-fusion-eval.ts locomo <folder>
```

## prs: 2543 documents, 600 queries
keyword leg empty for 0 queries; keyword search p50 0.35 ms, p95 0.66 ms

### all (n=600)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.260 | 0.310 | 0.219 | 0.223 |
| keyword | 0.981 | 0.987 | 0.971 | 0.969 |
| rrf k=60 | 0.950 | 0.985 | 0.874 | 0.857 |
| rrf k=5 | 0.948 | 0.985 | 0.871 | 0.853 |

### pr-identifier (n=600)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.260 | 0.310 | 0.219 | 0.223 |
| keyword | 0.981 | 0.987 | 0.971 | 0.969 |
| rrf k=60 | 0.950 | 0.985 | 0.874 | 0.857 |
| rrf k=5 | 0.948 | 0.985 | 0.871 | 0.853 |

## locomo: 5882 documents, 1536 queries
keyword leg empty for 0 queries; keyword search p50 5.30 ms, p95 7.15 ms

### all (n=1535)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.362 | 0.451 | 0.308 | 0.281 |
| keyword | 0.498 | 0.569 | 0.444 | 0.428 |
| rrf k=60 | 0.456 | 0.556 | 0.398 | 0.373 |
| rrf k=5 | 0.530 | 0.617 | 0.441 | 0.410 |

### locomo-cat1 (n=282)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.191 | 0.255 | 0.193 | 0.238 |
| keyword | 0.183 | 0.255 | 0.201 | 0.256 |
| rrf k=60 | 0.227 | 0.305 | 0.233 | 0.291 |
| rrf k=5 | 0.231 | 0.326 | 0.244 | 0.303 |

### locomo-cat2 (n=320)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.416 | 0.499 | 0.358 | 0.328 |
| keyword | 0.590 | 0.658 | 0.522 | 0.496 |
| rrf k=60 | 0.559 | 0.650 | 0.477 | 0.439 |
| rrf k=5 | 0.603 | 0.687 | 0.502 | 0.458 |

### locomo-cat3 (n=92)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.199 | 0.278 | 0.167 | 0.159 |
| keyword | 0.242 | 0.286 | 0.208 | 0.229 |
| rrf k=60 | 0.214 | 0.274 | 0.181 | 0.191 |
| rrf k=5 | 0.242 | 0.338 | 0.217 | 0.219 |

### locomo-cat4 (n=841)

| policy | R@5 | R@10 | nDCG@10 | MRR@10 |
| --- | --- | --- | --- | --- |
| vector (today) | 0.416 | 0.518 | 0.342 | 0.291 |
| keyword | 0.597 | 0.671 | 0.522 | 0.481 |
| rrf k=60 | 0.520 | 0.635 | 0.447 | 0.395 |
| rrf k=5 | 0.634 | 0.719 | 0.509 | 0.449 |
