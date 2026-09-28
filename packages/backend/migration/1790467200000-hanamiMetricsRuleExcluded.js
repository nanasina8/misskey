/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Keep the original capture logic; only the contentType dimension changes.
function captureEventSql(ruleExcluded) {
	return `CREATE OR REPLACE FUNCTION hanami_metrics_capture_event(e hanami_recommendation_event) RETURNS void LANGUAGE plpgsql AS $$
		DECLARE md jsonb := '{}'; dims jsonb; j jsonb := '{}'; loc jsonb; note_row record; axes jsonb;
		BEGIN
			IF e."createdAt" < clock_timestamp()-interval '105 days' THEN RETURN; END IF;
			SELECT cardinality(n."fileIds")>0 AS media, u.host IS NULL AS local INTO note_row
				FROM note n JOIN "user" u ON u.id=n."userId" WHERE n.id=e."noteId";
			IF NOT FOUND THEN RETURN; END IF;
			loc:=hanami_metrics_locator(e."feedEntryId");
			IF e."feedKind"='personal' AND loc->>'userId'=e."userId" AND loc->>'epochId'=e."feedEpochId" THEN
				SELECT x."reasonMetadata" INTO md FROM hanami_user_feed_entry x WHERE x."userId"=e."userId" AND x."epochId"=e."feedEpochId"
					AND x.sequence=(loc->>'sequence')::bigint AND x."noteId"=e."noteId";
			END IF;
			SELECT jsonb_build_object('ephemeralScore',x."ephemeralScore",'interest',x.interest,'contentType',x."contentType",'promptVersion',x."promptVersion",'model',x.model)
				INTO j FROM hanami_note_judgement x WHERE x."noteId"=e."noteId" ORDER BY x."promptVersion" DESC LIMIT 1;
			SELECT p."hanamiRecommendationAxes" INTO axes FROM user_profile p WHERE p."userId"=e."userId";
			dims:=jsonb_build_object('source',COALESCE(e.source,'unknown'),'relationshipClass',COALESCE(md->'qualityShadow'->>'relationshipClass','unknown'),
				'contentType',${ruleExcluded ? "CASE WHEN j->>'model' LIKE 'rule:%' THEN 'ruleExcluded' ELSE COALESCE(j->>'contentType','unjudged') END" : "COALESCE(j->>'contentType','unjudged')"},'media',CASE WHEN note_row.media THEN 'image' ELSE 'text' END,
				'freshness','unknown',
				'authorLocality',CASE WHEN note_row.local THEN 'local' ELSE 'remote' END,'trendTerm',left(COALESCE(md->>'term','unknown'),128),
				'cluster',CASE WHEN md->>'clusterId' IS NOT NULL THEN 'clustered' ELSE 'none' END,'axisLevels',COALESCE(axes,'{}'));
			INSERT INTO hanami_metrics_event(id,"userId","noteId","eventType",source,"feedKind","feedEpochId","feedEntryId","occurredAt","createdAt",dimensions,judgement)
				VALUES(e.id,e."userId",e."noteId",e."eventType",e.source,e."feedKind",e."feedEpochId",e."feedEntryId",e."occurredAt",e."createdAt",dims,COALESCE(j,'{}'))
				ON CONFLICT(id) DO UPDATE SET "occurredAt"=EXCLUDED."occurredAt";
		END $$`;
}

export class HanamiMetricsRuleExcluded1790467200000 {
	name = 'HanamiMetricsRuleExcluded1790467200000';

	async up(q) {
		await q.query(captureEventSql(true));
		const changed = await q.query(`WITH changed AS (UPDATE hanami_metrics_event e
			SET dimensions = jsonb_set(e.dimensions, '{contentType}', '"ruleExcluded"'::jsonb)
			FROM hanami_metrics_judgement j
			WHERE e.dimensions->>'contentType' = '0' AND j."noteId" = e."noteId"
				AND j."promptVersion"::text = e.judgement->>'promptVersion' AND j.model LIKE 'rule:%'
			RETURNING to_char(e."createdAt" AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day) SELECT DISTINCT day FROM changed`);
		await this.rebuild(q, changed);
	}

	async down(q) {
		await q.query(captureEventSql(false));
		const changed = await q.query(`WITH changed AS (UPDATE hanami_metrics_event
			SET dimensions = jsonb_set(dimensions, '{contentType}', '"0"'::jsonb)
			WHERE dimensions->>'contentType' = 'ruleExcluded'
			RETURNING to_char("createdAt" AT TIME ZONE 'Asia/Tokyo', 'YYYY-MM-DD') AS day) SELECT DISTINCT day FROM changed`);
		await this.rebuild(q, changed);
	}

	async rebuild(q, changed) {
		for (const day of [...new Set(changed.map(row => row.day))].sort()) {
			// Match the regular rollup's transaction lock and only replace existing daily data.
			await q.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`hanami-metrics:${day}:engagement:contentType`]);
			const existing = await q.query(`SELECT 1 FROM hanami_metrics_daily
				WHERE day = $1::date AND scope = 'engagement' AND dimension = 'contentType' LIMIT 1`, [day]);
			if (existing.length === 0) continue;
			await q.query(`DELETE FROM hanami_metrics_daily WHERE day = $1::date AND scope = 'engagement' AND dimension = 'contentType'`, [day]);
			// Recompute distinct users and per-served-row outcomes; summing old cells would overcount.
			await q.query(`WITH cohort AS (
				SELECT s."userId", COALESCE(NULLIF(s.dimensions->>'contentType', ''), 'unjudged') AS key,
					COALESCE(o.seen, 0) AS seen, COALESCE(o.reaction, 0) AS reaction,
					COALESCE(o.reply, 0) AS reply, COALESCE(o.renote, 0) AS renote
				FROM hanami_metrics_event s LEFT JOIN LATERAL (
					SELECT MAX(CASE WHEN e."eventType" = 'seen' THEN 1 ELSE 0 END) AS seen,
						MAX(CASE WHEN e."eventType" = 'reaction' THEN 1 ELSE 0 END) AS reaction,
						MAX(CASE WHEN e."eventType" = 'reply' THEN 1 ELSE 0 END) AS reply,
						MAX(CASE WHEN e."eventType" = 'renote' THEN 1 ELSE 0 END) AS renote
					FROM hanami_metrics_event e WHERE e."userId" = s."userId" AND e."noteId" = s."noteId"
						AND e."eventType" IN ('seen', 'reaction', 'reply', 'renote')
						AND COALESCE(e."occurredAt", e."createdAt") >= s."createdAt"
						AND COALESCE(e."occurredAt", e."createdAt") <= s."createdAt" + interval '336 hours'
				) o ON true
				WHERE s."eventType" = 'served'
					AND s."createdAt" >= $1::date::timestamp AT TIME ZONE 'Asia/Tokyo'
					AND s."createdAt" < ($1::date + 1)::timestamp AT TIME ZONE 'Asia/Tokyo'
			) INSERT INTO hanami_metrics_daily (day, scope, dimension, key, users, served, seen, reaction, reply, renote)
				SELECT $1::date, 'engagement', 'contentType', key, COUNT(DISTINCT "userId")::int, COUNT(*)::int,
					SUM(seen)::int, SUM(reaction)::int, SUM(reply)::int, SUM(renote)::int FROM cohort GROUP BY key`, [day]);
		}
	}
}
