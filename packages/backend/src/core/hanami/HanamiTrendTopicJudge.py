#!/usr/bin/env python3
"""GPU-only daily/same judgements and short generated topic titles."""
import json
import sys

# Reuse the note judge runtime without leaving a sibling __pycache__ artifact.
sys.dont_write_bytecode = True
from HanamiNoteJudgeCpu import MODEL, output, probe, resolve_runtime

SAME_PROMPT = 'SNS の2つの投稿のまとまりが、同じ出来事・同じ話題について話しているかを判定してください。「はい」か「いいえ」だけを出力してください。\n\n[A]\n{A}\n\n[B]\n{B}'
TITLE_PROMPT = 'SNS で同じ時間帯に複数の人が投稿した内容です。共通する話題を、トレンド欄に載せる短い見出し（日本語・12字以内・名詞止め）にしてください。投稿に書かれていないことは足さないでください。共通する話題が無い・ただの挨拶や雑談の寄せ集めなら「なし」とだけ答えてください。見出しだけを出力してください。\n\n投稿:\n{posts}'

DAILY_PROMPT = 'SNS の投稿のまとまりです。これが「今この時に多くの人が同じ出来事・ニュース・番組・作品・企画について話している話題」なら「話題」、「毎日いつでも見かける日常のつぶやき・あいさつ・定型の投稿（帰宅、おはよう、質問箱の募集、参加表明、ハッシュタグで回答を集める遊びや診断など）」なら「日常」と答えてください。「話題」か「日常」だけを出力してください。\n{X}'


def answer_probability(torch, tokenizer, model, prompt, choices, index):
    text = tokenizer.apply_chat_template([{'role': 'user', 'content': prompt}], tokenize=False, add_generation_prompt=True)
    inputs = tokenizer(text, add_special_tokens=False, return_tensors='pt').to(model.device)
    answer_ids = [tokenizer.encode(choice, add_special_tokens=False)[0] for choice in choices]
    if len(set(answer_ids)) != len(answer_ids):
        raise RuntimeError('answer choices have identical first tokens')
    with torch.no_grad():
        logits = model(**inputs).logits[0, -1, answer_ids].float()
    return float(torch.softmax(logits, dim=0)[index].item())


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
        topics = job['topics']
        if not isinstance(topics, list) or len(topics) > 15 * 2 + 10:
            raise ValueError('too many topics')
        by_id = {topic['topicId']: topic['text'] for topic in topics}
        if len(by_id) != len(topics) or any(not isinstance(text, str) for text in by_id.values()):
            raise ValueError('topics require unique IDs and text')
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        device, dtype, runtime = resolve_runtime(torch)
        if device != 'cuda':
            raise RuntimeError('GPU (CUDA) is required for trend topic judging')
        tokenizer = AutoTokenizer.from_pretrained(MODEL, local_files_only=True)
        model = AutoModelForCausalLM.from_pretrained(MODEL, local_files_only=True, torch_dtype=dtype)
        model.to(device)
        model.eval()
        for topic_id in job['dailyIds']:
            probability = answer_probability(torch, tokenizer, model, DAILY_PROMPT.format(X=by_id[topic_id]), ['話題', '日常'], 1)
            judgements.append({'kind': 'daily', 'topicId': topic_id, 'probability': probability})
            output({'model': MODEL, 'status': 'partial', 'runtime': runtime, 'judgements': judgements, 'titles': titles}, output_path)
        for pair in job['pairs']:
            probability = answer_probability(torch, tokenizer, model, SAME_PROMPT.format(A=by_id[pair['a']], B=by_id[pair['b']]), ['はい', 'いいえ'], 0)
            judgements.append({'kind': 'same', 'a': pair['a'], 'b': pair['b'], 'probability': probability})
            output({'model': MODEL, 'status': 'partial', 'runtime': runtime, 'judgements': judgements, 'titles': titles}, output_path)
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
            output({'model': MODEL, 'status': 'partial', 'runtime': runtime, 'judgements': judgements, 'titles': titles}, output_path)
        output({'model': MODEL, 'status': 'ok', 'runtime': runtime, 'judgements': judgements, 'titles': titles}, output_path)
    except Exception as exc:
        output({'model': MODEL, 'status': 'unavailable', 'judgements': judgements, 'titles': titles, 'error': f'{type(exc).__name__}: {exc}'}, output_path)


if __name__ == '__main__':
    main()
