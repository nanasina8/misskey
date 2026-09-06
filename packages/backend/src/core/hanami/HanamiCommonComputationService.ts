/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import { bindThis } from '@/decorators.js';
import type { MiMeta } from '@/models/Meta.js';
import { FeaturedService } from '@/core/FeaturedService.js';
import { IdService } from '@/core/IdService.js';
import {
	HANAMI_COMMON_AXES,
	type HanamiCommonAxis,
	type HanamiCommonCandidate,
	type HanamiCommonCandidateMap,
	type HanamiCommonComputationPort,
	type HanamiCommonFeedBuildInput,
	type HanamiCommonFeedMaterialization,
	type HanamiCommonSourceBuildInput,
	type HanamiCommonSourceBundle,
	type HanamiTrendSnapshotTerm,
} from '@/core/hanami/HanamiCommonGenerationContracts.js';
import { materializeHanamiCommonFeed } from '@/core/hanami/HanamiCommonFeedMaterializer.js';
import { HanamiForYouSafetyService } from '@/core/hanami/HanamiForYouSafetyService.js';
import { HanamiTrendService } from '@/core/hanami/HanamiTrendService.js';
import { pureRenoteSql } from '@/misc/is-renote.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DB_GLOBAL_FALLBACK_WINDOW_MS = 30 * DAY_MS;
const DB_GLOBAL_FALLBACK_SAMPLE = 5000;
const FEATURED_HEADROOM = 5000;
const GLOBAL_POPULAR_POOL = 200;
const TRENDING_POOL = 200;
const EXPLORATION_POOL = 500;
const EXPLORATION_MIN_AUTHORS = 20;
const EXPLORATION_MAX_AUTHOR_SHARE = 0.05;
const TREND_SNAPSHOT_TERM_MAX = 30;
const TREND_REPRESENTATIVE_NOTE_MAX = 5;

export const HANAMI_COMMON_ALGORITHM_VERSION = 'hanami-common-v1';

type AxisConfig = { available?: boolean; default?: boolean };
type RawCandidate = {
	readonly noteId: string;
	readonly baseScore: number;
	readonly metadata?: Readonly<Record<string, unknown>>;
};
type RawTrendTerm = {
	readonly term: string;
	readonly score: number;
	readonly distinctAuthors: number;
	readonly representativeNoteIds: readonly string[];
};
type ExplorationSource =
	| { readonly kind: 'none'; readonly noteIds: readonly string[] }
	| { readonly kind: 'db'; readonly noteIds: readonly string[] }
	| { readonly kind: 'featured'; readonly noteIds: readonly string[] };

const emptyMetadata: Readonly<Record<string, unknown>> = Object.freeze({});

