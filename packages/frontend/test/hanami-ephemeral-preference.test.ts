/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../src/pages/settings/hanamode.vue'), 'utf8');

describe('Hanami ephemeral-post preference contract', () => {
	test('defaults on and persists account updates immediately', () => {
		expect(source).toContain('account.hanamiReduceEphemeralPosts ?? true');
		expect(source).toContain("<template #label>その場限りの投稿を控えめにする</template>");
		expect(source).toMatch(/saveHanamiReduceEphemeralPosts[\s\S]*?i\/update/);
		expect(source).toContain('updateCurrentAccount(patch');
		expect(source).toContain('hanamiReduceEphemeralPosts: value');
	});
});
