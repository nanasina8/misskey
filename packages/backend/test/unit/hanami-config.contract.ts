/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import { readConfigInt, readHanamiCursorSigningKeys, resolveHanamiConfig } from '@/config.js';

const yamlKeys = [
	{ id: 'current', secret: 'x'.repeat(32) },
	{ id: 'previous', secret: 'y'.repeat(32) },
];

describe('Hanami config contracts', () => {
	test('YAML signing keys are required when the env override is absent', () => {
		expect(() => readHanamiCursorSigningKeys(undefined, undefined)).toThrow('hanamiCursorSigningKeys is required');
	});

	test('lets migrations load config without runtime-only secrets', () => {
		// `pnpm migrate` はDB接続情報しか使わない。鍵未設定でスキーマ適用が止まると復旧できなくなる。
		expect(readHanamiCursorSigningKeys(undefined, undefined, false)).toEqual([]);
		expect(resolveHanamiConfig({}, {}, false).hanamiCursorSigningKeys).toEqual([]);
	});

	test('still validates signing keys that are present even when they are not required', () => {
		expect(() => readHanamiCursorSigningKeys([], undefined, false)).toThrow('1 or 2 keys');
		expect(() => readHanamiCursorSigningKeys([{ id: 'short', secret: 'x'.repeat(31) }], undefined, false)).toThrow('at least 32 bytes');
		expect(readHanamiCursorSigningKeys(yamlKeys, undefined, false)).toEqual(yamlKeys);
	});

	test('tells the operator how to generate a missing signing key', () => {
		expect(() => readHanamiCursorSigningKeys(undefined, undefined)).toThrow('HANAMI_CURSOR_SIGNING_KEYS_JSON');
		expect(() => readHanamiCursorSigningKeys(undefined, undefined)).toThrow('randomBytes');
	});

	test('rejects empty signing key lists, short secrets, and duplicate ids', () => {
		expect(() => readHanamiCursorSigningKeys([], undefined)).toThrow('1 or 2 keys');
		expect(() => readHanamiCursorSigningKeys([{ id: 'short', secret: 'x'.repeat(31) }], undefined)).toThrow('at least 32 bytes');
		expect(() => readHanamiCursorSigningKeys([
			{ id: 'dup', secret: 'x'.repeat(32) },
			{ id: 'dup', secret: 'y'.repeat(32) },
		], undefined)).toThrow('duplicate cursor signing key id: dup');
	});

	test('accepts one-key and two-key rotation configs', () => {
		expect(readHanamiCursorSigningKeys([{ id: 'current', secret: 'x'.repeat(32) }], undefined)).toEqual([
			{ id: 'current', secret: 'x'.repeat(32) },
		]);
		expect(readHanamiCursorSigningKeys(yamlKeys, undefined)).toEqual(yamlKeys);
	});

	test('env override wins over YAML and accepts valid JSON', () => {
		const envKeys = JSON.stringify([{ id: 'env-current', secret: 'z'.repeat(32) }]);

		expect(readHanamiCursorSigningKeys(yamlKeys, envKeys)).toEqual([
			{ id: 'env-current', secret: 'z'.repeat(32) },
		]);
	});

	test('env override rejects malformed JSON and wrong shapes without leaking secrets', () => {
		const malformedSecret = 'super-secret-should-not-leak';
		const wrongShapeSecret = 'another-secret-should-not-leak';

		try {
			readHanamiCursorSigningKeys(undefined, `{"secret":"${malformedSecret}`);
			throw new Error('expected malformed env JSON to throw');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('HANAMI_CURSOR_SIGNING_KEYS_JSON must be valid JSON');
			expect(message).not.toContain(malformedSecret);
		}

		try {
			readHanamiCursorSigningKeys(undefined, JSON.stringify([{ id: 1, secret: wrongShapeSecret }]));
			throw new Error('expected wrong env shape to throw');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).toContain('HANAMI_CURSOR_SIGNING_KEYS_JSON must be a JSON array');
			expect(message).not.toContain(wrongShapeSecret);
		}
	});

	test('readConfigInt enforces finite safe integers and lower bounds', () => {
		for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() => readConfigInt('hanamiGenerationMaxAttempts', value, 3, { min: 1 })).toThrow('finite safe integer');
		}

		expect(() => readConfigInt('hanamiGenerationSyncWaitMs', -1, 2000, { min: 0 })).toThrow('must be >= 0');
		expect(() => readConfigInt('userHibernationDays', 0, 50, { min: 1 })).toThrow('must be >= 1');
	});

	test('user hibernation days cannot exceed the JavaScript Date range', () => {
		expect(() => resolveHanamiConfig({
			hanamiCursorSigningKeys: yamlKeys,
			userHibernationDays: 100_000_001,
		}, {})).toThrow('userHibernationDays must be <= 100000000');
	});

	test('resolveHanamiConfig rejects lease windows that do not exceed worker timeout', () => {
		expect(() => resolveHanamiConfig({
			hanamiCursorSigningKeys: yamlKeys,
			hanamiGenerationWorkerTimeoutMs: 60_000,
			hanamiGenerationLeaseMs: 60_000,
		}, {})).toThrow('must be greater than hanamiGenerationWorkerTimeoutMs');
	});

	test('resolveHanamiConfig returns the expected defaults', () => {
		expect(resolveHanamiConfig({ hanamiCursorSigningKeys: yamlKeys }, {})).toEqual({
			hanamiCursorSigningKeys: yamlKeys,
			hanamiGenerationSyncWaitMs: 2000,
			userHibernationDays: 50,
			hanamiCommonGenerationIntervalMs: 600000,
			hanamiGenerationWorkerTimeoutMs: 60000,
			hanamiGenerationLeaseMs: 75000,
			hanamiGenerationMaxAttempts: 3,
			hanamiGenerationReconcileIntervalMs: 5000,
			hanamiGenerationQueueConcurrency: 4,
		});
	});
});
