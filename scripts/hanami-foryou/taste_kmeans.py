#!/usr/bin/env python3
"""
taste-clustered popular（spec v0.2 §1.3）: ユーザーごとの好みクラスタ k-means。

Node が evidence ベクトル（fp16）を1本のバイナリに連結して渡す。再埋め込みはしない。
平均中心化（meanVec は §1.4 の共有値）→ 正規化 → KMeans。centroid は中心化後・正規化済みの
float32 で返す（serve 側は候補埋め込みに同じ meanVec を引いて cos を取る）。

入力 JSON: {
  "k": int, "dim": int, "meanVec": [f32...],
  "users": [{ "userId": str, "offset": int, "count": int }]   # offset/count は fp16 要素単位でなく「ベクトル本数」
}
入力 BIN: fp16 little-endian、dim 次元 × 総本数
出力 JSON: { "users": [{
  "userId": str, "k": int,
  "centroids": [[f32...] * k],
  "assignment": [int * count],        # 各 evidence の所属クラスタ
  "examples": [[idx...] * k]          # クラスタ中心に近い evidence の index（各 top3）
}] }
"""
import json
import sys

import numpy as np
from sklearn.cluster import KMeans


def main() -> None:
    with open(sys.argv[1], encoding='utf8') as f:
        inp = json.load(f)
    dim = int(inp['dim'])
    k_max = int(inp['k'])
    mean = np.array(inp['meanVec'], dtype=np.float32)
    raw = np.fromfile(sys.argv[2], dtype=np.float16).astype(np.float32).reshape(-1, dim)

    out_users = []
    for u in inp['users']:
        x = raw[u['offset']:u['offset'] + u['count']]
        if len(x) == 0:
            continue
        x = x - mean
        x = x / (np.linalg.norm(x, axis=1, keepdims=True) + 1e-9)
        k = min(k_max, max(2, len(x) // 25))
        km = KMeans(n_clusters=k, n_init=10, random_state=42).fit(x)
        centroids = km.cluster_centers_
        centroids = centroids / (np.linalg.norm(centroids, axis=1, keepdims=True) + 1e-9)
        examples = []
        for c in range(k):
            idx = np.where(km.labels_ == c)[0]
            sims = x[idx] @ centroids[c]
            examples.append([int(i) for i in idx[np.argsort(-sims)[:3]]])
        out_users.append({
            'userId': u['userId'],
            'k': k,
            'centroids': [[round(float(v), 6) for v in c] for c in centroids],
            'assignment': [int(a) for a in km.labels_],
            'examples': examples,
        })

    with open(sys.argv[3], 'w', encoding='utf8') as f:
        json.dump({'users': out_users}, f)


if __name__ == '__main__':
    main()
