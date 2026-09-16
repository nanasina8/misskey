/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type * as Misskey from 'misskey-js';
import { selectConnectionItems } from '@/utility/hanami-connection-layout.js';

// Preview-only fictional people and generated avatars; no DB or remote image access.
const palette = [['#c7d9ae', '#596d4a', '#f2cfab'], ['#becbe4', '#4b5b7d', '#f6dac5'], ['#e6c3bb', '#794d52', '#f8dbc3'], ['#d5c7e5', '#675579', '#f1d1b6'], ['#e9d59e', '#78633e', '#f8dcbc'], ['#accfc9', '#416863', '#eec3a7'], ['#c8c9cf', '#515563', '#e9beaa'], ['#e3bda1', '#7c5745', '#f6d6b6']];

function avatar(i: number) {
	const [bg, hair, skin] = palette[i % palette.length];
	const variants = [
		`<path d="M12 30 14 9 27 20 38 20 51 9 53 32v15H12Z" fill="${hair}"/><ellipse cx="32" cy="37" rx="20" ry="16" fill="${skin}"/><path d="m29 39 3 3 3-3" fill="#704f51"/>`,
		`<path d="M8 66c1-21 11-25 24-25s24 4 25 25" fill="${hair}"/><ellipse cx="32" cy="30" rx="18" ry="21" fill="${skin}"/><path d="M13 30C8 6 44-4 52 22l-1 12-8-18c-5 9-15 12-30 14" fill="${hair}"/>`,
		`<path d="M10 64c0-20 11-25 22-25s22 5 22 25" fill="${hair}"/><rect x="13" y="13" width="38" height="36" rx="16" fill="${skin}"/><path d="M12 25C7 5 49 2 52 24L38 19l-3 6-5-6-18 6" fill="${hair}"/>`,
		`<circle cx="18" cy="18" r="10" fill="${hair}"/><circle cx="46" cy="18" r="10" fill="${hair}"/><circle cx="32" cy="34" r="23" fill="${hair}"/><ellipse cx="32" cy="38" rx="17" ry="16" fill="${skin}"/><ellipse cx="32" cy="40" rx="4" ry="3" fill="${hair}"/>`,
	];
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${bg}"/><circle cx="53" cy="8" r="22" fill="#ffffff20"/>${variants[i % 4]}<circle cx="25" cy="33" r="1.6" fill="#383635"/><circle cx="39" cy="33" r="1.6" fill="#383635"/><path d="M29 44q3 2 6 0" fill="none" stroke="#9c7068" stroke-width="1.4" stroke-linecap="round"/>${i % 5 === 0 ? '<g fill="none" stroke="#5b5657" stroke-width="1.2"><circle cx="24" cy="33" r="6"/><circle cx="40" cy="33" r="6"/><path d="M30 33h4"/></g>' : ''}</svg>`;
	return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

const names = ['ひより', 'あおい', 'なぎ', 'こはる', 'むぎ', 'ゆき', 'そら', '凪沙', 'みお', 'しろ', 'つき', 'すい'];
export const previewUsers: Misskey.entities.UserLite[] = Array.from({ length: 73 }, (_, i) => ({
	id: `mock-person-${i * 7919}`, name: names[i % names.length], username: `sample${i}`, host: null,
	avatarUrl: avatar(i), avatarBlurhash: null, avatarDecorations: [], emojis: {}, onlineStatus: 'unknown',
}));
export const previewItems: Misskey.entities.UsersHanamiAffinityResponse['items'] = previewUsers.slice(1).map((user, i) => ({
	// A fixed sample population: 10 close, 19 middle, 43 distant people.
	// Selecting a different count never rewrites an individual's score or counts.
	user, rank: i + 1, score: Math.round(240 * (i < 10 ? 1 - i / 9 * 0.32 : i < 29 ? 0.66 - (i - 10) / 18 * 0.31 : 0.33 - (i - 29) / 42 * 0.33)), rankDelta: null,
	mutualFollow: i % 3 === 0, mutualInteraction: i % 4 !== 0,
	lastInteractionAt: new Date(Date.now() - (i + 1) * 3600000).toISOString(),
	counts: { reply: { out: Math.max(0, 24 - i), in: i % 4 === 0 ? 0 : Math.max(0, 18 - i) }, mention: { out: Math.max(0, 9 - i), in: 0 }, renote: { out: Math.max(0, 12 - i), in: 0 }, reaction: { out: Math.max(1, 30 - i), in: i % 4 === 0 ? 0 : Math.max(0, 28 - i) } },
}));

// Sample the full distance range instead of taking only the highest scores.
// Both endpoints stay present, keeping normalization stable when count changes.
export function selectPreviewItems(count: number) {
	return selectConnectionItems(previewItems, count);
}
