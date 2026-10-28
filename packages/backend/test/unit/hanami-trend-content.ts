/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { hanamiTrendAuthorGroups, hanamiTrendEffectiveAuthors, trendShingles } from '@/core/hanami/HanamiTrendEffectiveAuthors.js';
import { HanamiTrendService, trendTitleNeedsRename, trendTitlePosts, trendTopicsOverlap, trendTopicVisible, validateTrendTitle } from '@/core/hanami/HanamiTrendService.js';
import { prepareHanamiPythonCommand, resolveHanamiTrendTopicsScript } from '@/core/hanami/HanamiPythonRuntime.js';

const probe = prepareHanamiPythonCommand(['-c', 'import numpy, networkx']);
let pythonAvailable = true;
try { execFileSync(probe.file, probe.args, { env: probe.env }); } catch { pythonAvailable = false; }
const pythonTest = pythonAvailable ? test : test.skip;
const fixtureRoot = process.env.HANAMI_TREND_REPLAY_DATA ?? '/tmp/claude-1000/-workspace/e4781234-8e7b-4c3c-b939-7148bda2dfb6/scratchpad/foryou1027';
type Post = { userId: string; text: string; tags?: string[]; createdAt: string };
const fixtures = existsSync(join(fixtureRoot, 'gen.json')) ? JSON.parse(readFileSync(join(fixtureRoot, 'gen.json'), 'utf8')) as Record<string, Post[]> : null;
const fixtureTest = fixtures != null ? test : test.skip;

function runPython(code: string, data: unknown): unknown {
	const dir = mkdtempSync(join(tmpdir(), 'hanami-content-test-'));
	try {
		const file = join(dir, 'input.json');
		writeFileSync(file, JSON.stringify(data));
		const command = prepareHanamiPythonCommand(['-c', `import sys,json,importlib.util\nsys.dont_write_bytecode=True\nspec=importlib.util.spec_from_file_location('topics',sys.argv[1])\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nd=json.load(open(sys.argv[2]))\n${code}`, resolveHanamiTrendTopicsScript(), file]);
		return JSON.parse(execFileSync(command.file, command.args, { env: command.env, encoding: 'utf8' }));
	} finally { rmSync(dir, { recursive: true, force: true }); }
}

afterEach(() => vi.unstubAllEnvs());

describe('effective authors', () => {
	fixtureTest.each([
		['ioメシヨソイゲーム', 33, 4.2], ['地獄の鬼ルーレット', 52, 7.0], ['フリスビー投げ', 35, 4.4],
		['レモン水を作ろう', 4, 1.3], ['豊臣兄弟', 14, 14],
	] as const)('%s reproduces calibrated counts with and without play tags', (tag, raw, effective) => {
		const notes = fixtures![tag];
		expect(new Set(notes.map(note => note.userId)).size).toBe(raw);
		expect(hanamiTrendEffectiveAuthors(notes, false)).toBe(effective);
		expect(hanamiTrendEffectiveAuthors(notes)).toBe(effective);
	});
	fixtureTest('caturday has one similar pair under the specified skeleton (brief table says 52)', () => {
		expect(new Set(fixtures!.caturday.map(note => note.userId)).size).toBe(52);
		expect(hanamiTrendEffectiveAuthors(fixtures!.caturday, false)).toBe(51.1);
		expect(hanamiTrendEffectiveAuthors(fixtures!.caturday)).toBe(51.1);
	});
	fixtureTest('busiest UTC two-hour earthquake window has 33 authors and 31.2 effective authors', () => {
		const bins = new Map<number, Post[]>();
		for (const note of JSON.parse(readFileSync(join(fixtureRoot, 'quake.json'), 'utf8')) as Post[]) {
			const key = Math.floor(Date.parse(note.createdAt) / 7200000); const bucket = bins.get(key) ?? [];
			bucket.push(note); bins.set(key, bucket);
		}
		const notes = [...bins.values()].sort((a, b) => b.length - a.length)[0];
		expect(new Set(notes.map(note => note.userId)).size).toBe(33);
		expect(hanamiTrendEffectiveAuthors(notes)).toBe(31.2);
	});
	test('union-find connects multiple posts transitively and only groups play tags', () => {
		const notes = [{ userId: 'a', text: 'abcdef' }, { userId: 'b', text: 'abcdef' }, { userId: 'b', text: 'uvwxyz' }, { userId: 'c', text: 'uvwxyz' }];
		expect(hanamiTrendEffectiveAuthors(notes)).toBe(1.2);
		for (const tag of ['豊臣兄弟', '紙本祭8', 'caturday']) expect(hanamiTrendEffectiveAuthors([{ userId: 'a', text: '#'+tag }, { userId: 'b', text: '#'+tag }])).toBe(2);
		for (const tag of ['私は存在感が薄いので', 'ShindanMaker']) expect(hanamiTrendEffectiveAuthors([{ userId: 'a', text: '#'+tag }, { userId: 'b', text: '#'+tag }])).toBe(1.1);
		expect(hanamiTrendAuthorGroups([{ userId: 'a', text: '' }, { userId: 'b', text: '' }])).toHaveLength(2);
		expect(trendShingles('https://a @user@host :emoji: $[spin <center>１２.３％あいうえ</center>] #タグ')).toEqual(trendShingles('0あいうえ'));
	});
	pythonTest('TS and Python agree on fixtures, markup, numeric runs and Unicode codepoints', () => {
		const samples = [...Object.values(fixtures ?? {}), [{ userId: 'a', text: '123 456😀😸🐱' }, { userId: 'b', text: '1 2😀😸🐱' }]];
		const expected = samples.map(notes => [hanamiTrendEffectiveAuthors(notes, false), hanamiTrendEffectiveAuthors(notes)]);
		expect(runPython('print(json.dumps([[m.effective_authors(ns,False),m.effective_authors(ns)] for ns in d]))', samples)).toEqual(expected);
	});
});

