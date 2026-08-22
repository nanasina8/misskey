/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from '@jest/globals';
import { hanamiReturningRows } from '@/core/hanami/HanamiReturningRows.js';

const hanamiDir = join(dirname(fileURLToPath(import.meta.url)), '../../src/core/hanami');

type SqlSite = {
	file: string;
	line: number;
	command: string;
	wrapped: boolean;
	discarded: boolean;
};

/** テンプレートリテラルの外側の実行コマンドを返す（CTEは最後のトップレベルDMLを採用）。 */
function outerCommand(sql: string): string {
	const head = sql.replace(/\s+/g, ' ').trim().toUpperCase();
	const first = head.split(' ', 1)[0]!;
	if (first !== 'WITH') return first;
	const outer = [...head.matchAll(/\)\s*(INSERT|UPDATE|DELETE)\b/g)].map(m => m[1]!);
	return outer.at(-1) ?? '?';
}

function collectSites(): SqlSite[] {
	const sites: SqlSite[] = [];
	for (const name of readdirSync(hanamiDir).filter(f => f.endsWith('.ts')).sort()) {
		const source = readFileSync(join(hanamiDir, name), 'utf-8');
		for (const match of source.matchAll(/`([^`]*?)`/gs)) {
			const sql = match[1]!;
			if (!sql.toUpperCase().includes('RETURNING')) continue;
			const command = outerCommand(sql);
			if (command !== 'UPDATE' && command !== 'DELETE') continue;

			const start = match.index!;
			const awaitAt = source.lastIndexOf('await ', start);
			if (awaitAt < 0) continue;
			const before = source.slice(source.lastIndexOf('\n', awaitAt) + 1, awaitAt);
			sites.push({
				file: name,
				line: source.slice(0, start).split('\n').length,
				command,
				wrapped: before.includes('hanamiReturningRows('),
				// 結果を捨てている式文（行頭がそのまま `await`）は取り違えようがない。
				discarded: before.trim().length === 0,
			});
		}
	}
	return sites;
}

describe('Hanami RETURNING row normalisation', () => {
	test('unwraps the [rows, rowCount] tuple that TypeORM returns for UPDATE/DELETE', () => {
		const rows = [{ id: 'a' }, { id: 'b' }];
		expect(hanamiReturningRows([rows, 2])).toBe(rows);
		expect(hanamiReturningRows([[], 0])).toEqual([]);
	});

	test('passes SELECT/INSERT row arrays through untouched', () => {
		const rows = [{ id: 'a' }];
		expect(hanamiReturningRows(rows)).toBe(rows);
		expect(hanamiReturningRows([])).toEqual([]);
		// 行はオブジェクトなので、2行のSELECT結果をタプルと取り違えない。
		const twoRows = [{ id: 'a' }, { id: 'b' }];
		expect(hanamiReturningRows(twoRows)).toBe(twoRows);
	});

	test('every consumed UPDATE/DELETE ... RETURNING in core/hanami is normalised', () => {
		const sites = collectSites();
		// 走査そのものが壊れていないことの担保。
		expect(sites.length).toBeGreaterThan(20);

		const unnormalised = sites
			.filter(site => !site.wrapped && !site.discarded)
			.map(site => `${site.file}:${site.line} (${site.command})`);

		// TypeORMのPostgresドライバは UPDATE/DELETE のとき [rows, rowCount] を返すため、
		// 素の行配列として扱うと length が常に2になりCAS判定が必ず失敗する。
		expect(unnormalised).toEqual([]);
	});
});
