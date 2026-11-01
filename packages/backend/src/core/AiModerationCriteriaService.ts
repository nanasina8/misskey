/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { AiModerationCriteriaRepository, MiMeta } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { resolveHanamiSpamJudgeScript } from '@/core/hanami/HanamiPythonRuntime.js';
import {
	aiModerationCriteriaVersion,
	buildAiModerationCriteria,
	type AiModerationCriteria,
} from '@/misc/ai-moderation.js';

export const AI_MODERATION_LOCAL_MODEL = 'Qwen/Qwen3-4B-Instruct-2507';

/**
 * いまの判定条件（モデル・判定スクリプト・閾値・点数）とその版を返し、初めての版は記録する。
 */
@Injectable()
export class AiModerationCriteriaService {
	private scriptSha: Promise<string | null> | null = null;
	private savedVersions = new Set<string>();

	constructor(
		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.aiModerationCriteriaRepository)
		private aiModerationCriteriaRepository: AiModerationCriteriaRepository,
	) {
	}

	@bindThis
	public async current(): Promise<{ version: string; criteria: AiModerationCriteria }> {
		// 判定スクリプトは入れ替え（デプロイ）でしか変わらないので、プロセスごとに1回だけ読む
		this.scriptSha ??= readFile(resolveHanamiSpamJudgeScript())
			.then(buf => createHash('sha256').update(buf).digest('hex').slice(0, 16))
			.catch(() => null);

		const criteria = buildAiModerationCriteria({
			model: AI_MODERATION_LOCAL_MODEL,
			judgeScriptSha: await this.scriptSha,
			localThreshold: this.meta.aiModerationLocalThreshold,
			autoHideThreshold: this.meta.aiModerationAutoHideThreshold,
			newAuthorDays: this.meta.aiModerationNewAuthorDays,
			externalEnabled: this.meta.aiModerationExternalEnabled,
			externalModel: this.meta.aiModerationExternalModel,
		});
		const version = aiModerationCriteriaVersion(criteria);

		if (!this.savedVersions.has(version)) {
			await this.aiModerationCriteriaRepository.createQueryBuilder()
				.insert()
				.values({ id: version, criteria: () => ':criteria::jsonb', firstUsedAt: new Date() })
				.setParameter('criteria', JSON.stringify(criteria))
				.orIgnore()
				.execute();
			this.savedVersions.add(version);
		}

		return { version, criteria };
	}
}
