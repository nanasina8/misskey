/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { randomBytes } from 'node:crypto';
import { Client, type QueryResultRow } from 'pg';
import { describe, expect, test } from 'vitest';
import { HanamiTasteClusterBatchService } from '@/core/hanami/HanamiTasteClusterBatchService.js';
import { HanamiForYouDataLayer1782950400000 } from '../../migration/1782950400000-hanamiForYouDataLayer.js';
import { HanamiTasteCluster1783036800000 } from '../../migration/1783036800000-hanamiTasteCluster.js';
import { HanamiTasteModelColumn1783123200000 } from '../../migration/1783123200000-hanamiTasteModelColumn.js';

const databaseUrl = process.env.HANAMI_SCHEMA_TEST_DATABASE_URL;
const MODEL = 'intfloat/multilingual-e5-base';

type Query = <T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) => Promise<T[]>;

type TasteInternals = {
	upsertNoteEmbeddings(embeddings: [string, number[]][], dim: number, updateExisting: boolean): Promise<void>;
	appendEvidence(sinceId: string, eligibleIds: string[], logger: { info: (message: string) => void }): Promise<void>;
};

const withSchema = async (run: (query: Query) => Promise<void>): Promise<void> => {
	const schema = `hanami_taste_contract_${Date.now()}_${randomBytes(4).toString('hex')}`;
	const schemaName = `"${schema}"`;
	const client = new Client({ connectionString: databaseUrl });
	const query: Query = async <T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> => (await client.query<T>(sql, values)).rows;
	try {
		await client.connect();
		await query(`CREATE SCHEMA ${schemaName}`);
		await query(`SET search_path TO ${schemaName}, public`);
		await query('CREATE TABLE "user" ("id" character varying(32) PRIMARY KEY)');
		await query('CREATE TABLE "note" ("id" character varying(32) PRIMARY KEY)');
		await new HanamiForYouDataLayer1782950400000().up({ query });
		await new HanamiTasteCluster1783036800000().up({ query });
		await new HanamiTasteModelColumn1783123200000().up({ query });
		await run(query);
	} finally {
		await query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
		await client.end().catch(() => undefined);
	}
};

const idService = {
	gen: (time: number) => `${String(time).padStart(13, '0')}-floor`,
	parse: (id: string) => ({ date: new Date(Number(id.slice(0, 13))) }),
};

describe('Hanami taste embedding DB-backed contracts', () => {
	if (!databaseUrl) {
		if (process.env.CI) {
			test('requires HANAMI_SCHEMA_TEST_DATABASE_URL in CI', () => {
				throw new Error('HANAMI_SCHEMA_TEST_DATABASE_URL must be set in CI for the Hanami taste embedding DB contract suite.');
			});
		} else {
			test.skip('skipped: set HANAMI_SCHEMA_TEST_DATABASE_URL for PostgreSQL access', () => undefined);
		}
		return;
	}

	test('stores embeddings for the notes that still exist when one of the batch was deleted meanwhile', async () => {
		await withSchema(async (query) => {
			await query('INSERT INTO "note" ("id") VALUES ($1), ($2)', ['note-a', 'note-b']);
			const service = new HanamiTasteClusterBatchService({ query } as never, {} as never, idService as never, {} as never) as unknown as TasteInternals;

			// 埋め込みを計算している間に note-gone が消された。以前は外部キー違反で 3 件とも保存されなかった。
			await service.upsertNoteEmbeddings([['note-a', [0.1, 0.2]], ['note-gone', [0.3, 0.4]], ['note-b', [0.5, 0.6]]], 2, false);
			expect(await query('SELECT "noteId", model, dim, embedding FROM "hanami_note_embedding" ORDER BY "noteId"')).toEqual([
				{ noteId: 'note-a', model: MODEL, dim: 2, embedding: [expect.closeTo(0.1, 5), expect.closeTo(0.2, 5)] },
				{ noteId: 'note-b', model: MODEL, dim: 2, embedding: [expect.closeTo(0.5, 5), expect.closeTo(0.6, 5)] },
			]);

			// 既にある行は、通常の保存では上書きせず、作り直し（updateExisting）では上書きする。
			await service.upsertNoteEmbeddings([['note-a', [0.9, 0.9]]], 2, false);
			expect((await query<{ embedding: number[] }>('SELECT embedding FROM "hanami_note_embedding" WHERE "noteId" = $1', ['note-a']))[0]!.embedding[0]).toBeCloseTo(0.1, 5);
			await service.upsertNoteEmbeddings([['note-a', [0.9, 0.9]], ['note-gone', [0.3, 0.4]]], 2, true);
			expect((await query<{ embedding: number[] }>('SELECT embedding FROM "hanami_note_embedding" WHERE "noteId" = $1', ['note-a']))[0]!.embedding[0]).toBeCloseTo(0.9, 5);
			expect(await query('SELECT 1 FROM "hanami_note_embedding" WHERE "noteId" = $1', ['note-gone'])).toEqual([]);
		});
	});

	test('appends taste evidence for the notes that still exist when one was deleted meanwhile', async () => {
		await withSchema(async (query) => {
			await query('INSERT INTO "note" ("id") VALUES ($1), ($2)', ['0000000001000-a', '0000000002000-b']);
			const actionAt = Date.now() - 60_000;
			const actionId = idService.gen(actionAt);
			// 集める側の SELECT は決まった行を返し、保存の INSERT だけを実 DB に流す。
			const db = {
				query: async (sql: string, values?: unknown[]) => {
					if (sql.includes('INSERT INTO "hanami_foryou_taste_evidence"')) return await query(sql, values);
					if (sql.includes('FROM note_reaction r')) {
						return [
							{ uid: 'user-1', nid: '0000000001000-a', emb: [0.5, -0.5], actid: actionId },
							{ uid: 'user-1', nid: '0000000009000-gone', emb: [0.25, 0.25], actid: actionId },
							{ uid: 'user-2', nid: '0000000002000-b', emb: [1, 0], actid: actionId },
						];
					}
					return [];
				},
			};
			const service = new HanamiTasteClusterBatchService(db as never, {} as never, idService as never, {} as never) as unknown as TasteInternals;
			(service as unknown as { embedMissingEngagedNotes: () => Promise<void> }).embedMissingEngagedNotes = async () => undefined;

			await service.appendEvidence(idService.gen(0), ['user-1', 'user-2'], { info: () => undefined });

			expect(await query('SELECT "userId", "noteId", src, model, octet_length(vector) AS bytes FROM "hanami_foryou_taste_evidence" ORDER BY "userId"')).toEqual([
				{ userId: 'user-1', noteId: '0000000001000-a', src: 'R', model: MODEL, bytes: 4 },
				{ userId: 'user-2', noteId: '0000000002000-b', src: 'R', model: MODEL, bytes: 4 },
			]);
		});
	});
});