describe('content thresholds and gating', () => {
	pythonTest('requires three baseline days, two other authors, and a threefold burst', () => {
		const result = runPython(`import numpy as np
out=[]
for count,base_days,base_count in [(3,3,0),(2,3,0),(3,2,0),(3,3,1),(6,3,1)]:
 notes=[dict(id=str(i),userId=str(i),text=chr(0x4e00+i)*15,createdAt=999,embeddingIndex=i) for i in range(count)]
 days=[[dict(userId='base'+str(i),embeddingIndex=count+i) for i in range(base_count)] for _ in range(base_days)]
 raw=np.array([[1.,0.]]*(count+base_count),dtype=np.float32)
 out.append(len(m.build_content_topics(dict(now=1000,notes=notes,baselineDays=days,meanVec=[0,0]),raw)))
print(json.dumps(out))`, null);
		expect(result).toEqual([1, 0, 0, 0, 1]);
	});
	test('merge is inclusive at 30% overlap or cosine 0.85', () => {
		const a = { noteIds: Array.from({ length: 10 }, (_, i) => String(i)), center: [1, 0] };
		expect(trendTopicsOverlap(a, { noteIds: ['0', '1', '2', ...Array.from({ length: 7 }, (_, i) => 'x'+i)], center: null })).toBe(true);
		expect(trendTopicsOverlap(a, { noteIds: ['0', '1', ...Array.from({ length: 8 }, (_, i) => 'x'+i)], center: null })).toBe(false);
		expect(trendTopicsOverlap(a, { noteIds: ['other'], center: [0.85, Math.sqrt(1-0.85**2)] })).toBe(true);
		expect(trendTopicsOverlap(a, { noteIds: ['other'], center: [0.849, Math.sqrt(1-0.849**2)] })).toBe(false);
	});
	test.each([null, undefined, '1', '0'])('content-only visibility requires a cached zero (%s)', verdict => {
		expect(trendTopicVisible('content', verdict)).toBe(verdict === '0');
		expect(trendTopicVisible('term', verdict)).toBe(true);
	});
	test('old hashtag terms are rejected from cached and live candidates', async () => {
		const candidates = [{ term: '#昔のタグ', score: 100, proper: true, distinctAuthors: 100 }, { term: '地震', score: 3, proper: false, distinctAuthors: 3 }];
		const cached = new HanamiTrendService({ get: async () => JSON.stringify(candidates) } as never, {} as never, {} as never, {} as never);
		expect(await cached.getTrendingTerms(30)).toEqual([{ term: '地震', score: 3, distinctAuthors: 3 }]);
		const pipe: Record<string, unknown> = { exec: async () => [[null, ['#昔のタグ', '100']]] };
		for (const method of ['zrange', 'zmscore', 'del', 'sadd', 'expire']) pipe[method] = () => pipe;
		const live = new HanamiTrendService({ get: async () => null, smembers: async () => ['#昔のタグ'], pipeline: () => pipe, multi: () => pipe, set: async () => 'OK' } as never,
			{ getGlobalNotesScoresWithCache: async () => new Map() } as never, {} as never, {} as never);
		expect(await live.getTrendingTerms(30)).toEqual([]);
	});
	test('content input is collected even without term seeds', async () => {
		const query = vi.fn(async (sql: string) => sql.includes('char_length') ? [{ id: 'one', userId: 'a', text: '内容だけの投稿を調べる', replyId: null, renoteId: null }] : []);
		const service = new HanamiTrendService({ pipeline: () => ({ exec: async () => [] }) } as never, {} as never, {} as never, { query } as never,
			{ gen: String, parse: () => ({ date: new Date(999) }) } as never);
		expect((await service['collectTopicInput']([], 1000)).notes.map(note => note.id)).toEqual(['one']);
	});
});

