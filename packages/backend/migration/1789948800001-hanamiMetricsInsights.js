/* SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
export class HanamiMetricsInsights1789948800001 {
	name = 'HanamiMetricsInsights1789948800001';
	async up(q) {
		await q.query(`ALTER TABLE hanami_metrics_state ADD COLUMN "insightsStartedAt" timestamptz NOT NULL DEFAULT now()`);
		await q.query(`CREATE TABLE hanami_metrics_page(id uuid PRIMARY KEY,"userId" varchar(32) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,"servedAt" timestamptz NOT NULL,counts jsonb NOT NULL,axes jsonb NOT NULL)`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_page_period" ON hanami_metrics_page("servedAt","userId")`);
		await q.query(`CREATE TABLE hanami_metrics_candidate("batchId" varchar(32) NOT NULL,"userId" varchar(32) NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,"noteId" varchar(32) NOT NULL REFERENCES note(id) ON DELETE CASCADE,axis varchar(32) NOT NULL,decision varchar(32) NOT NULL CHECK(decision IN ('hiddenEphemeral','shown')),"capturedAt" timestamptz NOT NULL,PRIMARY KEY("batchId","userId","noteId",axis,decision))`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_candidate_period" ON hanami_metrics_candidate("capturedAt")`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_candidate_note" ON hanami_metrics_candidate("noteId")`);
		await q.query(`CREATE INDEX "IDX_hanami_metrics_candidate_user" ON hanami_metrics_candidate("userId")`);
		await q.query(`CREATE TABLE hanami_metrics_collector(id uuid PRIMARY KEY,"startedAt" timestamptz NOT NULL,"lastSeenAt" timestamptz NOT NULL,"verifiedThrough" date NOT NULL,"stoppedAt" timestamptz)`);
		await q.query(`CREATE TABLE hanami_metrics_gap(day date NOT NULL,metric varchar(32) NOT NULL,PRIMARY KEY(day,metric))`);
		for (const name of ['hanami_metrics_page','hanami_metrics_candidate','hanami_metrics_collector','hanami_metrics_gap']) await q.query(`REVOKE ALL ON TABLE "${name}" FROM PUBLIC`);
	}
	async down(q) {
		for (const name of ['hanami_metrics_page','hanami_metrics_candidate','hanami_metrics_collector','hanami_metrics_gap']) await q.query(`DROP TABLE "${name}"`);
		await q.query(`ALTER TABLE hanami_metrics_state DROP COLUMN "insightsStartedAt"`);
	}
}
