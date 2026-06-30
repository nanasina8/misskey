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
 */

import pg from 'pg';

const { Pool } = pg;
const pool = new Pool(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : undefined);
const SINCE_DAYS = Number(process.env.SINCE_DAYS ?? 14);

async function main() {
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

main().catch(err => {
	console.error(err);
	process.exit(1);
});
