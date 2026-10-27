/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as Path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from 'vitest';
import { HANAMI_PYTHON_THREAD_ENV, prepareHanamiPythonCommand, resolveHanamiPython, resolveHanamiRepoRoot } from '@/core/hanami/HanamiPythonRuntime.js';

test('Hanami Python runtime follows override, executable repo venv, then python3 priority', () => {
	const root = mkdtempSync(Path.join(tmpdir(), 'hanami-python-runtime-'));
	try {
		const venvPython = Path.join(root, '.venv-hanami-foryou', 'bin', 'python');
		mkdirSync(Path.dirname(venvPython), { recursive: true });
		writeFileSync(venvPython, '#!/bin/sh\n', { encoding: 'utf8', flag: 'w' });
		chmodSync(venvPython, 0o644);
		expect(resolveHanamiPython({ env: {}, repoRoot: root })).toBe('python3');
		chmodSync(venvPython, 0o755);
		expect(resolveHanamiPython({ env: {}, repoRoot: root })).toBe(venvPython);
		expect(resolveHanamiPython({ env: { HANAMI_FORYOU_PYTHON: '/opt/python' }, repoRoot: root })).toBe('/opt/python');
		expect(resolveHanamiPython({ env: { HANAMI_FORYOU_PYTHON: '  ' }, repoRoot: root })).toBe(venvPython);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('Hanami Python runtime retains inherited env, resolves from module location, and never turns interpreter input into shell syntax', () => {
	const injection = 'python3; touch /not-run';
	const command = prepareHanamiPythonCommand(['worker.py', 'in.json'], {
		env: { HANAMI_FORYOU_PYTHON: injection, REQUIRED_VALUE: 'kept', OMP_NUM_THREADS: '99' },
	});
	expect(command.file).toBe(injection);
	expect(command.args).toEqual(['worker.py', 'in.json']);
	expect(command.env).toEqual(expect.objectContaining({ REQUIRED_VALUE: 'kept', ...HANAMI_PYTHON_THREAD_ENV }));
});

test('Hanami repo root is found from both the source tree and the flat bundled build', () => {
	const root = mkdtempSync(Path.join(tmpdir(), 'hanami-repo-root-'));
	try {
		writeFileSync(Path.join(root, 'pnpm-workspace.yaml'), '');
		const source = Path.join(root, 'packages/backend/src/core/hanami/HanamiPythonRuntime.ts');
		const bundled = Path.join(root, 'packages/backend/built/chunk-abc123.js');
		mkdirSync(Path.dirname(source), { recursive: true });
		mkdirSync(Path.dirname(bundled), { recursive: true });
		expect(resolveHanamiRepoRoot(pathToFileURL(source).href)).toBe(root);
		expect(resolveHanamiRepoRoot(pathToFileURL(bundled).href)).toBe(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