describe('titles', () => {
	test.each(['', 'なし', 'あ'.repeat(13), '甲・乙・丙', '#地震', 'https://example.test', '寒波\n到来'])('rejects %j', title => expect(validateTrendTitle(title)).toBeNull());
	test('trims quotations and counts codepoints', () => {
		expect(validateTrendTitle(' 「ソフトバンク日本一」 ')).toBe('ソフトバンク日本一');
		expect(validateTrendTitle('😀'.repeat(12))).toBe('😀'.repeat(12));
	});
	test('renames below half of the named posts, using the old sample as denominator', () => {
		const title = { title: '寒波', noteIds: ['a', 'b', 'c', 'd'] };
		expect(trendTitleNeedsRename(title, ['a', 'b', 'new'])).toBe(false);
		expect(trendTitleNeedsRename(title, ['a'])).toBe(true);
		expect(trendTitleNeedsRename(null, ['a'])).toBe(true);
	});
	test('deduplicates before selecting ten cleaned posts and requires three', () => {
		const notes = [{ text: '最初の異なる話を説明する #タグ' }, { text: '最初の異なる話を説明する #別タグ' }, { text: 'ABCDEFGHIJKLMNOP' }, { text: 'ひらがなだけのふたつめ' }];
		expect(trendTitlePosts(notes)).toEqual(['最初の異なる話を説明する', 'ABCDEFGHIJKLMNOP', 'ひらがなだけのふたつめ']);
		expect(trendTitlePosts(notes.slice(0, 3))).toEqual([]);
	});
});

pythonTest('R2: Python reads only selected binary row ranges with the same float32 results', () => {
	expect(runPython(`import numpy as np,tempfile,os
with tempfile.TemporaryDirectory() as directory:
 path=os.path.join(directory,'hour.f32')
 np.array([[1,0],[0,1],[0,1],[1,0]],dtype='<f4').tofile(path)
 notes=[dict(id=str(i),userId=str(i),text=chr(0x4e00+i)*15,createdAt=999,embeddingIndex=i) for i in range(3)]
 inp=dict(now=1000,notes=notes,meanVec=[0,0],baselineFiles=[[dict(path=path,ranges=[[1,3]],userIds=['b','c'])]]*3)
 raw=np.array([[1,0]]*3,dtype=np.float32)
 actual=m.build_content_topics(inp,raw)
 del inp['baselineFiles']
 inp['baselineDays']=[[dict(userId='b',embeddingIndex=3),dict(userId='c',embeddingIndex=4)]]*3
 expected=m.build_content_topics(inp,np.concatenate([raw,np.array([[0,1],[0,1]],dtype=np.float32)]))
 print(json.dumps([len(actual),actual==expected]))`, null)).toEqual([1, true]);
});

