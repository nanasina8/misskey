#!/usr/bin/env python3
"""
taste-clustered popular（spec v0.2 §1.1）: ノート埋め込みスイープの Python 側。

Node（HanamiForYouBatchService.runTasteSweep）が未埋め込みノートを新しい順で集めて渡す。
このスクリプトは埋め込むだけ。時間予算を超えたら残りを捨てて返す（次回実行が拾う）。

入力 JSON: { "model": str, "timeBudgetSec": float, "texts": [[noteId, cleanedText], ...] }
出力 JSON: { "dim": int, "processed": int, "embeddings": [[noteId, [f32...]], ...] }
"""
import json
import os
import sys
import time


def configure_torch_threads() -> None:
    """Node側のCPU上限envが効かないtorchビルドでも、taste系queueがCPUを食い切らないようにする。"""
    try:
        n = int(os.environ.get('OMP_NUM_THREADS') or '0')
    except ValueError:
        n = 0
    if n <= 0:
        return
    try:
        import torch
        torch.set_num_threads(n)
    except Exception:
        pass


def main() -> None:
    t0 = time.time()
    with open(sys.argv[1], encoding='utf8') as f:
        inp = json.load(f)
    model_name = inp['model']
    budget = float(inp.get('timeBudgetSec', 480))
    texts = inp['texts']

    configure_torch_threads()
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer(model_name, device='cpu')

    out = []
    batch = 64
    for i in range(0, len(texts), batch):
        if time.time() - t0 > budget:
            break
        chunk = texts[i:i + batch]
        vecs = model.encode(
            [f'passage: {t[:512]}' for _, t in chunk],
            batch_size=batch, normalize_embeddings=True, show_progress_bar=False,
        )
        for (note_id, _), v in zip(chunk, vecs):
            out.append([note_id, [round(float(x), 6) for x in v]])

    with open(sys.argv[2], 'w', encoding='utf8') as f:
        json.dump({'dim': model.get_sentence_embedding_dimension(), 'processed': len(out), 'embeddings': out}, f)


if __name__ == '__main__':
    main()
