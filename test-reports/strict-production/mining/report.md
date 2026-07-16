# Mining Eval Report

- startedAt: 2026-07-16T00:00:00.000Z
- provider: frozen-fixture/strict-production-fixture-v1 | judge: frozen-fixture/strict-production-fixture-v1
- totals: candidates=1, abandonedModules=0, tokens=4in/4out

## alembic-workspace-single-file-value

- candidates: 1 | recall(heuristic): 100% | precision(heuristic): 100% | precision(judge): 100% | triviality: 0%
- expected `strict-role-no-tool-route`: ✅ matched by candidate #0
- toolDistribution: {}

### Judge verdicts
- candidate #0: **uphold** (entailment=entailed, trivial=false) — The source slice binds strict role markers to no-tool stage definitions.

## bilidili-three-file-generic

- candidates: 0 | recall(heuristic): n/a | precision(heuristic): n/a | triviality: n/a
- toolDistribution: {}

## Notes
- precision/recall(heuristic) 是关键词+引用文件的方向性判据，非语义判定；--judge 的 precision(judge) 才是语义口径。
- LLM 有方差：结论看多次运行的区间，不看单点。
