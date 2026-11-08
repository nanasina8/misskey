#!/usr/bin/env node

/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
 * Redis(Dragonfly) から消えた通知を、Postgres に残っている出来事から作り直す。
 *
 * 停電などで Dragonfly が古い保存データで起動し直し、ある期間の通知
 * (notificationTimeline:{userId}) が消えたとき用。TL の作り直しは
 * scripts/hanami-repair-fanout-timelines.mjs を使う。
 *
 * うるさくしないための約束:
 *   - Misskey の API も NotificationService も使わない。Redis に直接書くので、
 *     ストリーム配信・プッシュ通知・メール・Webhook は一切出ない。
 *   - 書き戻したユーザーは「全部既読」にする (latestReadNotification を
 *     その人の通知の一番新しいものに合わせる)。未読バッジも付かない。
 *
 * 作り直す種類 (元の処理と同じ条件で絞る):
 *   reply / mention / renote / quote / note (NoteCreateService)
 *   reaction (ReactionService) / follow / followRequestAccepted (UserFollowingService.insertFollowingDoc)
 *   receiveFollowRequest (保留中のものだけ) / roleAssigned (公開ロール) / achievementEarned / pollEnded
 *   受け取り設定 (notificationRecieveConfig)・ミュート・スレッドのミュート・リノートのミュート・自分自身を除く。
 * 戻せないもの: login / createToken / app / test / exportCompleted / 予約投稿 / チャット招待、
 *   取り消されたリアクション、承認か拒否で消えたフォローリクエスト。
 *
 * すでに同じ通知 (種類・相手・投稿・リアクションが同じ) があれば足さない。何度流しても増えない。
 *
 * 既定は dry-run。実際に書き込むには --apply を付ける。書き込む前に、触るユーザーの通知と
 * 既読位置を _local/runs/notifications-backup-<時刻>.json に保存する (--rollback <file> で戻せる)。
 *
 *   node scripts/hanami-repair-notifications.mjs --list
 *   node scripts/hanami-repair-notifications.mjs --find-gap   (消えた期間を調べる。読むだけ)
 *   node scripts/hanami-repair-notifications.mjs --since '2026-11-01T12:00:00+09:00' --until '2026-11-07T03:00:00+09:00'
 *   node scripts/hanami-repair-notifications.mjs --since ... --until ... --apply
 *   node scripts/hanami-repair-notifications.mjs --rollback _local/runs/notifications-backup-XXXX.json --apply
 *
 * そのほかの指定: --user <username>  (1 人だけ) / --verbose / 接続は TL のスクリプトと同じ
 *   (--pg-container --pg-user --pg-pass --pg-db --redis-container --redis-host --redis-port --redis-pass --redis-prefix)
 *
 * 触らないもの: notificationTimeline:* と latestReadNotification:* 以外のキーすべて。Postgres は読むだけ。
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const redisSrc = config.redis;

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

/** SQL を投げて TSV の二次元配列で返す */
function psql(sql) {
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


// ---------- Redis: docker exec redis-cli (引数はシェルを通さず渡す) ----------
class RedisDocker {
	constructor(container, pass, db) { this.container = container; this.pass = pass; this.db = db; }

	call(...cmd) {
		const args = ['exec', '-i', this.container, 'redis-cli'];
		if (this.pass) args.push('--no-auth-warning', '-a', this.pass);
		if (this.db) args.push('-n', String(this.db));
		args.push(...cmd.map(String));
		const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 1024 });
		if (r.error) throw r.error;
		if (r.status !== 0) throw new Error(`redis-cli 失敗:\n${r.stderr}`);
		const lines = r.stdout.replace(/\n$/, '').split('\n');
		const bad = lines.find(l => /^(\(error\) )?(ERR|WRONGTYPE|NOSCRIPT|NOAUTH|EXECABORT)\b/.test(l));
		if (bad) throw new Error(`redis-cli: ${bad}`);
		return lines;
	}

	async init() { this.call('PING'); }
	async scanKeys(pattern) {
		return this.call('--scan', '--pattern', pattern).filter(l => l.length > 0);
	}
	/** @returns {[string, string][]} [streamId, data] */
	async xrangeAll(key) {
		const lines = this.call('XRANGE', key, '-', '+');
		if (lines.length === 1 && lines[0] === '') return [];
		const out = [];
		// 生出力は「ID / フィールド名 / 値」が 1 行ずつ並ぶ (Misskey はフィールドを data 1 つだけ書く)
		for (let i = 0; i + 2 < lines.length; i += 3) {
			if (lines[i + 1] !== 'data') throw new Error(`${key} に data 以外のフィールドがある: ${lines[i + 1]}`);
			out.push([lines[i], lines[i + 2]]);
		}
		return out;
	}
	async get(key) {
		const [v] = this.call('GET', key);
		return v === '' ? null : v;
	}
	async eval(script, keys, args) {
		return this.call('EVAL', script, keys.length, ...keys, ...args).map(Number);
	}
	close() {}
	describe() { return `docker exec ${this.container} redis-cli`; }
}

