#!/usr/bin/env node
import { createRequire } from 'node:module';
import { OUTPUT_SCHEMA, OUTPUT_VERSION, assertPrivacySafe, evaluateModelRuns, evaluateRows, runReadOnlyTransaction, seedDigest, stableSelectUsers } from './restored-evaluation-lib.mjs';

const help = `Usage: node evaluate_restored_feed.mjs --connection <postgres-url> --seed <seed> [--after-table hanami_user_feed_entry] [--before-table table] [--scope active-ready-epoch|latest-ready-batch|all] [--samples 10,30,210] [--windows 10,30,210] [--dry-run]\nOutputs one privacy-safe aggregate JSON document. Use a read-only clone only.`;
function args(argv) { const out = {}; for (let i = 0; i < argv.length; i++) { const a = argv[i]; if (a === '--help') out.help = true; else if (a === '--dry-run') out.dry = true; else if (a.startsWith('--')) out[a.slice(2)] = argv[++i]; } return out; }
const options = args(process.argv.slice(2));
if (options.help) { process.stdout.write(`${help}\n`); process.exit(0); }
if (options.dry) { process.stdout.write(JSON.stringify({ schema: OUTPUT_SCHEMA, version: OUTPUT_VERSION, dryRun: true }) + '\n'); process.exit(0); }
if (!options.connection || !options.seed) { process.stderr.write('missing required connection or seed\n'); process.exit(2); }
const validTable = name => /^[a-z_][a-z0-9_]*$/i.test(name || '') ? name : null;
const afterTable = validTable(options['after-table'] || 'hanami_user_feed_entry'); const beforeTable = options['before-table'] ? validTable(options['before-table']) : null;
if (!afterTable || (options['before-table'] && !beforeTable)) { process.stderr.write('invalid table name\n'); process.exit(2); }
const scope = options.scope || 'active-ready-epoch';
if (!['active-ready-epoch', 'latest-ready-batch', 'all'].includes(scope)) { process.stderr.write('invalid scope\n'); process.exit(2); }
const samples = (options.samples || '10,30,210').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0); const windows = (options.windows || '10,30,210').split(',').map(Number).filter(n => Number.isInteger(n) && n > 0);
const pg = createRequire(new URL('../../packages/backend/package.json', import.meta.url))('pg'); const client = new pg.Client({ connectionString: options.connection });
const safeError = () => 'evaluation failed (database details withheld)\n';
async function columns(table) { const r = await client.query('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name', [table]); return new Set(r.rows.map(x => x.column_name)); }
function col(set, name, fallback = 'NULL') { return set.has(name) ? `e."${name}"` : fallback; }
async function readTable(table, users) {
	const c = await columns(table); if (!c.has('userId') || !c.has('noteId')) return { rows: null, reason: 'feed_entry_schema_unavailable' };
	let scopeJoin = ''; let scopeWhere = '';
	if (scope !== 'all') {
		const state = await columns('hanami_user_feed_state'); const batch = await columns('hanami_user_feed_batch');
		if (!['userId', 'epochId', 'batchId'].every(name => c.has(name)) || !['userId', 'epochId'].every(name => state.has(name)) || !['id', 'userId', 'epochId', 'status'].every(name => batch.has(name)) || (scope === 'latest-ready-batch' && !state.has('latestReadyBatchId'))) return { rows: null, reason: 'scope_tables_or_columns_unavailable' };
		scopeJoin = ' JOIN "hanami_user_feed_state" s ON s."userId" = e."userId" AND s."epochId" = e."epochId" JOIN "hanami_user_feed_batch" b ON b.id = e."batchId" AND b."userId" = e."userId" AND b."epochId" = e."epochId"';
		scopeWhere = ` AND b.status = 'ready'${scope === 'latest-ready-batch' ? ' AND e."batchId" = s."latestReadyBatchId"' : ''}`;
	}
	const note = await columns('note'); const canJoinNote = note.has('id'); const author = canJoinNote && note.has('userId') ? 'n."userId"' : 'NULL'; const text = canJoinNote && note.has('text') ? 'n.text' : 'NULL'; const join = canJoinNote ? ' LEFT JOIN note n ON n.id = e."noteId"' : ''; const sql = `SELECT ${col(c, 'userId')} AS user_id, ${col(c, 'epochId', "'single'")} AS epoch, ${col(c, 'sequence', '0')} AS sequence, ${col(c, 'position', '0')} AS position, ${col(c, 'batchId', "''")} AS batch, ${col(c, 'noteId')} AS note_id, ${col(c, 'generatedAt')} AS generated_at, ${col(c, 'reasonMetadata')} AS metadata, ${col(c, 'source')} AS source, ${col(c, 'sources')} AS sources, ${author} AS author_id, ${text} AS text FROM "${table}" e${scopeJoin}${join} WHERE e."userId" = ANY($1)${scopeWhere} ORDER BY e."userId", ${col(c, 'sequence', '0')} DESC, ${col(c, 'position', '0')} ASC, ${col(c, 'batchId', "''")} ASC`; const r = await client.query(sql, [users]); return { rows: r.rows.map(x => ({ userId: x.user_id, epoch: x.epoch, sequence: x.sequence, position: x.position, batch: x.batch, noteId: x.note_id, generatedAt: x.generated_at, authorId: x.author_id, text: x.text, metadata: c.has('reasonMetadata') ? x.metadata : undefined, source: x.source, sources: x.sources })) };
}
async function readSeenEvents(users) { const c = await columns('hanami_recommendation_event'); if (!['userId', 'noteId', 'eventType', 'occurredAt'].every(name => c.has(name))) return { available: false, rows: [] }; const r = await client.query('SELECT "userId" AS user_id, "noteId" AS note_id, "occurredAt" AS occurred_at FROM "hanami_recommendation_event" WHERE "userId" = ANY($1) AND "eventType" = $2 AND "occurredAt" IS NOT NULL ORDER BY "userId", "noteId", "occurredAt"', [users, 'seen']); return { available: true, rows: r.rows.map(x => ({ userId: x.user_id, noteId: x.note_id, occurredAt: x.occurred_at })) }; }
try {
	await client.connect(); const output = await runReadOnlyTransaction(client, async () => { const userRows = await client.query(`SELECT DISTINCT "userId" AS user_id FROM "${afterTable}" ORDER BY "userId"`); const allUsers = userRows.rows.map(r => r.user_id);
		let modelRuns = []; let modelRunTableAvailable = false; try { const mc = await columns('hanami_foryou_model_run'); modelRunTableAvailable = mc.has('kind') && mc.has('params') && mc.has('status') && mc.has('startedAt') && mc.has('id'); if (modelRunTableAvailable) modelRuns = (await client.query('SELECT kind, params FROM "hanami_foryou_model_run" WHERE kind = $1 AND status = $2 ORDER BY "startedAt" ASC, id ASC', ['embedding-e5-shadow', 'ready'])).rows; } catch { modelRunTableAvailable = false; modelRuns = []; }
		const result = { schema: OUTPUT_SCHEMA, version: OUTPUT_VERSION, scope, run: { deterministic: true, seedDigest: seedDigest(options.seed), snapshot: 'transaction_repeatable_read', requestedSamples: samples, windows }, samples: {} };
		for (const size of samples) { const users = stableSelectUsers(allUsers, size, options.seed); const [after, before, seen] = await Promise.all([readTable(afterTable, users), beforeTable ? readTable(beforeTable, users) : null, readSeenEvents(users)]); const evaluate = table => table.rows ? evaluateRows(table.rows, { windowSizes: windows, seenEvents: seen.rows, seenEventsAvailable: seen.available }) : { available: false, value: null, reason: table.reason }; result.samples[String(size)] = { selectedUserCount: users.length, after: evaluate(after), before: before ? evaluate(before) : { available: false, value: null, reason: 'before_table_not_supplied' } }; }
		result.modelRuns = evaluateModelRuns(modelRuns, { tableAvailable: modelRunTableAvailable }); return result;
	}); assertPrivacySafe(output); process.stdout.write(JSON.stringify(output) + '\n');
} catch { process.stderr.write(safeError()); process.exitCode = 1; } finally { await client.end().catch(() => {}); }
