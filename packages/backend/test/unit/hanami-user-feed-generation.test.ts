/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import { classifyHanamiMetricsFailure } from '@/core/hanami/HanamiMetricsFailure.js';

describe('Hanami personal generation failure classification', () => {
	test('classifies an empty result', () => {
		expect(classifyHanamiMetricsFailure(new Error('Hanami personal generation produced an empty result'))).toEqual({
			failureKind: 'emptyResult', failureMessage: 'produced an empty result',
		});
	});

	test.each(['candidate count exceeded 1200', 'Candidate Note count exceeds 1200'])('classifies RangeError: %s', (message) => {
		expect(classifyHanamiMetricsFailure(new RangeError(message))).toEqual({
			failureKind: 'candidateLimit', failureMessage: 'candidate limit exceeded',
		});
	});

	test.each([
		Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' }),
		Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }),
		Object.assign(new Error('query failed'), {
			driverError: { code: '55P03', message: 'canceling statement due to lock timeout' },
		}),
		Object.assign(new Error('query failed'), {
			driverError: { code: '57014', message: 'canceling statement due to statement timeout' },
		}),
		new Error('Hanami user feed generation private-batch exceeded its worker timeout'),
		new Error('Hanami personal-generation database deadline expired'),
		new Error('Hanami user feed generation lease is no longer current'),
	])('classifies actual PostgreSQL and generation timeouts (case %#)', (error) => {
		expect(classifyHanamiMetricsFailure(error)).toEqual({
			failureKind: 'lockTimeout', failureMessage: 'generation lock, lease or deadline timed out',
		});
	});

	test.each([
		new Error('unexpected computation failure'),
		new Error('candidate count exceeded 1200'),
		new RangeError('invalid range'),
		Object.assign(new Error('could not obtain lock on row in relation "private"'), { code: '55P03' }),
		Object.assign(new Error('canceling statement due to user request'), { code: '57014' }),
		new Error('Invalid Hanami database deadline'),
		new Error('Hanami user generation database deadline is not established'),
		new Error('unrelated network timeout'),
		new Error('Hanami personal-feed seed has an unhealable constraint violation'),
		null,
		undefined,
		'private non-Error rejection',
		{ userId: 'private-user', toString: () => { throw new Error('must not stringify'); } },
	])('falls back without mistaking contention/configuration errors for timeouts (case %#)', (error) => {
		expect(classifyHanamiMetricsFailure(error)).toEqual({
			failureKind: 'exception', failureMessage: 'generation failed with an exception',
		});
	});

	test('never persists raw identifiers, SQL, URLs, credentials, note text or stack traces', () => {
		const sensitive = 'userId=private-user noteId=private-note batchId=private-batch '
			+ 'https://private.example/notes/123 token=secret SELECT * FROM "user"; '
			+ 'Key (id)=(9f6c8eda-992a-4c99-a52c-414639c8418b) private note text\n\0\tat private/file.ts:1';
		for (const error of [
			new Error(sensitive),
			new Error(`produced an empty result: ${sensitive}`),
			new RangeError(`candidate limit exceeded: ${sensitive}`),
			Object.assign(new Error(`canceling statement due to lock timeout: ${sensitive}`), { code: '55P03' }),
		]) {
			const result = classifyHanamiMetricsFailure(error);
			expect(result.failureMessage).not.toMatch(/private|secret|SELECT|9f6c8eda|\n|\0/);
			expect(result.failureMessage.length).toBeLessThanOrEqual(512);
			expect(result.failureKind.length).toBeLessThanOrEqual(32);
		}
	});

	test.each([511, 512, 513, 20_000])('bounds messages even for %i characters of sensitive input', (length) => {
		// Canonical replacement is stricter than truncating raw input: neither an
		// identifier in the first 512 characters nor one beyond the limit survives.
		const error = new Error(`private-user ${'🔒'.repeat(length)} private-note`);
		expect(classifyHanamiMetricsFailure(error)).toEqual({
			failureKind: 'exception', failureMessage: 'generation failed with an exception',
		});
		expect(classifyHanamiMetricsFailure(error).failureMessage.length).toBeLessThanOrEqual(512);
	});
});
