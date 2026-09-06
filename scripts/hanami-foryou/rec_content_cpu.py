#!/usr/bin/env python3
"""CPU MiniLM embedding worker.

Besides the established ``tasteByUser`` input, this accepts optional
``coldSourceCentroids`` (also ``coldSourcesByUser`` for compatibility).  Each
entry is ``[userId, sources]`` or ``{"userId": ..., "sources": ...}``; a
source is ``[name, texts, fallback?]`` or an object with ``texts`` and
``fallback``.  Source means are normalized independently, then combined with
equal source weight.
"""
import json
import os
import sys

# Set these before anything can initialize a torch/OpenMP worker pool.
for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ[_name] = "2"
os.environ["TOKENIZERS_PARALLELISM"] = "false"


def configure_torch_threads():
    """Limit torch safely even if another library already used interop threads."""
    import torch
    torch.set_num_threads(2)
    try:
        torch.set_num_interop_threads(2)
    except RuntimeError:
        # PyTorch permits this exactly once, before interop work starts.
        pass


def source_entries(raw):
    """Normalize the deliberately permissive cold-source wire format."""
    for item in raw or []:
        if isinstance(item, dict):
            uid, sources = item.get("userId"), item.get("sources", [])
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            uid, sources = item[0], item[1]
        else:
            continue
        parsed = []
        for source in sources or []:
            if isinstance(source, dict):
                texts, fallback = source.get("texts", []), bool(source.get("fallback", False))
            elif isinstance(source, (list, tuple)) and len(source) >= 2:
                texts, fallback = source[1], bool(source[2]) if len(source) >= 3 else False
            else:
                continue
            texts = [t for t in (texts or []) if isinstance(t, str) and t.strip()]
            if texts:
                parsed.append((texts, fallback))
        if uid is not None and parsed:
            yield uid, parsed


def write_output(path, output):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(output, f)


def main():
    if len(sys.argv) < 3:
        print("usage: python3 rec_content_cpu.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)

    model_name = job.get("model", "paraphrase-multilingual-MiniLM-L12-v2")
    notes = job.get("notes", [])
    taste_by_user = job.get("tasteByUser", [])
    cold_by_user = list(source_entries(job.get("coldSourceCentroids", job.get("coldSourcesByUser", []))))
    out = {"model": model_name, "dim": 0, "status": "ok", "embeddings": [], "centroids": []}

    note_pairs = [(nid, t) for nid, t in notes if isinstance(t, str) and t.strip()]
    texts = [t for _nid, t in note_pairs]
    for _uid, user_texts in taste_by_user:
        texts.extend(t for t in user_texts if isinstance(t, str) and t.strip())
    for _uid, sources in cold_by_user:
        for source_texts, _fallback in sources:
            texts.extend(source_texts)
    uniq = {t: i for i, t in enumerate(dict.fromkeys(texts))}
    if not uniq:
        write_output(sys.argv[2], out)
        return

    try:
        configure_torch_threads()
        import numpy as np
        from sentence_transformers import SentenceTransformer
        model = SentenceTransformer(f"sentence-transformers/{model_name}")
        emb = np.asarray(model.encode(list(uniq), batch_size=256, normalize_embeddings=True,
                                      show_progress_bar=False), dtype=np.float32)
    except Exception as exc:
        # The caller can leave rows pending and retry after dependencies/model cache recover.
        out.update(status="unavailable", error=f"{type(exc).__name__}: {exc}")
        write_output(sys.argv[2], out)
        return

    out["dim"] = int(emb.shape[1])
    out["embeddings"] = [{"noteId": nid, "vector": [float(x) for x in emb[uniq[text]]]}
                         for nid, text in note_pairs]

    centroids = {}
    for uid, user_texts in taste_by_user:
        idxs = [uniq[t] for t in user_texts if isinstance(t, str) and t.strip() and t in uniq]
        if idxs:
            c = emb[idxs].mean(axis=0)
            norm = np.linalg.norm(c)
            if norm:
                centroids[uid] = {"userId": uid, "vector": [float(x) for x in c / norm],
                                  "evidenceCount": len(idxs)}
    # Cold input intentionally overrides the flat centroid for that user: each source gets
    # one vote regardless of how many fallback texts it supplied.
    for uid, sources in cold_by_user:
        source_means, fallback_count, evidence = [], 0, 0
        for source_texts, fallback in sources:
            c = emb[[uniq[t] for t in source_texts]].mean(axis=0)
            norm = np.linalg.norm(c)
            if norm:
                source_means.append(c / norm)
                fallback_count += int(fallback)
                evidence += len(source_texts)
        if source_means:
            c = np.asarray(source_means).mean(axis=0)
            norm = np.linalg.norm(c)
            if norm:
                centroids[uid] = {"userId": uid, "vector": [float(x) for x in c / norm],
                                  "evidenceCount": evidence, "sourceCount": len(source_means),
                                  "fallbackSourceCount": fallback_count,
                                  "lowConfidence": fallback_count == len(source_means)}
    out["centroids"] = list(centroids.values())
    write_output(sys.argv[2], out)


if __name__ == "__main__":
    main()
