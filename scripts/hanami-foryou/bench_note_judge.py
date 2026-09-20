#!/usr/bin/env python3
"""Benchmark Qwen note-judge model load + one forward pass.

Uses the same runtime selection as HanamiNoteJudgeCpu.py: CUDA if available
(bfloat16), otherwise CPU float32. Override with HANAMI_NOTE_JUDGE_DEVICE /
HANAMI_NOTE_JUDGE_DTYPE.

Usage (inside the web container):
    /opt/hanami-foryou-venv/bin/python3 /tmp/bench_note_judge.py

Judge batches hold up to 64 notes and are killed after 35 minutes
(NOTE_JUDGE_TIMEOUT_MS), so: load_sec + fwd_sec * 64 must stay under 2100s.
"""
import importlib.util
import os
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = 'Qwen/Qwen3-4B-Instruct-2507'

_judge_path = os.environ.get('HANAMI_NOTE_JUDGE_SCRIPT') or os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'packages', 'backend', 'src', 'core', 'hanami', 'HanamiNoteJudgeCpu.py')
_spec = importlib.util.spec_from_file_location('hanami_note_judge', _judge_path)
_judge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_judge)
device, dtype, runtime = _judge.resolve_runtime(torch)
if device == 'cpu':
    _judge.configure_torch_threads(torch)
print('runtime', runtime, file=sys.stderr)

t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
m = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
m.to(device)
m.eval()
print('load_sec', time.time() - t0)

ids = tok('テスト投稿です。' * 50, return_tensors='pt').input_ids.to(device)
t0 = time.time()
with torch.no_grad():
    m(input_ids=ids)
print('fwd_sec', time.time() - t0)
