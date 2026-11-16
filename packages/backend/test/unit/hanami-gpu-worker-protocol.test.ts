/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';

const execFileAsync = promisify(execFile);
const workerDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../src/core/hanami');

/**
 * 本物の判定係（HanamiGpuWorker.py）の受け口を、モデル抜きで動かす。
 * 判定の関数だけを差し替え、「頼まれた形を読めるか」「返す JSON の形」「1 件の失敗がほかを巻き込まないか」を確かめる。
 * モデルを使う判定の中身は、この環境（GPU なし）では確かめられない。
 */
async function runWorkerHandlers(body: string): Promise<Array<Record<string, unknown>>> {
	const script = `
import json, sys
sys.dont_write_bytecode = True
sys.path.insert(0, ${JSON.stringify(workerDirectory)})
import HanamiGpuWorker as worker

def fake_note(torch, tokenizer, model, note, settings):
    if note["cleanedText"] == "boom":
        raise RuntimeError("inference failed")
    return {"noteId": note["noteId"], "ephemeralScore": 1.5, "interest": 3.0, "interestDist": [0, 0, 1, 0, 0], "contentType": 4, "sawInterest5": settings["basis"]["interest5"], "hasFiles": note["hasFiles"]}

def fake_topic(torch, tokenizer, model, job):
    if job.get("fail"):
        error = ValueError("invalid title input")
        error.partial = ([{"kind": "daily", "topicId": "a", "probability": 0.5}], [])
        raise error
    return [{"kind": "daily", "topicId": topic, "probability": 0.9} for topic in job["dailyIds"]], [{"topicId": "a", "title": "寒波"}]

worker.judge_note_one = fake_note
worker.judge_topic_job = fake_topic
${body}
`;
	const { stdout } = await execFileAsync('python3', ['-c', script], { timeout: 30_000 });
	return stdout.split('\n').filter(line => line.trim() !== '').map(line => JSON.parse(line) as Record<string, unknown>);
}

describe('常駐の判定係の受け口（HanamiGpuWorker.py）', () => {
	test('noteJudge: 1 件ずつ判定し、失敗した投稿だけ errors に入れて残りは返す', async () => {
		const settings = { basis: { interest5: 'とても興味深い' }, examples: [] };
		const request = { op: 'noteJudge', requestId: 'r1', items: [
			{ itemId: '1:a', noteId: 'a', cleanedText: '役立つ運用メモです。', hasFiles: true, settings },
			{ itemId: '1:b', noteId: 'b', cleanedText: 'boom', hasFiles: false, settings },
			{ itemId: '1:c', noteId: 'c', cleanedText: '基準が無い', hasFiles: false, settings: {} },
		] };
		const [message] = await runWorkerHandlers(`worker.handle_note_judge(None, None, None, json.loads(${JSON.stringify(JSON.stringify(request))}))`);
		expect(message).toMatchObject({ op: 'result', requestId: 'r1' });
		expect(message.results).toEqual([{ itemId: '1:a', output: { noteId: 'a', ephemeralScore: 1.5, interest: 3, interestDist: [0, 0, 1, 0, 0], contentType: 4, sawInterest5: 'とても興味深い', hasFiles: true } }]);
		expect(message.errors).toEqual([
			{ itemId: '1:b', error: 'RuntimeError: inference failed' },
			{ itemId: '1:c', error: 'ValueError: settings.basis is required' },
		]);
		expect(typeof message.durationMs).toBe('number');
	});

	test('noteJudge: itemId の無い依頼は、まるごと error で返す（配り役が項目を順番待ちに戻す）', async () => {
		const request = { op: 'noteJudge', requestId: 'r2', items: [{ noteId: 'a', cleanedText: 'x' }] };
		const [message] = await runWorkerHandlers(`worker.handle_note_judge(None, None, None, json.loads(${JSON.stringify(JSON.stringify(request))}))`);
		expect(message).toEqual({ op: 'error', requestId: 'r2', error: 'each item requires a string itemId' });
	});

	test('topicJudge: 1 回分の結果を output に入れて返す。途中で失敗しても、済んだ分を status=partial で返す', async () => {
		const ok = { op: 'topicJudge', requestId: 'r3', items: [{ itemId: 'current', job: { topics: [], dailyIds: ['a', 'b'], pairs: [], titles: [] } }] };
		const failed = { op: 'topicJudge', requestId: 'r4', items: [{ itemId: 'current', job: { fail: true } }] };
		const messages = await runWorkerHandlers([
			`worker.handle_topic_judge(None, None, None, "cuda", json.loads(${JSON.stringify(JSON.stringify(ok))}))`,
			`worker.handle_topic_judge(None, None, None, "cuda", json.loads(${JSON.stringify(JSON.stringify(failed))}))`,
			`worker.handle_topic_judge(None, None, None, "cpu", json.loads(${JSON.stringify(JSON.stringify(ok))}))`,
		].join('\n'));
		expect(messages[0]).toMatchObject({ op: 'result', requestId: 'r3', errors: [], results: [{ itemId: 'current', output: {
			status: 'ok', titles: [{ topicId: 'a', title: '寒波' }],
			judgements: [{ kind: 'daily', topicId: 'a', probability: 0.9 }, { kind: 'daily', topicId: 'b', probability: 0.9 }],
		} }] });
		expect(messages[1]).toMatchObject({ op: 'result', requestId: 'r4', results: [{ itemId: 'current', output: {
			status: 'partial', error: 'ValueError: invalid title input', titles: [], judgements: [{ kind: 'daily', topicId: 'a', probability: 0.5 }],
		} }] });
		// GPU でなければ話題の判定はしない（以前のスクリプトと同じ決まり）。
		expect(messages[2]).toMatchObject({ op: 'result', results: [], errors: [{ itemId: 'current', error: expect.stringContaining('GPU (CUDA) is required') }] });
	});

	test('本物の judge_topic_job は、おかしい入力をモデルに触る前に断り、そこまでの結果（空）を付ける', async () => {
		const [message] = await runWorkerHandlers(`
import HanamiTrendTopicJudge as topic
try:
    topic.judge_topic_job(None, None, None, {"topics": [{"topicId": "a", "text": "A"}, {"topicId": "a", "text": "B"}], "dailyIds": [], "pairs": []})
    print(json.dumps({"raised": False}))
except Exception as exc:
    print(json.dumps({"raised": True, "error": str(exc), "partial": list(exc.partial)}))
`);
		expect(message).toEqual({ raised: true, error: 'topics require unique IDs and text', partial: [[], []] });
	});
});