test('R2: hourly cache keeps vectors binary, reuses complete baselines and reads recent rows only', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hanami-content-cache-'));
	vi.stubEnv('HANAMI_TREND_CACHE_DIR', dir);
	const now = Date.parse('2026-10-28T12:45Z');
	const hour = 3600000;
	const current = { id: 'current', userId: 'a', text: '異なる内容を表す長い投稿', createdAt: now - hour, terms: [], embeddingIndex: null, replyId: null, renoteId: null };
	const times = new Map<string, number>([['current', current.createdAt]]);
	const query = vi.fn(async (sql: string, args: unknown[]) => {
		if (sql.startsWith('SELECT "noteId"')) return [{ noteId: 'current', embedding: [1, 0, 0] }];
		const at = Number(args[0]) + 1000;
		const noteId = String(at); times.set(noteId, at);
		return [{ noteId, userId: noteId, cleanLength: 20, embedding: [0, 1, 0] }];
	});
	const service = new HanamiTrendService({} as never, {} as never, {} as never, { query } as never,
		{ gen: String, parse: (id: string) => ({ date: new Date(times.get(id)!) }) } as never);
	try {
		const first = await service['loadTopicEmbeddings']([current], now);
		expect(first.baselineDays).toHaveLength(7);
		expect(first.rows).toHaveLength(1);
		expect(first.rows[0]).not.toHaveProperty('embedding');
		expect(first.embeddings.readFloatLE(0)).toBe(1);
		const file = first.baselineDays[0][0];
		expect(readFileSync(file.path).length).toBe(12);
		const meta = JSON.parse(readFileSync(file.path.replace(/\.f32$/, '.json'), 'utf8'));
		expect(meta).toMatchObject({ complete: true, dim: 3, rows: [{ row: 0, cleanLength: 20 }] });
		expect(meta.rows[0]).not.toHaveProperty('embedding');
		const calls = query.mock.calls.length;
		const second = await service['loadTopicEmbeddings']([current], now);
		expect(second.embeddings).toEqual(first.embeddings);
		expect(query).toHaveBeenCalledTimes(calls);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('R2: backfill respects the 8000-vector budget and atomically appends after an interrupted write', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'hanami-content-backfill-'));
	vi.stubEnv('HANAMI_TREND_CACHE_DIR', dir);
	const now = Date.parse('2026-10-28T12:00Z');
	const baselineStart = now - 30 * 3600000;
	const current = { id: 'current', userId: 'a', text: '内容を表す十分長い本文です', createdAt: now - 1000, terms: [], embeddingIndex: null, replyId: null, renoteId: null };
	const query = vi.fn(async (sql: string, args: unknown[]) => {
		if (sql.startsWith('SELECT "noteId"')) return [{ noteId: 'current', embedding: [1, 0] }];
		if (Number(args[0]) !== baselineStart) return [];
		const start = args[2] == null ? 0 : Number(args[2]) + 1;
		return Array.from({ length: Math.min(8005 - start, Number(args[6])) }, (_, offset) => ({
			noteId: String(start + offset), userId: 'baseline', cleanLength: 20, embedding: [start + offset, 1],
		}));
	});
	const service = new HanamiTrendService({} as never, {} as never, {} as never, { query } as never,
		{ gen: String, parse: () => ({ date: new Date(baselineStart + 1000) }) } as never);
	try {
		const first = await service['loadTopicEmbeddings']([current], now);
		expect(first.baselineDays).toEqual([]);
		expect(query.mock.calls[1][1][6]).toBe(7999);
		const { readdirSync, appendFileSync } = await import('node:fs');
		const metaPath = join(dir, readdirSync(dir).find(name => name.endsWith(`-${baselineStart / 3600000}.json`))!);
		const metadata = JSON.parse(readFileSync(metaPath, 'utf8'));
		expect(metadata).toMatchObject({ complete: false, cursor: '7998' });
		expect(metadata.rows).toHaveLength(7999);
		const binaryPath = metaPath.replace(/\.json$/, '.f32');
		appendFileSync(binaryPath, Buffer.alloc(8, 255)); // binary rename succeeded, metadata rename did not
		const second = await service['loadTopicEmbeddings']([current], now);
		expect(second.baselineDays).toHaveLength(1);
		expect(second.baselineDays[0][0].ranges).toEqual([[0, 8005]]);
		const binary = readFileSync(binaryPath);
		expect(binary.length).toBe(8005 * 8);
		expect(binary.readFloatLE(7999 * 8)).toBe(7999);
		expect(binary.readFloatLE(8004 * 8)).toBe(8004);
		expect(readdirSync(dir).some(name => name.includes('.tmp'))).toBe(false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
