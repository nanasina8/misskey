import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const mfm = createRequire(new URL('../../packages/backend/package.json', import.meta.url))('mfm-js');

export const OUTPUT_SCHEMA = 'hanami.restored-db-evaluation';
export const OUTPUT_VERSION = 1;
export const READ_ONLY_TRANSACTION_SQL = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
export function isReadOnlySql(sql) {
	return /^(?:BEGIN\s+ISOLATION\s+LEVEL\s+REPEATABLE\s+READ\s+READ\s+ONLY|SELECT\b|COMMIT$|ROLLBACK$)/i.test(String(sql).trim()) && !/\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|COPY|GRANT|REVOKE)\b/i.test(String(sql));
}
export async function runReadOnlyTransaction(db, work) {
	await db.query(READ_ONLY_TRANSACTION_SQL);
	try { const result = await work(); await db.query('COMMIT'); return result; }
	catch (error) { try { await db.query('ROLLBACK'); } catch {} throw error; }
}

// Evaluator-local implementation of the approved contract. It deliberately
// returns a value only for transient aggregate computation; callers must not emit it.
export function normalizeExactText(value) {
	if (typeof value !== 'string') return '';
	try {
		const out = [];
		const walk = nodes => {
			for (const node of nodes) {
				if (node.type === 'text') out.push(node.props.text);
				else if (node.type === 'unicodeEmoji') out.push(node.props.emoji);
				else if (node.type === 'hashtag') out.push(node.props.hashtag);
				else if ('children' in node && node.children != null) walk(node.children);
			}
		};
		walk(mfm.parse(value));
		value = out.join(' ');
	} catch { /* Match the backend's malformed-MFM raw-text fallback. */ }
	return value.normalize('NFKC').replace(/[\p{Cf}\u{FE00}-\u{FE0F}\u{E0100}-\u{E01EF}]/gu, '').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim();
}

export function maximumInWindows(rows, key, windowSizes) {
	const result = {};
	for (const size of windowSizes) {
		let maximum = 0;
		for (let start = 0; start < rows.length; start++) {
			const counts = new Map();
			for (const row of rows.slice(start, start + size)) {
				const value = key(row); if (value === null || value === undefined || value === '') continue;
				counts.set(value, (counts.get(value) || 0) + 1);
			}
			for (const count of counts.values()) maximum = Math.max(maximum, count);
		}
		result[String(size)] = maximum;
	}
	return result;
}

const compareSequenceDesc = (a, b) => {
	try { const left = BigInt(a ?? 0); const right = BigInt(b ?? 0); return left === right ? 0 : left > right ? -1 : 1; } catch { return String(b ?? '').localeCompare(String(a ?? '')); }
};
/** Internal-only deployment boundary. Callers must never serialize the supplied IDs/sequences. */
/** @param {Array<Record<string, unknown>>} rows @param {{ minimumSequence?: string | null, maximumSequence?: string | null, batchIds?: Set<string> | null }} [options] */
export function selectDeploymentCohort(rows, { minimumSequence = null, maximumSequence = null, batchIds = null } = {}) {
	return rows.filter(row => {
		if (minimumSequence !== null && compareSequenceDesc(row.sequence, minimumSequence) > 0) return false;
		if (maximumSequence !== null && compareSequenceDesc(row.sequence, maximumSequence) < 0) return false;
		return batchIds == null || batchIds.has(row.batch);
	});
}
/** Mirrors the SQL scope predicates for synthetic/offline tests; values remain transient. */
export function filterScopedRows(rows, scope) {
	if (scope === 'all') return [...rows];
	return rows.filter(row => row.epoch === row.activeEpoch && row.batchStatus === 'ready' && (scope !== 'latest-ready-batch' || row.batch === row.latestReadyBatch));
}

const unavailable = (reason) => ({ available: false, value: null, reason });
const available = (value) => ({ available: true, value });
const ratio = (n, d) => d ? n / d : 0;
export function stableSelectUsers(ids, sampleSize, seed) {
	return [...ids].sort((a, b) => createHash('sha256').update(`${seed}\0${a}`).digest('hex').localeCompare(createHash('sha256').update(`${seed}\0${b}`).digest('hex')) || String(a).localeCompare(String(b))).slice(0, sampleSize);
}
export function seedDigest(seed) { return createHash('sha256').update(String(seed)).digest('hex'); }

