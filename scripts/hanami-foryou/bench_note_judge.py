#!/usr/bin/env python3
"""Benchmark Qwen note-judge model load + one forward pass on CPU.

Usage (inside the web container):
    /opt/hanami-foryou-venv/bin/python3 /tmp/bench_note_judge.py

Judge batches hold up to 64 notes and are killed after 35 minutes
(NOTE_JUDGE_TIMEOUT_MS), so: load_sec + fwd_sec * 64 must stay under 2100s.
"""
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = 'Qwen/Qwen3-4B-Instruct-2507'

t0 = time.time()
tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
m = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=torch.bfloat16)
m.eval()
print('load_sec', time.time() - t0)

ids = tok('テスト投稿です。' * 50, return_tensors='pt').input_ids
t0 = time.time()
with torch.no_grad():
    m(input_ids=ids)
print('fwd_sec', time.time() - t0)
