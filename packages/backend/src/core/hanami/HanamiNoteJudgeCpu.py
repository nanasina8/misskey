#!/usr/bin/env python3
"""Local-only Qwen note judge: input/output JSON file arguments, never generation.

The caller has already applied deterministic exclusions. Each retained note gets
one causal-LM forward pass; logits at three fixed answer positions provide the
Q1/Q2/Q3 choice distributions. Model/cache/runtime failures are data, not
tracebacks, so the job runner can leave notes pending and report the failure.
"""
import json
import os
import sys

for _name in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS", "NUMEXPR_NUM_THREADS"):
    os.environ.setdefault(_name, "2")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

MODEL = "Qwen/Qwen3-4B-Instruct-2507"
MAX_NOTES = 64


def output(data, output_path=None):
    if output_path is None:
        json.dump(data, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
        return
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False)
        handle.write("\n")


def failure(message, output_path=None):
    output({"model": MODEL, "status": "unavailable", "judgements": [], "error": message}, output_path)


def configure_torch_threads(torch):
    threads = os.environ.get("HANAMI_LLM_MAX_THREADS", os.environ.get("HANAMI_TASTE_MAX_THREADS", "2"))
    try:
        threads = max(1, int(threads))
    except ValueError:
        threads = 2
    torch.set_num_threads(threads)
    try:
        torch.set_num_interop_threads(threads)
    except RuntimeError:
        pass


def prompt(note, settings):
    basis = settings["basis"]
    examples = settings.get("examples", [])
    example_text = "（なし）" if not examples else "\n".join("- " + str(x) for x in examples)
    image_notice = "\n（画像あり。画像の中身は見えません。）" if note.get("hasFiles") else ""
    kinds = [
        "挨拶・相づち・定型文", "ニュース・情報の共有", "解説・知識・ハウツー", "意見・考察・問題提起", "出来事・体験談・エピソード",
        "ユーモア・ネタ・大喜利", "作品の投稿", "写真・食事・日常の記録", "告知・宣伝・募集・企画参加", "近況・独り言・感情の吐露",
    ]
    return f'''あなたは公開投稿を第三者視点で評価する判定器です。投稿本文だけを根拠にしてください。

投稿:
---
{note["cleanedText"]}{image_notice}
---

Q1: 次の投稿は、投稿者を知らない第三者が単独で読んでも意味が通り、読む価値がありますか？
A = {basis["ephemeralA"]}
B = {basis["ephemeralB"]}

Q2: 投稿者を知らない第三者が読んだときの「興味深さ」を 1〜5 で評価してください。
1 = {basis["interest1"]}
2 = {basis["interest2"]}
3 = {basis["interest3"]}
4 = {basis["interest4"]}
5 = {basis["interest5"]}

Q3: 種類を 0〜9 で選んでください。
{chr(10).join(f"{i} = {kind}" for i, kind in enumerate(kinds))}

判定例:
{example_text}

回答は他の文章を出さず、必ず {{"ephemeral":"AまたはB","interest":"1から5","contentType":"0から9"}} の JSON 形式にしてください。'''


def one_token(tokenizer, value):
    token_ids = tokenizer.encode(value, add_special_tokens=False)
    if len(token_ids) != 1:
        raise RuntimeError(f"tokenizer does not expose {value!r} as one answer token")
    return token_ids[0]


def answer_positions(tokenizer, target):
    encoded = tokenizer(target, add_special_tokens=False, return_offsets_mapping=True)
    offsets = encoded.get("offset_mapping")
    ids = encoded.get("input_ids")
    if offsets is None or ids is None:
        raise RuntimeError("transformers tokenizer lacks offset mappings needed for prompt-position logprobs")
    values = [("ephemeral", "B"), ("interest", "3"), ("contentType", "0")]
    positions = {}
    search_at = 0
    for name, value in values:
        char_at = target.index(value, search_at)
        search_at = char_at + len(value)
        matches = [index for index, offset in enumerate(offsets) if offset[0] == char_at and offset[1] == char_at + len(value)]
        if len(matches) != 1:
            raise RuntimeError(f"could not locate {name} answer token in tokenizer offsets")
        positions[name] = matches[0]
    return ids, positions


