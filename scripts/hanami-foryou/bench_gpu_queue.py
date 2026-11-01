#!/usr/bin/env python3
"""Benchmark for the planned resident GPU judge queue (design C, 2026-11-01).

Measures, on the real GPU, what decides the queue design:
  1. model load time (paid once by a resident worker, every job today)
  2. one item at a time vs. small batches of the same kind (4/8/16/32)
  3. reusing the shared prompt prefix (KV cache) vs. full forward
  4. one short generation (trend topic titles are generated, not scored)
  5. peak GPU memory

Standalone: does not import repo code, touches no DB/Redis, writes nothing.
Usage (inside the web container):
    docker cp scripts/hanami-foryou/bench_gpu_queue.py <web>:/tmp/
    docker exec -it <web> /opt/hanami-foryou-venv/bin/python3 /tmp/bench_gpu_queue.py
Prints progress to stderr and one JSON summary line to stdout at the end.
"""
import copy
import json
import os
import sys
import time

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

MODEL = 'Qwen/Qwen3-4B-Instruct-2507'
ITEMS = int(os.environ.get('HANAMI_BENCH_ITEMS', '32'))
BATCH_SIZES = tuple(size for size in (4, 8, 16, 32) if size <= ITEMS)

# Same shape as the AI moderation prompt: a long fixed instruction + a short post + a fixed tail.
PREFIX = """SNS の投稿を次の4つから1つ選び、数字1文字で答えてください。
0 = 普通の投稿（日常・感想・会話のほか、自分の作品・同人誌・イベント・配信・自分のお店の告知、絵の依頼や支援の受付ページの案内、使ってよかったサイトやお店をすすめる投稿も 0）
1 = 宣伝・勧誘・スパム（知らない相手へ送りつける店や商品やサイトへの誘導、副業・稼げる話への勧誘、同じ文の大量送信）
2 = 詐欺・フィッシング・偽サイトへの誘導（お金・個人情報・ログインを狙う、当選や凍結をかたる、本物を装ったドメイン）
3 = 嫌がらせ・攻撃・脅し

判定例:
- 新刊の通販始まりました！よかったら見てください booth.pm/ja/items/0000 → 0
- FANBOX で支援を受け付けています fanbox.cc/@name → 0
- この比較サイト見やすくておすすめ、使ってみて review-site.example → 0
- @someone 激安ブランドのお店見つけたよ outlet-sale.example/shop 今だけ半額 xkqe → 1
- アカウントが停止されます。こちらで本人確認を完了してください login-check.example → 2
- 今日のお昼はカレーにしました。辛くておいしい → 0
- お前のこと住所まで調べたからな → 3

投稿:
---
"""
SUFFIX = """
---

回答は数字1文字だけで答えてください。"""

POSTS = [
	'今日は駅前のパン屋さんでクロワッサン買った。サクサクでおいしかった',
	'@linl4n 激安のアウトレットショップ見つけました jmty.io/shop/ タイムセール中みたいです dhdn',
	'新しい同人誌の通販始まりました！よかったら見てください booth.pm/ja/items/1234567',
	'【重要】お使いのアカウントは凍結されます。24時間以内にこちらから本人確認してください misskey-login-verify.com',
	'今夜21時から配信します〜 youtube.com/live/abcd 雑談します',
	'副業で月30万稼げる方法教えます！興味ある人はDMください→ line.me/ti/p/xxxx',
	'イラストのリクエスト受付中です！ skeb.jp/@example よろしくお願いします',
	'@abc お前みたいなのはさっさと消えろ。二度と書き込むな',
]


def log(*args):
	print(*args, file=sys.stderr, flush=True)


def resolve_runtime():
	requested = os.environ.get('HANAMI_NOTE_JUDGE_DEVICE', '').strip().lower()
	if requested != 'cpu' and torch.cuda.is_available():
		return 'cuda', torch.bfloat16, torch.cuda.get_device_name(0)
	return 'cpu', torch.float32, 'cpu'


def sync(device):
	if device == 'cuda':
		torch.cuda.synchronize()


