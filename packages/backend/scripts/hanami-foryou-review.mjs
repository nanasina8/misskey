/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/*
 * はなみTL For You 週次レビュー（実装計画 B5 / 仕様§14）。
 *
 * hanami_recommendation_event を集計し、per-user の
 *   - served の source mix（humanPopular 偏重か／similarPeople・positiveLoop の出方）
 *   - engagement provenance（rec由来 vs normal由来＝「その5人が rec に反応しているか」）
 * を出す。**flag flip の前から**回し、ON 前後で比較する運用。
 *
 * 接続: 環境変数 DATABASE_URL、または PG*（PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE）。
 * 期間: 環境変数 SINCE_DAYS（既定14）。
 * 実行: node scripts/hanami-foryou-review.mjs
 * 独立 metrics 比較: node scripts/hanami-foryou-review.mjs --metrics --from YYYY-MM-DD --to YYYY-MM-DD [--json]
 * metrics の日付は JST・両端含む（最大90日）。少人数 source は非表示。
 */

import pg from 'pg';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;
const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 14);
const DAY_MS = 86_400_000;

class MetricsUsageError extends Error {}

/** Pure CLI parser. today is an explicit JST YYYY-MM-DD supplied by the caller. */
export function parseMetricsArgs(args, today) {
	const options = new Map();
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (!['--metrics', '--from', '--to', '--json'].includes(flag) || options.has(flag)) {
			throw new MetricsUsageError('Expected --metrics --from YYYY-MM-DD --to YYYY-MM-DD [--json], without duplicate flags.');
		}
		if (flag === '--from' || flag === '--to') {
			options.set(flag, args[++i]);
		} else {
			options.set(flag, true);
		}
	}
	const from = options.get('--from');
	const to = options.get('--to');
	const canonical = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)
		&& day >= '0001-01-01' && Number.isFinite(Date.parse(`${day}T00:00:00Z`))
		&& new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
	if (!options.has('--metrics') || !canonical(from) || !canonical(to) || !canonical(today)) {
		throw new MetricsUsageError('Metrics dates must be real, canonical YYYY-MM-DD dates.');
	}
	const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1;
	if (days < 1 || days > 90 || to > today) {
		throw new MetricsUsageError('Metrics range must contain 1–90 inclusive days and no future JST dates.');
	}
	return { range: { from, to }, json: options.has('--json') };
}

/** Pure query builder; takes the validated range. No backend SQL/helpers are imported. */
export function buildMetricsQuery(range) {
	// Deliberately independent EXISTS implementation: duplicates of one outcome
	// count once per served row, but reaction + reply count as TWO engagements.
	const outcomes = ['seen', 'reaction', 'reply', 'renote'];
	const flags = outcomes.map(type => `EXISTS (
		SELECT 1 FROM hanami_metrics_event e
		WHERE e."userId" = s."userId" AND e."noteId" = s."noteId"
			AND e."eventType" = '${type}'
			AND COALESCE(e."occurredAt", e."createdAt") >= s."createdAt"
			AND COALESCE(e."occurredAt", e."createdAt") <= s."createdAt" + interval '336 hours'
	) AS ${type}`).join(',\n');
	const counts = outcomes.map(type => `COUNT(*) FILTER (WHERE ${type}) AS ${type}`).join(',\n');
	return {
		text: `WITH served_outcomes AS (
			SELECT s."userId", COALESCE(NULLIF(s.dimensions ->> 'source', ''), 'unknown') AS key,
				${flags}
			FROM hanami_metrics_event s
			WHERE s."eventType" = 'served'
				AND s."createdAt" >= $1::timestamptz
				AND s."createdAt" < $2::timestamptz
		)
		SELECT key, COUNT(DISTINCT "userId") AS users, COUNT(*) AS served, ${counts}
		FROM served_outcomes GROUP BY key ORDER BY key`,
		values: [
			new Date(Date.parse(`${range.from}T00:00:00+09:00`)).toISOString(),
			new Date(Date.parse(`${range.to}T00:00:00+09:00`) + DAY_MS).toISOString(),
		],
	};
}