// RedisTcp に通知用の操作を足す
RedisTcp.prototype.xrangeAll = async function (key) {
	const res = await this.send('XRANGE', key, '-', '+');
	return (res ?? []).map(([sid, fields]) => {
		const i = fields.indexOf('data');
		if (i < 0 || fields.length !== 2) throw new Error(`${key} に data 以外のフィールドがある`);
		return [sid, fields[i + 1]];
	});
};
RedisTcp.prototype.get = function (key) { return this.send('GET', key); };
RedisTcp.prototype.eval = async function (script, keys, args) {
	const res = await this.send('EVAL', script, keys.length, ...keys, ...args);
	return res.map(Number);
};

async function openRedis() {
	const forced = opt('--redis-container');
	const pass = opt('--redis-pass', redisSrc.pass ?? null);
	const db = redisSrc.db ?? null;

	if (!forced) {
		const host = opt('--redis-host', redisSrc.host ?? '127.0.0.1');
		const port = Number(opt('--redis-port', redisSrc.port ?? 6379));
		const tcp = new RedisTcp(host, port, pass, db);
		try { await tcp.init(); return tcp; } catch (e) {
			tcp.close();
			console.log(`Redis: TCP ${host}:${port} へ繋がらない (${e.message})。docker exec 経由を試します`);
		}
	}
	const name = forced ?? requireOne('Redis', pickContainers(/dragonfly|redis|valkey/i), '--redis-container');
	const cli = new RedisDocker(name, pass, db);
	await cli.init();
	return cli;
}

// ---------- Stream を書き換える Lua (1 ユーザー分を原子的に) ----------
// KEYS[1]=notificationTimeline:{id}  KEYS[2]=latestReadNotification:{id}
// ARGV[1]=merge|replace  ARGV[2]=上限件数  ARGV[3]=既読位置 (newest=一番新しい通知 / keep=触らない / ''=消す / それ以外=その ID)
// ARGV[4..]=streamId, data の組
// merge は今ある通知に足す。replace は丸ごと入れ替える (--rollback 用)。
// XADD は今の先頭より古い ID を受け付けないので、全件を ID 順に並べて入れ直す。
// Lua の中で行うので、その間に届いた通知も落ちない。
const STREAM_SCRIPT = `
local function lt(a, b)
	local am, as = string.match(a, '^(%d+)%-(%d+)$')
	local bm, bs = string.match(b, '^(%d+)%-(%d+)$')
	if #am ~= #bm then return #am < #bm end
	if am ~= bm then return am < bm end
	if #as ~= #bs then return #as < #bs end
	return as < bs
end
local entries = {}
local seen = {}
if ARGV[1] == 'merge' then
	local existing = redis.call('XRANGE', KEYS[1], '-', '+')
	for _, e in ipairs(existing) do
		local data = nil
		for i = 1, #e[2], 2 do
			if e[2][i] == 'data' then data = e[2][i + 1] end
		end
		if data then
			entries[#entries + 1] = { e[1], data }
			seen[e[1]] = true
		end
	end
end
local added = 0
for i = 4, #ARGV, 2 do
	if not seen[ARGV[i]] then
		entries[#entries + 1] = { ARGV[i], ARGV[i + 1] }
		seen[ARGV[i]] = true
		added = added + 1
	end
end
table.sort(entries, function(x, y) return lt(x[1], y[1]) end)
local maxlen = tonumber(ARGV[2])
local first = 1
if maxlen > 0 and #entries > maxlen then first = #entries - maxlen + 1 end
redis.call('DEL', KEYS[1])
for i = first, #entries do
	redis.call('XADD', KEYS[1], entries[i][1], 'data', entries[i][2])
end
local readTo = ARGV[3]
if readTo == 'newest' then
	if #entries >= first then redis.call('SET', KEYS[2], entries[#entries][1]) end
elseif readTo == '' then
	redis.call('DEL', KEYS[2])
elseif readTo ~= 'keep' then
	redis.call('SET', KEYS[2], readTo)
end
return { added, #entries - first + 1 }
`;

