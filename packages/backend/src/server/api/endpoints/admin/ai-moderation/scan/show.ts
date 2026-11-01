/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { AiModerationCriteriaRepository, AiModerationScanItemRepository, AiModerationScanRepository, NotesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { IdService } from '@/core/IdService.js';
import { AiModerationScanService } from '@/core/AiModerationScanService.js';
import { packedAiModerationScanSchema } from '@/models/json-schema/ai-moderation-scan.js';

const countList = (key: string) => ({
	type: 'array',
	optional: false, nullable: false,
	items: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			[key]: { type: 'string', optional: false, nullable: true },
			items: { type: 'number', optional: false, nullable: false },
			accounts: { type: 'number', optional: false, nullable: false },
			wouldHideAccounts: { type: 'number', optional: false, nullable: false },
		},
	},
} as const);

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'read:admin:ai-moderation',

	description: '全体スキャンの進み具合と集計（判定の内訳・サーバー・リンク・目印・判定条件の版）。scanId を省くといちばん新しいもの。',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			scan: { ...packedAiModerationScanSchema, nullable: true },
			scans: { type: 'array', optional: false, nullable: false, items: packedAiModerationScanSchema },
			progress: { type: 'number', optional: false, nullable: true },
			etaSeconds: { type: 'number', optional: false, nullable: true },
			criteria: { type: 'object', optional: false, nullable: true },
			byLabel: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						label: { type: 'string', optional: false, nullable: true },
						items: { type: 'number', optional: false, nullable: false },
						flagged: { type: 'number', optional: false, nullable: false },
					},
				},
			},
			hosts: countList('host'),
			links: countList('link'),
			signals: countList('signal'),
			criteriaVersions: countList('version'),
			external: {
				type: 'object',
				optional: false, nullable: true,
				description: '外部 API の分（useExternal のスキャンだけ）。both 等は送り終えた項目での Qwen と外部の食い違い',
				properties: {
					pending: { type: 'number', optional: false, nullable: false },
					done: { type: 'number', optional: false, nullable: false },
					skipped: { type: 'number', optional: false, nullable: false },
					failed: { type: 'number', optional: false, nullable: false },
					flagged: { type: 'number', optional: false, nullable: false },
					both: { type: 'number', optional: false, nullable: false },
					localOnly: { type: 'number', optional: false, nullable: false },
					externalOnly: { type: 'number', optional: false, nullable: false },
					neither: { type: 'number', optional: false, nullable: false },
					categories: {
						type: 'array',
						optional: false, nullable: false,
						items: {
							type: 'object',
							optional: false, nullable: false,
							properties: {
								category: { type: 'string', optional: false, nullable: false },
								items: { type: 'number', optional: false, nullable: false },
								localFlagged: { type: 'number', optional: false, nullable: false },
							},
						},
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		scanId: { type: 'string', format: 'misskey:id' },
	},
	required: [],
} as const;

type CountRow = { key: string | null; items: string; accounts: string; wouldHideAccounts: string };

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.aiModerationScanRepository)
		private aiModerationScanRepository: AiModerationScanRepository,

		@Inject(DI.aiModerationScanItemRepository)
		private aiModerationScanItemRepository: AiModerationScanItemRepository,

		@Inject(DI.aiModerationCriteriaRepository)
		private aiModerationCriteriaRepository: AiModerationCriteriaRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private idService: IdService,
		private aiModerationScanService: AiModerationScanService,
	) {
		super(meta, paramDef, async (ps) => {
			const recent = await this.aiModerationScanRepository.find({ order: { id: 'DESC' }, take: 5 });
			const scans = await Promise.all(recent.map(s => this.aiModerationScanService.packScan(s)));
			const scan = ps.scanId != null
				? await this.aiModerationScanRepository.findOneBy({ id: ps.scanId })
				: recent[0] ?? null;
			if (scan == null) {
				return { scan: null, scans, progress: null, etaSeconds: null, criteria: null, byLabel: [], hosts: [], links: [], signals: [], criteriaVersions: [], external: null };
			}

			// 進み具合は「どの時期の投稿まで見たか」で測る
			let sinceTime: number;
			if (scan.sinceNoteId != null) {
				sinceTime = this.idService.parse(scan.sinceNoteId).date.getTime();
			} else {
				const first = await this.notesRepository.createQueryBuilder('note').select('MIN(note.id)', 'id').getRawOne<{ id: string | null }>();
				sinceTime = first?.id != null ? this.idService.parse(first.id).date.getTime() : this.idService.parse(scan.id).date.getTime();
			}
			const untilTime = this.idService.parse(scan.untilNoteId).date.getTime();
			const cursorTime = scan.cursor != null ? this.idService.parse(scan.cursor).date.getTime() : sinceTime;
			const progress = scan.status === 'done' ? 1 : untilTime > sinceTime ? Math.min(1, Math.max(0, (cursorTime - sinceTime) / (untilTime - sinceTime))) : null;

			// 残り時間は「ここまでにかかった実時間 ÷ 進んだ割合」で出す（GPU 待ちなども含めた本当の速さ）。
			// 判定の上限が先に来るときは、上限までの時間で頭打ちにする
			let etaSeconds: number | null = null;
			if (scan.status === 'running' && progress != null && progress >= 0.01) {
				const elapsedSeconds = (Date.now() - this.idService.parse(scan.id).date.getTime()) / 1000;
				etaSeconds = Math.round(elapsedSeconds * (1 - progress) / progress);
				const { secondsPerPost } = await this.aiModerationScanService.speed();
				etaSeconds = Math.min(etaSeconds, this.aiModerationScanService.wallSeconds(scan.maxJudged - scan.judgedCount, secondsPerPost));
			}

			const criteria = await this.aiModerationCriteriaRepository.findOneBy({ id: scan.criteriaVersion });

			const byLabel = await this.aiModerationScanItemRepository.createQueryBuilder('item')
				.select('item.localLabel', 'label')
				.addSelect('COUNT(*)', 'items')
				.addSelect('COUNT(*) FILTER (WHERE item.flagged = true)', 'flagged')
				.where('item.scanId = :scanId', { scanId: scan.id })
				.groupBy('item.localLabel')
				.orderBy('items', 'DESC')
				.getRawMany<{ label: string | null; items: string; flagged: string }>();

			// 引っかけた項目を、キー（サーバー・リンク・目印・判定条件の版）ごとに数える
			const counts = async (keySql: string): Promise<Array<{ key: string | null; items: number; accounts: number; wouldHideAccounts: number }>> => {
				const rows: CountRow[] = await this.aiModerationScanItemRepository.query(
					`SELECT ${keySql} AS "key", COUNT(*) AS "items", COUNT(DISTINCT item."noteUserId") AS "accounts",
						COUNT(DISTINCT item."noteUserId") FILTER (WHERE item."wouldHide" = true) AS "wouldHideAccounts"
					FROM "ai_moderation_scan_item" item ${keySql.startsWith('k.') ? `CROSS JOIN LATERAL unnest(item."${keySql === 'k.link' ? 'links' : 'spamSignals'}") AS k(${keySql.slice(2)})` : ''}
					WHERE item."scanId" = $1 AND item."flagged" = true
					GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
					[scan.id],
				);
				return rows.map(r => ({ key: r.key, items: Number(r.items), accounts: Number(r.accounts), wouldHideAccounts: Number(r.wouldHideAccounts) }));
			};

			const hosts = await counts('item."noteUserHost"');
			const links = await counts('k.link');
			const signals = await counts('k.signal');
			const versions = await counts('item."criteriaVersion"');

			let external = null;
			if (scan.useExternal) {
				const row = await this.aiModerationScanItemRepository.createQueryBuilder('item')
					.select('COUNT(*) FILTER (WHERE item.externalStatus = \'pending\')', 'pending')
					.addSelect('COUNT(*) FILTER (WHERE item.externalStatus = \'done\')', 'done')
					.addSelect('COUNT(*) FILTER (WHERE item.externalStatus = \'skipped\')', 'skipped')
					.addSelect('COUNT(*) FILTER (WHERE item.externalStatus = \'failed\')', 'failed')
					.addSelect('COUNT(*) FILTER (WHERE item.externalFlagged = true)', 'flagged')
					.addSelect('COUNT(*) FILTER (WHERE item.externalFlagged = true AND item.flagged = true)', 'both')
					.addSelect('COUNT(*) FILTER (WHERE item.externalFlagged = false AND item.flagged = true)', 'localOnly')
					.addSelect('COUNT(*) FILTER (WHERE item.externalFlagged = true AND item.flagged = false)', 'externalOnly')
					.addSelect('COUNT(*) FILTER (WHERE item.externalFlagged = false AND item.flagged = false)', 'neither')
					.where('item.scanId = :scanId', { scanId: scan.id })
					.getRawOne<Record<string, string>>();
				const categories: Array<{ category: string; items: string; localFlagged: string }> = await this.aiModerationScanItemRepository.query(
					`SELECT k.category AS "category", COUNT(*) AS "items", COUNT(*) FILTER (WHERE item."flagged" = true) AS "localFlagged"
					FROM "ai_moderation_scan_item" item CROSS JOIN LATERAL unnest(item."externalCategories") AS k(category)
					WHERE item."scanId" = $1
					GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
					[scan.id],
				);
				const n = (key: string) => Number(row?.[key] ?? 0);
				external = {
					pending: n('pending'),
					done: n('done'),
					skipped: n('skipped'),
					failed: n('failed'),
					flagged: n('flagged'),
					both: n('both'),
					localOnly: n('localOnly'),
					externalOnly: n('externalOnly'),
					neither: n('neither'),
					categories: categories.map(c => ({ category: c.category, items: Number(c.items), localFlagged: Number(c.localFlagged) })),
				};
			}

			return {
				scan: await this.aiModerationScanService.packScan(scan),
				scans,
				progress,
				etaSeconds,
				criteria: criteria?.criteria ?? null,
				byLabel: byLabel.map(r => ({ label: r.label, items: Number(r.items), flagged: Number(r.flagged) })),
				hosts: hosts.map(({ key, ...r }) => ({ host: key, ...r })),
				links: links.map(({ key, ...r }) => ({ link: key, ...r })),
				signals: signals.map(({ key, ...r }) => ({ signal: key, ...r })),
				criteriaVersions: versions.map(({ key, ...r }) => ({ version: key, ...r })),
				external,
			};
		});
	}
}
