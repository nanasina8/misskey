#!/usr/bin/env python3
"""AI 投稿チェック用のローカル判定 (Qwen3-4B)。1件1回の forward で4択の確率を出す。

HanamiNoteJudgeCpu.py と同じ作り: 生成はしない。回答位置の logits から選択肢の確率を出し、
失敗はデータとして JSON に書く。出力は原子的に置き換える。GPU/dtype の決め方とスレッド設定は
HanamiNoteJudgeCpu.py の関数を import して再利用する。
"""
import json
import sys

from HanamiNoteJudgeCpu import (
    MODEL,
    configure_torch_threads,
    output,
    resolve_runtime,
)

MAX_NOTES = 32
MAX_TEXT_LENGTH = 400

PROMPT = """SNS の投稿を次の4つから1つ選び、数字1文字で答えてください。
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
{text}
---

回答は数字1文字だけで答えてください。"""


def fail(message, output_path):
    output({
        "model": MODEL,
        "status": "unavailable",
        "runtime": None,
        "judgements": [],
        "errors": [{"error": message}],
    }, output_path)


def one_token(tokenizer, value):
    token_ids = tokenizer.encode(value, add_special_tokens=False)
    if len(token_ids) != 1:
        raise RuntimeError("tokenizer does not expose %r as one answer token" % value)
    return token_ids[0]


def judge_one(torch, tokenizer, model, note_id, text):
    user_prompt = PROMPT.format(text=text)
    messages = [{"role": "user", "content": user_prompt}]
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    # 回答位置は1桁の数字。teacher-forcing で "0" を足し、その直前の logits を見る。
    target_ids = tokenizer("0", add_special_tokens=False)["input_ids"]
    ids = prompt_ids + target_ids
    input_ids = torch.tensor([ids], dtype=torch.long, device=model.device)
    with torch.no_grad():
        logits = model(input_ids=input_ids).logits[0]
    answer_logits = logits[len(prompt_ids) - 1]
    choice_ids = [one_token(tokenizer, str(number)) for number in range(4)]
    selected = answer_logits[choice_ids].float()
    probabilities = torch.softmax(selected, dim=0).tolist()
    return {
        "noteId": note_id,
        "scores": {
            "normal": float(probabilities[0]),
            "spam": float(probabilities[1]),
            "scam": float(probabilities[2]),
            "abuse": float(probabilities[3]),
        },
    }


def main():
    if len(sys.argv) != 3:
        fail("usage: HanamiSpamJudge.py INPUT_JSON OUTPUT_JSON", None)
        return
    input_path, output_path = sys.argv[1], sys.argv[2]
    try:
        with open(input_path, "r", encoding="utf-8") as handle:
            job = json.load(handle)
    except Exception as exc:
        fail("invalid input JSON: %s: %s" % (type(exc).__name__, exc), output_path)
        return
    notes = job.get("notes", []) if isinstance(job, dict) else []
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        fail("notes must be an array of at most %d items" % MAX_NOTES, output_path)
        return
    valid_notes = []
    for note in notes:
        if not isinstance(note, dict) or not isinstance(note.get("noteId"), str) or not isinstance(note.get("text"), str):
            fail("each note requires string noteId and text", output_path)
            return
        valid_notes.append({"noteId": note["noteId"], "text": note["text"][:MAX_TEXT_LENGTH]})
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        device, dtype, runtime = resolve_runtime(torch)
        if device == "cpu":
            configure_torch_threads(torch)
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
        model.to(device)
        model.eval()
    except Exception as exc:
        fail("model/runtime unavailable: %s: %s" % (type(exc).__name__, exc), output_path)
        return

    judgements, errors = [], []

    def flush(status):
        output({"model": MODEL, "status": status, "runtime": runtime, "judgements": judgements, "errors": errors}, output_path)

    for note in valid_notes:
        try:
            judgements.append(judge_one(torch, tokenizer, model, note["noteId"], note["text"]))
        except Exception as exc:
            errors.append({"noteId": note["noteId"], "error": "%s: %s" % (type(exc).__name__, exc)})
        flush("partial")
    flush("ok" if not errors else "partial")


if __name__ == "__main__":
    main()
