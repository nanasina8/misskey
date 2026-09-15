import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/pages/admin/performance.vue'), 'utf8');

describe('HJ-01 admin judge UI source contract', () => {
	test('uses literal, inferred judge endpoint contracts and required controls', () => {
		expect(source).toMatch(/misskeyApi\('admin\/hanami\/judge-settings'(?:\)|, \{ settings:)/);
		expect(source).toContain("misskeyApi('admin/hanami/judge-status')");
		expect(source).toContain("misskeyApi('admin/hanami/judge-trial', { limit: 50, settings: judgeDraftSettings() })");
		expect(source).toContain("misskeyApi('admin/hanami/judge-aggregate')");
		for (const control of ['ephemeralA', 'ephemeralB', 'interest1', 'interest2', 'interest3', 'interest4', 'interest5', 'q1Examples', 'q1Templates', 'q2Examples', 'q2Templates', 'thetaEMax', 'thetaIMax', 'reactionMax', 'interestMax']) {
			expect(source).toContain(control);
		}
		expect(source).toContain('limit: 50');
		expect(source).toContain('設定を保存');
		expect(source).toContain('下書き設定で試行（最新50件）');
	});

	test('binds and persists every judge basis value', () => {
		for (const key of ['ephemeralA', 'ephemeralB', 'interest1', 'interest2', 'interest3', 'interest4', 'interest5']) {
			expect(source).toContain(`v-model="judgeSettings.${key}"`);
			expect(source).toContain(`${key}: judgeSettingsRaw.value.basis?.${key} ?? ''`);
			expect(source).toContain(`${key}: judgeSettings.value.${key}`);
		}
		expect(source).toContain('...judgeSettingsRaw.value.basis');
		expect(source).toContain('function judgeDraftSettings()');
		expect(source).toContain('async function runJudgeTrial()');
	});

	test('does not mask judge endpoint contracts', () => {
		const judgeSource = source.slice(source.indexOf('type JudgeSettings'), source.indexOf('type TasteRebuildStatus'));
		expect(judgeSource).not.toContain('judgeApi');
		expect(judgeSource).not.toContain('as never');
		expect(judgeSource).not.toContain('Record<string, any>');
		expect(judgeSource).not.toContain('JudgePayload');
	});
});
