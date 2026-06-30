#!/usr/bin/env python3
"""
はなみ For You ALS バッチ（canonical spec §5/§7.4 production 版）。

Node 側（packages/backend/src/core/hanami/HanamiForYouBatchService.ts）が input.json を書き、
本スクリプトが ALS 行列分解を回して output.json を書く。Node がそれを派生テーブルへ取り込み ready swap する。

usage: python3 rec_als.py <input.json> <output.json>

input.json:
  {
    "matrix": [[userId, authorId, count], ...],   # user×author 反応行列
    "targetUsers": [userId, ...],                  # rec/neighbor を計算する対象（ローカルユーザー）
    "factors": 128, "iterations": 25,
    "bm25K1": 100, "bm25B": 0.8,
    "topAuthorRecs": 150, "topNeighbors": 150,
    "minUserEvidence": 5
  }

output.json:
  {
    "userFactors":   [{"userId","factor":[...],"evidenceCount"}],
    "authorFactors": [{"authorId","factor":[...],"reactionCount"}],
    "authorRecs":    [{"userId","authorId","score","rank"}],   # 発見作者 top-N（filter_already_liked）
    "neighbors":     [{"userId","neighborUserId","score","rank"}]  # taste 近傍ユーザ
  }

deps: numpy scipy implicit  （uv venv && . .venv/bin/activate && uv pip install numpy scipy implicit）
"""
import sys
import json
import numpy as np
import scipy.sparse as sp
from implicit.als import AlternatingLeastSquares
from implicit.nearest_neighbours import bm25_weight


def main():
    if len(sys.argv) < 3:
        print("usage: python3 rec_als.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(2)
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp, encoding="utf-8") as f:
        job = json.load(f)

    matrix = job["matrix"]
    factors = int(job.get("factors", 128))
    iterations = int(job.get("iterations", 25))
    k1 = float(job.get("bm25K1", 100))
    b = float(job.get("bm25B", 0.8))
    top_recs = int(job.get("topAuthorRecs", 150))
    top_neighbors = int(job.get("topNeighbors", 150))
    min_evidence = int(job.get("minUserEvidence", 5))

    # build user×author matrix
    uidx, aidx = {}, {}
    rows, cols, vals = [], [], []
    for u, a, c in matrix:
        ui = uidx.setdefault(u, len(uidx))
        ai = aidx.setdefault(a, len(aidx))
        rows.append(ui)
        cols.append(ai)
        vals.append(float(c))
    nU, nA = len(uidx), len(aidx)

    out = {"userFactors": [], "authorFactors": [], "authorRecs": [], "neighbors": []}
    if nU == 0 or nA == 0:
        with open(outp, "w", encoding="utf-8") as f:
            json.dump(out, f)
        return

    urev = {v: k for k, v in uidx.items()}
    arev = {v: k for k, v in aidx.items()}

    M = sp.csr_matrix((np.array(vals, dtype=np.float32), (rows, cols)), shape=(nU, nA))
    user_evidence = np.asarray(M.sum(axis=1)).ravel()
    author_count = np.asarray(M.sum(axis=0)).ravel()

    # bm25 weighting is good for implicit feedback（§10）
    Mw = bm25_weight(M, K1=k1, B=b).tocsr()
    model = AlternatingLeastSquares(factors=factors, regularization=0.05, iterations=iterations, random_state=42)
    model.fit(Mw, show_progress=False)

    # factors（reset 後 evidence が薄い user の factor は作らない＝§7.4）
    for ui in range(nU):
        if user_evidence[ui] < min_evidence:
            continue
        out["userFactors"].append({
            "userId": urev[ui],
            "factor": [float(x) for x in model.user_factors[ui]],
            "evidenceCount": int(user_evidence[ui]),
        })
    for ai in range(nA):
        out["authorFactors"].append({
            "authorId": arev[ai],
            "factor": [float(x) for x in model.item_factors[ai]],
            "reactionCount": int(author_count[ai]),
        })

    # target users（ローカル）について 発見作者 top-N（filter_already_liked）と taste 近傍を計算
    target = [uidx[u] for u in job.get("targetUsers", []) if u in uidx and user_evidence[uidx[u]] >= min_evidence]
    for ui in target:
        ids, scores = model.recommend(ui, Mw[ui], N=top_recs, filter_already_liked_items=True)
        for rank, (ai, sc) in enumerate(zip(ids, scores)):
            out["authorRecs"].append({
                "userId": urev[ui], "authorId": arev[int(ai)], "score": float(sc), "rank": rank,
            })
        sids, sscores = model.similar_users(ui, N=top_neighbors + 1)
        rank = 0
        for nu, sc in zip(sids, sscores):
            if int(nu) == ui:
                continue
            out["neighbors"].append({
                "userId": urev[ui], "neighborUserId": urev[int(nu)], "score": float(sc), "rank": rank,
            })
            rank += 1
            if rank >= top_neighbors:
                break

    with open(outp, "w", encoding="utf-8") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
