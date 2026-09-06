#!/usr/bin/env python3
"""Best-effort E5 quality-shadow embeddings; never used by the MiniLM worker.

Input/output use the note portion of rec_content_cpu.py's JSON contract.  The
model is cache-only so an absent optional shadow model reports ``unavailable``
without triggering a download or changing primary ranking.
"""
import json
import os
import sys

for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "2")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = "intfloat/multilingual-e5-small"
VERSION = "multilingual-e5-small/query-prefix-v1"


def write(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)


def configure_torch_threads():
    import torch
    torch.set_num_threads(2)
    try:
        torch.set_num_interop_threads(2)
    except RuntimeError:
        pass


def main():
    if len(sys.argv) < 3:
        print("usage: rec_quality_shadow_cpu.py <input.json> <output.json>", file=sys.stderr)
        sys.exit(2)
    with open(sys.argv[1], encoding="utf-8") as f:
        job = json.load(f)
    notes = [(nid, text) for nid, text in job.get("notes", []) if isinstance(text, str) and text.strip()]
    out = {"model": MODEL, "version": VERSION, "dim": 0, "status": "ok", "embeddings": []}
    if not notes:
        write(sys.argv[2], out)
        return
    try:
        configure_torch_threads()
        import numpy as np
        from transformers import AutoModel, AutoTokenizer
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        model = AutoModel.from_pretrained(MODEL, local_files_only=True)
        model.eval()
        # E5 requires this exact prefix for every input, including non-question notes.
        encoded = tokenizer(["query: " + text for _nid, text in notes], padding=True,
                            truncation=True, max_length=512, return_tensors="pt")
        import torch
        with torch.no_grad():
            hidden = model(**encoded).last_hidden_state
            mask = encoded["attention_mask"].unsqueeze(-1).to(hidden.dtype)
            vectors = (hidden * mask).sum(dim=1) / mask.sum(dim=1).clamp_min(1e-9)
            vectors = torch.nn.functional.normalize(vectors, p=2, dim=1)
        vectors = np.asarray(vectors.cpu(), dtype=np.float32)
    except Exception as exc:
        out.update(status="unavailable", error=f"{type(exc).__name__}: {exc}")
        write(sys.argv[2], out)
        return
    out["dim"] = int(vectors.shape[1])
    out["embeddings"] = [{"noteId": nid, "vector": [float(x) for x in vectors[i]]}
                         for i, (nid, _text) in enumerate(notes)]
    write(sys.argv[2], out)


if __name__ == "__main__":
    main()
