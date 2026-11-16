/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { beforeAll } from 'vitest';
import { initTestDb, sendEnvResetRequest } from './utils.js';

beforeAll(async () => {
	// 前ファイルのNestJSアプリをdispose(env-reset)した後にスキーマをdrop & 再作成する。
	// 逆順だと、前ファイルの最後のテストが投げっぱなしにした非同期処理(cacheServiceのrefresh等)が
	// dispose前のdrop中に発火し、Unhandled Rejection (relation does not exist) でクラッシュしうる。
	await sendEnvResetRequest();
	await initTestDb(false);
	// migration で作ったテスト DB（MISSKEY_TEST_DB_MIGRATIONS=1）は drop せず TRUNCATE するだけなので、
	// 上の env-reset で起動し直したアプリは「消す前」の meta（rootUserId など）を読み込んでいる。
	// そのままだと 2 ファイル目以降で最初のユーザーが管理者にならず、管理 API が 403 になる。
	// 空にした後でもう一度起動し直して、空の状態を読ませる。
	if (process.env.MISSKEY_TEST_DB_MIGRATIONS === '1') await sendEnvResetRequest();
});
