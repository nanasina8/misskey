#!/usr/bin/env node

/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
 * 欠損した Redis fanout タイムライン(list:*)を Postgres の note から埋め直す。
 *
 * NoteCreateService#pushToTl の分岐をそのまま写している。読み出し側
 * (FanoutTimelineService#get) は lrange 後に ID でソートするため、
 * リスト内の物理順は表示順に影響しない。ただし ltrim は末尾を切るので、
 * 書き戻しは「ID降順・上限件数まで」に整列してから入れ直す。
 *
 * 依存パッケージなしで動く:
 *   - Postgres は docker exec <container> psql 経由。接続情報はコンテナの
 *     POSTGRES_USER/PASSWORD/DB から読む (--pg-* で上書き可)
 *   - Redis は TCP(RESP直喋り)、届かなければ docker exec redis-cli 経由へ自動切替
 *
 * 環境を確かめるだけなら --list を付ける (接続も書き込みもしない)。
 *
 * docker で動かしている本番では、ホストに node が無くてもよい。web コンテナの node に標準入力で流す:
 *   docker compose exec -T web node --input-type=module - --list < scripts/hanami-repair-fanout-timelines.mjs
 *   (引数は「-」の後ろに書く。コンテナ内では psql の代わりに pg ライブラリ、Redis は設定のホストへ直接つなぐ)
 *
 * 既定は dry-run。実際に書き込むには --apply を付ける。
 *
 *   node scripts/hanami-repair-fanout-timelines.mjs
 *   node scripts/hanami-repair-fanout-timelines.mjs --since 4d
 *   node scripts/hanami-repair-fanout-timelines.mjs --since 4d --apply
 *
 * アンテナ (list:antennaTimeline:*) も AntennaService#checkHitAntenna と同じ条件で埋める
 * (止まっているアンテナも含む)。アンテナを外すときは --no-antenna。
 *
 * 触らないもの: 通知(notificationTimeline)、ジョブキュー(bull:*)、
 * その他すべてのキー。list: で始まる TL キーだけを書き換える。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { domainToASCII, fileURLToPath } from 'node:url';

// Misskey のリポジトリ直下 (.config がある所)。標準入力から流したとき (docker の web コンテナ内) は今いる場所から探す
const ROOT = (() => {
	const starts = [process.cwd()];
	if (import.meta.url.startsWith('file:') && !import.meta.url.includes('[eval')) starts.unshift(path.dirname(fileURLToPath(import.meta.url)));
	for (const start of starts) {
		for (let dir = start; ; dir = path.dirname(dir)) {
			if (fs.existsSync(path.join(dir, '.config'))) return dir;
			if (path.dirname(dir) === dir) break;
		}
	}
	return process.cwd();
})();
const TIME2000 = 946684800000;
const ID_RE = /^[0-9a-zA-Z]{1,32}$/;

// ---------- 引数 ----------
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, fallback = null) => {
	const i = argv.indexOf(name);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APPLY = flag('--apply');
const VERBOSE = flag('--verbose');

function parseSince(spec) {
	if (spec == null) return null;
	const rel = /^(\d+)([dh])$/.exec(spec);
	if (rel) return new Date(Date.now() - Number(rel[1]) * (rel[2] === 'd' ? 86400000 : 3600000));
	const d = new Date(spec);
	if (Number.isNaN(d.getTime())) throw new Error(`--since を解釈できない: ${spec}`);
	return d;
}

// aidx: 先頭8文字が 2000-01-01 からの経過msのbase36
const idToDate = (id) => new Date(parseInt(id.slice(0, 8), 36) + TIME2000);
const dateToId = (d) => Math.max(0, d.getTime() - TIME2000).toString(36).padStart(8, '0').slice(-8);

// ---------- 設定 (.config/default.yml は既定値として使うだけ) ----------
function readConfig() {
	const file = path.join(ROOT, '.config/default.yml');
	if (!fs.existsSync(file)) return { url: null, db: {}, redis: {}, redisForTimelines: {} };
	const lines = fs.readFileSync(file, 'utf8').split('\n').filter(l => !/^\s*#/.test(l));
	const block = (name) => {
		const out = {};
		let inside = false;
		for (const line of lines) {
			if (new RegExp(`^${name}:\\s*$`).test(line)) { inside = true; continue; }
			if (inside) {
				if (/^\S/.test(line)) break;                       // 次のトップレベルキーで終了
				const m = /^\s+([A-Za-z_]+):\s*(.+?)\s*$/.exec(line);
				if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
			}
		}
		return out;
	};
	const url = /^url:\s*(.+?)\s*$/m.exec(lines.join('\n'))?.[1].replace(/^['"]|['"]$/g, '') ?? null;
	return { url, db: block('db'), redis: block('redis'), redisForTimelines: block('redisForTimelines') };
}

const config = readConfig();
const redisSrc = Object.keys(config.redisForTimelines).length > 0 ? config.redisForTimelines : config.redis;

function dockerPs() {
	const r = spawnSync('docker', ['ps', '--format', '{{.Names}}\t{{.Image}}'], { encoding: 'utf8' });
	if (r.error || r.status !== 0) return [];
	return r.stdout.split('\n').filter(l => l.includes('\t'))
		.map(l => { const [name, image] = l.split('\t'); return { name, image }; });
}
const CONTAINERS = dockerPs();
const pickContainers = (re) => CONTAINERS.filter(c => re.test(c.image) || re.test(c.name));

/** 複数候補があれば列挙して中断する */
function requireOne(kind, candidates, optName) {
	if (candidates.length === 1) return candidates[0].name;
	console.error(`\n${kind} のコンテナを一意に決められません (候補 ${candidates.length} 件):`);
	for (const c of candidates) console.error(`  ${c.name}\t${c.image}`);
	console.error(`\n${optName} <名前> で明示してください。`);
	process.exit(1);
}

// ---------- Postgres ----------
/** イメージ名に依存せず、pg_isready が通るコンテナを Postgres とみなす */
function detectPgCandidates() {
	const hits = [];
	for (const c of CONTAINERS) {
		const r = spawnSync('docker', ['exec', '-i', c.name, 'sh', '-c', 'pg_isready -q >/dev/null 2>&1 && echo YES'],
			{ encoding: 'utf8', timeout: 15000 });
		if (!r.error && r.stdout.trim() === 'YES') hits.push(c);
	}
	return hits;
}

/** コンテナ自身の環境変数を正 (無ければ default.yml、最後に --pg-* で上書き) */
function pgAuthOf(container) {
	let user = config.db.user, pass = config.db.pass, dbname = config.db.db;
	const r = spawnSync('docker',
		['exec', '-i', container, 'sh', '-c', 'echo "$POSTGRES_USER"; echo "$POSTGRES_PASSWORD"; echo "$POSTGRES_DB"'],
		{ encoding: 'utf8', timeout: 15000 });
	if (!r.error && r.status === 0) {
		const [u, p, d] = r.stdout.split('\n');
		if (u) user = u; if (p) pass = p; if (d) dbname = d;
	}
	return {
		user: opt('--pg-user', user ?? 'postgres'),
		pass: opt('--pg-pass', pass ?? 'postgres'),
		db: opt('--pg-db', dbname ?? 'misskey'),
	};
}

/** note の推定行数 (pg_class.reltuples なので即答する) */
function noteRowEstimate(container, auth) {
	const r = spawnSync('docker',
		['exec', '-i', '-e', `PGPASSWORD=${auth.pass}`, container, 'psql', '-U', auth.user, '-d', auth.db,
			'-X', '-q', '-A', '-t', '-c', `SELECT coalesce(max(reltuples), -1)::bigint FROM pg_class WHERE relname = 'note';`],
		{ encoding: 'utf8', timeout: 30000 });
	if (r.error) return { rows: -1, err: r.error.message };
	if (r.status !== 0) return { rows: -1, err: (r.stderr || '').trim().split('\n').slice(-1)[0] };
	return { rows: Number(r.stdout.trim()), err: null };
}

let PG_CONTAINER = opt('--pg-container');
let PG;
if (PG_CONTAINER) {
	PG = pgAuthOf(PG_CONTAINER);
} else {
	const cands = detectPgCandidates();
	if (cands.length === 0) {
		PG_CONTAINER = null;
		PG = { user: opt('--pg-user', config.db.user ?? 'postgres'), pass: opt('--pg-pass', config.db.pass ?? 'postgres'), db: opt('--pg-db', config.db.db ?? 'misskey') };
	} else if (cands.length === 1) {
		PG_CONTAINER = cands[0].name;
		PG = pgAuthOf(PG_CONTAINER);
	} else {
		// 候補が複数あるときは note の行数が最大のものを本番とみなす
		console.log(`Postgres 候補が ${cands.length} 件。note の行数で判定します:`);
		let best = null, failed = 0;
		for (const c of cands) {
			const auth = pgAuthOf(c.name);
			const { rows, err } = noteRowEstimate(c.name, auth);
			console.log(`  ${c.name}\t(user=${auth.user} db=${auth.db})\tnote≈${err ? `読めない: ${err}` : rows.toLocaleString()}`);
			if (err) { failed++; continue; }
			if (best == null || rows > best.rows) best = { name: c.name, auth, rows };
		}
		// 1つでも読めない候補があるなら、残りから勝手に選ばない
		if (failed > 0 || best == null || best.rows <= 0) {
			console.error('\n読めない候補があるため自動選択しません。--pg-container <名前> で明示してください。');
			console.error('認証情報が違う場合は --pg-user / --pg-pass / --pg-db も添えてください。');
			process.exit(1);
		}
		PG_CONTAINER = best.name;
		PG = best.auth;
	}
}

// psql も docker も無いとき (docker の web コンテナ内で動かすとき) は、
// コンテナにある pg ライブラリで子プロセスから問い合わせる。出力は psql -A -t -F '\t' と同じ形にそろえる
const HAS_PSQL = (() => { const r = spawnSync('psql', ['--version'], { encoding: 'utf8' }); return !r.error && r.status === 0; })();
const PG_CHILD = `
import { createRequire } from 'node:module';
const [root, host, port, user, pass, db] = process.argv.slice(1);
const require = createRequire(root + '/packages/backend/package.json');
const pg = require('pg');
let sql = '';
for await (const c of process.stdin) sql += c;
const client = new pg.Client({ host, port: Number(port), user, password: pass, database: db });
await client.connect();
const res = await client.query({ text: sql, rowMode: 'array' });
await client.end();
const last = Array.isArray(res) ? res.at(-1) : res;
const cell = (v) => v == null ? '' : v === true ? 't' : v === false ? 'f' : v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
process.stdout.write((last.rows ?? []).map(r => r.map(cell).join('\\t')).join('\\n') + '\\n');
`;

function psqlViaNode(sql) {
	const r = spawnSync(process.execPath, ['--input-type=module', '-e', PG_CHILD, ROOT, config.db.host ?? '127.0.0.1', String(config.db.port ?? 5432), PG.user, PG.pass, PG.db], {
		input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
	});
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`DB への問い合わせに失敗:\n${r.stderr}`);
	return r.stdout.split('\n').filter(l => l.length > 0).map(l => l.split('\t'));
}

/** SQL を投げて TSV の二次元配列で返す */
function psql(sql) {
	if (!PG_CONTAINER && !HAS_PSQL) return psqlViaNode(sql);
	const psqlArgs = ['-U', PG.user, '-d', PG.db, '-X', '-q', '-A', '-t', '-F', '\t', '-v', 'ON_ERROR_STOP=1', '-f', '-'];
	const [cmd, args] = PG_CONTAINER
		? ['docker', ['exec', '-i', '-e', `PGPASSWORD=${PG.pass}`, PG_CONTAINER, 'psql', ...psqlArgs]]
		: ['psql', ['-h', config.db.host ?? '127.0.0.1', '-p', String(config.db.port ?? 5432), ...psqlArgs]];

	const r = spawnSync(cmd, args, {
		input: sql, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024,
		env: { ...process.env, PGPASSWORD: PG.pass },
	});
	if (r.error) throw r.error;
	if (r.status !== 0) throw new Error(`psql 失敗:\n${r.stderr}`);
	return r.stdout.split('\n').filter(l => l.length > 0).map(l => l.split('\t'));
}

const sqlList = (ids) => {
	for (const id of ids) if (!ID_RE.test(id)) throw new Error(`不正なID: ${id}`);
	return ids.map(id => `'${id}'`).join(',');
};

// ---------- Redis: TCP(RESP直喋り) ----------
class RedisTcp {
	constructor(host, port, pass, db) { this.host = host; this.port = port; this.pass = pass; this.db = db; this.buf = Buffer.alloc(0); this.queue = []; }

	connect() {
		return new Promise((resolve, reject) => {
			this.sock = net.createConnection({ host: this.host, port: this.port });
			this.sock.setTimeout(4000, () => { this.sock.destroy(new Error('接続タイムアウト')); });
			this.sock.once('connect', () => { this.sock.setTimeout(0); resolve(); });
			this.sock.on('error', err => { this.queue.splice(0).forEach(q => q.reject(err)); reject(err); });
			this.sock.on('data', chunk => {
				this.buf = Buffer.concat([this.buf, chunk]);
				for (;;) {
					const parsed = this.#parse(0);
					if (parsed == null) break;
					this.buf = this.buf.subarray(parsed.next);
					const q = this.queue.shift();
					if (q == null) continue;
					if (parsed.value instanceof Error) q.reject(parsed.value); else q.resolve(parsed.value);
				}
			});
		});
	}

	/** 1件パースして {value, next} を返す。データ不足なら null */
	#parse(i) {
		if (i >= this.buf.length) return null;
		const type = String.fromCharCode(this.buf[i]);
		const crlf = this.buf.indexOf('\r\n', i);
		if (crlf < 0) return null;
		const head = this.buf.toString('utf8', i + 1, crlf);
		const next = crlf + 2;

		switch (type) {
			case '+': return { value: head, next };
			case '-': return { value: new Error(head), next };
			case ':': return { value: Number(head), next };
			case '$': {
				const len = Number(head);
				if (len === -1) return { value: null, next };
				if (this.buf.length < next + len + 2) return null;
				return { value: this.buf.toString('utf8', next, next + len), next: next + len + 2 };
			}
			case '*': {
				const len = Number(head);
				if (len === -1) return { value: null, next };
				const items = [];
				let cur = next;
				for (let n = 0; n < len; n++) {
					const el = this.#parse(cur);
					if (el == null) return null;
					items.push(el.value);
					cur = el.next;
				}
				return { value: items, next: cur };
			}
			default: throw new Error(`未知のRESP型: ${type}`);
		}
	}

	send(...args) {
		let out = `*${args.length}\r\n`;
		for (const a of args) { const s = String(a); out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`; }
		const p = new Promise((resolve, reject) => this.queue.push({ resolve, reject }));
		this.sock.write(out);
		return p;
	}

	async init() {
		await this.connect();
		if (this.pass) await this.send('AUTH', this.pass);
		if (this.db) await this.send('SELECT', this.db);
	}
	async scanKeys(pattern) {
		let cursor = '0'; const keys = [];
		do { const [next, ks] = await this.send('SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000); cursor = next; keys.push(...ks); } while (cursor !== '0');
		return keys;
	}
	lrangeMany(keys) { return Promise.all(keys.map(k => this.send('LRANGE', k, 0, -1).then(v => v ?? []))); }
	async replaceKey(key, values) {
		const rs = [this.send('MULTI'), this.send('DEL', key)];
		for (let i = 0; i < values.length; i += 500) rs.push(this.send('RPUSH', key, ...values.slice(i, i + 500)));
		rs.push(this.send('EXEC'));
		const res = await Promise.all(rs);
		if (res.at(-1) == null) throw new Error(`${key} の書き込みに失敗 (EXEC が nil)`);
	}
	close() { this.sock?.end(); }
	describe() { return `${this.host}:${this.port} (TCP)`; }
}

// ---------- Redis: docker exec redis-cli ----------
const SENTINEL = '@@HANAMI_END@@';
class RedisDocker {
	constructor(container, pass) { this.container = container; this.pass = pass; }

	/** 複数コマンドを1回の docker exec でまとめて流し、SENTINEL 区切りで応答を切り出す */
	run(blocks) {
		const input = blocks.map(cmds => cmds.concat([`ECHO ${SENTINEL}`]).join('\n')).join('\n') + '\n';
		const args = ['exec', '-i', this.container, 'redis-cli'];
		if (this.pass) args.push('--no-auth-warning', '-a', this.pass);
		const r = spawnSync('docker', args, { input, encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
		if (r.error) throw r.error;
		if (r.status !== 0) throw new Error(`redis-cli 失敗:\n${r.stderr}`);
		const out = [];
		let cur = [];
		for (const line of r.stdout.split('\n')) {
			if (line === SENTINEL) { out.push(cur); cur = []; continue; }
			cur.push(line);
		}
		if (out.length !== blocks.length) throw new Error(`redis-cli の応答数が合わない (期待${blocks.length}/実際${out.length})`);
		return out;
	}

	async init() { this.run([['PING']]); }
	async scanKeys(pattern) {
		const args = ['exec', '-i', this.container, 'redis-cli'];
		if (this.pass) args.push('--no-auth-warning', '-a', this.pass);
		args.push('--scan', '--pattern', pattern);
		const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
		if (r.status !== 0) throw new Error(`redis-cli --scan 失敗:\n${r.stderr}`);
		return r.stdout.split('\n').filter(l => l.length > 0);
	}
	async lrangeMany(keys) {
		// 応答の最後は ECHO の直前までが LRANGE の結果。空リストは0行になる
		return this.run(keys.map(k => [`LRANGE ${k} 0 -1`]))
			.map(lines => lines.filter(l => l.length > 0));
	}
	async replaceKey(key, values) {
		const cmds = ['MULTI', `DEL ${key}`];
		// 1行が長くなりすぎないよう100件ずつに割る (MULTI内なので原子性は保たれる)
		for (let i = 0; i < values.length; i += 100) cmds.push(`RPUSH ${key} ${values.slice(i, i + 100).join(' ')}`);
		cmds.push('EXEC');
		const [lines] = this.run([cmds]);
		if (lines.some(l => /^(ERR|WRONGTYPE|EXECABORT|NOAUTH)/.test(l))) {
			throw new Error(`${key} の書き込みに失敗: ${lines.find(l => /^(ERR|WRONGTYPE|EXECABORT|NOAUTH)/.test(l))}`);
		}
	}
	close() {}
	describe() { return `docker exec ${this.container} redis-cli`; }
}

/** そのコンテナの redis-cli で list:localTimeline を探す */
function scanLocalTimeline(container, pass) {
	const args = ['exec', '-i', container, 'redis-cli'];
	if (pass) args.push('--no-auth-warning', '-a', pass);
	args.push('--scan', '--pattern', '*list:localTimeline');
	const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, timeout: 120000 });
	if (r.error || r.status !== 0) return null;
	return r.stdout.split('\n').filter(l => l.length > 0);
}

/** TCP を試し、駄目なら docker exec へ自動フォールバック */
async function openRedis() {
	const forced = opt('--redis-container');
	const pass = opt('--redis-pass', redisSrc.pass ?? null);

	if (!forced) {
		const host = opt('--redis-host', redisSrc.host ?? '127.0.0.1');
		const port = Number(opt('--redis-port', redisSrc.port ?? 6379));
		const tcp = new RedisTcp(host, port, pass, redisSrc.db ?? null);
		try { await tcp.init(); return { redis: tcp, seen: null }; } catch (e) {
			tcp.close();
			console.log(`Redis: TCP ${host}:${port} へ繋がらない (${e.message})。docker exec 経由を試します`);
		}
	}

	const cands = pickContainers(/dragonfly|redis|valkey/i);
	if (cands.length === 0) throw new Error('Redis に到達できません。--redis-container か --redis-host/--redis-port を指定してください。');

	if (forced) {
		const cli = new RedisDocker(forced, pass);
		await cli.init();
		return { redis: cli, seen: scanLocalTimeline(forced, pass) };
	}
	if (cands.length === 1) {
		const cli = new RedisDocker(cands[0].name, pass);
		await cli.init();
		return { redis: cli, seen: scanLocalTimeline(cands[0].name, pass) };
	}

	// 候補が複数: list:localTimeline を実際に持っているものを選ぶ
	console.log(`Redis 候補が ${cands.length} 件。list:localTimeline の有無で判定します:`);
	const withKey = [];
	for (const c of cands) {
		const found = scanLocalTimeline(c.name, pass);
		console.log(`  ${c.name}\t${found == null ? '接続できない' : `list:localTimeline ${found.length} 件`}`);
		if (found != null && found.length > 0) withKey.push({ c, found });
	}
	if (withKey.length !== 1) {
		console.error(`\nRedis を一意に決められません。--redis-container <名前> で明示してください。`);
		process.exit(1);
	}
	const cli = new RedisDocker(withKey[0].c.name, pass);
	await cli.init();
	return { redis: cli, seen: withKey[0].found };
}

// ---------- 修復対象の蓄積 ----------
/** @type {Map<string, { max: number, ids: Set<string> }>} */
const want = new Map();
const add = (key, max, id) => {
	let e = want.get(key);
	if (e == null) want.set(key, e = { max: Math.floor(max), ids: new Set() });
	e.ids.add(id);
};

const isReply = (note, viewerId) =>
	note.replyId !== '' && note.replyUserId !== note.userId && note.replyUserId !== viewerId;

async function main() {
	// ---------- 環境の解決を先に全部表示する ----------
	if (PG_CONTAINER) console.log(`Postgres: docker exec ${PG_CONTAINER} psql -U ${PG.user} -d ${PG.db}`);
	else console.log(`Postgres: ホストの psql で ${config.db.host ?? '127.0.0.1'}:${config.db.port ?? 5432}/${PG.db} へ接続 (dockerのpostgresが見つからない)`);

	const { redis, seen } = await openRedis();
	console.log(`Redis: ${redis.describe()}`);

	// keyPrefix は url のホスト部だが、実物を SCAN して確かめる
	let prefix = opt('--redis-prefix');
	if (prefix == null) {
		const found = seen ?? await redis.scanKeys('*list:localTimeline');
		if (found.length === 1) {
			prefix = found[0].slice(0, found[0].length - 'list:localTimeline'.length);
		} else if (found.length > 1) {
			console.error('\nkeyPrefix を一意に決められません。該当キー:');
			for (const f of found) console.error(`  ${f}`);
			console.error('\n--redis-prefix <接頭辞> で明示してください。');
			process.exit(1);
		} else {
			prefix = config.url ? `${new URL(config.url).host}:` : '';
			console.log(`  list:localTimeline が見つからないため url から推定: '${prefix}'`);
		}
	}
	console.log(`keyPrefix: '${prefix}'`);
	const k = (name) => prefix + name;

	if (flag('--list')) {
		console.log('\n--list 指定のため、ここで終了します (接続確認のみ)。');
		console.log('docker ps:');
		for (const c of CONTAINERS) console.log(`  ${c.name}\t${c.image}`);
		redis.close();
		return;
	}

	const [metaRow] = psql(`SELECT "perLocalUserUserTimelineCacheMax", "perRemoteUserUserTimelineCacheMax",
	                               "perUserHomeTimelineCacheMax", "perUserListTimelineCacheMax",
	                               "enableFanoutTimeline" FROM meta LIMIT 1;`);
	if (metaRow == null) throw new Error('meta テーブルが読めない');
	const meta = {
		localUser: Number(metaRow[0]), remoteUser: Number(metaRow[1]),
		home: Number(metaRow[2]), list: Number(metaRow[3]), fanout: metaRow[4] === 't',
	};
	if (!meta.fanout) {
		console.log('meta.enableFanoutTimeline が false。Redis TL は使われていないので修復不要。');
		redis.close();
		return;
	}
	console.log(`上限: home=${meta.home} userTL(local)=${meta.localUser} userTL(remote)=${meta.remoteUser} list=${meta.list}`);

	// 復旧開始点: 明示指定がなければ list:localTimeline の現在の最新IDから
	let since = parseSince(opt('--since'));
	if (since == null) {
		const [head] = await redis.lrangeMany([k('list:localTimeline')]);
		const newest = (head ?? []).sort().at(-1);
		if (newest == null) throw new Error('list:localTimeline が空。--since で開始時刻を指定してください。');
		since = idToDate(newest);
		console.log(`--since 未指定: list:localTimeline の最新 ${newest} = ${since.toISOString()} から再構築`);
	}
	const until = parseSince(opt('--until')) ?? new Date();
	const loId = dateToId(since), hiId = dateToId(until);
	console.log(`対象範囲: ${since.toISOString()} 〜 ${until.toISOString()}  (id ${loId}… 〜 ${hiId}…)`);

	// ---------- note を走査 ----------
	let cursor = loId.padEnd(16, '0');
	const end = hiId.padEnd(16, 'z');
	const notes = [];
	for (;;) {
		const rows = psql(`
			SELECT id, "userId", ("userHost" IS NULL), visibility,
			       array_to_string("visibleUserIds", ','),
			       (coalesce(array_length("fileIds", 1), 0) > 0),
			       coalesce("replyId", ''), coalesce("replyUserId", ''), ("replyUserHost" IS NULL),
			       coalesce("channelId", ''), "isNoteInHanaMode"
			FROM note WHERE id > '${cursor}' AND id <= '${end}' ORDER BY id ASC LIMIT 5000;`);
		if (rows.length === 0) break;
		for (const r of rows) {
			notes.push({
				id: r[0], userId: r[1], isLocal: r[2] === 't', visibility: r[3],
				visibleUserIds: r[4] ? r[4].split(',') : [], hasFiles: r[5] === 't',
				replyId: r[6], replyUserId: r[7], replyUserLocal: r[8] === 't',
				channelId: r[9], hana: r[10] === 't',
			});
		}
		cursor = rows.at(-1)[0];
		process.stdout.write(`\rnote 取得: ${notes.length} 件   `);
		if (rows.length < 5000) break;
	}
	console.log(`\nnote ${notes.length} 件を対象に fanout を再計算`);
	if (notes.length === 0) { redis.close(); return; }

	// ---------- 関連テーブルを一括取得 ----------
	const authorIds = [...new Set(notes.map(n => n.userId))];
	const channelIds = [...new Set(notes.map(n => n.channelId).filter(x => x !== ''))];

	const followings = new Map();   // authorId -> [{followerId, withReplies}]
	const memberships = new Map();  // authorId -> [{userListId, userListUserId, withReplies}]
	const chFollowers = new Map();  // channelId -> [followerId]

	for (let i = 0; i < authorIds.length; i += 500) {
		const chunk = sqlList(authorIds.slice(i, i + 500));
		for (const r of psql(`SELECT "followeeId", "followerId", "withReplies" FROM following
			WHERE "followeeId" IN (${chunk}) AND "followerHost" IS NULL AND "isFollowerHibernated" = false;`)) {
			if (!followings.has(r[0])) followings.set(r[0], []);
			followings.get(r[0]).push({ followerId: r[1], withReplies: r[2] === 't' });
		}
		for (const r of psql(`SELECT "userId", "userListId", "userListUserId", "withReplies"
			FROM user_list_membership WHERE "userId" IN (${chunk});`)) {
			if (!memberships.has(r[0])) memberships.set(r[0], []);
			memberships.get(r[0]).push({ userListId: r[1], userListUserId: r[2], withReplies: r[3] === 't' });
		}
		process.stdout.write(`\rフォロー関係: ${Math.min(i + 500, authorIds.length)}/${authorIds.length} 作者   `);
	}
	for (let i = 0; i < channelIds.length; i += 500) {
		for (const r of psql(`SELECT "followeeId", "followerId" FROM channel_following
			WHERE "followeeId" IN (${sqlList(channelIds.slice(i, i + 500))});`)) {
			if (!chFollowers.has(r[0])) chFollowers.set(r[0], []);
			chFollowers.get(r[0]).push(r[1]);
		}
	}
	console.log('');

	// ---------- pushToTl の再現 ----------
	for (const note of notes) {
		const userMax = note.isLocal ? meta.localUser : meta.remoteUser;
		const pushLocalTl = !note.hana; // はなモードのノートは LTL に出さない

		if (note.channelId !== '') {
			add(`list:channelTimeline:${note.channelId}`, 1000, note.id);
			add(`list:userTimelineWithChannel:${note.userId}`, userMax, note.id);
			for (const followerId of chFollowers.get(note.channelId) ?? []) {
				add(`list:homeTimeline:${followerId}`, meta.home, note.id);
				if (note.hasFiles) add(`list:homeTimelineWithFiles:${followerId}`, meta.home / 2, note.id);
			}
			continue;
		}

		const follows = followings.get(note.userId) ?? [];
		let lists = memberships.get(note.userId) ?? [];
		if (note.visibility === 'followers') {
			lists = lists.filter(x => x.userListUserId === note.userId || follows.some(f => f.followerId === x.userListUserId));
		}

		for (const f of follows) {
			if (note.visibility === 'specified' && !note.visibleUserIds.includes(f.followerId)) continue;
			if (isReply(note, f.followerId) && !f.withReplies) continue;
			add(`list:homeTimeline:${f.followerId}`, meta.home, note.id);
			if (note.hasFiles) add(`list:homeTimelineWithFiles:${f.followerId}`, meta.home / 2, note.id);
		}

		for (const m of lists) {
			if (note.visibility === 'specified'
				&& note.userId !== m.userListUserId
				&& !note.visibleUserIds.includes(m.userListUserId)) continue;
			if (isReply(note, m.userListUserId) && !m.withReplies) continue;
			add(`list:userListTimeline:${m.userListId}`, meta.list, note.id);
			if (note.hasFiles) add(`list:userListTimelineWithFiles:${m.userListId}`, meta.list / 2, note.id);
		}

		// 自分自身のHTL
		if (note.isLocal && (note.visibility !== 'specified' || !note.visibleUserIds.includes(note.userId))) {
			add(`list:homeTimeline:${note.userId}`, meta.home, note.id);
			if (note.hasFiles) add(`list:homeTimelineWithFiles:${note.userId}`, meta.home / 2, note.id);
		}

		if (isReply(note)) {
			add(`list:userTimelineWithReplies:${note.userId}`, userMax, note.id);
			if (note.visibility === 'public' && note.isLocal && pushLocalTl) {
				add('list:localTimelineWithReplies', 300, note.id);
				if (note.replyUserLocal) add(`list:localTimelineWithReplyTo:${note.replyUserId}`, 30, note.id);
			}
		} else {
			add(`list:userTimeline:${note.userId}`, userMax, note.id);
			if (note.hasFiles) add(`list:userTimelineWithFiles:${note.userId}`, userMax / 2, note.id);
			if (note.visibility === 'public' && note.isLocal && pushLocalTl) {
				add('list:localTimeline', 1000, note.id);
				if (note.hasFiles) add('list:localTimelineWithFiles', 500, note.id);
			}
		}
	}
	if (!flag('--no-antenna')) await collectAntennas(loId, hiId);

	console.log(`対象キー ${want.size} 本`);

	// ---------- Redis と突き合わせて書き戻し ----------
	let touched = 0, inserted = 0, skipped = 0;
	const keys = [...want.keys()];

	for (let i = 0; i < keys.length; i += 200) {
		const chunk = keys.slice(i, i + 200);
		const existings = await redis.lrangeMany(chunk.map(k));

		for (let j = 0; j < chunk.length; j++) {
			const key = chunk[j];
			const { max, ids } = want.get(key);
			const existing = existings[j] ?? [];
			const existingSet = new Set(existing);

			// ID降順・上限件数に整えて入れ直す (ltrim は末尾を切るため物理順を正しておく)
			const merged = [...new Set([...existing, ...ids])].sort().reverse().slice(0, max);
			// 上限を超えるぶんは元々入らないので「欠損」ではない。実際に入る件数だけ数える。
			// 追加するものが無いなら触らない (push のトリムは確率的なので上限超過は正常な状態)
			const entering = merged.filter(id => !existingSet.has(id));
			if (entering.length === 0) { skipped++; continue; }

			touched++;
			inserted += entering.length;
			if (VERBOSE || !APPLY) {
				const capped = [...ids].filter(id => !existingSet.has(id)).length - entering.length;
				console.log(`${key}  既存${existing.length} + 追加${entering.length} -> ${merged.length}件`
					+ (capped > 0 ? ` (上限超過で対象外 ${capped}件)` : ''));
			}

			// DEL と RPUSH を同一トランザクションにして、読み出しに空を見せない
			if (APPLY) await redis.replaceKey(k(key), merged);
		}
		if (!VERBOSE && APPLY) process.stdout.write(`\r書き戻し: ${Math.min(i + 200, keys.length)}/${keys.length} キー   `);
	}

	console.log('');
	console.log(`修復が必要なキー: ${touched} 本 (追加ID延べ ${inserted} 件) / 既に正常: ${skipped} 本`);
	console.log(APPLY ? '--apply 指定のため書き込み済み。' : 'dry-run。実行するには --apply を付けてください。');
	redis.close();
}

// ---------- アンテナ (AntennaService#checkHitAntenna を写す) ----------
const ANTENNA_MAX = 200; // AntennaService#addNoteToAntennas の上限
const b64 = (s) => Buffer.from(s, 'base64').toString('utf8');
const puny = (host) => (domainToASCII(host) || host).toLowerCase();
const LOCAL_HOST = config.url ? puny(new URL(config.url).host) : '';
/** UtilityService#getFullApAccount と同じ形 (小文字) */
const fullAcct = (username, host) => `${username}@${host ? puny(host) : LOCAL_HOST}`.toLowerCase();
const parseAcct = (s) => { const t = s.startsWith('@') ? s.slice(1) : s; const [username, host] = t.split('@', 2); return fullAcct(username, host ?? null); };
const cleanKeywords = (xs) => (Array.isArray(xs) ? xs : []).map(and => (Array.isArray(and) ? and : []).filter(x => x !== '')).filter(and => and.length > 0);

async function collectAntennas(loId, hiId) {
	// 止まっているアンテナ (使われずに isActive=false) も埋める。開いた時点で動き出すので、埋めておいて困ることはない
	const antennas = psql(`SELECT id, "userId", src, coalesce("userListId", ''), array_to_json(users)::text,
		keywords::text, "excludeKeywords"::text, "caseSensitive", "excludeBots", "withReplies", "withFile",
		"localOnly", "excludeNotesInSensitiveChannel", "isActive" FROM antenna;`).map(r => ({
		id: r[0], userId: r[1], src: r[2], userListId: r[3],
		accts: new Set(JSON.parse(r[4] || '[]').map(parseAcct)),
		keywords: cleanKeywords(JSON.parse(r[5] || '[]')), excludeKeywords: cleanKeywords(JSON.parse(r[6] || '[]')),
		caseSensitive: r[7] === 't', excludeBots: r[8] === 't', withReplies: r[9] === 't', withFile: r[10] === 't',
		localOnly: r[11] === 't', excludeSensitiveChannel: r[12] === 't', isActive: r[13] === 't',
	}));
	if (antennas.length === 0) { console.log('アンテナ: なし'); return; }
	console.log(`アンテナ: ${antennas.length} 本 (止まっているもの ${antennas.filter(a => !a.isActive).length} 本も含む)`);

	// 持ち主のフォロー先 (followers 限定の投稿用) と、リストの中身 (src=list 用)
	const ownerIds = [...new Set(antennas.map(a => a.userId))];
	const followeesOf = new Map(ownerIds.map(id => [id, new Set()]));
	for (const r of psql(`SELECT "followerId", "followeeId" FROM following WHERE "followerId" IN (${sqlList(ownerIds)});`)) followeesOf.get(r[0])?.add(r[1]);
	const listIds = [...new Set(antennas.map(a => a.userListId).filter(x => x !== ''))];
	const listMembers = new Map(listIds.map(id => [id, new Set()]));
	if (listIds.length > 0) {
		for (const r of psql(`SELECT "userListId", "userId" FROM user_list_membership WHERE "userListId" IN (${sqlList(listIds)});`)) listMembers.get(r[0])?.add(r[1]);
	}

	const matchText = (a, kws, text, cw) => {
		const t = (text ?? '') + '\n' + (cw ?? '');
		const lower = t.toLowerCase();
		return kws.some(and => and.every(kw => a.caseSensitive ? t.includes(kw) : lower.includes(kw.toLowerCase())));
	};
	const hit = (a, n) => {
		if (a.excludeSensitiveChannel && n.channelSensitive) return false;
		if (a.excludeBots && n.isBot) return false;
		if (a.localOnly && n.host != null) return false;
		if (a.localOnly && n.hana) return false;
		if (!a.withReplies && n.hasReply) return false;
		if (n.visibility === 'specified' && n.userId !== a.userId && !n.visibleUserIds.includes(a.userId)) return false;
		if (n.visibility === 'followers' && n.userId !== a.userId && !followeesOf.get(a.userId)?.has(n.userId)) return false;
		if (a.src === 'list') {
			if (a.userListId === '' || !listMembers.get(a.userListId)?.has(n.userId)) return false;
		} else if (a.src === 'users') {
			if (!a.accts.has(n.acct)) return false;
		} else if (a.src === 'users_blacklist') {
			if (a.accts.has(n.acct)) return false;
		}
		if (a.keywords.length > 0) {
			if (n.text == null && n.cw == null) return false;
			if (!matchText(a, a.keywords, n.text, n.cw)) return false;
		}
		if (a.excludeKeywords.length > 0) {
			if (n.text == null && n.cw == null) return false;
			if (matchText(a, a.excludeKeywords, n.text, n.cw)) return false;
		}
		if (a.withFile && !n.hasFiles) return false;
		return true;
	};

	// 本文は改行やタブを含むので base64 で受け取る。量が多いので 5000 件ずつ見て捨てる
	let cursor = loId.padEnd(16, '0');
	const end = hiId.padEnd(16, 'z');
	let seen = 0;
	const hits = new Map(antennas.map(a => [a.id, 0]));
	for (;;) {
		const rows = psql(`
			SELECT n.id, n."userId", u.username, coalesce(u.host, ''), u."isBot", n.visibility,
			       array_to_string(n."visibleUserIds", ','), (coalesce(array_length(n."fileIds", 1), 0) > 0),
			       (n."replyId" IS NOT NULL), coalesce(c."isSensitive", false), n."isNoteInHanaMode",
			       (n.text IS NULL), replace(encode(convert_to(coalesce(n.text, ''), 'UTF8'), 'base64'), E'\\n', ''),
			       (n.cw IS NULL), replace(encode(convert_to(coalesce(n.cw, ''), 'UTF8'), 'base64'), E'\\n', '')
			FROM note n JOIN "user" u ON u.id = n."userId" LEFT JOIN channel c ON c.id = n."channelId"
			WHERE n.id > '${cursor}' AND n.id <= '${end}' ORDER BY n.id ASC LIMIT 5000;`);
		if (rows.length === 0) break;
		for (const r of rows) {
			const host = r[3] === '' ? null : r[3];
			const n = {
				id: r[0], userId: r[1], host, acct: fullAcct(r[2], host), isBot: r[4] === 't', visibility: r[5],
				visibleUserIds: r[6] ? r[6].split(',') : [], hasFiles: r[7] === 't', hasReply: r[8] === 't',
				channelSensitive: r[9] === 't', hana: r[10] === 't',
				text: r[11] === 't' ? null : b64(r[12] ?? ''), cw: r[13] === 't' ? null : b64(r[14] ?? ''),
			};
			for (const a of antennas) {
				if (!hit(a, n)) continue;
				add(`list:antennaTimeline:${a.id}`, ANTENNA_MAX, n.id);
				hits.set(a.id, hits.get(a.id) + 1);
			}
		}
		seen += rows.length;
		cursor = rows.at(-1)[0];
		process.stdout.write(`\rアンテナ判定: note ${seen} 件   `);
		if (rows.length < 5000) break;
	}
	console.log('');
	if (VERBOSE || !APPLY) {
		for (const a of antennas) console.log(`  アンテナ ${a.id} (${a.src}${a.isActive ? '' : '・停止中'}): 期間内に当たった投稿 ${hits.get(a.id)} 件`);
	}
}

main().catch(err => { console.error(err.message ?? err); process.exitCode = 1; });
