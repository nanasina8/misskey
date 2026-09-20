/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/** Internal facts are application-role-only, cascade on erasure, and expire after
 * 105 days (90-day queries + 14-day attribution + a finalization margin).
 * The public daily table deliberately contains no individual identifiers.
 */
export class HanamiMetricsDaily1789948800000 {
	name = 'HanamiMetricsDaily1789948800000';

	async up(q) {
		await q.query(`ALTER TABLE hanami_user_feed_batch ADD COLUMN "failureKind" varchar(32), ADD COLUMN "failureMessage" varchar(512)`);
		await q.query(`UPDATE hanami_user_feed_batch SET "failureKind" = 'unknown' WHERE status = 'failed'`);
		await q.query(`CREATE TABLE hanami_metrics_daily (
			day date NOT NULL, scope varchar(32) NOT NULL, dimension varchar(32) NOT NULL, key varchar(128) NOT NULL,
			users integer NOT NULL DEFAULT 0, served integer NOT NULL DEFAULT 0, seen integer NOT NULL DEFAULT 0,
			reaction integer NOT NULL DEFAULT 0, reply integer NOT NULL DEFAULT 0, renote integer NOT NULL DEFAULT 0,
			extra jsonb NOT NULL DEFAULT '{}', "updatedAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(day,scope,dimension,key))`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_daily_scope" ON hanami_metrics_daily(scope,dimension,day)`);
		await q.query(`CREATE TABLE hanami_metrics_state (id integer PRIMARY KEY CHECK(id=1), "startedAt" timestamptz NOT NULL DEFAULT now())`);
		await q.query(`INSERT INTO hanami_metrics_state(id) VALUES(1)`);
		await q.query(`CREATE TABLE hanami_metrics_event (
			id varchar(32) PRIMARY KEY, "userId" varchar(32) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
			"noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE,
			"eventType" varchar(32) NOT NULL, source varchar(64), "feedKind" varchar(32), "feedEpochId" varchar(32), "feedEntryId" varchar(512),
			"occurredAt" timestamptz, "createdAt" timestamptz NOT NULL, dimensions jsonb NOT NULL DEFAULT '{}', judgement jsonb NOT NULL DEFAULT '{}')`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_event_cohort" ON hanami_metrics_event("createdAt",source) WHERE "eventType"='served'`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_event_outcomes" ON hanami_metrics_event("userId","noteId",(COALESCE("occurredAt","createdAt")),"eventType")`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_event_note" ON hanami_metrics_event("noteId")`);
		await q.query(`CREATE TABLE hanami_metrics_judgement (
			"noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE, "promptVersion" integer NOT NULL,
			"ephemeralScore" double precision NOT NULL, interest double precision NOT NULL, "contentType" integer NOT NULL,
			model varchar(256) NOT NULL, "judgedAt" timestamptz NOT NULL, PRIMARY KEY("noteId","promptVersion"))`);
		await q.query(`CREATE TABLE hanami_metrics_refresh (
			"userId" varchar(32) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
			"epochId" varchar(32) NOT NULL, "refreshTokenDigest" bytea NOT NULL, "createdAt" timestamptz NOT NULL,
			PRIMARY KEY("userId","epochId","refreshTokenDigest"))`);
		await q.query(`CREATE TABLE hanami_metrics_timeline (
			day date NOT NULL, kind varchar(32) NOT NULL CHECK(kind IN ('home','local','social','global','hanami')),
			"userId" varchar(32) REFERENCES "user"(id) ON DELETE CASCADE, requests integer NOT NULL DEFAULT 0,
			UNIQUE NULLS NOT DISTINCT(day,kind,"userId"))`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_timeline_user" ON hanami_metrics_timeline("userId")`);
		await q.query(`CREATE TABLE hanami_metrics_diagnostic (
			day date NOT NULL, scope varchar(32) NOT NULL, key varchar(128) NOT NULL, users integer NOT NULL,
			data jsonb NOT NULL DEFAULT '{}', "capturedAt" timestamptz NOT NULL, PRIMARY KEY(day,scope,key))`);
		// Decode the existing HFE-v1 personal locator; never confuse it with an entry ID.
		await q.query(`CREATE FUNCTION hanami_metrics_locator(locator text) RETURNS jsonb LANGUAGE plpgsql IMMUTABLE AS $$
		DECLARE b bytea; p integer := 5; n integer; vals text[] := '{}'; i integer;
		BEGIN
			IF locator IS NULL OR locator !~ '^[A-Za-z0-9_-]+$' THEN RETURN NULL; END IF;
			b := decode(translate(locator,'-_','+/') || repeat('=', (4-length(locator)%4)%4),'base64');
			IF substring(b from 1 for 3) <> convert_to('HFE','UTF8') OR get_byte(b,3)<>1 OR get_byte(b,4)<>112 THEN RETURN NULL; END IF;
			FOR i IN 1..3 LOOP
				n := get_byte(b,p)*256+get_byte(b,p+1); p:=p+2;
				IF n<1 OR p+n>length(b) THEN RETURN NULL; END IF;
				vals:=array_append(vals,convert_from(substring(b from p+1 for n),'UTF8')); p:=p+n;
			END LOOP;
			IF p<>length(b) OR vals[3] !~ '^(0|[1-9][0-9]*)$' THEN RETURN NULL; END IF;
			RETURN jsonb_build_object('userId',vals[1],'epochId',vals[2],'sequence',vals[3]::bigint);
		EXCEPTION WHEN OTHERS THEN RETURN NULL;
		END $$`);
		await q.query(`CREATE FUNCTION hanami_metrics_capture_event(e hanami_recommendation_event) RETURNS void LANGUAGE plpgsql AS $$
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
				'contentType',COALESCE(j->>'contentType','unjudged'),'media',CASE WHEN note_row.media THEN 'image' ELSE 'text' END,
				'freshness','unknown',
				'authorLocality',CASE WHEN note_row.local THEN 'local' ELSE 'remote' END,'trendTerm',left(COALESCE(md->>'term','unknown'),128),
				'cluster',CASE WHEN md->>'clusterId' IS NOT NULL THEN 'clustered' ELSE 'none' END,'axisLevels',COALESCE(axes,'{}'));
			INSERT INTO hanami_metrics_event(id,"userId","noteId","eventType",source,"feedKind","feedEpochId","feedEntryId","occurredAt","createdAt",dimensions,judgement)
				VALUES(e.id,e."userId",e."noteId",e."eventType",e.source,e."feedKind",e."feedEpochId",e."feedEntryId",e."occurredAt",e."createdAt",dims,COALESCE(j,'{}'))
				ON CONFLICT(id) DO UPDATE SET "occurredAt"=EXCLUDED."occurredAt";
		END $$`);
		await q.query(`CREATE FUNCTION hanami_metrics_event_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM hanami_metrics_capture_event(NEW); RETURN NEW; END $$`);
		await q.query(`CREATE TRIGGER hanami_metrics_event_capture AFTER INSERT OR UPDATE ON hanami_recommendation_event FOR EACH ROW EXECUTE FUNCTION hanami_metrics_event_trigger()`);
		await q.query(`CREATE FUNCTION hanami_metrics_judgement_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			INSERT INTO hanami_metrics_judgement VALUES(NEW."noteId",NEW."promptVersion",NEW."ephemeralScore",NEW.interest,NEW."contentType",NEW.model,NEW."judgedAt")
			ON CONFLICT("noteId","promptVersion") DO UPDATE SET "ephemeralScore"=EXCLUDED."ephemeralScore",interest=EXCLUDED.interest,"contentType"=EXCLUDED."contentType",model=EXCLUDED.model,"judgedAt"=EXCLUDED."judgedAt";
			RETURN NEW; END $$`);
		await q.query(`CREATE TRIGGER hanami_metrics_judgement_capture AFTER INSERT OR UPDATE ON hanami_note_judgement FOR EACH ROW EXECUTE FUNCTION hanami_metrics_judgement_trigger()`);
		await q.query(`CREATE FUNCTION hanami_metrics_refresh_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
			INSERT INTO hanami_metrics_refresh VALUES(NEW."userId",NEW."epochId",NEW."refreshTokenDigest",NEW."createdAt") ON CONFLICT DO NOTHING;
			RETURN NEW; END $$`);
		await q.query(`CREATE TRIGGER hanami_metrics_refresh_capture AFTER INSERT ON hanami_user_feed_refresh FOR EACH ROW EXECUTE FUNCTION hanami_metrics_refresh_trigger()`);
		// Backfill retained observations without claiming that missing history was observed zero.
		await q.query(`SELECT hanami_metrics_capture_event(e) FROM hanami_recommendation_event e WHERE e."createdAt">=clock_timestamp()-interval '105 days'`);
		await q.query(`INSERT INTO hanami_metrics_judgement SELECT "noteId","promptVersion","ephemeralScore",interest,"contentType",model,"judgedAt" FROM hanami_note_judgement WHERE "judgedAt">=clock_timestamp()-interval '105 days' ON CONFLICT DO NOTHING`);
		await q.query(`INSERT INTO hanami_metrics_refresh SELECT "userId","epochId","refreshTokenDigest","createdAt" FROM hanami_user_feed_refresh ON CONFLICT DO NOTHING`);
		for (const table of ['hanami_metrics_event','hanami_metrics_judgement','hanami_metrics_refresh','hanami_metrics_timeline','hanami_metrics_state','hanami_metrics_diagnostic']) {
			await q.query(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC`);
		}
		for (const fn of ['hanami_metrics_locator(text)','hanami_metrics_capture_event(hanami_recommendation_event)','hanami_metrics_event_trigger()','hanami_metrics_judgement_trigger()','hanami_metrics_refresh_trigger()']) {
			await q.query(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC`);
		}
		for (const table of ['__chart__hanami_timeline','__chart_day__hanami_timeline']) {
			const columns=['id serial PRIMARY KEY','date integer NOT NULL UNIQUE'];
			for (const kind of ['home','local','social','global','hanami']) columns.push(`"___${kind}_users" integer NOT NULL DEFAULT 0`, `"___${kind}_requests" integer NOT NULL DEFAULT 0`, `"unique_temp___${kind}_users" varchar[] NOT NULL DEFAULT '{}'`);
			await q.query(`CREATE TABLE "${table}" (${columns.join(',')})`);
			await q.query(`REVOKE ALL ON TABLE "${table}" FROM PUBLIC`);
		}
	}

	async down(q) {
		await q.query(`DROP TRIGGER hanami_metrics_event_capture ON hanami_recommendation_event`);
		await q.query(`DROP TRIGGER hanami_metrics_judgement_capture ON hanami_note_judgement`);
		await q.query(`DROP TRIGGER hanami_metrics_refresh_capture ON hanami_user_feed_refresh`);
		for (const fn of ['hanami_metrics_event_trigger()','hanami_metrics_judgement_trigger()','hanami_metrics_refresh_trigger()','hanami_metrics_capture_event(hanami_recommendation_event)','hanami_metrics_locator(text)']) await q.query(`DROP FUNCTION ${fn}`);
		for (const table of ['hanami_metrics_event','hanami_metrics_judgement','hanami_metrics_refresh','hanami_metrics_timeline','hanami_metrics_diagnostic','hanami_metrics_state','hanami_metrics_daily','__chart__hanami_timeline','__chart_day__hanami_timeline']) await q.query(`DROP TABLE "${table}"`);
		await q.query(`ALTER TABLE hanami_user_feed_batch DROP COLUMN "failureKind", DROP COLUMN "failureMessage"`);
	}
}
