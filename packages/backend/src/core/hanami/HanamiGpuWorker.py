#!/usr/bin/env python3
"""常駐の判定係。Qwen3-4B を 1 回だけ読み込み、標準入出力で 1 行 1 件の JSON をやり取りする。

段1では AI投稿チェックの spamJudge だけを扱う。判定のプロンプト・トークン・4択の確率の出し方は
HanamiSpamJudge.py の PROMPT / one_token / judge_one と同じ値になるようにする（1回の forward で
まとめて判定する点だけが違う）。ログは stderr、JSON の行は stdout にだけ書く。
"""
import json
import sys
import time

from HanamiNoteJudgeCpu import MODEL, configure_torch_threads, resolve_runtime
from HanamiSpamJudge import MAX_TEXT_LENGTH, PROMPT, one_token

MAX_ITEMS = 32
# GPU では同じ種類をまとめて1回の forward にする。CPU（確認用）はまとめると遅くなるので1件ずつ
CHUNK_SIZE_GPU = 16
CHUNK_SIZE_CPU = 1

started_at = time.time()
processed = 0


def log(message):
    sys.stderr.write("%s\n" % message)
    sys.stderr.flush()


def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def fail(message):
    emit({"op": "failed", "error": message})
    sys.exit(1)


def build_ids(tokenizer, text):
    user_prompt = PROMPT.format(text=text[:MAX_TEXT_LENGTH])
    messages = [{"role": "user", "content": user_prompt}]
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    target_ids = tokenizer("0", add_special_tokens=False)["input_ids"]
    # ids = prompt_ids + target_ids。回答の logits は「最後から2番目」（= prompt 末尾）の位置を見る。
    return prompt_ids + target_ids, len(prompt_ids)


def load_model():
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    device, dtype, runtime = resolve_runtime(torch)
    if device == "cpu":
        configure_torch_threads(torch)
    tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
    model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
    model.to(device)
    model.eval()
    return torch, tokenizer, model, device, runtime


def judge_one_chunk(torch, model, device, choice_ids, pad_token_id, chunk):
    """1塊（最大16件）を左詰めパディングで1回の forward で判定する。"""
    results = {}
    errors = {}
    max_len = max(len(entry["ids"]) for entry in chunk)
    padded = []
    masks = []
    pad_lens = []
    for entry in chunk:
        pad_len = max_len - len(entry["ids"])
        pad_lens.append(pad_len)
        padded.append([pad_token_id] * pad_len + entry["ids"])
        # 左のパディングは attention で見ない（見ると同じ塊のほかの投稿の長さで結果が変わる）
        masks.append([0] * pad_len + [1] * len(entry["ids"]))
    input_ids = torch.tensor(padded, dtype=torch.long, device=device)
    attention_mask = torch.tensor(masks, dtype=torch.long, device=device)
    # 位置はパディングを数えずに 0 から振る（1件ずつ判定したときと同じ位置にする）
    position_ids = (attention_mask.cumsum(dim=1) - 1).clamp(min=0)
    # 語彙全体の logits を全位置ぶん出すと 16件×1000トークン×15万語で約5GB になり OOM する。
    # 本体の隠れ状態だけ出し、回答の位置1つだけを lm_head に通す（結果は同じ）。
    answer_positions = torch.tensor([pad_lens[i] + entry["answer_index"] - 1 for i, entry in enumerate(chunk)], dtype=torch.long, device=device)
    with torch.no_grad():
        hidden = model.model(input_ids=input_ids, attention_mask=attention_mask, position_ids=position_ids).last_hidden_state
        answer_hidden = hidden[torch.arange(len(chunk), device=device), answer_positions]
        logits = model.lm_head(answer_hidden)
    for i, entry in enumerate(chunk):
        try:
            answer_logits = logits[i]
            selected = answer_logits[choice_ids].float()
            probabilities = torch.softmax(selected, dim=0).tolist()
            results[entry["itemId"]] = {
                "normal": float(probabilities[0]),
                "spam": float(probabilities[1]),
                "scam": float(probabilities[2]),
                "abuse": float(probabilities[3]),
            }
        except Exception as exc:
            errors[entry["itemId"]] = "%s: %s" % (type(exc).__name__, exc)
    return results, errors


