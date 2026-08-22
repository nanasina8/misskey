/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * TypeORMのPostgresドライバは `raw.command` によって `query()` の返り値の形を変える
 * （`PostgresQueryRunner.query()`）。
 *
 * - `SELECT` / `INSERT` … `rows`（行の配列）
 * - `UPDATE` / `DELETE` … `[rows, rowCount]` の2要素タプル
 *
 * このため `UPDATE ... RETURNING` の結果をそのまま行配列として扱うと、`length` が常に2になり、
 * `at(0)` は行ではなく内側の配列を返す。CASの成否を `length !== 1` で判定している箇所では
 * 「必ず失敗する」という形で表面化する。
 *
 * 生SQLで `UPDATE` / `DELETE` に `RETURNING` を付ける箇所は必ずこの関数を通すこと。
 * `SELECT` / `INSERT` は素の行配列が返るため、通しても通さなくても同じ結果になる。
 */
export function hanamiReturningRows<T>(result: T[] | readonly [T[], number]): T[] {
	if (!Array.isArray(result)) return [];
	// 行はオブジェクトなので、`[配列, 数値]` は UPDATE/DELETE のタプル以外にはなり得ない。
	if (result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
		return result[0] as T[];
	}
	return result as T[];
}