def probabilities(torch, logits, token_ids):
    selected = logits[token_ids].float()
    return torch.softmax(selected, dim=0).tolist(), torch.log_softmax(selected, dim=0).tolist()


def judge_one(torch, tokenizer, model, note, settings):
    user_prompt = prompt(note, settings)
    messages = [{"role": "user", "content": user_prompt}]
    # Keep chat formatting separate from tokenization.  Transformers 5.x no
    # longer supports relying on apply_chat_template's tokenized return for
    # this path; explicitly disable special tokens on the second step so the
    # teacher-forced scaffold remains contiguous with the prompt.
    prompt_text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    prompt_ids = tokenizer(prompt_text, add_special_tokens=False)["input_ids"]
    # Teacher-forced answer scaffold gives all three answer positions in one forward.
    target = '{"ephemeral":"B","interest":"3","contentType":"0"}'
    target_ids, positions = answer_positions(tokenizer, target)
    ids = prompt_ids + target_ids
    import torch.nn.functional as functional
    input_ids = torch.tensor([ids], dtype=torch.long)
    with torch.no_grad():
        logits = model(input_ids=input_ids).logits[0]
    base = len(prompt_ids)
    answer_logits = {name: logits[base + index - 1] for name, index in positions.items()}
    ephemeral_ids = [one_token(tokenizer, "A"), one_token(tokenizer, "B")]
    interest_ids = [one_token(tokenizer, str(number)) for number in range(1, 6)]
    content_ids = [one_token(tokenizer, str(number)) for number in range(10)]
    _unused = functional  # Keep the no-generation path explicit without optional APIs.
    _ephemeral_prob, ephemeral_log_prob = probabilities(torch, answer_logits["ephemeral"], ephemeral_ids)
    interest_prob, _interest_log_prob = probabilities(torch, answer_logits["interest"], interest_ids)
    content_prob, _content_log_prob = probabilities(torch, answer_logits["contentType"], content_ids)
    return {
        "noteId": note["noteId"],
        "ephemeralScore": float(ephemeral_log_prob[0] - ephemeral_log_prob[1]),
        "interest": float(sum((index + 1) * probability for index, probability in enumerate(interest_prob))),
        "interestDist": [float(value) for value in interest_prob],
        "contentType": int(max(range(10), key=lambda index: content_prob[index])),
    }


def main():
    if len(sys.argv) != 3:
        failure("usage: HanamiNoteJudgeCpu.py INPUT_JSON OUTPUT_JSON")
        return
    input_path, output_path = sys.argv[1], sys.argv[2]
    try:
        with open(input_path, "r", encoding="utf-8") as handle:
            job = json.load(handle)
    except Exception as exc:
        failure(f"invalid input JSON: {type(exc).__name__}: {exc}", output_path)
        return
    notes = job.get("notes", []) if isinstance(job, dict) else []
    settings = job.get("settings") if isinstance(job, dict) else None
    if not isinstance(notes, list) or len(notes) > MAX_NOTES:
        failure(f"notes must be an array of at most {MAX_NOTES} items", output_path)
        return
    if not isinstance(settings, dict) or not isinstance(settings.get("basis"), dict):
        failure("settings.basis is required", output_path)
        return
    valid_notes = [note for note in notes if isinstance(note, dict) and isinstance(note.get("noteId"), str) and isinstance(note.get("cleanedText"), str)]
    if len(valid_notes) != len(notes):
        failure("each note requires string noteId and cleanedText", output_path)
        return
    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        configure_torch_threads(torch)
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=torch.bfloat16)
        model.eval()
    except Exception as exc:
        failure(f"model/runtime unavailable: {type(exc).__name__}: {exc}", output_path)
        return
    judgements, errors = [], []
    for note in valid_notes:
        try:
            judgements.append(judge_one(torch, tokenizer, model, note, settings))
        except Exception as exc:
            errors.append({"noteId": note["noteId"], "error": f"{type(exc).__name__}: {exc}"})
    output({"model": MODEL, "promptVersion": settings.get("promptVersion"), "status": "ok" if not errors else "partial", "judgements": judgements, "errors": errors}, output_path)


if __name__ == "__main__":
    main()