// ---------- 小物 ----------
const jst = (ms) => new Date(ms + 9 * 3600e3).toISOString().replace('T', ' ').slice(0, 16) + ' JST';
const idMs = (id) => idToDate(id).getTime();
/** NotificationService.toXListId と同じ (aidx: 時刻ms - 後ろ8文字の36進数) */
const toStreamId = (id) => `${idMs(id)}-${BigInt.asUintN(64, BigInt(parseInt(id.slice(8, 16), 36))).toString()}`;
const b64 = (s) => (s === '' ? '' : Buffer.from(s, 'base64').toString('utf8'));

// 作り直した通知の ID: aidx (時刻 8 文字 + 個体 4 文字 + 連番 4 文字)。個体は 'rstr' で固定
let idCounter = 0;
function genId(ms) {
	idCounter++;
	return Math.max(0, ms - TIME2000).toString(36).padStart(8, '0').slice(-8)
		+ 'rstr' + idCounter.toString(36).padStart(4, '0').slice(-4);
}

/** 同じ通知かを見る鍵。種類・相手・投稿・リアクションなどが同じなら同じとみなす */
const signature = (n) => [n.type, n.notifierId ?? '', n.noteId ?? '', n.targetNoteId ?? '', n.reaction ?? '', n.roleId ?? '', n.achievement ?? ''].join('|');

function perUserMax() {
	const file = path.join(ROOT, '.config/default.yml');
	if (!fs.existsSync(file)) return 500;
	const m = /^perUserNotificationsMaxCount:\s*(\d+)/m.exec(fs.readFileSync(file, 'utf8'));
	return m ? Number(m[1]) : 500;
}

/** id の範囲で 5000 件ずつ読む。sql は ${cursor} と ${hi} を受け取る関数 */
function scanById(label, sql, lo, hi) {
	const rows = [];
	let cursor = lo;
	for (;;) {
		const chunk = psql(sql(cursor, hi));
		if (chunk.length === 0) break;
		rows.push(...chunk);
		cursor = chunk.at(-1)[0];
		process.stdout.write(`\r${label}: ${rows.length} 件   `);
		if (chunk.length < 5000) break;
	}
	process.stdout.write(`\r${label}: ${rows.length} 件   \n`);
	return rows;
}

// ---------- 消えた期間を調べる (読むだけ) ----------
/** 新しい順の時刻の列で、一番大きい間を返す */
function biggestGap(times) {
	let best = null;
	for (let i = 0; i + 1 < times.length; i++) {
		const gap = times[i] - times[i + 1];
		if (!best || gap > best.gap) best = { gap, newer: times[i], older: times[i + 1] };
	}
	return best;
}

async function findGap(redis, prefix) {
	const call = (...args) => (redis instanceof RedisDocker ? Promise.resolve(redis.call(...args)) : redis.send(...args));
	const hours = (ms) => `${(ms / 3600e3).toFixed(1)} 時間`;

	console.log('\n== Dragonfly の保存設定');
	for (const key of ['dir', 'dbfilename', 'snapshot_cron']) {
		try {
			const r = await call('CONFIG', 'GET', key);
			console.log(`  ${key}: ${JSON.stringify(r[1] ?? null)}`);
		} catch (e) { console.log(`  ${key}: 取得できず (${e.message})`); }
	}
	for (const section of ['persistence', 'server']) {
		try {
			const r = await call('INFO', section);
			const lines = Array.isArray(r) ? r : String(r).split('\n');
			for (const line of lines) if (/save|load|uptime_in_seconds|_version/.test(line)) console.log(`  ${line.trim()}`);
		} catch { /* INFO が無い実装は飛ばす */ }
	}

	console.log('\n== TL (list:localTimeline)');
	const tl = await call('LRANGE', `${prefix}list:localTimeline`, 0, -1);
	const tlIds = (tl ?? []).filter(id => /^[0-9a-z]{16}$/.test(id));
	if (tlIds.length === 0) console.log('  空');
	else {
		const times = tlIds.map(idMs).sort((a, b) => b - a);
		const g = biggestGap(times);
		console.log(`  ${tlIds.length} 件 / ${jst(times.at(-1))} 〜 ${jst(times[0])}`);
		if (g) console.log(`  一番大きい抜け: ${jst(g.older)} 〜 ${jst(g.newer)} (${hours(g.gap)})`);
	}

	console.log('\n== 通知');
	const keys = await redis.scanKeys(`${prefix}notificationTimeline:*`);
	const starts = new Map();
	const rows = [];
	for (const key of keys) {
		const times = (await redis.xrangeAll(key)).map(([sid]) => Number(sid.split('-')[0])).sort((a, b) => b - a);
		const g = biggestGap(times);
		if (!g) continue;
		rows.push({ userId: key.slice(key.indexOf('notificationTimeline:') + 'notificationTimeline:'.length), count: times.length, ...g });
		const bucket = Math.floor(g.older / 600e3) * 600e3;
		starts.set(bucket, (starts.get(bucket) ?? 0) + 1);
	}
	console.log(`  通知のあるユーザー: ${keys.length} 人`);
	rows.sort((a, b) => b.gap - a.gap);
	for (const r of rows.slice(0, 15)) console.log(`  ${r.userId}: ${r.count} 件 / 一番大きい抜け ${jst(r.older)} 〜 ${jst(r.newer)} (${hours(r.gap)})`);
	console.log('\n  抜けの始まり (10 分単位) がそろっている人数 (多い順):');
	for (const [bucket, n] of [...starts].sort((a, b) => b[1] - a[1]).slice(0, 5)) console.log(`    ${jst(bucket)} から: ${n} 人`);
	console.log('\n  多くの人で始まりがそろっていれば、そこが前回保存した時刻 (= --since)。');
	console.log('  終わり側 (再起動後の最初の通知) の少し前が停電の時刻 (= --until)。');
}

