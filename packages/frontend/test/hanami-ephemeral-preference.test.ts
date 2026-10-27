/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const source = readFileSync(resolve(__dirname, '../src/pages/settings/hanamode.vue'), 'utf8');
const panel = readFileSync(resolve(__dirname, '../src/components/MkHanamiTuningPanel.vue'), 'utf8');
const client = readFileSync(resolve(__dirname, '../src/utility/hanami-tuning-client.ts'), 'utf8');

describe('Hanami ephemeral-post preference contract', () => {
	test('shares the tuning panel with default-on immediate persistence', () => {
		expect(source).toContain('<MkHanamiTuningPanel ');
		expect(source).not.toMatch(/MkFormFooter|suggestReload|axisEditor/);
		expect(panel).toContain('hanamiReduceEphemeralPosts: $event');
		expect(client).toContain('$i?.hanamiReduceEphemeralPosts ?? true');
		expect(client).toContain("await misskeyApi('i/update', patch)");
		expect(client).toContain('updateCurrentAccount(patch)');
	});
});
