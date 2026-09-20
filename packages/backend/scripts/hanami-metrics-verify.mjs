/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
// Destructive fixture operations are deliberately restricted to the explicitly
// approved empty test database and this one dedicated schema. Never accepts a URL.
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import yaml from 'js-yaml';
import { DataSource } from 'typeorm';
import { HanamiMetricsDaily1789948800000 } from '../migration/1789948800000-hanamiMetricsDaily.js';
import { HanamiMetricsInsights1789948800001 } from '../migration/1789948800001-hanamiMetricsInsights.js';
import { buildMetricsQuery, summarizeMetrics } from './hanami-foryou-review.mjs';

const scratch = '/tmp/hanami-metrics-verification';
const schema = 'hm_metrics_gate';
const cfg = yaml.load(readFileSync('/workspace/.config/default.yml', 'utf8'));
assert(['127.0.0.1', 'localhost', '::1'].includes(cfg.db.host), 'Refuse nonlocal host');
const connection = { host: cfg.db.host, port: cfg.db.port, database: 'hanami_contract_test', user: cfg.db.user, password: cfg.db.pass, options: `-c search_path=${schema},public -c statement_timeout=30000` };
const client = new pg.Client(connection);
await client.connect();
assert.equal((await client.query('SELECT current_database() AS db')).rows[0].db, 'hanami_contract_test');
const q = { query: async (sql, values) => (await client.query(sql, values)).rows };
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const shift = n => new Date(Date.parse(today + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const range = { from: shift(-14), to: shift(-1) };
let serial = 0;
const id = (at) => (Date.parse(at) - 946684800000).toString(36).padStart(8, '0') + 'hmtt' + (++serial).toString(36).padStart(4, '0');
let db;
try {
	if (process.argv.includes('--insights-migrate')) {
		const applied = await q.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='hanami_metrics_state' AND column_name='insightsStartedAt'`, [schema]);
		if (applied.length === 0) {
			await q.query('BEGIN');
			try {
				await new HanamiMetricsInsights1789948800001().up(q);
				await q.query('COMMIT');
			} catch (error) {
				await q.query('ROLLBACK');
				throw error;
			}
			console.log('PASS actual insights/collector migration');
		} else {
			console.log('Existing insights/collector migration reused');
		}
	}
	if (process.argv.includes('--setup')) {
		const exists = await q.query('SELECT 1 FROM information_schema.schemata WHERE schema_name=$1', [schema]);
		assert.equal(exists.length, 0, 'Dedicated schema exists; inspect it, do not overwrite unknown work');
		await q.query(`CREATE SCHEMA ${schema}`);
		await q.query(`CREATE TABLE "user" (id varchar(32) PRIMARY KEY, host varchar(128))`);
		await q.query(`CREATE TABLE note (id varchar(32) PRIMARY KEY, "userId" varchar(32) REFERENCES "user"(id) ON DELETE CASCADE, "fileIds" varchar[] NOT NULL DEFAULT '{}', text text, visibility varchar(32) DEFAULT 'public')`);
		await q.query(`CREATE TABLE user_profile ("userId" varchar(32) PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,"hanamiRecommendationAxes" jsonb DEFAULT '{}')`);
		await q.query(`CREATE TABLE hanami_recommendation_event(id varchar(32) PRIMARY KEY,"userId" varchar(32) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,"noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE,"eventType" varchar(32),source varchar(64),"feedKind" varchar(32),"feedEpochId" varchar(32),"feedEntryId" varchar(512),"occurredAt" timestamptz,"createdAt" timestamptz NOT NULL)`);
		await q.query(`CREATE TABLE hanami_user_feed_entry ("userId" varchar(32),"epochId" varchar(32),sequence bigint,"noteId" varchar(32),"reasonMetadata" jsonb)`);
		await q.query(`CREATE TABLE hanami_user_feed_refresh ("userId" varchar(32),"epochId" varchar(32),"refreshTokenDigest" bytea,"createdAt" timestamptz)`);
		await q.query(`CREATE TABLE hanami_user_feed_batch (id varchar(32) PRIMARY KEY,"userId" varchar(32),status varchar(32),attempts integer DEFAULT 3,"createdAt" timestamptz,"startedAt" timestamptz,"finishedAt" timestamptz)`);
		await q.query(`CREATE TABLE hanami_common_generation(id varchar(32) PRIMARY KEY,status varchar(32),"startedAt" timestamptz,"finishedAt" timestamptz)`);
		await q.query(`CREATE TABLE hanami_foryou_model_run(id varchar(32) PRIMARY KEY,kind varchar(32),status varchar(32),params jsonb DEFAULT '{}',"startedAt" timestamptz,"finishedAt" timestamptz)`);
		await q.query(`CREATE TABLE hanami_note_judgement("noteId" varchar(32) PRIMARY KEY REFERENCES note(id) ON DELETE CASCADE,"promptVersion" integer,"ephemeralScore" real,interest real,"contentType" smallint,model varchar(128),"judgedAt" timestamptz)`);
		for (let u = 1; u <= 7; u++) {
			await q.query(`INSERT INTO "user" VALUES($1,NULL)`, [`fixture-u${u}`]);
			await q.query(`INSERT INTO user_profile("userId") VALUES($1)`, [`fixture-u${u}`]);
			if (u <= 6) await q.query(`INSERT INTO hanami_user_feed_batch VALUES($1,$2,'failed',3,$3,$3,$3::timestamptz+interval '1 second')`, [`fixture-b${u}`, `fixture-u${u}`, `${range.to}T12:00:00+09:00`]);
		}
		await new HanamiMetricsDaily1789948800000().up(q);
		assert.deepEqual(await q.query(`SELECT "failureKind",count(*)::int AS count FROM hanami_user_feed_batch GROUP BY 1`), [{ failureKind: 'unknown', count: 6 }]);
		await q.query(`UPDATE hanami_metrics_state SET "startedAt"=$1::timestamptz`, [`${range.from}T00:00:00+09:00`]); // synthetic coverage, not production history
		for (let d = -14; d <= -1; d++) for (const source of ['globalPopular', 'exploration']) for (let u = 1; u <= 6; u++) {
			const at = `${shift(d)}T12:00:00+09:00`, note = id(`${shift(d)}T11:00:00+09:00`), user = `fixture-u${u}`;
			await q.query(`INSERT INTO note(id,"userId",text) VALUES($1,$2,'synthetic metrics fixture')`, [note, user]);
			await q.query(`INSERT INTO hanami_note_judgement VALUES($1,1,0,3.5,2,'fixture',$2)`, [note, at]);
			for (const [type, seconds] of [['served', 0], ['seen', 1], ['reaction', 2], ['reaction', 3], ...(u <= 3 ? [['reply', 4]] : [])]) {
				await q.query(`INSERT INTO hanami_recommendation_event(id,"userId","noteId","eventType",source,"occurredAt","createdAt") VALUES($1,$2,$3,$4,$5,$6::timestamptz+($7::int*interval '1 second'),$6::timestamptz+($7::int*interval '1 second'))`, [id(at), user, note, type, source, at, seconds]);
			}
			await q.query(`INSERT INTO hanami_user_feed_refresh VALUES($1,'fixture-epoch',$2,$3)`, [user, Buffer.from(`${d}:${source}:${u}`), at]);
		}
		// Rare row and multi-day repeated users: exact distinct must remain six, not 84.
		const at = `${range.to}T12:00:00+09:00`, note = id(at);
		await q.query(`INSERT INTO note(id,"userId") VALUES($1,'fixture-u7')`, [note]);
		await q.query(`INSERT INTO hanami_recommendation_event(id,"userId","noteId","eventType",source,"occurredAt","createdAt") VALUES($1,'fixture-u7',$2,'served','fof',$3,$3)`, [id(at), note, at]);
		const isolated = { ...cfg, url: 'http://127.0.0.1:56314/', port: 56314, id: 'aidx', db: { ...cfg.db, db: connection.database, disableCache: true, extra: { options: connection.options } }, redis: { host: '127.0.0.1', port: 56313, db: 0, prefix: 'hm-metrics-verification' } };
		delete isolated.dbReplications; delete isolated.dbSlaves;
		writeFileSync(`${scratch}/config.yml`, yaml.dump(isolated), { mode: 0o600 });
		writeFileSync(`${scratch}/salt`, randomBytes(32).toString('hex'), { mode: 0o600 });
		console.log('PASS actual migration / failed unknown backfill / 14-day synthetic archive fixtures');
	}
	if (process.argv.includes('--cli')) {
		const result = spawnSync(process.execPath, ['--loader', `${scratch}/loader.mjs`, '/workspace/packages/backend/src/boot/cli.ts', 'hanami:metrics-rollup', '--from', range.from, '--to', range.to], {
			cwd: '/workspace/packages/backend', encoding: 'utf8', timeout: 120000,
			env: { ...process.env, NODE_ENV: 'production', MISSKEY_CONFIG_YML: `${scratch}/config.yml`, HANAMI_METRICS_SALT: readFileSync(`${scratch}/salt`, 'utf8') },
		});
		if (result.status !== 0) { console.error(result.stderr); console.error(result.stdout); throw new Error('Isolated metrics CLI failed'); }
		assert.match(result.stdout, /14 days, JST/);
		console.log('PASS actual hanami:metrics-rollup CLI: 14 days');
	}
	if (process.argv.includes('--p1-final')) {
		await q.query(`CREATE TABLE IF NOT EXISTS meta ("hanamiNoteJudgeSettings" jsonb, "hanamiRecommendationAxisConfig" jsonb DEFAULT '{}')`);
		const { createDefaultHanamiNoteJudgeSettings } = await import('../src/core/hanami/HanamiNoteJudgeContracts.ts');
		await q.query(`INSERT INTO meta("hanamiNoteJudgeSettings") SELECT $1 WHERE NOT EXISTS(SELECT 1 FROM meta)`, [createDefaultHanamiNoteJudgeSettings()]);
		await q.query(`ALTER TABLE hanami_common_generation ADD COLUMN IF NOT EXISTS ordinal bigint DEFAULT 0, ADD COLUMN IF NOT EXISTS "generationFence" bigint DEFAULT 1`);
		await q.query(`CREATE TABLE IF NOT EXISTS hanami_common_candidate ("generationId" varchar(32),"generationFence" bigint,"noteId" varchar(32),axis varchar(32),rank integer,"baseScore" double precision)`);
		await q.query(`ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "isSuspended" boolean DEFAULT false, ADD COLUMN IF NOT EXISTS "isDeleted" boolean DEFAULT false`);
		await q.query(`ALTER TABLE user_profile ADD COLUMN IF NOT EXISTS "hanamiRecommendationEnabled" boolean DEFAULT true, ADD COLUMN IF NOT EXISTS "hanamiReduceEphemeralPosts" boolean DEFAULT true, ADD COLUMN IF NOT EXISTS "exploreMediaFilter" varchar(32) DEFAULT 'all'`);
		await q.query(`ALTER TABLE note ADD COLUMN IF NOT EXISTS "channelId" varchar(32), ADD COLUMN IF NOT EXISTS "replyId" varchar(32), ADD COLUMN IF NOT EXISTS "renoteId" varchar(32), ADD COLUMN IF NOT EXISTS cw text, ADD COLUMN IF NOT EXISTS "hasPoll" boolean DEFAULT false, ADD COLUMN IF NOT EXISTS "userHost" varchar(128), ADD COLUMN IF NOT EXISTS "replyUserId" varchar(32), ADD COLUMN IF NOT EXISTS "replyUserHost" varchar(128), ADD COLUMN IF NOT EXISTS "renoteUserId" varchar(32), ADD COLUMN IF NOT EXISTS "renoteUserHost" varchar(128), ADD COLUMN IF NOT EXISTS tags varchar[] DEFAULT '{}'`);
		await q.query(`CREATE TABLE IF NOT EXISTS hanami_user_feed_state ("userId" varchar(32) PRIMARY KEY,"epochId" varchar(32),mode varchar(32))`);
		await q.query(`CREATE TABLE IF NOT EXISTS following ("followerId" varchar(32),"followeeId" varchar(32))`);
		await q.query(`INSERT INTO hanami_user_feed_state SELECT id,'fixture-epoch','personalized' FROM "user" WHERE id<>'fixture-u7' ON CONFLICT DO NOTHING`);
		await q.query(`INSERT INTO hanami_common_generation VALUES('fixture-generation','ready',now(),now(),1,1) ON CONFLICT DO NOTHING`);
		await q.query(`INSERT INTO hanami_common_candidate SELECT 'fixture-generation',1,id,'exploration',row_number() OVER (),1 FROM (SELECT DISTINCT ON ("userId") id FROM note ORDER BY "userId",id) n WHERE NOT EXISTS(SELECT 1 FROM hanami_common_candidate)`);
		await q.query(`INSERT INTO hanami_foryou_model_run VALUES('fixture-judge','note-judge','ready','{"secondsPerItem":1.9,"processedCount":10,"runtime":{"device":"cpu"}}',now(),now()) ON CONFLICT DO NOTHING`);
		const { createPostgresDataSource } = await import('../src/postgres.ts');
		const config = yaml.load(readFileSync(`${scratch}/config.yml`, 'utf8'));
		const stateDb = createPostgresDataSource(config);
		stateDb.setOptions({ synchronize: false, dropSchema: false, cache: false, installExtensions: false, logging: false });
		await stateDb.initialize();
		try {
			const { QueryService } = await import('../src/core/QueryService.ts');
			const { HanamiForYouSafetyService } = await import('../src/core/hanami/HanamiForYouSafetyService.ts');
			const { HanamiMetricsDiagnosticsService } = await import('../src/core/hanami/HanamiMetricsDiagnosticsService.ts');
			const { HanamiMetricsRetentionService } = await import('../src/core/hanami/HanamiMetricsRetentionService.ts');
			const safety = new HanamiForYouSafetyService(null, new QueryService(null,null,null,null,null,null,null,{blockedHosts:[]},null), null, null);
			const diagnostics = new HanamiMetricsDiagnosticsService(stateDb, safety);
			await diagnostics.capture(today);
			const captured = await diagnostics.query(today);
			assert(captured.available); assert(captured.rows.some(row => row.scope === 'dropped'));
			const before = await q.query(`SELECT * FROM hanami_metrics_diagnostic ORDER BY day,scope,key`);
			await diagnostics.capture(today); await diagnostics.capture(range.to);
			assert.deepEqual(await q.query(`SELECT * FROM hanami_metrics_diagnostic ORDER BY day,scope,key`), before);
			const note = (await q.query(`SELECT id FROM note LIMIT 1`))[0].id;
			await q.query(`INSERT INTO hanami_metrics_event(id,"userId","noteId","eventType","createdAt") VALUES('fixture-expired','fixture-u1',$1,'served',now()-interval '106 days') ON CONFLICT DO NOTHING`, [note]);
			await q.query(`INSERT INTO "__chart_day__hanami_timeline"(date,"unique_temp___home_users") VALUES(EXTRACT(EPOCH FROM now()-interval '5 days')::int,ARRAY['fixture-u1']) ON CONFLICT DO NOTHING`);
			await new HanamiMetricsRetentionService(stateDb).prune();
			assert.equal((await q.query(`SELECT count(*)::int AS n FROM hanami_metrics_event WHERE id='fixture-expired'`))[0].n, 0);
			assert((await q.query(`SELECT cardinality("unique_temp___home_users") AS n FROM "__chart_day__hanami_timeline"`)).every(row => row.n === 0));
			console.log('PASS real diagnostics with actual safety SQL, current-only/idempotent capture, 105-day retention and overdue chart-array cleanup');
		} finally { await stateDb.destroy(); }
	}
	if (process.argv.includes('--verify')) {
		process.env.HANAMI_METRICS_SALT = readFileSync(`${scratch}/salt`, 'utf8');
		db = await new DataSource({ type: 'postgres', host: connection.host, port: connection.port, username: connection.user, password: connection.password, database: connection.database, extra: { options: connection.options }, synchronize: false, entities: [] }).initialize();
		const { HanamiMetricsQueryService } = await import('../src/core/hanami/HanamiMetricsQueryService.ts');
		const { HanamiMetricsRollupService } = await import('../src/core/hanami/HanamiMetricsRollupService.ts');
		const service = new HanamiMetricsQueryService(db);
		const responses = {};
		for (const name of ['summary', 'breakdown', 'errors']) {
			const module = await import(`../src/server/api/endpoints/admin/hanami/metrics/${name}.ts`);
			responses[name] = await new module.default(service).exec({ range, ...(name === 'breakdown' ? { dimension: 'source' } : {}) }, { id: 'fixture-admin' }, null);
		}
		assert.equal((await q.query(`SELECT count(DISTINCT day)::int AS days FROM hanami_metrics_daily`))[0].days, 14);
		assert.equal(responses.summary.series.day.length, 14);
		assert.deepEqual(responses.breakdown.suppressed, ['fof']);
		for (const row of responses.breakdown.rows) {
			assert.equal(row.users, 6); assert.equal(row.served, 84); assert.equal(row.reaction, 84); assert.equal(row.reply, 42);
			assert.equal(row.engagementRate, 1.5);
		}
		assert.equal(responses.errors.personal.recent.length, 6);
		assert(!JSON.stringify(responses).includes('fixture-u'));
		const independentSql = buildMetricsQuery(range);
		const independentRows = await q.query(independentSql.text, independentSql.values);
		const independent = summarizeMetrics(independentRows, range);
		for (const row of responses.breakdown.rows) for (const key of ['share','engagementShare','engagementRate','lift']) {
			assert(Math.abs(row[key] - independent.rows.find(x => x.key === row.key)[key]) <= 0.01, key);
		}
		const before = await q.query(`SELECT day,scope,dimension,key,users,served,seen,reaction,reply,renote,extra FROM hanami_metrics_daily ORDER BY 1,2,3,4`);
		await new HanamiMetricsRollupService(db).rollupDay(range.to, { recompute: true });
		assert.deepEqual(await q.query(`SELECT day,scope,dimension,key,users,served,seen,reaction,reply,renote,extra FROM hanami_metrics_daily ORDER BY 1,2,3,4`), before);
		writeFileSync(`${scratch}/p1-responses.json`, JSON.stringify(responses, null, 2));
		console.log('PASS real endpoint execution, 14 days, per-type DISTINCT=1.5, exact period users=6, suppression, independent comparison delta=0, rerollup idempotency');
		// Exercise actual API credential/admin/scope enforcement through HTTP routing;
		// only authentication identity and role lookup are synthetic test adapters.
		const { default: Fastify } = await import('fastify');
		const { ApiCallService } = await import('../src/server/api/ApiCallService.ts');
		const api = new ApiCallService({ enableIpLogging: false, rootUserId: 'fixture-root' }, { sentryForBackend: false }, {},
			{ authenticate: async (token) => token ? [{ id: token, isSuspended: false }, null] : [null, null] }, {},
			{ getUserRoles: async userId => userId === 'fixture-admin' ? [{ isAdministrator: true }] : [] },
			{ updateLastActiveDate: async () => undefined }, { logger: { error() {}, warn() {} } });
		const http = Fastify();
		try {
			for (const name of ['summary', 'breakdown', 'errors']) {
				const module = await import(`../src/server/api/endpoints/admin/hanami/metrics/${name}.ts`);
				const instance = new module.default(service);
				http.post(`/api/admin/hanami/metrics/${name}`, (request, reply) => api.handleRequest({ name: `admin/hanami/metrics/${name}`, meta: module.meta, params: module.paramDef, exec: instance.exec }, request, reply));
			}
			for (const name of ['summary', 'breakdown', 'errors']) {
				for (const [credential, expected] of [[undefined, 401], ['fixture-ordinary', 403], ['fixture-admin', 200]]) {
					const response = await http.inject({ method: 'POST', url: `/api/admin/hanami/metrics/${name}`, payload: { i: credential, range, ...(name === 'breakdown' ? { dimension: 'source' } : {}) } });
					assert.equal(response.statusCode, expected, `${name} authorization`);
				}
			}
		} finally { await http.close(); api.dispose(); }
		console.log('PASS HTTP API authorization: anonymous=401, ordinary=403, administrator=200 for all P1 endpoints');
		const { metricsCohortSql } = await import('../src/core/hanami/HanamiMetricsContracts.ts');
		await q.query('BEGIN');
		try {
			const at = `${range.from}T01:00:00+09:00`, boundaryNote = id(at);
			await q.query(`INSERT INTO note(id,"userId") VALUES($1,'fixture-u1')`, [boundaryNote]);
			for (const [type, offset] of [['served', 0], ['reaction', 336 * 3600000], ['reaction', 336 * 3600000], ['reply', 336 * 3600000 + 1], ['renote', -1]]) {
				await q.query(`INSERT INTO hanami_recommendation_event(id,"userId","noteId","eventType",source,"occurredAt","createdAt") VALUES($1,'fixture-u1',$2,$3,'boundary',$4::timestamptz+($5::bigint*interval '1 millisecond'),$4::timestamptz+($5::bigint*interval '1 millisecond'))`, [id(at), boundaryNote, type, at, offset]);
			}
			const [boundary] = await q.query(metricsCohortSql('total'), [`${range.from}T00:00:00+09:00`, `${range.to}T23:59:59+09:00`, '{"source":"boundary"}']);
			assert.equal(boundary.reaction, 1); assert.equal(boundary.reply, 0); assert.equal(boundary.renote, 0);
			await q.query(`DELETE FROM note WHERE id=$1`, [boundaryNote]);
			assert.equal((await q.query(`SELECT count(*)::int AS n FROM hanami_metrics_event WHERE "noteId"=$1`, [boundaryNote]))[0].n, 0);
			await new HanamiMetricsDaily1789948800000().down(q);
			assert.equal((await q.query(`SELECT to_regclass('hanami_metrics_daily') AS name`))[0].name, null);
		} finally { await q.query('ROLLBACK'); }
		console.log('PASS real SQL inclusive 14-day boundary, per-type duplicate, negative/late exclusion, note erasure cascade, migration down (rolled back)');
	}
	if (process.argv.includes('--units')) {
		const focusIndex = process.argv.indexOf('--focus');
		const pattern = focusIndex >= 0 ? process.argv[focusIndex + 1] : 'hanami';
		assert(pattern && /^[a-zA-Z0-9./_-]+$/.test(pattern), 'Invalid test pattern');
		const url = new URL('postgresql://127.0.0.1');
		url.port = String(connection.port); url.username = connection.user; url.password = connection.password; url.pathname = '/hanami_contract_test';
		const result = spawnSync('pnpm', ['--filter', 'backend', 'jest', '--runInBand', '--no-cache', `--cacheDirectory=${scratch}/jest-cache`, pattern], {
			cwd: '/workspace', stdio: 'inherit', timeout: 180000,
			env: { ...process.env, HANAMI_SCHEMA_TEST_DATABASE_URL: url.href },
		});
		assert.equal(result.status, 0, 'Full Hanami units with isolated real DB contracts');
	}
	if (process.argv.includes('--p3')) {
		const { createPostgresDataSource } = await import('../src/postgres.ts');
		const config = yaml.load(readFileSync(`${scratch}/config.yml`, 'utf8'));
		db = createPostgresDataSource(config);
		db.setOptions({ synchronize: false, dropSchema: false, cache: false, installExtensions: false, logging: false });
		await db.initialize();
		const { HanamiMetricsQueryService } = await import('../src/core/hanami/HanamiMetricsQueryService.ts');
		const { HanamiMetricsInsightsService } = await import('../src/core/hanami/HanamiMetricsInsightsService.ts');
		const { HanamiMetricsDiagnosticsService } = await import('../src/core/hanami/HanamiMetricsDiagnosticsService.ts');
		const { HanamiMetricsCaptureService } = await import('../src/core/hanami/HanamiMetricsCaptureService.ts');
		const { HanamiMetricsPageService } = await import('../src/core/hanami/HanamiMetricsPageService.ts');
		const { HanamiMetricsTimelineHealthService } = await import('../src/core/hanami/HanamiMetricsTimelineHealthService.ts');
		const { default: HanamiTimelineChart } = await import('../src/core/chart/charts/hanami-timeline.ts');
		const health = new HanamiMetricsTimelineHealthService(db);
		await health.onModuleInit();
		try {
			// Reuse only this pre-existing synthetic fixture. A failed assertion must
			// not require another database/schema or inflate the next run's counts.
			await q.query(`DELETE FROM note WHERE text IN ('isolated shared note','isolated hidden candidate')`);
			await q.query(`DELETE FROM hanami_metrics_page WHERE "userId" LIKE 'fixture-u%' AND "servedAt">=$1::timestamptz`, [`${today}T00:00:00+09:00`]);
			await q.query(`DELETE FROM hanami_metrics_gap WHERE day=$1::date`, [today]);
			await q.query(`UPDATE hanami_metrics_state SET "insightsStartedAt"=$1`, [`${range.from}T00:00:00+09:00`]); // explicitly synthetic coverage
			for (let u = 8; u <= 12; u++) {
				await q.query(`INSERT INTO "user"(id) VALUES($1) ON CONFLICT DO NOTHING`, [`fixture-u${u}`]);
				await q.query(`INSERT INTO user_profile("userId") VALUES($1) ON CONFLICT DO NOTHING`, [`fixture-u${u}`]);
			}
			await q.query(`INSERT INTO "user"(id) VALUES('fixture-author') ON CONFLICT DO NOTHING`);
			const at = `${today}T00:00:00+09:00`, note = id(at), hidden = id(at);
			await q.query(`INSERT INTO note(id,"userId",text) VALUES($1,'fixture-author','isolated shared note'),($2,'fixture-author','isolated hidden candidate')`, [note, hidden]);
			await q.query(`INSERT INTO hanami_note_judgement VALUES($1,1,0,3.5,2,'fixture',$2),($3,1,1,3.5,2,'fixture',$2)`, [note,at,hidden]);
			const capture = new HanamiMetricsCaptureService();
			const pages = new HanamiMetricsPageService(db, health);
			for (let u = 1; u <= 12; u++) {
				const user = `fixture-u${u}`, entries=[];
				await q.query(`UPDATE user_profile SET "hanamiRecommendationAxes"=$2 WHERE "userId"=$1`, [user, { exploration: u<=6 ? 'high' : 'normal' }]);
				for (let n=0;n<(u<=6?4:1);n++) {
					const entry=`fixture-page-${u}-${n}-${serial}`; entries.push(entry);
					await q.query(`INSERT INTO hanami_recommendation_event(id,"userId","noteId","eventType",source,"feedEntryId","occurredAt","createdAt") VALUES($1,$2,$3,'served','exploration',$4,$5,$5)`, [id(at),user,note,entry,at]);
				}
				for (const type of ['seen','reaction','reply']) await q.query(`INSERT INTO hanami_recommendation_event(id,"userId","noteId","eventType",source,"occurredAt","createdAt") VALUES($1,$2,$3,$4,'exploration',$5::timestamptz+interval '1 second',$5::timestamptz+interval '1 second')`, [id(at),user,note,type,at]);
				await pages.record(user,entries);
				await db.transaction(async manager => assert(await capture.recordCandidates(`fixture-b-${u}`,user,[{noteId:hidden,axis:'globalPopular',decision:'hiddenEphemeral'},{noteId:note,axis:'globalPopular',decision:'shown'}],at,(sql,args)=>manager.query(sql,args))));
			}
			await health.heartbeat();
			const query = new HanamiMetricsQueryService(db), diagnostics = new HanamiMetricsDiagnosticsService(db,null);
			const insights = new HanamiMetricsInsightsService(db,query,diagnostics);
			const current={from:today,to:today};
			const opportunities = await insights.opportunities(current), breakdown=await query.breakdown({range:current,dimension:'source'});
			for(const allocation of opportunities.allocation) {
				const same=breakdown.rows.find(row=>row.key===allocation.axis);
				assert.equal(allocation.share,same.share); assert.equal(allocation.engagementShare,same.engagementShare);
			}
			assert(opportunities.demand.some(row=>row.axis==='exploration' && row.avgServedPerPageHigh===4 && row.avgServedPerPageNormal===1));
			assert(opportunities.hiddenCost.some(row=>row.axis==='globalPopular' && row.hidden===12));
			const whatIf = await insights.whatIf({range:current,axis:'exploration',thresholds:{interest:[2.5,2.95,3.5,4]}});
			assert.deepEqual(whatIf.interest.map(row=>row.passed),[1,1,1,null]); // no qualifying users: privacy suppression, not an exposed zero
			const { INSIGHTS_WHAT_IF_SQL } = await import('../src/core/hanami/HanamiMetricsInsightsService.ts');
			const { rangeParameters } = await import('../src/core/hanami/HanamiMetricsContracts.ts');
			const rawThresholds = await q.query(INSIGHTS_WHAT_IF_SQL,[...rangeParameters(current),'{"source":"exploration"}',1,[2.5,2.95,3.5,4],[],2.95,0.5]);
			assert.deepEqual(rawThresholds.filter(row=>row.kind==='interest').sort((a,b)=>a.theta-b.theta).map(row=>row.passed),[1,1,1,0]);
			const aggregateModule=await import('../src/server/api/endpoints/admin/hanami/judge-aggregate.ts');
			const aggregate=await new aggregateModule.default(db,insights).exec({range:current,axis:'exploration'},{id:'fixture-admin'},null);
			assert.equal(aggregate.cohort.passed,whatIf.interest[1].passed);
			const notes=await insights.notes({range:current}); assert(notes.notes.some(row=>row.noteId===note && row.served===30 && row.engagementRate===2));
			await q.query(`UPDATE note SET visibility='followers' WHERE id=$1`,[note]);
			assert(!(await insights.notes({range:current})).notes.some(row=>row.noteId===note));
			await q.query(`UPDATE note SET visibility='public' WHERE id=$1`,[note]);
			// Exercise actual PostgreSQL savepoint recovery, not a mocked SQL port.
			await db.transaction(async manager => {
				const port=(sql,args)=>manager.query(sql,args);
				assert.equal(await capture.recordCandidates('fixture-recovery','fixture-u1',[{noteId:'missing-fixture-note',axis:'globalPopular',decision:'shown'}],at,port),false);
				assert.equal((await manager.query('SELECT 1 AS ok'))[0].ok,1);
				assert(await capture.recordCandidates('fixture-recovery','fixture-u1',[{noteId:note,axis:'globalPopular',decision:'shown'}],at,port));
			});
			const chart = new HanamiTimelineChart(db,{getChartInsertLock:async()=>()=>{}},{logger:{warn(){},info(){},debug(){},error(){}}},health);
			const chartBefore=await chart.getChart('day',1,null);
			for(const kind of ['home','local','social','global','hanami']) for(let u=1;u<=6;u++){ await chart.hit(kind,`fixture-u${u}`); await chart.hit(kind,`fixture-u${u}`); }
			await chart.save();
			const chartRaw=await chart.getChart('day',1,null);
			for(const kind of ['home','local','social','global','hanami']) {assert.equal(chartRaw[kind].users[0],6); assert.equal(chartRaw[kind].requests[0],chartBefore[kind].requests[0]+12);}
			const { default: Fastify }=await import('fastify');
			const { ApiCallService }=await import('../src/server/api/ApiCallService.ts');
			const api=new ApiCallService({enableIpLogging:false,rootUserId:'fixture-root'},{sentryForBackend:false},{},
				{authenticate:async token=>token?[{id:token,isSuspended:false},null]:[null,null]}, {},
				{getUserRoles:async userId=>userId==='fixture-admin'?[{isAdministrator:true}]:[]},
				{updateLastActiveDate:async()=>undefined},{logger:{error(){},warn(){}}});
			const http=Fastify();
			try {
				const endpoints=[
					...['opportunities','what-if','notes'].map(name=>({name:`admin/hanami/metrics/${name}`,service:insights,params:{range:current,...(name==='what-if'?{axis:'exploration',thresholds:{interest:[2.95]}}:{})}})),
					{name:'hanami/stats',service:query,params:{range:current}},
					{name:'charts/hanami-timeline',service:chart,params:{span:'day',limit:1}},
				];
				for(const endpoint of endpoints){
					const module=await import(`../src/server/api/endpoints/${endpoint.name}.ts`);
					const instance=new module.default(endpoint.service);
					http.post(`/api/${endpoint.name}`,(request,reply)=>api.handleRequest({name:endpoint.name,meta:module.meta,params:module.paramDef,exec:instance.exec},request,reply));
				}
				for(const endpoint of endpoints){
					for(const [credential,expected] of [[undefined,401],['fixture-ordinary',403],['fixture-admin',200]]){
						const response=await http.inject({method:'POST',url:`/api/${endpoint.name}`,payload:{i:credential,...endpoint.params}});
						assert.equal(response.statusCode,expected,`${endpoint.name} authorization: ${response.body}`);
						if(expected===200 && endpoint.name==='hanami/stats') assert(!/fixture-u|noteId|userId|trendTerm/.test(response.body));
					}
				}
			} finally {await http.close();api.dispose();}
			await chart.hit('hanami','missing-fixture-user'); // real FK failure must not break REST serving
			await health.heartbeat();
			assert(Object.values((await query.summary(current)).usage.tlShare).every(value=>value===null));
			assert((await insights.opportunities(current)).unavailable.includes('demand.collectionGap'));
			await q.query(`DELETE FROM hanami_metrics_gap WHERE day=$1::date`,[today]); // remove intentional outage fixture
			writeFileSync(`${scratch}/p3-responses.json`,JSON.stringify({opportunities,whatIf,notes,aggregate,chartRaw},null,2));
			console.log('PASS P3 actual capture/savepoint recovery, 4-vs-1 demand, hidden candidates, allocation identity, monotonic what-if/judge equality, notes/cache visibility; P4 five real chart unique/request series and real failed-write gap suppression; all P3/P4 HTTP admin guards');
		} finally {await health.onApplicationShutdown();}
	}
} finally {
	if (db?.isInitialized) await db.destroy();
	await client.end();
}