/** Pure reducer of SQL aggregate rows; explicitly projects only public fields. */
export function summarizeMetrics(aggregates, range) {
	const visible = [];
	const suppressed = [];
	for (const aggregate of aggregates) {
		const row = { key: aggregate.key };
		for (const field of ['users', 'served', 'seen', 'reaction', 'reply', 'renote']) {
			row[field] = Number(aggregate[field]);
			if (!Number.isSafeInteger(row[field]) || row[field] < 0) {
				throw new Error('Metrics counts must be nonnegative safe integers.');
			}
		}
		if (row.users >= 1 && row.users <= 4) suppressed.push(row.key);
		else visible.push(row);
	}
	const engagement = row => row.reaction + row.reply + row.renote;
	const totalServed = visible.reduce((sum, row) => sum + row.served, 0);
	const totalEngagement = visible.reduce((sum, row) => sum + engagement(row), 0);
	const ratio = (numerator, denominator) => numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator;
	const baseline = ratio(totalEngagement, totalServed);
	const rows = visible.map(row => {
		const engaged = engagement(row);
		const engagementRate = ratio(engaged, row.served);
		return {
			...row,
			share: ratio(row.served, totalServed),
			engagementShare: ratio(engaged, totalEngagement),
			engagementRate,
			seenRate: ratio(row.seen, row.served),
			engagementPerSeen: ratio(engaged, row.seen),
			lift: ratio(engagementRate, baseline),
		};
	});
	return { dimension: 'source', rows, suppressed, denominator: 'visible', range: { from: range.from, to: range.to } };
}

async function main() {
	if (process.argv.slice(2).includes('--metrics')) {
		const today = new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10);
		const { range, json } = parseMetricsArgs(process.argv.slice(2), today);
		// Leave PG* and PGOPTIONS (including search_path) to node-postgres.
		const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
		try {
			const result = await pool.query(buildMetricsQuery(range));
			const metrics = summarizeMetrics(result.rows, range);
			if (json) console.log(JSON.stringify(metrics));
			else {
				console.log(`# はなみTL For You metrics (${range.from}–${range.to}, JST) — denominator: visible`);
				console.table(metrics.rows);
				console.log(`suppressed: ${JSON.stringify(metrics.suppressed)}`);
			}
		} finally {
			await pool.end();
		}
		return;
	}

	const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
	const sinceClause = `"createdAt" > now() - ($1 || ' days')::interval`;
	const arg = [String(SINCE_DAYS)];

	const served = await pool.query(
		`SELECT "userId", coalesce("source", '(none)') AS source, count(*)::int AS n
		 FROM "hanami_recommendation_event"
		 WHERE "eventType" = 'served' AND ${sinceClause}
		 GROUP BY "userId", source`,
		arg,
	);
	const eng = await pool.query(
		`SELECT "userId", "eventType",
		        (CASE WHEN "source" IS NOT NULL AND "source" <> 'normal' THEN 'rec' ELSE 'normal' END) AS prov,
		        count(*)::int AS n
		 FROM "hanami_recommendation_event"
		 WHERE "eventType" IN ('reaction', 'reply', 'renote') AND ${sinceClause}
		 GROUP BY "userId", "eventType", prov`,
		arg,
	);

	const users = new Map();
	const u = (id) => {
		if (!users.has(id)) users.set(id, { served: {}, eng: {} });
		return users.get(id);
	};
	for (const r of served.rows) u(r.userId).served[r.source] = r.n;
	for (const r of eng.rows) u(r.userId).eng[`${r.prov}_${r.eventType}`] = r.n;

	console.log(`# はなみTL For You review (last ${SINCE_DAYS}d) — ${users.size} users with events\n`);
	for (const [userId, data] of users) {
		const servedTotal = Object.values(data.served).reduce((a, b) => a + b, 0);
		const servedStr = Object.entries(data.served).sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}:${n}`).join(' ') || '-';
		const rec = Object.entries(data.eng).filter(([k]) => k.startsWith('rec_')).map(([k, n]) => `${k.slice(4)}:${n}`).join(' ') || '-';
		const norm = Object.entries(data.eng).filter(([k]) => k.startsWith('normal_')).map(([k, n]) => `${k.slice(7)}:${n}`).join(' ') || '-';
		console.log(`${userId}  served=${servedTotal} [${servedStr}]`);
		console.log(`    rec-engage: ${rec}   normal-engage: ${norm}`);
	}

	await pool.end();
}

// Importing the pure helpers must never connect to a database or run the CLI.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch(err => {
		if (process.argv.slice(2).includes('--metrics')) {
			// Driver errors may contain credentials, identifiers, or connection strings.
			console.error(err instanceof MetricsUsageError ? err.message : 'Metrics review failed; check database configuration and metrics table availability.');
		} else {
			console.error(err);
		}
		process.exit(1);
	});
}
