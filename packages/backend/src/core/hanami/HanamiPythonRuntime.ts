/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { accessSync, constants } from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HANAMI_PYTHON_THREAD_ENV = {
	OMP_NUM_THREADS: '2',
	MKL_NUM_THREADS: '2',
	OPENBLAS_NUM_THREADS: '2',
	NUMEXPR_NUM_THREADS: '2',
	TOKENIZERS_PARALLELISM: 'false',
} as const;

export type HanamiPythonCommand = {
	file: string;
	args: readonly string[];
	env: NodeJS.ProcessEnv;
};

/** Resolve the repository without depending on process.cwd() (workers run from arbitrary cwd). */
export function resolveHanamiRepoRoot(moduleUrl = import.meta.url): string {
	return Path.resolve(Path.dirname(fileURLToPath(moduleUrl)), '../../../../../');
}

/**
 * Select an interpreter as an executable file, never as a shell command.
 * A blank override deliberately behaves as if it were unset.
 */
export function resolveHanamiPython(options: { env?: NodeJS.ProcessEnv; repoRoot?: string } = {}): string {
	const env = options.env ?? process.env;
	const configured = env.HANAMI_FORYOU_PYTHON?.trim();
	if (configured) return configured;

	const venvPython = Path.join(options.repoRoot ?? resolveHanamiRepoRoot(), '.venv-hanami-foryou', 'bin', 'python');
	try {
		accessSync(venvPython, constants.X_OK);
		return venvPython;
	} catch {
		return 'python3';
	}
}

/** Keep inherited operational environment while enforcing bounded CPU parallelism. */
export function hanamiPythonEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...base, ...HANAMI_PYTHON_THREAD_ENV };
}

export function prepareHanamiPythonCommand(args: readonly string[], options: { env?: NodeJS.ProcessEnv; repoRoot?: string } = {}): HanamiPythonCommand {
	const env = options.env ?? process.env;
	return {
		file: resolveHanamiPython({ env, repoRoot: options.repoRoot }),
		args: [...args],
		env: hanamiPythonEnv(env),
	};
}
