/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Queue jobs retain a promptVersion, so their prompt inputs must remain available
// even after Meta advances to a newer current setting.
export class HanamiNoteJudgeSettingsHistory1789516800000 {
	name = 'HanamiNoteJudgeSettingsHistory1789516800000'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "hanami_note_judge_settings" (
			"promptVersion" integer NOT NULL,
			"settings" jsonb NOT NULL,
			"createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
			CONSTRAINT "PK_hanami_note_judge_settings" PRIMARY KEY ("promptVersion"),
			CONSTRAINT "CHK_hanami_note_judge_settings_prompt_version" CHECK ("promptVersion" > 0),
			CONSTRAINT "CHK_hanami_note_judge_settings_settings_version" CHECK (
				CASE WHEN jsonb_typeof("settings") = 'object'
					AND "settings"->>'promptVersion' ~ '^[1-9][0-9]*$'
					AND (char_length("settings"->>'promptVersion') < 10
						OR (char_length("settings"->>'promptVersion') = 10 AND "settings"->>'promptVersion' <= '2147483647'))
				THEN ("settings"->>'promptVersion')::integer = "promptVersion"
				ELSE false END
			)
		)`);
		await queryRunner.query(`CREATE FUNCTION "hanami_note_judge_settings_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				RAISE EXCEPTION 'hanami note judge settings history is immutable';
			END;
		$$`);
		await queryRunner.query(`CREATE TRIGGER "TRG_hanami_note_judge_settings_immutable"
			BEFORE UPDATE OR DELETE ON "hanami_note_judge_settings"
			FOR EACH ROW EXECUTE FUNCTION "hanami_note_judge_settings_immutable"()`);
		// Use the same highest-id Meta policy as runtime. Guard the extraction so a
		// malformed legacy JSON value leaves no history row rather than failing the
		// migration; rolling-deploy fallback then handles only the current version.
		await queryRunner.query(`INSERT INTO "hanami_note_judge_settings" ("promptVersion", "settings")
			SELECT CASE WHEN jsonb_typeof(current."hanamiNoteJudgeSettings") = 'object'
					AND current."hanamiNoteJudgeSettings"->>'promptVersion' ~ '^[1-9][0-9]*$'
					AND (char_length(current."hanamiNoteJudgeSettings"->>'promptVersion') < 10
						OR (char_length(current."hanamiNoteJudgeSettings"->>'promptVersion') = 10 AND current."hanamiNoteJudgeSettings"->>'promptVersion' <= '2147483647'))
				THEN (current."hanamiNoteJudgeSettings"->>'promptVersion')::integer
				END, current."hanamiNoteJudgeSettings"
			FROM (SELECT "hanamiNoteJudgeSettings" FROM "meta" ORDER BY id DESC LIMIT 1) AS current
			WHERE jsonb_typeof(current."hanamiNoteJudgeSettings") = 'object'
				AND current."hanamiNoteJudgeSettings"->>'promptVersion' ~ '^[1-9][0-9]*$'
				AND (char_length(current."hanamiNoteJudgeSettings"->>'promptVersion') < 10
					OR (char_length(current."hanamiNoteJudgeSettings"->>'promptVersion') = 10 AND current."hanamiNoteJudgeSettings"->>'promptVersion' <= '2147483647'))
			ON CONFLICT ("promptVersion") DO NOTHING`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "hanami_note_judge_settings"`);
		await queryRunner.query(`DROP FUNCTION "hanami_note_judge_settings_immutable"()`);
	}
}
