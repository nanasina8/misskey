#!/usr/bin/env python3
"""GPU-only daily/same judgements and short generated topic titles."""
import json
import sys

# Reuse the note judge runtime without leaving a sibling __pycache__ artifact.
sys.dont_write_bytecode = True
from HanamiNoteJudgeCpu import MODEL, output, probe, resolve_runtime

SAME_PROMPT = 'SNS の2つの投稿のまとまりが、同じ出来事・同じ話題について話しているかを判定してください。「はい」か「いいえ」だけを出力してください。\n\n[A]\n{A}\n\n[B]\n{B}'
TITLE_PROMPT = 'SNS で同じ時間帯に複数の人が投稿した内容です。共通する話題を、トレンド欄に載せる短い見出し（日本語・12字以内・名詞止め）にしてください。投稿に書かれていないことは足さないでください。共通する話題が無い・ただの挨拶や雑談の寄せ集めなら「なし」とだけ答えてください。見出しだけを出力してください。\n\n投稿:\n{posts}'

# 1 回に受け取る話題の数の上限。HanamiTrendService.ts の TREND_TOPIC_JUDGE_TOPIC_MAX と同じ値にする。
TOPIC_MAX = 60
DAILY_PROMPT = 'SNS の投稿のまとまりです。これが「今この時に多くの人が同じ出来事・ニュース・番組・作品・企画について話している話題」なら「話題」、「毎日いつでも見かける日常のつぶやき・あいさつ・定型の投稿（帰宅、おはよう、質問箱の募集、参加表明、ハッシュタグで回答を集める遊びや診断など）」なら「日常」と答えてください。「話題」か「日常」だけを出力してください。\n{X}'


def answer_probabilities(torch, tokenizer, model, prompt, choices):
    """prompt の答えの最初の 1 語が choices のどれになるかの確率を、choices の順で返す。"""
    text = tokenizer.apply_chat_template([{'role': 'user', 'content': prompt}], tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, add_special_tokens=False, return_tensors='pt').to(model.device)
    answer_ids = [tokenizer.encode(choice, add_special_tokens=False)[0] for choice in choices]
    if len(set(answer_ids)) != len(answer_ids):
        raise RuntimeError('answer choices have identical first tokens')
    with torch.no_grad():
        logits = model(**inputs).logits[0, -1, answer_ids].float()
    return [float(value) for value in torch.softmax(logits, dim=0).tolist()]


def answer_probability(torch, tokenizer, model, prompt, choices, index):
    return answer_probabilities(torch, tokenizer, model, prompt, choices)[index]


def judge_topic_job(torch, tokenizer, model, job, on_progress=None):
    """話題の判定 1 回分（日常か・同じ話題か・見出し）を、読み込み済みのモデルで行う。

    1 件終わるごとに on_progress(judgements, titles) を呼ぶ（途中で止められても済んだ分を残すため）。
    入力がおかしい・途中で失敗した場合は例外を投げる。そこまでの結果は例外の partial に入れる。
    """
    judgements = []
    titles = []

    def progress():
        if on_progress is not None:
            on_progress(judgements, titles)

    try:
        topics = job['topics']
        if not isinstance(topics, list) or len(topics) > TOPIC_MAX:
            raise ValueError('too many topics')
        by_id = {topic['topicId']: topic['text'] for topic in topics}
        if len(by_id) != len(topics) or any(not isinstance(text, str) for text in by_id.values()):
            raise ValueError('topics require unique IDs and text')
        for topic_id in job['dailyIds']:
            probability = answer_probability(torch, tokenizer, model, DAILY_PROMPT.format(X=by_id[topic_id]), ['話題', '日常'], 1)
            judgements.append({'kind': 'daily', 'topicId': topic_id, 'probability': probability})
            progress()
        for pair in job['pairs']:
            probability = answer_probability(torch, tokenizer, model, SAME_PROMPT.format(A=by_id[pair['a']], B=by_id[pair['b']]), ['はい', 'いいえ'], 0)
            judgements.append({'kind': 'same', 'a': pair['a'], 'b': pair['b'], 'probability': probability})
            progress()
        for topic in job.get('titles', []):
            if topic['topicId'] not in by_id or not 3 <= len(topic['posts']) <= 10:
                raise ValueError('invalid title input')
            prompt = TITLE_PROMPT.format(posts='\n'.join('- ' + post for post in topic['posts']))
            text = tokenizer.apply_chat_template([{'role': 'user', 'content': prompt}], tokenize=False, add_generation_prompt=True, enable_thinking=False)
            inputs = tokenizer(text, add_special_tokens=False, return_tensors='pt').to(model.device)
            with torch.no_grad():
                generated = model.generate(**inputs, do_sample=False, max_new_tokens=24)
            title = tokenizer.decode(generated[0, inputs['input_ids'].shape[1]:], skip_special_tokens=True)
            titles.append({'topicId': topic['topicId'], 'title': title})
            progress()
    except Exception as exc:
        exc.partial = (judgements, titles)
        raise
    return judgements, titles


def main():
    if len(sys.argv) == 2 and sys.argv[1] == '--probe':
        probe()
        return
    if len(sys.argv) != 3:
        output({'model': MODEL, 'status': 'unavailable', 'judgements': [], 'error': 'usage: HanamiTrendTopicJudge.py INPUT_JSON OUTPUT_JSON | --probe'})
        return
    input_path, output_path = sys.argv[1:]
    judgements = []
    titles = []
    try:
        with open(input_path, encoding='utf8') as handle:
            job = json.load(handle)
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        device, dtype, runtime = resolve_runtime(torch)
        if device != 'cuda':
            raise RuntimeError('GPU (CUDA) is required for trend topic judging')
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
        model.to(device)
        model.eval()

        def flush(done_judgements, done_titles):
            output({'model': MODEL, 'status': 'partial', 'runtime': runtime, 'judgements': done_judgements, 'titles': done_titles}, output_path)

        judgements, titles = judge_topic_job(torch, tokenizer, model, job, flush)
        output({'model': MODEL, 'status': 'ok', 'runtime': runtime, 'judgements': judgements, 'titles': titles}, output_path)
    except Exception as exc:
        partial = getattr(exc, 'partial', None)
        if partial is not None:
            judgements, titles = partial
        output({'model': MODEL, 'status': 'unavailable', 'judgements': judgements, 'titles': titles, 'error': f'{type(exc).__name__}: {exc}'}, output_path)


if __name__ == '__main__':
    main()