@Injectable()
export class HanamiCommonComputationService implements HanamiCommonComputationPort {
	public readonly algorithmVersion = HANAMI_COMMON_ALGORITHM_VERSION;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meta)
		private meta: MiMeta,

		private featuredService: FeaturedService,
		private idService: IdService,
		private hanamiTrendService: HanamiTrendService,
		private hanamiForYouSafetyService: HanamiForYouSafetyService,
	) {
	}

	private throwIfAborted(signal: AbortSignal): void {
		if (!signal.aborted) return;
		if (signal.reason !== undefined) throw signal.reason;
		const error = new Error('The operation was aborted');
		error.name = 'AbortError';
		throw error;
	}

	private async runSourcePhase<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
		this.throwIfAborted(signal);
		try {
			const result = await operation();
			this.throwIfAborted(signal);
			return result;
		} catch (error) {
			this.throwIfAborted(signal);
			throw error;
		}
	}

	private validIso(value: string, field: string): string {
		const timestamp = Date.parse(value);
		if (!Number.isFinite(timestamp)) throw new TypeError(`${field} must be a valid ISO timestamp`);
		return new Date(timestamp).toISOString();
	}

	private nowIso(): string {
		return new Date(Date.now()).toISOString();
	}

	private resolveEnabledAxes(): readonly HanamiCommonAxis[] {
		const config = this.meta.hanamiRecommendationAxisConfig ?? {};
		const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(config, key);
		const axisConfig = (axis: HanamiCommonAxis): AxisConfig | undefined => {
			if (has(axis)) return config[axis];
			if ((axis === 'globalPopular' || axis === 'exploration') && has('popular')) return config.popular;
			return undefined;
		};
		return Object.freeze(HANAMI_COMMON_AXES.filter(axis => axisConfig(axis)?.available !== false));
	}

	private rankFeatured(scores: ReadonlyMap<string, number>): { noteId: string; score: number }[] {
		return Array.from(scores.entries())
			.map(([noteId, score], originalRank) => ({ noteId, score, originalRank }))
			.filter(candidate => candidate.noteId.length > 0 && Number.isFinite(candidate.score))
			.sort((a, b) => b.score - a.score || a.originalRank - b.originalRank)
			.slice(0, FEATURED_HEADROOM)
			.map(({ noteId, score }) => ({ noteId, score }));
	}

	private uniqueTrendingCandidates(candidates: readonly { readonly noteId: string; readonly term: string }[]): RawCandidate[] {
		const unique: { noteId: string; term: string }[] = [];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			if (candidate.noteId.length === 0 || candidate.term.length === 0 || seen.has(candidate.noteId)) continue;
			seen.add(candidate.noteId);
			unique.push({ noteId: candidate.noteId, term: candidate.term });
		}
		const count = unique.length || 1;
		return unique.map((candidate, index) => ({
			noteId: candidate.noteId,
			baseScore: (count - index) / count,
			metadata: Object.freeze({ term: candidate.term }),
		}));
	}

	private finalizeCandidates(raw: readonly RawCandidate[], safeAuthors: ReadonlyMap<string, string>, axis: HanamiCommonAxis, limit?: number): readonly HanamiCommonCandidate[] {
		const seen = new Set<string>();
		const out: HanamiCommonCandidate[] = [];
		for (const candidate of raw) {
			const authorId = safeAuthors.get(candidate.noteId);
			if (candidate.noteId.length === 0 || authorId == null || authorId.length === 0 || !Number.isFinite(candidate.baseScore)) continue;
			if (seen.has(candidate.noteId)) continue;
			const term = candidate.metadata?.term;
			if (axis === 'trending' && (typeof term !== 'string' || term.length === 0)) continue;
			seen.add(candidate.noteId);
			const metadata = axis === 'trending' ? Object.freeze({ term }) : emptyMetadata;
			out.push(Object.freeze({
				noteId: candidate.noteId,
				authorId,
				baseScore: candidate.baseScore,
				metadata,
			}));
			if (limit != null && out.length >= limit) break;
		}
		return Object.freeze(out);
	}

	private validSnapshotTerms(terms: readonly RawTrendTerm[]): readonly RawTrendTerm[] {
		const seen = new Set<string>();
		const out: RawTrendTerm[] = [];
		for (const term of terms) {
			if (term.term.length === 0 || term.term.length > 256 || seen.has(term.term)) continue;
			if (!Number.isFinite(term.score) || !Number.isSafeInteger(term.distinctAuthors) || term.distinctAuthors < 0) continue;
			seen.add(term.term);
			out.push(term);
			if (out.length >= TREND_SNAPSHOT_TERM_MAX) break;
		}
		return out;
	}

	private async dbGlobalPopularFallbackCandidates(sourceAsOf: Date): Promise<RawCandidate[]> {
		const sinceId = this.idService.gen(sourceAsOf.getTime() - DB_GLOBAL_FALLBACK_WINDOW_MS);
		const rows = await this.db.query(
			`WITH recent AS (
			   SELECT n.id, n."userId"
			   FROM note n
			   WHERE n.id >= $1
			     AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			     AND NOT (${pureRenoteSql('n')})
			   ORDER BY n.id DESC
			   LIMIT $2
			 )
			 SELECT recent.id AS "noteId", recent."userId" AS "userId", count(r.id)::int AS "reactionCount"
			 FROM recent
			 LEFT JOIN note_reaction r ON r."noteId" = recent.id
			 GROUP BY recent.id, recent."userId"
			 ORDER BY count(r.id) DESC, recent.id DESC`,
			[sinceId, DB_GLOBAL_FALLBACK_SAMPLE],
		) as { noteId: string; userId: string; reactionCount: number }[];
		const max = Math.max(1, ...rows.map(row => Number(row.reactionCount)).filter(Number.isFinite));
		return rows.map(row => ({ noteId: row.noteId, baseScore: (Number(row.reactionCount) || 0) / max }));
	}

	private async dbRecentExplorationRows(sourceAsOf: Date): Promise<{ noteId: string; userId: string }[]> {
		const sinceId = this.idService.gen(sourceAsOf.getTime() - DB_GLOBAL_FALLBACK_WINDOW_MS);
		const rows = await this.db.query(
			`SELECT n.id AS "noteId", n."userId" AS "userId"
			 FROM note n
			 INNER JOIN "user" u ON u.id = n."userId"
			 WHERE n.id >= $1
			   AND n.visibility IN ('public','home') AND n."channelId" IS NULL
			   AND NOT (${pureRenoteSql('n')})
			   AND u."isDeleted" = FALSE AND u."isSuspended" = FALSE
			 ORDER BY n.id DESC
			 LIMIT $2`,
			[sinceId, DB_GLOBAL_FALLBACK_SAMPLE],
		) as { noteId: string; userId: string }[];
		return rows;
	}

	private async resolveExplorationSource(featured: readonly { noteId: string; score: number }[], sourceAsOf: Date): Promise<ExplorationSource> {
		try {
			const rows = await this.dbRecentExplorationRows(sourceAsOf);
			const distinctAuthors = new Set(rows.map(row => row.userId).filter(userId => userId.length > 0)).size;
			if (distinctAuthors >= EXPLORATION_MIN_AUTHORS) {
				return { kind: 'db', noteIds: Object.freeze(rows.map(row => row.noteId)) };
			}
		} catch {
			// fall through to the featured fallback below.
		}
		return { kind: 'featured', noteIds: Object.freeze(featured.slice(GLOBAL_POPULAR_POOL).map(candidate => candidate.noteId)) };
	}

	private authorDiverseSample(rows: readonly { noteId: string; authorId: string }[], cap: number, maxShare: number): { noteId: string; authorId: string }[] {
		const byAuthor = new Map<string, { noteId: string; authorId: string }[]>();
		for (const row of rows) {
			const list = byAuthor.get(row.authorId);
			if (list == null) byAuthor.set(row.authorId, [row]);
			else list.push(row);
		}
		// 行の初出順を保つ。Misskey の id は時系列ソート可能なので、ここで並べ替えると
		// cap 打ち切りが「最古の cap 人」を選び、探索軸から新規アカウントが永久に消える。
		const allAuthors = [...byAuthor.keys()];
		if (allAuthors.length < Math.ceil(1 / maxShare)) return [];
		const authors = allAuthors.slice(0, cap);
		// Keep complete author rounds. A fixed per-author cap derived from the
		// 500-item maximum is insufficient for a short pool (for example, 25
		// items from one author in a 44-item result). Complete rounds make every
		// author's final share exactly 1 / authorCount.
		const rounds = Math.min(
			Math.max(1, Math.floor(cap / authors.length)),
			...authors.map(author => byAuthor.get(author)!.length),
		);
		const out: { noteId: string; authorId: string }[] = [];
		for (let round = 0; round < rounds; round++) {
			for (const author of authors) {
				const list = byAuthor.get(author)!;
				out.push(list[round]!);
			}
		}
		return out;
	}

	private finalizeExploration(noteIds: readonly string[], safeAuthors: ReadonlyMap<string, string>): readonly HanamiCommonCandidate[] {
		const eligible: { noteId: string; authorId: string }[] = [];
		const seen = new Set<string>();
		for (const noteId of noteIds) {
			if (noteId.length === 0 || seen.has(noteId)) continue;
			const authorId = safeAuthors.get(noteId);
			if (authorId == null || authorId.length === 0) continue;
			seen.add(noteId);
			eligible.push({ noteId, authorId });
		}
		const sampled = this.authorDiverseSample(eligible, EXPLORATION_POOL, EXPLORATION_MAX_AUTHOR_SHARE);
		// Safety can remove authors after the DB evidence check. Do not emit a
		// smaller pool while claiming the strict five-percent exploration contract.
		if (new Set(sampled.map(row => row.authorId)).size < EXPLORATION_MIN_AUTHORS) return Object.freeze([]);
		const count = sampled.length;
		return Object.freeze(sampled.map((row, index) => Object.freeze({
			noteId: row.noteId,
			authorId: row.authorId,
			baseScore: count > 0 ? (count - index) / count : 0,
			metadata: emptyMetadata,
		})));
	}

	private finalizeExplorationWithFallback(source: ExplorationSource, safeAuthors: ReadonlyMap<string, string>, featured: readonly { noteId: string; score: number }[], globalPopularNoteIds: ReadonlySet<string>): readonly HanamiCommonCandidate[] {
		if (source.kind === 'none') return Object.freeze([]);
		// globalPopular is finalized only after safety. Its safe backfill can extend
		// into the raw Featured tail, so remove the finalized set for both a direct
		// Featured source and a DB source before diversity sampling.
		const primary = this.finalizeExploration(source.noteIds.filter(noteId => !globalPopularNoteIds.has(noteId)), safeAuthors);
		if (primary.length > 0 || source.kind === 'featured') return primary;
		// The DB source is chosen before safety. If safety later removes enough
		// authors to make its diversity contract impossible, use the independently
		// ranked featured tail that was safety-resolved in the same bounded pass.
		return this.finalizeExploration(featured
			.slice(GLOBAL_POPULAR_POOL)
			.filter(candidate => !globalPopularNoteIds.has(candidate.noteId))
			.map(candidate => candidate.noteId), safeAuthors);
	}

	@bindThis
	public async buildSourceBundle(input: HanamiCommonSourceBuildInput): Promise<HanamiCommonSourceBundle> {
		this.throwIfAborted(input.signal);
		const capturedAt = this.validIso(input.generatedAt, 'generatedAt');
		if (!(input.sourceAsOf instanceof Date)) throw new TypeError('sourceAsOf must be a valid finite Date');
		const effectiveSourceAsOf = new Date(input.sourceAsOf.getTime());
		if (!Number.isFinite(effectiveSourceAsOf.getTime())) throw new TypeError('sourceAsOf must be a valid finite Date');
		const enabledAxes = this.resolveEnabledAxes();
		const enabled = new Set(enabledAxes);
		const axisConfigAt = this.nowIso();

		const featuredScores = await this.runSourcePhase(input.signal, () => this.featuredService.getGlobalNotesScoresWithCache());
		const featuredAt = this.nowIso();
		const featured = this.rankFeatured(featuredScores);

		const [trend, globalPopularRaw, explorationSource] = await this.runSourcePhase(input.signal, () => {
			const trendPromise = this.hanamiTrendService.computeTrendBundle(featuredScores);
			const globalPopularPromise = !enabled.has('globalPopular') || featured.length > 0
				? Promise.resolve<RawCandidate[]>(featured.map(candidate => ({ noteId: candidate.noteId, baseScore: candidate.score })))
				: this.dbGlobalPopularFallbackCandidates(effectiveSourceAsOf);
			const explorationPromise = !enabled.has('exploration')
				? Promise.resolve<ExplorationSource>({ kind: 'none', noteIds: Object.freeze([]) })
				: this.resolveExplorationSource(featured, effectiveSourceAsOf);
			return Promise.all([trendPromise, globalPopularPromise, explorationPromise]);
		});

		const trendingRaw = this.uniqueTrendingCandidates(trend.noteCandidates);
		const snapshotTerms = this.validSnapshotTerms(trend.terms);
		const candidateIds = [...new Set([
			...(enabled.has('globalPopular') ? globalPopularRaw.map(candidate => candidate.noteId) : []),
			...(enabled.has('trending') ? trendingRaw.map(candidate => candidate.noteId) : []),
			...(enabled.has('exploration') ? explorationSource.noteIds : []),
			// The fallback may be needed only after the DB source is safety-filtered.
			// Resolve its bounded Featured tail now even if globalPopular is disabled.
			...(enabled.has('exploration') ? featured.slice(GLOBAL_POPULAR_POOL).map(candidate => candidate.noteId) : []),
			...snapshotTerms.flatMap(term => term.representativeNoteIds),
		])];

		const safeAuthors = await this.runSourcePhase(input.signal, () => this.hanamiForYouSafetyService.filterCommonEligibleNotes(candidateIds));

		const globalPopular = enabled.has('globalPopular')
			? this.finalizeCandidates(globalPopularRaw, safeAuthors, 'globalPopular', GLOBAL_POPULAR_POOL)
			: Object.freeze([]);
		const candidates: HanamiCommonCandidateMap = Object.freeze({
			globalPopular,
			trending: enabled.has('trending') ? this.finalizeCandidates(trendingRaw, safeAuthors, 'trending', TRENDING_POOL) : Object.freeze([]),
			exploration: enabled.has('exploration') ? this.finalizeExplorationWithFallback(explorationSource, safeAuthors, featured, new Set(globalPopular.map(candidate => candidate.noteId))) : Object.freeze([]),
		});

		const trendTerms: HanamiTrendSnapshotTerm[] = [];
		for (const term of snapshotTerms) {
			const representativeNoteIds = [...new Set(term.representativeNoteIds)]
				.filter(noteId => noteId.length > 0 && safeAuthors.has(noteId))
				.slice(0, TREND_REPRESENTATIVE_NOTE_MAX);
			trendTerms.push(Object.freeze({
				term: term.term,
				score: term.score,
				distinctAuthors: term.distinctAuthors,
				representativeNoteIds: Object.freeze(representativeNoteIds),
			}));
		}

		const sourceAsOf = Object.freeze({
			version: 1 as const,
			capturedAt: effectiveSourceAsOf.toISOString(),
			featuredAt,
			trendAt: this.validIso(trend.computedAt, 'trend.computedAt'),
			axisConfigAt,
		});
		this.throwIfAborted(input.signal);
		return Object.freeze({
			version: 1 as const,
			capturedAt,
			sourceAsOf,
			enabledAxes,
			candidates,
			trendSnapshot: Object.freeze({ terms: Object.freeze(trendTerms) }),
		});
	}

	@bindThis
	public materializeFeed(input: HanamiCommonFeedBuildInput): HanamiCommonFeedMaterialization {
		return materializeHanamiCommonFeed(input);
	}
}
