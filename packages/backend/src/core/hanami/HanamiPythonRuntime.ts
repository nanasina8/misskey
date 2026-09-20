/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFile } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import * as Path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

export type HanamiNoteJudgeRuntimeStatus = Readonly<{
	available: boolean;
	device: 'cuda' | 'cpu' | null;
	deviceName: string | null;
	reason: string | null;
	probedAt: string;
}>;

const NOTE_JUDGE_RUNTIME_PROBE_TTL_MS = 10 * 60 * 1000;
const NOTE_JUDGE_RUNTIME_PROBE_TIMEOUT_MS = 60 * 1000;
let noteJudgeRuntimeCache: { status: HanamiNoteJudgeRuntimeStatus; expiresAt: number } | null = null;

export function resolveHanamiNoteJudgeScript(env: NodeJS.ProcessEnv = process.env): string {
	return env.HANAMI_NOTE_JUDGE_SCRIPT ?? Path.join(resolveHanamiRepoRoot(), 'packages/backend/src/core/hanami/HanamiNoteJudgeCpu.py');
}

/**
 * ノート判定（Qwen3-4B）を動かしてよいか。GPU が無ければ動かさない（CPU は実用外の速度）。
 * `HANAMI_NOTE_JUDGE_DEVICE=cpu` で明示した場合だけ CPU を許可する。結果は 10 分キャッシュ。
 */
export async function probeHanamiNoteJudgeRuntime(options: { env?: NodeJS.ProcessEnv; force?: boolean } = {}): Promise<HanamiNoteJudgeRuntimeStatus> {
	const env = options.env ?? process.env;
	const requested = env.HANAMI_NOTE_JUDGE_DEVICE?.trim().toLowerCase() ?? '';
	if (requested === 'cpu') {
		return { available: true, device: 'cpu', deviceName: 'cpu (forced by HANAMI_NOTE_JUDGE_DEVICE)', reason: null, probedAt: new Date().toISOString() };
	}
	if (!options.force && noteJudgeRuntimeCache != null && noteJudgeRuntimeCache.expiresAt > Date.now()) return noteJudgeRuntimeCache.status;
	const command = prepareHanamiPythonCommand([resolveHanamiNoteJudgeScript(env), '--probe'], { env });
	let status: HanamiNoteJudgeRuntimeStatus;
	try {
		const { stdout } = await execFileAsync(command.file, command.args, { env: command.env, timeout: NOTE_JUDGE_RUNTIME_PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
		const probe = JSON.parse(stdout.trim().split('\n').pop() ?? '{}') as { cudaAvailable?: boolean; deviceName?: string | null; error?: string | null };
		status = probe.cudaAvailable === true
			? { available: true, device: 'cuda', deviceName: probe.deviceName ?? 'cuda', reason: null, probedAt: new Date().toISOString() }
			: { available: false, device: null, deviceName: null, reason: probe.error ?? 'GPU (CUDA) is not available; set HANAMI_NOTE_JUDGE_DEVICE=cpu to force CPU', probedAt: new Date().toISOString() };
	} catch (error) {
		status = { available: false, device: null, deviceName: null, reason: `probe failed: ${(error as Error).message}`, probedAt: new Date().toISOString() };
	}
	noteJudgeRuntimeCache = { status, expiresAt: Date.now() + NOTE_JUDGE_RUNTIME_PROBE_TTL_MS };
	return status;
}

/**
 * キャッシュだけを見る（プロセスを起動しない）。未探索なら null。
 * 個人生成のような時間予算のある経路用。キャッシュは判定ジョブの準備（reconcile 5 秒ごと）や
 * 管理画面の status が温める。
 */
export function peekHanamiNoteJudgeRuntime(env: NodeJS.ProcessEnv = process.env): HanamiNoteJudgeRuntimeStatus | null {
	const requested = env.HANAMI_NOTE_JUDGE_DEVICE?.trim().toLowerCase() ?? '';
	if (requested === 'cpu') return { available: true, device: 'cpu', deviceName: 'cpu (forced by HANAMI_NOTE_JUDGE_DEVICE)', reason: null, probedAt: new Date().toISOString() };
	if (noteJudgeRuntimeCache != null && noteJudgeRuntimeCache.expiresAt > Date.now()) return noteJudgeRuntimeCache.status;
	return null;
}

export function prepareHanamiPythonCommand(args: readonly string[], options: { env?: NodeJS.ProcessEnv; repoRoot?: string } = {}): HanamiPythonCommand {
	const env = options.env ?? process.env;
	return {
		file: resolveHanamiPython({ env, repoRoot: options.repoRoot }),
		args: [...args],
		env: hanamiPythonEnv(env),
	};
}