def main():
	summary = {'model': MODEL}
	device, dtype, name = resolve_runtime()
	summary['device'] = device
	summary['deviceName'] = name
	log('runtime', device, name)

	t0 = time.time()
	tok = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
	model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
	model.to(device)
	model.eval()
	sync(device)
	summary['loadSec'] = round(time.time() - t0, 2)
	log('load_sec', summary['loadSec'])
	if device == 'cuda':
		summary['vramAfterLoadGiB'] = round(torch.cuda.memory_allocated() / 2**30, 2)

	def chat(text):
		messages = [{'role': 'user', 'content': PREFIX + text + SUFFIX}]
		return tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True) + '0'

	prompts = [chat(POSTS[i % len(POSTS)] + ' ' * (i % 3)) for i in range(ITEMS)]
	summary['promptTokens'] = len(tok(prompts[0], add_special_tokens=False).input_ids)

	# warm up kernels so the first measurement is not inflated
	with torch.no_grad():
		model(input_ids=tok(prompts[0], return_tensors='pt', add_special_tokens=False).input_ids.to(device))
	sync(device)

	# 1. one item at a time
	t0 = time.time()
	single_logits = []
	with torch.no_grad():
		for p in prompts:
			ids = tok(p, return_tensors='pt', add_special_tokens=False).input_ids.to(device)
			single_logits.append(model(input_ids=ids).logits[0, -2].float().cpu())
	sync(device)
	summary['singleSecPerItem'] = round((time.time() - t0) / ITEMS, 4)
	log('single sec/item', summary['singleSecPerItem'])

	# 2. batches of the same kind (left padding, read the logits before the final "0")
	tok.padding_side = 'left'
	if tok.pad_token is None:
		tok.pad_token = tok.eos_token
	summary['batch'] = {}
	for size in BATCH_SIZES:
		try:
			if device == 'cuda':
				torch.cuda.reset_peak_memory_stats()
			t0 = time.time()
			max_diff = 0.0
			with torch.no_grad():
				for start in range(0, ITEMS, size):
					chunk = prompts[start:start + size]
					enc = tok(chunk, return_tensors='pt', padding=True, add_special_tokens=False).to(device)
					logits = model(**enc).logits[:, -2].float().cpu()
					for j in range(len(chunk)):
						max_diff = max(max_diff, float((logits[j] - single_logits[start + j]).abs().max()))
			sync(device)
			entry = {'secPerItem': round((time.time() - t0) / ITEMS, 4), 'maxLogitDiffVsSingle': round(max_diff, 4)}
			if device == 'cuda':
				entry['peakVramGiB'] = round(torch.cuda.max_memory_allocated() / 2**30, 2)
			summary['batch'][str(size)] = entry
			log('batch', size, entry)
		except torch.cuda.OutOfMemoryError:
			summary['batch'][str(size)] = 'oom'
			log('batch', size, 'OOM')
			torch.cuda.empty_cache()
			break

	# 3. reuse the shared prefix (KV cache), one item at a time
	try:
		prefix_text = tok.apply_chat_template([{'role': 'user', 'content': PREFIX}], tokenize=False, add_generation_prompt=False)
		# the chat template closes the user turn; cut at the end of PREFIX so the post continues the same turn
		cut = prefix_text.find(PREFIX) + len(PREFIX)
		prefix_text = prefix_text[:cut]
		prefix_ids = tok(prefix_text, return_tensors='pt', add_special_tokens=False).input_ids.to(device)
		with torch.no_grad():
			prefix_cache = model(input_ids=prefix_ids, use_cache=True).past_key_values
		t0 = time.time()
		max_diff = 0.0
		usable = 0
		with torch.no_grad():
			for i, p in enumerate(prompts):
				full = tok(p, return_tensors='pt', add_special_tokens=False).input_ids.to(device)
				if not torch.equal(full[0, :prefix_ids.shape[1]], prefix_ids[0]):
					continue  # tokenization merged across the boundary; skip this item
				usable += 1
				rest = full[:, prefix_ids.shape[1]:]
				logits = model(input_ids=rest, past_key_values=copy.deepcopy(prefix_cache), use_cache=True).logits[0, -2].float().cpu()
				max_diff = max(max_diff, float((logits - single_logits[i]).abs().max()))
		sync(device)
		summary['prefixCache'] = {
			'prefixTokens': int(prefix_ids.shape[1]),
			'usableItems': usable,
			'secPerItem': round((time.time() - t0) / max(usable, 1), 4),
			'maxLogitDiffVsSingle': round(max_diff, 4),
		}
		log('prefix cache', summary['prefixCache'])
	except Exception as err:  # noqa: BLE001 - report and continue
		summary['prefixCache'] = f'error: {err}'
		log('prefix cache error', err)

	# 4. one short generation (topic titles use max_new_tokens=24)
	try:
		messages = [{'role': 'user', 'content': '次の投稿のまとめに15文字以内の見出しを付けてください。\n- 駅前に新しいパン屋が開いた\n- 焼きたてのパンを買って帰った\n- 週末のパン屋は大盛況だった'}]
		enc = tok(tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True), return_tensors='pt', add_special_tokens=False).to(device)
		t0 = time.time()
		with torch.no_grad():
			out = model.generate(**enc, do_sample=False, max_new_tokens=24)
		sync(device)
		summary['generate24Sec'] = round(time.time() - t0, 3)
		summary['generateSample'] = tok.decode(out[0, enc.input_ids.shape[1]:], skip_special_tokens=True)
		log('generate', summary['generate24Sec'], summary['generateSample'])
	except Exception as err:  # noqa: BLE001
		summary['generate24Sec'] = f'error: {err}'

	if device == 'cuda':
		summary['vramTotalGiB'] = round(torch.cuda.get_device_properties(0).total_memory / 2**30, 2)
	print(json.dumps(summary, ensure_ascii=False))


if __name__ == '__main__':
	main()
