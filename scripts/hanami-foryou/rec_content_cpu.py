#!/usr/bin/env python3
"""
はなみ For You MiniLM 埋め込みバッチ（canonical spec §5/§7.4/§7.5 production 版・CPU）。

Node 側（HanamiForYouBatchService.runEmbeddingBatch）が input.json を書き、本スクリプトが
候補窓ノートの MiniLM 埋め込み（384d）と、ユーザの taste-centroid（反応先テキストの平均）を計算して
output.json を書く。Node がそれを hanami_note_embedding / hanami_foryou_user_centroid へ取り込む。

usage: python3 rec_content_cpu.py <input.json> <output.json>

input.json:
  {
    "model": "paraphrase-multilingual-MiniLM-L12-v2",
    "notes": [[noteId, text], ...],                 # 埋め込み未生成の候補窓ノート（増分）
    "tasteByUser": [[userId, [reactedText, ...]], ...]  # centroid 用（反応先テキスト・上限付き）
  }

output.json:
  {
    "model": "...", "dim": 384,
    "embeddings": [{"noteId", "vector":[...]}],
    "centroids":  [{"userId", "vector":[...], "evidenceCount"}]
  }

deps: numpy sentence-transformers  （uv pip install numpy sentence-transformers）
GPU は不要（CPU で候補窓2.6万件=約2分・Appendix A）。
"""
import sys
import json
import numpy as np


def main():
    if len(sys.argv) < 3:
        print("usage: python3 rec_content_cpu.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(2)
    inp, outp = sys.argv[1], sys.argv[2]
    with open(inp, encoding="utf-8") as f:
        job = json.load(f)

    model_name = job.get("model", "paraphrase-multilingual-MiniLM-L12-v2")
    notes = job.get("notes", [])
    taste_by_user = job.get("tasteByUser", [])

    out = {"model": model_name, "dim": 0, "embeddings": [], "centroids": []}

    # 埋め込む全テキストを一括 encode（ノート＋全ユーザの taste テキストの重複排除）。
    note_texts = [t for (_nid, t) in notes if t and t.strip()]
    note_ids = [nid for (nid, t) in notes if t and t.strip()]

    taste_texts = []
    for _uid, texts in taste_by_user:
        for t in texts:
            if t and t.strip():
                taste_texts.append(t)
    # dedup（同じ文を二度 encode しない）
    uniq = {}
    for t in note_texts + taste_texts:
        if t not in uniq:
            uniq[t] = len(uniq)
    if not uniq:
        with open(outp, "w", encoding="utf-8") as f:
            json.dump(out, f)
        return

    from sentence_transformers import SentenceTransformer
    m = SentenceTransformer(f"sentence-transformers/{model_name}")
    uniq_list = list(uniq.keys())
    emb = m.encode(uniq_list, batch_size=256, normalize_embeddings=True, show_progress_bar=False)
    emb = np.asarray(emb, dtype=np.float32)
    dim = int(emb.shape[1])
    out["dim"] = dim

    # note embeddings
    for nid, t in zip(note_ids, note_texts):
        out["embeddings"].append({"noteId": nid, "vector": [float(x) for x in emb[uniq[t]]]})

    # per-user taste centroid（反応先埋め込みの平均→正規化）
    for uid, texts in taste_by_user:
        idxs = [uniq[t] for t in texts if t and t.strip() and t in uniq]
        if not idxs:
            continue
        c = emb[idxs].mean(axis=0)
        n = np.linalg.norm(c)
        if n == 0:
            continue
        c = c / n
        out["centroids"].append({"userId": uid, "vector": [float(x) for x in c], "evidenceCount": len(idxs)})

    with open(outp, "w", encoding="utf-8") as f:
        json.dump(out, f)


if __name__ == "__main__":
    main()
