/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const judgeBasisKeys = ['ephemeralA', 'ephemeralB', 'interest1', 'interest2', 'interest3', 'interest4', 'interest5'] as const;

export type JudgeSettings = {
	schemaVersion: number;
	promptVersion: number;
	ephemeralThreshold: number;
	interestThreshold: number;
	reactionMax: number;
	interestMax: number;
	basis: Record<typeof judgeBasisKeys[number], string>;
	examples: string[];
	templatePatterns: string[];
	contentTypeBonus: number[];
};

export type JudgeFormState = Omit<JudgeSettings, 'templatePatterns'> & { templatePatternsText: string };

export function judgeSettingsToForm(settings: JudgeSettings): JudgeFormState {
	const { templatePatterns, ...rest } = settings;
	return { ...rest, basis: { ...rest.basis }, examples: [...rest.examples], contentTypeBonus: [...rest.contentTypeBonus], templatePatternsText: templatePatterns.join('\n') };
}

export function judgeFormToSettings(form: JudgeFormState): JudgeSettings {
	const { templatePatternsText, ...rest } = form;
	return { ...rest, basis: { ...rest.basis }, examples: [...rest.examples], contentTypeBonus: [...rest.contentTypeBonus], templatePatterns: templatePatternsText.split(/\r?\n/).filter(line => line.length > 0) };
}

/** Same fields and order as the server's normalized prompt fingerprint. */
export function judgePromptChanged(before: JudgeSettings, after: JudgeSettings): boolean {
	const fingerprint = (settings: JudgeSettings) => JSON.stringify({
		basis: judgeBasisKeys.map(key => settings.basis[key]),
		examples: settings.examples,
		templatePatterns: settings.templatePatterns,
	});
	return fingerprint(before) !== fingerprint(after);
}

/** Original editor line indexes, not indexes after blank lines have been removed. */
export function judgeRegexRows(text: string): { index: number; pattern: string; invalid: boolean }[] {
	return text.split(/\r?\n/).map((pattern, index) => {
		try {
			// Match backend validation and rule execution, including Unicode syntax.
			void new RegExp(pattern, 'iu');
			return { index, pattern, invalid: false };
		} catch {
			return { index, pattern, invalid: true };
		}
	});
}

export function judgeFormValid(form: JudgeFormState): boolean {
	const settings = judgeFormToSettings(form);
	return judgeBasisKeys.every(key => settings.basis[key].trim().length > 0 && settings.basis[key].length <= 2000)
		&& settings.examples.length <= 30 && settings.examples.every(text => text.trim().length > 0 && text.length <= 2000)
		&& settings.templatePatterns.length <= 100 && settings.templatePatterns.every(text => text.length <= 512)
		&& !judgeRegexRows(form.templatePatternsText).some(row => row.invalid)
		&& [settings.ephemeralThreshold, settings.interestThreshold, settings.reactionMax, settings.interestMax].every(value => typeof value === 'number' && Number.isFinite(value))
		&& settings.reactionMax >= 0 && settings.interestMax >= 0
		&& settings.contentTypeBonus.length === 10 && settings.contentTypeBonus.every(value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10);
}

export function judgeTrialAvailable(runtime: { available: boolean; device?: string | null } | null | undefined): boolean {
	// P2 explicitly disallows the interactive trial without a working GPU.
	return runtime?.available === true && runtime.device === 'cuda';
}

export function judgeSecondsPerNote(params: Record<string, unknown> | null | undefined): number | null {
	const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
	if (finite(params?.secondsPerItem)) return params.secondsPerItem;
	if (finite(params?.wallDurationMs) && finite(params.processedCount) && params.processedCount > 0) return params.wallDurationMs / 1000 / params.processedCount;
	return null;
}

/** Missing cohort information is not a zero, nor is the 24h judged count a candidate count. */
export function judgeRejudgeEstimate(backlog: number | null | undefined, candidates: number | null | undefined, secondsPerNote: number | null) {
	const count = backlog != null && candidates != null ? backlog + candidates : null;
	return { count, seconds: count != null && secondsPerNote != null ? count * secondsPerNote : null };
}

export function createJudgeDebounce(run: () => void, delay = 600) {
	let timer: ReturnType<typeof globalThis['setTimeout']> | undefined;
	const cancel = () => {
		if (timer !== undefined) globalThis.clearTimeout(timer);
		timer = undefined;
	};
	return {
		cancel,
		schedule() {
			cancel();
			timer = globalThis.setTimeout(() => { timer = undefined; run(); }, delay);
		},
	};
}

// Fixed Japanese choices used by the model and both admin tabs.
export const judgeContentTypes = ['挨拶・相づち・定型文', 'ニュース・情報の共有', '解説・知識・ハウツー', '意見・考察・問題提起', '出来事・体験談・エピソード', 'ユーモア・ネタ・大喜利', '作品の投稿', '写真・食事・日常の記録', '告知・宣伝・募集・企画参加', '近況・独り言・感情の吐露'];
export function typeLabel(value: number | string | null | undefined, unjudged: string): string {
	if (value == null) return '—';
	return /^[0-9]$/.test(String(value)) ? judgeContentTypes[Number(value)] : unjudged;
}
