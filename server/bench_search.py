"""检索压测：生成 N 个分块加入索引，统计检索 P95 耗时（BE-03 验收 ≤200ms）。

用法：python -m server.bench_search [chunks=5000] [queries=200]
"""
from __future__ import annotations

import random
import sys
import time

from . import chunker

WORDS = [f"词条{i}" for i in range(2000)]


def main() -> None:
    n_chunks = int(sys.argv[1]) if len(sys.argv) > 1 else 5000
    n_queries = int(sys.argv[2]) if len(sys.argv) > 2 else 200
    rng = random.Random(42)

    t0 = time.perf_counter()
    for i in range(n_chunks):
        text = "".join(rng.choice(WORDS) for _ in range(120))
        cid = 10_000_000 + i
        chunker.add_file(file_id=i // 10, file_name=f"bench-{i // 10}.txt",
                         chunk_ids=[cid], texts=[text])
    build_s = time.perf_counter() - t0

    latencies: list[float] = []
    for _ in range(n_queries):
        q = "".join(rng.choice(WORDS) for _ in range(8))
        t = time.perf_counter()
        chunker.search(q, 8)
        latencies.append((time.perf_counter() - t) * 1000)

    latencies.sort()
    p50 = latencies[int(len(latencies) * 0.50)]
    p95 = latencies[int(len(latencies) * 0.95)]
    print(f"chunks={n_chunks} queries={n_queries} build={build_s:.2f}s "
          f"p50={p50:.2f}ms p95={p95:.2f}ms")
    print("PASS" if p95 <= 200 else "FAIL", "(P95 门槛 200ms)")


if __name__ == "__main__":
    main()