def judge_batch(torch, tokenizer, model, device, items):
    """items: [{itemId, text}]。1回の forward でまとめて判定する。"""
    choice_ids = [one_token(tokenizer, str(number)) for number in range(4)]
    pad_token_id = tokenizer.pad_token_id
    if pad_token_id is None:
        pad_token_id = tokenizer.eos_token_id
        if pad_token_id is None:
            raise RuntimeError("tokenizer has no pad token or eos token for left padding")

    # パディングを減らすため、token 長で並べ替えてから塊に分ける
    prepared = []
    for item in items:
        ids, answer_index = build_ids(tokenizer, item["text"])
        prepared.append({"itemId": item["itemId"], "ids": ids, "answer_index": answer_index})
    prepared.sort(key=lambda entry: len(entry["ids"]))

    results = {}
    errors = {}
    chunk_size = CHUNK_SIZE_GPU if device == "cuda" else CHUNK_SIZE_CPU
    chunks = [prepared[start:start + chunk_size] for start in range(0, len(prepared), chunk_size)]
    for chunk in chunks:
        try:
            chunk_results, chunk_errors = judge_one_chunk(torch, model, device, choice_ids, pad_token_id, chunk)
            results.update(chunk_results)
            errors.update(chunk_errors)
        except RuntimeError as exc:
            if len(chunk) > 1 and "CUDA out of memory" in str(exc):
                log("CUDA OOM; retrying with half chunk size")
                half = max(1, len(chunk) // 2)
                for half_chunk in (chunk[:half], chunk[half:]):
                    if not half_chunk:
                        continue
                    try:
                        chunk_results, chunk_errors = judge_one_chunk(torch, model, device, choice_ids, pad_token_id, half_chunk)
                        results.update(chunk_results)
                        errors.update(chunk_errors)
                    except Exception as inner:
                        for entry in half_chunk:
                            errors[entry["itemId"]] = "%s: %s" % (type(inner).__name__, inner)
            else:
                raise
    return results, errors


def handle_spam_judge(torch, tokenizer, model, device, request):
    global processed
    request_id = request.get("requestId")
    items = request.get("items", [])
    if not isinstance(items, list) or len(items) > MAX_ITEMS:
        emit({"op": "error", "requestId": request_id, "error": "items must be an array of at most %d items" % MAX_ITEMS})
        return
    valid = []
    for item in items:
        if not isinstance(item, dict) or not isinstance(item.get("itemId"), str) or not isinstance(item.get("text"), str):
            emit({"op": "error", "requestId": request_id, "error": "each item requires string itemId and text"})
            return
        valid.append({"itemId": item["itemId"], "text": item["text"]})

    started = time.time()
    try:
        results, errors = judge_batch(torch, tokenizer, model, device, valid)
    except Exception as exc:
        emit({"op": "error", "requestId": request_id, "error": "%s: %s" % (type(exc).__name__, exc)})
        return

    processed += len(results)
    emit({
        "op": "result",
        "requestId": request.get("requestId"),
        "results": [{"itemId": item_id, "scores": scores} for item_id, scores in results.items()],
        "errors": [{"itemId": item_id, "error": error} for item_id, error in errors.items()],
        "durationMs": int((time.time() - started) * 1000),
    })


def handle_ping(torch, device):
    vram = None
    if device == "cuda":
        try:
            vram = round(torch.cuda.memory_allocated() / (1024 ** 3), 3)
        except Exception:
            vram = None
    emit({
        "op": "pong",
        "processed": processed,
        "uptimeSec": int(time.time() - started_at),
        "vramGiB": vram,
    })


def main():
    try:
        torch, tokenizer, model, device, runtime = load_model()
    except Exception as exc:
        fail("%s: %s" % (type(exc).__name__, exc))
        return

    emit({"op": "ready", "model": MODEL, "runtime": runtime})

    while True:
        line = sys.stdin.readline()
        if line == "":
            return
        line = line.strip()
        if line == "":
            continue
        try:
            request = json.loads(line)
        except Exception as exc:
            emit({"op": "error", "error": "invalid JSON: %s: %s" % (type(exc).__name__, exc)})
            continue
        if not isinstance(request, dict):
            emit({"op": "error", "error": "request must be a JSON object"})
            continue
        op = request.get("op")
        if op == "spamJudge":
            handle_spam_judge(torch, tokenizer, model, device, request)
        elif op == "ping":
            handle_ping(torch, device)
        elif op == "exit":
            return
        else:
            emit({"op": "error", "error": "unknown op: %r" % op})


if __name__ == "__main__":
    main()