/** Maps only actual Build-4 embedding-e5-shadow params; arbitrary run data never enters output. */
export function evaluateModelRuns(rows, { tableAvailable = true } = {}) {
	const noRuns = tableAvailable ? 'model_run_kind_unavailable' : 'model_run_table_unavailable';
	const e5 = rows.filter(row => row.kind === 'embedding-e5-shadow' && row.params && typeof row.params === 'object').map(row => row.params);
	if (!e5.length) return { generationWallTimeMs: unavailable(noRuns), generationCpuTimeMs: unavailable(noRuns), e5: unavailable(noRuns) };
	const numbers = key => e5.map(p => p[key]).filter(Number.isFinite).map(Number);
	const processed = numbers('processedCount'); const backlog = numbers('backlog'); const wall = numbers('wallDurationMs'); const cpu = numbers('cpuDurationMicros');
	const threads = e5.map(p => p.threadSettings?.OMP_NUM_THREADS).map(String).filter(v => /^\d{1,3}$/.test(v)).at(-1) ?? null;
	const safeModel = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/.test(v) ? v : null;
	const model = e5.map(p => safeModel(p.model)).filter(Boolean).at(-1) ?? null;
	const modelVersion = e5.map(p => safeModel(p.modelVersion)).filter(Boolean).at(-1) ?? null;
	return { generationWallTimeMs: wall.length ? available(wall.reduce((a, b) => a + b, 0)) : unavailable('model_run_wall_duration_unavailable'), generationCpuTimeMs: cpu.length ? available(cpu.reduce((a, b) => a + b, 0)) : unavailable('model_run_cpu_duration_unavailable'), e5: processed.length || backlog.length || threads || model || modelVersion ? available({ processed: processed.reduce((a, b) => a + b, 0), backlog: backlog.at(-1) ?? null, threads, model, modelVersion }) : unavailable('model_run_allowlisted_params_unavailable') };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {{ windowSizes?: number[], seenEvents?: Array<{ userId: string, noteId: string, occurredAt: string }>, seenEventsAvailable?: boolean }} [options]
 * @returns {any}
 */
export function evaluateRows(rows, { windowSizes = [10, 30, 210], seenEvents = null, seenEventsAvailable = false } = {}) {
	const ordered = [...rows].sort((a, b) => String(a.userId).localeCompare(String(b.userId)) || compareSequenceDesc(a.sequence, b.sequence) || Number(a.position ?? 0) - Number(b.position ?? 0) || String(a.batch ?? '').localeCompare(String(b.batch ?? '')));
	const perUser = new Map(); for (const row of ordered) (perUser.get(row.userId) || (perUser.set(row.userId, []), perUser.get(row.userId))).push(row);
	const authorMax = Object.fromEntries(windowSizes.map(size => [String(size), 0])); const textMax = { '30': 0 };
	let duplicates = 0, contamination = 0, poolCount = 0, poolMax = 0, follows = 0, known = 0, unknown = 0;
	const quality = { directFollow: 0, known: 0, unknown: 0, standaloneTrue: 0, standaloneFalse: 0, standaloneNull: 0, socialOnlyTrue: 0, socialOnlyFalse: 0, socialOnlyNull: 0 };
	let hasText = false, hasAuthor = false, hasQualityShadow = false;
	for (const list of perUser.values()) {
		const epochs = new Map(); for (const r of list) (epochs.get(r.epoch) || (epochs.set(r.epoch, []), epochs.get(r.epoch))).push(r);
		for (const epochRows of epochs.values()) { const notes = new Set(); for (const r of epochRows) { if (notes.has(r.noteId)) duplicates++; notes.add(r.noteId); } }
		if (seenEventsAvailable) for (const r of list) {
			const generated = Date.parse(r.generatedAt); if (!Number.isFinite(generated)) continue;
			if ((seenEvents ?? []).some(event => event.userId === r.userId && event.noteId === r.noteId && (() => { const occurred = Date.parse(event.occurredAt); return Number.isFinite(occurred) && occurred >= generated - 7 * 86400000 && occurred < generated; })())) contamination++;
		}
		if (list.some(r => r.authorId !== undefined && r.authorId !== null)) { hasAuthor = true; for (const [size, value] of Object.entries(maximumInWindows(list, r => r.authorId, windowSizes))) authorMax[size] = Math.max(authorMax[size], value); }
		const normalized = list.map(r => ({ ...r, normalized: normalizeExactText(r.text) })); if (normalized.some(r => r.text !== undefined)) { hasText = true; textMax['30'] = Math.max(textMax['30'], maximumInWindows(normalized, r => r.normalized, [30])['30']); }
		const pool = list.filter(r => r.source === 'exploration' || (Array.isArray(r.sources) && r.sources.includes('exploration'))); if (pool.length && hasAuthor) { poolCount += pool.length; poolMax = Math.max(poolMax, ...Object.values(maximumInWindows(pool, r => r.authorId, [pool.length]))); }
		for (const r of list) {
			const shadow = r.metadata?.version === 2 && r.metadata?.qualityShadow;
			if (shadow && ['directFollow', 'known', 'unknown'].includes(shadow.relationshipClass)) {
				hasQualityShadow = true; quality[shadow.relationshipClass]++;
				if (shadow.relationshipClass === 'directFollow') follows++; else if (shadow.relationshipClass === 'known') known++; else unknown++;
				quality[shadow.standaloneValue === true ? 'standaloneTrue' : shadow.standaloneValue === false ? 'standaloneFalse' : 'standaloneNull']++;
				quality[shadow.socialOnly === true ? 'socialOnlyTrue' : shadow.socialOnly === false ? 'socialOnlyFalse' : 'socialOnlyNull']++;
			}
		}
	}
	const total = ordered.length;
	return {
		entryCount: available(total), sameEpochDuplicateNoteCount: available(duplicates), sevenDaySeenContaminationCount: !seenEventsAvailable ? unavailable('recommendation_seen_event_unavailable') : ordered.some(r => Number.isFinite(Date.parse(r.generatedAt))) ? available(contamination) : unavailable('generated_at_unavailable'),
		maxAuthorOccurrenceByWindow: hasAuthor ? available(authorMax) : unavailable('note_author_unavailable'), maxNormalizedSameTextIn30: hasText ? available(textMax['30']) : unavailable('note_text_unavailable'),
		explorationPoolMaxSingleAuthorShare: poolCount ? available(poolMax / poolCount) : unavailable(hasAuthor ? 'exploration_pool_unavailable' : 'note_author_unavailable'),
		directFollowKnownUnknownRatios: hasQualityShadow ? available({ direct: ratio(follows, follows + known + unknown), known: ratio(known, follows + known + unknown), unknown: ratio(unknown, follows + known + unknown) }) : unavailable('quality_shadow_v2_unavailable'),
		qualityDistributions: { bot: unavailable('bot_not_persisted'), template: unavailable('template_not_persisted'), short: unavailable('short_not_persisted'), qualityShadow: hasQualityShadow ? available({ relationshipClass: { directFollow: ratio(quality.directFollow, total), known: ratio(quality.known, total), unknown: ratio(quality.unknown, total) }, standaloneValue: { true: ratio(quality.standaloneTrue, total), false: ratio(quality.standaloneFalse, total), null: ratio(quality.standaloneNull, total) }, socialOnly: { true: ratio(quality.socialOnlyTrue, total), false: ratio(quality.socialOnlyFalse, total), null: ratio(quality.socialOnlyNull, total) } }) : unavailable('quality_shadow_v2_unavailable') },
		safetyExcludedCandidateCount: unavailable('no_persisted_safety_exclusion_field'),
	};
}

const forbiddenKey = /(?:^|_)(?:user|note|author|feed.?entry|epoch|event|text|fingerprint|embedding|vector|cluster|term|timestamp|url|mention|hashtag|reaction|id)(?:$|_)|(?:user|note|author|feedentry|epoch|event|text|fingerprint|embedding|vector|cluster|term|timestamp|url|mention|hashtag|reaction|id)/i;
export function assertPrivacySafe(value, path = '') {
	if (Array.isArray(value)) return value.forEach((v, i) => assertPrivacySafe(v, `${path}[${i}]`));
	const aggregateKeys = new Set(['deterministic', 'entryCount', 'selectedUserCount', 'sameEpochDuplicateNoteCount', 'sevenDaySeenContaminationCount', 'maxAuthorOccurrenceByWindow', 'maxNormalizedSameTextIn30', 'explorationPoolMaxSingleAuthorShare', 'safetyExcludedCandidateCount']);
	if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { if (forbiddenKey.test(key) && !aggregateKeys.has(key)) throw new Error('privacy schema violation'); assertPrivacySafe(child, `${path}.${key}`); }
	if (typeof value === 'string' && (/[a-z][a-z0-9+.-]*:\/\//i.test(value) || /@\S+/.test(value))) throw new Error('privacy value violation');
}
