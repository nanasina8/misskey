/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import type * as Misskey from 'misskey-js';

type Item = Misskey.entities.UsersHanamiAffinityResponse['items'][number];
export type CloudPoint = { x: number; y: number; z: number };

function scoreRange(items: Item[]) {
	let top = 0;
	let bottom = Infinity;
	for (const item of items) {
		const score = Math.max(0, item.score ?? 0);
		top = Math.max(top, score);
		bottom = Math.min(bottom, score);
	}
	return { top, bottom };
}

function closenessOf(item: Item, range: ReturnType<typeof scoreRange>) {
	if (!range.top || range.top === range.bottom) return 0.5;
	return Math.max(0, Math.min(1, ((item.score ?? 0) - range.bottom) / (range.top - range.bottom)));
}

// Distance compares only the displayed users, not an absolute measure of friendship.
export function connectionCloseness(item: Item, items: Item[]): number {
	return closenessOf(item, scoreRange(items));
}

function hashId(id: string) {
	let hash = 2166136261;
	for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
	return hash >>> 0;
}

export function connectionDistanceBand(closeness: number): number {
	return closeness >= 0.67 ? 0 : closeness >= 0.34 ? 1 : 2;
}

// Spread each distance band across the whole sphere, so the numerous distant
// people form its outline. Bands affect direction only; radius stays continuous.
// This work runs only when the displayed data changes.
export function buildConnectionLayout(items: Item[]) {
	const range = scoreRange(items);
	const sorted = items.map(item => ({ item, closeness: closenessOf(item, range), hash: hashId(item.user.id) }))
		.sort((a, b) => a.hash - b.hash || a.item.user.id.localeCompare(b.item.user.id));
	return [0, 1, 2].flatMap(band => {
		const members = sorted.filter(point => connectionDistanceBand(point.closeness) === band);
		return members.map(({ item, closeness }, index) => {
			const radius = 0.34 + (1 - closeness) * 0.61;
			const y = 1 - 2 * (index + 0.5) / members.length;
			const ring = Math.sqrt(1 - y * y);
			const angle = (index + band * 0.5) * Math.PI * (3 - Math.sqrt(5));
			return { item, closeness, radius, x: Math.cos(angle) * ring * radius, y: y * radius, z: Math.sin(angle) * ring * radius };
		});
	});
}

// Compute camera trigonometry once per frame.
export function cloudCamera(yaw: number, pitch: number) {
	return { cy: Math.cos(yaw), sy: Math.sin(yaw), cp: Math.cos(pitch), sp: Math.sin(pitch) };
}

export function projectCloudPoint(point: CloudPoint, camera: ReturnType<typeof cloudCamera>) {
	const x = point.x * camera.cy + point.z * camera.sy;
	const z = -point.x * camera.sy + point.z * camera.cy;
	const y = point.y * camera.cp - z * camera.sp;
	const depth = point.y * camera.sp + z * camera.cp;
	const perspective = 3.8 / (3.8 - depth);
	// Match TagCanvas's 10–100% opacity across the full cloud depth.
	// Use the outer radius, so inner people retain their actual depth difference.
	const opacity = 0.1 + Math.max(0, Math.min(1, (depth / 0.95 + 1) / 2)) * 0.9;
	return { x: 50 + x * 40 * perspective, y: 50 + y * 40 * perspective, depth, scale: perspective, order: Math.round((depth + 1) * 45) + 1, opacity };
}

// Large at low density, gently reduced as more people share the sphere.
export function connectionAvatarSize(count: number): number {
	return Math.max(30, Math.min(40, 40 * Math.sqrt(30 / Math.max(1, count))));
}

export const CONNECTION_COUNT_MIN = 24;
export const CONNECTION_COUNT_MAX = 72;
export const CONNECTION_COUNT_DEFAULT = 30;

// Keep the full score range when reducing the display count. Reuse the original
// items unchanged, including both score extremes, so distance stays consistent.
export function selectConnectionItems(items: Item[], count: number): Item[] {
	const sorted = [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.user.id.localeCompare(b.user.id));
	const size = Math.min(sorted.length, normalizeConnectionCount(count));
	return Array.from({ length: size }, (_, index) => sorted[Math.round(index * (sorted.length - 1) / Math.max(1, size - 1))]);
}

export function normalizeConnectionCount(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return CONNECTION_COUNT_DEFAULT;
	return Math.max(CONNECTION_COUNT_MIN, Math.min(CONNECTION_COUNT_MAX, Math.round(value)));
}