// ---------- 巻き戻し ----------
async function rollback(redis, file) {
	const backup = JSON.parse(fs.readFileSync(file, 'utf8'));
	console.log(`バックアップ ${file} (${backup.createdAt}) / ${Object.keys(backup.users).length} 人 / keyPrefix '${backup.prefix}'`);
	for (const [userId, u] of Object.entries(backup.users)) {
		console.log(`  ${u.username ?? userId}: 通知 ${u.entries.length} 件・既読位置 ${u.latestRead ?? '(なし)'} に戻す`);
		if (!APPLY) continue;
		const args = ['replace', '0', u.latestRead ?? ''];
		for (const [sid, data] of u.entries) args.push(sid, data);
		await redis.eval(STREAM_SCRIPT, [`${backup.prefix}notificationTimeline:${userId}`, `${backup.prefix}latestReadNotification:${userId}`], args);
	}
	console.log(APPLY ? '巻き戻しました。' : 'dry-run。実行するには --apply を付けてください。');
}

async function main() {
	if (PG_CONTAINER) console.log(`Postgres: docker exec ${PG_CONTAINER} psql -U ${PG.user} -d ${PG.db}`);
	else console.log(`Postgres: ホストの psql で ${config.db.host ?? '127.0.0.1'}:${config.db.port ?? 5432}/${PG.db} へ接続`);

	const redis = await openRedis();
	console.log(`Redis: ${redis.describe()}`);

	// keyPrefix: 実物の notificationTimeline:* から決める
	let prefix = opt('--redis-prefix');
	if (prefix == null) {
		const found = await redis.scanKeys('*notificationTimeline:*');
		const prefixes = [...new Set(found.map(k => k.slice(0, k.indexOf('notificationTimeline:'))))];
		if (prefixes.length === 1) prefix = prefixes[0];
		else if (prefixes.length > 1) {
			console.error(`\nkeyPrefix を一意に決められません: ${prefixes.map(p => `'${p}'`).join(', ')}\n--redis-prefix で明示してください。`);
			process.exit(1);
		} else {
			prefix = `${redisSrc.prefix ?? (config.url ? new URL(config.url).host : '')}:`;
			console.log(`  notificationTimeline が 1 つも無いため設定から推定: '${prefix}'`);
		}
	}
	console.log(`keyPrefix: '${prefix}'`);
	const streamKey = (userId) => `${prefix}notificationTimeline:${userId}`;
	const readKey = (userId) => `${prefix}latestReadNotification:${userId}`;

	if (flag('--list')) {
		console.log('\n--list 指定のため、ここで終了します (接続確認のみ)。');
		redis.close();
		return;
	}

	if (flag('--find-gap')) { await findGap(redis, prefix); redis.close(); return; }

	const rollbackFile = opt('--rollback');
	if (rollbackFile) { await rollback(redis, rollbackFile); redis.close(); return; }

	const since = parseSince(opt('--since'));
	const until = parseSince(opt('--until')) ?? new Date();
	if (since == null) throw new Error('--since が必要です (消えた期間の始まり。_local/redis-rollback-check-20261108.mjs で調べる)');
	if (since >= until) throw new Error('--since が --until より後になっています');
	const sinceMs = since.getTime(), untilMs = until.getTime();
	const lo = dateToId(since).padEnd(16, '0'), hi = dateToId(until).padEnd(16, 'z');
	console.log(`対象期間: ${jst(sinceMs)} 〜 ${jst(untilMs)}`);

	// ID が aidx であることを確かめる (違うと時刻の読み方が狂う)
	const sample = psql(`SELECT id FROM note ORDER BY id DESC LIMIT 20;`).map(r => r[0]);
	if (sample.some(id => !/^[0-9a-z]{16}$/.test(id))) throw new Error(`note の ID が aidx ではない (${sample[0]})。このスクリプトは aidx 専用です`);

	const maxLen = perUserMax();

	// ---------- ローカルユーザーと設定 ----------
	const users = new Map(); // id -> { username, config }
	for (const [id, username, cfg] of psql(`SELECT u.id, u.username, coalesce(p."notificationRecieveConfig"::text, '{}')
		FROM "user" u JOIN user_profile p ON p."userId" = u.id WHERE u.host IS NULL;`)) {
		users.set(id, { username, config: JSON.parse(cfg) });
	}
	const onlyUser = opt('--user');
	let onlyUserId = null;
	if (onlyUser) {
		onlyUserId = [...users].find(([, u]) => u.username === onlyUser)?.[0];
		if (!onlyUserId) throw new Error(`ローカルユーザー ${onlyUser} が見つからない`);
	}
	console.log(`ローカルユーザー ${users.size} 人${onlyUser ? ` (対象は ${onlyUser} だけ)` : ''} / 1 人あたりの上限 ${maxLen} 件`);

	const pairSet = (rows) => new Set(rows.map(r => `${r[0]}>${r[1]}`));
	const mutings = pairSet(psql(`SELECT m."muterId", m."muteeId" FROM muting m JOIN "user" u ON u.id = m."muterId"
		WHERE u.host IS NULL AND (m."expiresAt" IS NULL OR m."expiresAt" > now());`));
	const renoteMutings = pairSet(psql(`SELECT m."muterId", m."muteeId" FROM renote_muting m JOIN "user" u ON u.id = m."muterId" WHERE u.host IS NULL;`));
	const threadMutings = pairSet(psql(`SELECT t."userId", t."threadId" FROM note_thread_muting t JOIN "user" u ON u.id = t."userId" WHERE u.host IS NULL;`));
	const followRows = psql(`SELECT "followerId", "followeeId", coalesce(notify, '') FROM following WHERE "followerHost" IS NULL OR "followeeHost" IS NULL;`);
	const follows = pairSet(followRows); // follower>followee
	const noteSubscribers = new Map(); // followeeId -> [followerId] (投稿の通知をオンにしている人)
	for (const [follower, followee, notify] of followRows) {
		if (notify !== 'normal' || !users.has(follower)) continue;
		if (!noteSubscribers.has(followee)) noteSubscribers.set(followee, []);
		noteSubscribers.get(followee).push(follower);
	}
	const listIds = [...new Set([...users.values()].flatMap(u => Object.values(u.config).filter(c => c?.type === 'list').map(c => c.userListId)))];
	const listMembers = new Map();
	if (listIds.length > 0) {
		for (const [listId, userId] of psql(`SELECT "userListId", "userId" FROM user_list_membership WHERE "userListId" IN (${sqlList(listIds)});`)) {
			if (!listMembers.has(listId)) listMembers.set(listId, new Set());
			listMembers.get(listId).add(userId);
		}
	}

	/** NotificationService.#createNotificationInternal の判定と同じ */
	function allowed(notifieeId, type, notifierId) {
		const u = users.get(notifieeId);
		if (u == null) return false; // ローカルユーザーだけ
		const cfg = u.config[type];
		if (cfg?.type === 'never') return false;
		if (notifierId) {
			if (notifieeId === notifierId) return false;
			if (mutings.has(`${notifieeId}>${notifierId}`)) return false;
			const isFollowing = () => follows.has(`${notifieeId}>${notifierId}`);
			const isFollower = () => follows.has(`${notifierId}>${notifieeId}`);
			if (cfg?.type === 'following' && !isFollowing()) return false;
			if (cfg?.type === 'follower' && !isFollower()) return false;
			if (cfg?.type === 'mutualFollow' && !(isFollowing() && isFollower())) return false;
			if (cfg?.type === 'followingOrFollower' && !(isFollowing() || isFollower())) return false;
			if (cfg?.type === 'list' && !(listMembers.get(cfg.userListId)?.has(notifierId))) return false;
		}
		return true;
	}

	/** @type {Map<string, { ms: number, n: object }[]>} */
	const candidates = new Map();
	const skippedByRule = {};
	function offer(notifieeId, ms, type, notifierId, data) {
		if (onlyUserId && notifieeId !== onlyUserId) return;
		if (!allowed(notifieeId, type, notifierId)) {
			if (users.has(notifieeId)) skippedByRule[type] = (skippedByRule[type] ?? 0) + 1;
			return;
		}
		if (!candidates.has(notifieeId)) candidates.set(notifieeId, []);
		candidates.get(notifieeId).push({ ms, type, notifierId, data });
	}

	// ---------- 投稿: reply / mention / renote / quote / note ----------
	const notes = scanById('投稿', (c, h) => `
		SELECT id, "userId", visibility, array_to_string("visibleUserIds", ','), array_to_string(mentions, ','),
		       coalesce("replyId", ''), coalesce("replyUserId", ''), ("replyUserHost" IS NULL),
		       coalesce("renoteId", ''), coalesce("renoteUserId", ''), ("renoteUserHost" IS NULL),
		       (text IS NOT NULL OR cw IS NOT NULL OR "replyId" IS NOT NULL OR "hasPoll" OR coalesce(cardinality("fileIds"), 0) > 0),
		       coalesce("threadId", '')
		FROM note WHERE id > '${c}' AND id <= '${h}' ORDER BY id ASC LIMIT 5000;`, lo, hi);
	for (const r of notes) {
		const [id, userId, visibility, visibleCsv, mentionsCsv, replyId, replyUserId, replyUserLocal, renoteId, renoteUserId, renoteUserLocal, quoteLike, threadId] = r;
		const ms = idMs(id);
		if (ms < sinceMs || ms > untilMs) continue;
		const visible = visibleCsv ? new Set(visibleCsv.split(',')) : new Set();
		const isRenote = renoteId !== '';
		const isQuote = isRenote && quoteLike === 't';

		// NotificationManager: メンション → 返信 → リノートの順に積み、後のもの (メンション以外) で上書き
		const queue = new Map();
		const push = (target, reason) => {
			if (target === userId) return;
			const exist = queue.get(target);
			if (exist) { if (reason !== 'mention') queue.set(target, reason); } else queue.set(target, reason);
		};
		for (const m of mentionsCsv ? mentionsCsv.split(',') : []) {
			if (!users.has(m)) continue;
			if (threadMutings.has(`${m}>${threadId || id}`)) continue;
			push(m, 'mention');
		}
		if (replyId !== '' && replyUserLocal === 't' && !threadMutings.has(`${replyUserId}>${threadId || replyId}`)) push(replyUserId, 'reply');
		if (isRenote && renoteUserLocal === 't') push(renoteUserId, isQuote ? 'quote' : 'renote');
		for (const [target, reason] of queue) {
			if (visibility === 'specified' && !visible.has(target)) continue;
			offer(target, ms, reason, userId, reason === 'renote' ? { noteId: id, targetNoteId: renoteId } : { noteId: id });
		}

		// 投稿の通知 (通知をオンにしたユーザーの投稿)
		if (replyId === '' && visibility !== 'specified') {
			for (const follower of noteSubscribers.get(userId) ?? []) {
				if (isRenote && !isQuote && renoteMutings.has(`${follower}>${userId}`)) continue;
				offer(follower, ms, 'note', userId, { noteId: id });
			}
		}
	}

	// ---------- リアクション ----------
	const reactions = scanById('リアクション', (c, h) => `
		SELECT r.id, r."userId", r."noteId", r.reaction, n."userId"
		FROM note_reaction r JOIN note n ON n.id = r."noteId"
		WHERE r.id > '${c}' AND r.id <= '${h}' AND n."userHost" IS NULL ORDER BY r.id ASC LIMIT 5000;`, lo, hi);
	for (const [id, reactor, noteId, reaction, owner] of reactions) {
		const ms = idMs(id);
		if (ms < sinceMs || ms > untilMs) continue;
		offer(owner, ms, 'reaction', reactor, { noteId, reaction });
	}

	// ---------- フォロー (follow と、フォローした側への followRequestAccepted) ----------
	const followings = scanById('フォロー', (c, h) => `
		SELECT f.id, f."followerId", f."followeeId", (f."followerHost" IS NULL), (f."followeeHost" IS NULL),
		       (p."followedMessage" IS NULL), coalesce(replace(encode(convert_to(p."followedMessage", 'UTF8'), 'base64'), E'\\n', ''), '')
		FROM following f LEFT JOIN user_profile p ON p."userId" = f."followeeId"
		WHERE f.id > '${c}' AND f.id <= '${h}' AND (f."followerHost" IS NULL OR f."followeeHost" IS NULL) ORDER BY f.id ASC LIMIT 5000;`, lo, hi);
	for (const [id, follower, followee, followerLocal, followeeLocal, msgNull, msg64] of followings) {
		const ms = idMs(id);
		if (ms < sinceMs || ms > untilMs) continue;
		if (followerLocal === 't') offer(follower, ms, 'followRequestAccepted', followee, { message: msgNull === 't' ? null : b64(msg64) });
		if (followeeLocal === 't') offer(followee, ms, 'follow', follower, {});
	}

	// ---------- 保留中のフォローリクエスト ----------
	const requests = scanById('フォローリクエスト', (c, h) => `
		SELECT id, "followerId", "followeeId" FROM follow_request
		WHERE id > '${c}' AND id <= '${h}' AND "followeeHost" IS NULL ORDER BY id ASC LIMIT 5000;`, lo, hi);
	for (const [id, follower, followee] of requests) {
		const ms = idMs(id);
		if (ms < sinceMs || ms > untilMs) continue;
		offer(followee, ms, 'receiveFollowRequest', follower, {});
	}

	// ---------- 公開ロールの付与 ----------
	const roles = scanById('ロールの付与', (c, h) => `
		SELECT a.id, a."userId", a."roleId" FROM role_assignment a JOIN role r ON r.id = a."roleId"
		WHERE a.id > '${c}' AND a.id <= '${h}' AND r."isPublic" ORDER BY a.id ASC LIMIT 5000;`, lo, hi);
	for (const [id, userId, roleId] of roles) {
		const ms = idMs(id);
		if (ms < sinceMs || ms > untilMs) continue;
		offer(userId, ms, 'roleAssigned', null, { roleId });
	}

	// ---------- 実績 ----------
	const achievements = psql(`
		SELECT p."userId", a->>'name', (a->>'unlockedAt')::bigint
		FROM user_profile p JOIN "user" u ON u.id = p."userId", jsonb_array_elements(coalesce(p.achievements, '[]'::jsonb)) a
		WHERE u.host IS NULL AND (a->>'unlockedAt')::bigint BETWEEN ${sinceMs} AND ${untilMs};`);
	console.log(`実績: ${achievements.length} 件`);
	for (const [userId, name, unlockedAt] of achievements) offer(userId, Number(unlockedAt), 'achievementEarned', null, { achievement: name });

	// ---------- 投票の終了 ----------
	const polls = psql(`
		SELECT p."noteId", n."userId", (n."userHost" IS NULL), (extract(epoch FROM p."expiresAt") * 1000)::bigint
		FROM poll p JOIN note n ON n.id = p."noteId"
		WHERE p."expiresAt" > '${since.toISOString()}'::timestamptz AND p."expiresAt" <= least('${until.toISOString()}'::timestamptz, now());`);
	console.log(`終わった投票: ${polls.length} 件`);
	if (polls.length > 0) {
		const voters = new Map();
		for (const [noteId, userId] of psql(`SELECT DISTINCT v."noteId", v."userId" FROM poll_vote v JOIN "user" u ON u.id = v."userId"
			WHERE u.host IS NULL AND v."noteId" IN (${sqlList(polls.map(p => p[0]))});`)) {
			if (!voters.has(noteId)) voters.set(noteId, new Set());
			voters.get(noteId).add(userId);
		}
		for (const [noteId, owner, ownerLocal, expiresMs] of polls) {
			const targets = new Set(voters.get(noteId) ?? []);
			if (ownerLocal === 't') targets.add(owner);
			for (const t of targets) offer(t, Number(expiresMs), 'pollEnded', null, { noteId });
		}
	}

	// ---------- 今ある通知と突き合わせる ----------
	console.log(`\n通知を作る候補: ${[...candidates.values()].reduce((a, l) => a + l.length, 0)} 件 / ${candidates.size} 人`);
	const plan = []; // { userId, existing, latestRead, add: [[sid, json, n]] }
	const totalByType = {};
	for (const [userId, list] of candidates) {
		const existing = await redis.xrangeAll(streamKey(userId));
		const latestRead = await redis.get(readKey(userId));
		const have = new Set();
		const usedSids = new Set(existing.map(e => e[0]));
		for (const [, data] of existing) {
			try { have.add(signature(JSON.parse(data))); } catch { /* 壊れた行は無視 */ }
		}
		const add = [];
		list.sort((a, b) => a.ms - b.ms);
		for (const c of list) {
			const n = { id: '', createdAt: new Date(c.ms).toISOString(), type: c.type, ...(c.notifierId ? { notifierId: c.notifierId } : {}), ...c.data };
			const sig = signature(n);
			if (have.has(sig)) continue;
			have.add(sig);
			let sid;
			do { n.id = genId(c.ms); sid = toStreamId(n.id); } while (usedSids.has(sid));
			usedSids.add(sid);
			add.push([sid, JSON.stringify(n), n]);
			totalByType[n.type] = (totalByType[n.type] ?? 0) + 1;
		}
		if (add.length > 0) plan.push({ userId, existing, latestRead, add });
	}

	// ---------- 結果の表示 ----------
	plan.sort((a, b) => b.add.length - a.add.length);
	for (const p of plan) {
		const u = users.get(p.userId);
		const byType = {};
		for (const [, , n] of p.add) byType[n.type] = (byType[n.type] ?? 0) + 1;
		const over = Math.max(0, p.existing.length + p.add.length - maxLen);
		console.log(`  @${u.username}: 今 ${p.existing.length} 件 + 戻す ${p.add.length} 件 (${Object.entries(byType).map(([t, c]) => `${t} ${c}`).join(', ')})`
			+ (over > 0 ? ` / 上限超えで古い ${over} 件は捨てる` : ''));
		if (VERBOSE) for (const [, , n] of p.add) console.log(`      ${jst(Date.parse(n.createdAt))} ${n.type} ${n.notifierId ?? ''} ${n.noteId ?? n.roleId ?? n.achievement ?? ''} ${n.reaction ?? ''}`);
	}
	const total = plan.reduce((a, p) => a + p.add.length, 0);
	console.log(`\n戻す通知: ${total} 件 / ${plan.length} 人`);
	console.log(`  種類別: ${Object.entries(totalByType).map(([t, c]) => `${t} ${c}`).join(', ') || '(なし)'}`);
	if (Object.keys(skippedByRule).length > 0) console.log(`  受け取り設定・ミュートで除いたもの: ${Object.entries(skippedByRule).map(([t, c]) => `${t} ${c}`).join(', ')}`);
	console.log('  書き戻したユーザーは全員「全部既読」になります (通知音・プッシュ・未読バッジは出ません)');

	if (!APPLY || total === 0) {
		console.log(total === 0 ? '戻すものはありません。' : '\ndry-run。実行するには --apply を付けてください。');
		redis.close();
		return;
	}

	// ---------- バックアップしてから書き込む ----------
	const stamp = new Date(Date.now() + 9 * 3600e3).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
	const backupDir = path.join(ROOT, '_local/runs');
	fs.mkdirSync(backupDir, { recursive: true });
	const backupFile = path.join(backupDir, `notifications-backup-${stamp}.json`);
	fs.writeFileSync(backupFile, JSON.stringify({
		createdAt: new Date().toISOString(), prefix, since: since.toISOString(), until: until.toISOString(),
		users: Object.fromEntries(plan.map(p => [p.userId, { username: users.get(p.userId).username, latestRead: p.latestRead, entries: p.existing }])),
	}));
	console.log(`\nバックアップ: ${backupFile}`);

	let done = 0;
	for (const p of plan) {
		const args = ['merge', String(maxLen), 'newest'];
		for (const [sid, json] of p.add) args.push(sid, json);
		const [added, size] = await redis.eval(STREAM_SCRIPT, [streamKey(p.userId), readKey(p.userId)], args);
		done += added;
		if (VERBOSE) console.log(`  @${users.get(p.userId).username}: ${added} 件足して ${size} 件・全部既読`);
	}
	console.log(`書き込み済み: ${done} 件 / ${plan.length} 人。戻すときは --rollback ${path.relative(ROOT, backupFile)} --apply`);
	redis.close();
}

main().catch(err => { console.error(err.message ?? err); process.exitCode = 1; });
