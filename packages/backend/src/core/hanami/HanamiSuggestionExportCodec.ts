/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { validateHanamiCursorSigningKeys } from './HanamiFeedCodec.js';
import type { HanamiCursorSigningKey } from './HanamiFeedCodecTypes.js';

const MAGIC = Buffer.from('HSE1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const AAD = Buffer.from('hanami:suggestion-events-export:cursor:v1', 'ascii');

export type HanamiSuggestionExportCursor = Readonly<{
	exportId: string;
	actorId: string;
	startAt: string;
	endAt: string;
	limit: number;
	lastCreatedAt: string | null;
	lastEventId: string | null;
	expiresAt: string;
}>;

export class HanamiSuggestionExportCodecError extends Error {
	public constructor(public readonly code: 'INVALID_CURSOR' | 'EXPIRED_CURSOR' | 'INVALID_KEY') {
		super(code);
	}
}

function keyMaterial(keys: readonly HanamiCursorSigningKey[], info: string): Buffer {
	try {
		validateHanamiCursorSigningKeys(keys);
	} catch {
		throw new HanamiSuggestionExportCodecError('INVALID_KEY');
	}
	const secret = Buffer.isBuffer(keys[0]!.secret) ? keys[0]!.secret : Buffer.from(keys[0]!.secret, 'utf8');
	if (secret.length < 32) throw new HanamiSuggestionExportCodecError('INVALID_KEY');
	return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(info, 'utf8'), 32));
}

function parseCursorPayload(value: unknown): HanamiSuggestionExportCursor {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HanamiSuggestionExportCodecError('INVALID_CURSOR');
	const cursor = value as Record<string, unknown>;
	if (typeof cursor.exportId !== 'string' || typeof cursor.actorId !== 'string'
		|| typeof cursor.startAt !== 'string' || typeof cursor.endAt !== 'string'
		|| !Number.isSafeInteger(cursor.limit) || typeof cursor.expiresAt !== 'string'
		|| (cursor.lastCreatedAt !== null && typeof cursor.lastCreatedAt !== 'string')
		|| (cursor.lastEventId !== null && typeof cursor.lastEventId !== 'string')) throw new HanamiSuggestionExportCodecError('INVALID_CURSOR');
	return cursor as HanamiSuggestionExportCursor;
}

/** Encrypts export state; IDs never appear in the wire token. */
export function encodeHanamiSuggestionExportCursor(cursor: HanamiSuggestionExportCursor, keys: readonly HanamiCursorSigningKey[]): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv('aes-256-gcm', keyMaterial(keys, 'hanami/suggestion-events-export/cursor/aes-256-gcm/v1'), iv, { authTagLength: TAG_BYTES });
	cipher.setAAD(AAD);
	const encrypted = Buffer.concat([cipher.update(JSON.stringify(cursor), 'utf8'), cipher.final()]);
	return Buffer.concat([MAGIC, iv, encrypted, cipher.getAuthTag()]).toString('base64url');
}

export function decodeHanamiSuggestionExportCursor(token: string, keys: readonly HanamiCursorSigningKey[], now = new Date()): HanamiSuggestionExportCursor {
	try {
		if (typeof token !== 'string' || !/^[A-Za-z0-9_-]+$/.test(token)) throw new Error('format');
		const raw = Buffer.from(token, 'base64url');
		if (raw.toString('base64url') !== token || raw.length <= MAGIC.length + IV_BYTES + TAG_BYTES || !raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('format');
		const iv = raw.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
		const tag = raw.subarray(-TAG_BYTES);
		const decipher = createDecipheriv('aes-256-gcm', keyMaterial(keys, 'hanami/suggestion-events-export/cursor/aes-256-gcm/v1'), iv, { authTagLength: TAG_BYTES });
		decipher.setAAD(AAD);
		decipher.setAuthTag(tag);
		const cursor = parseCursorPayload(JSON.parse(Buffer.concat([decipher.update(raw.subarray(MAGIC.length + IV_BYTES, -TAG_BYTES)), decipher.final()]).toString('utf8')));
		if (!Number.isFinite(Date.parse(cursor.startAt)) || !Number.isFinite(Date.parse(cursor.endAt)) || !Number.isFinite(Date.parse(cursor.expiresAt))) throw new Error('dates');
		if (Date.parse(cursor.expiresAt) <= now.getTime()) throw new HanamiSuggestionExportCodecError('EXPIRED_CURSOR');
		return cursor;
	} catch (error) {
		if (error instanceof HanamiSuggestionExportCodecError) throw error;
		throw new HanamiSuggestionExportCodecError('INVALID_CURSOR');
	}
}

export function createHanamiSuggestionExportId(): string {
	return randomBytes(24).toString('base64url');
}

export function pseudonymizeHanamiSuggestionExportId(exportId: string, domain: 'user' | 'note' | 'author', rawId: string, keys: readonly HanamiCursorSigningKey[]): string {
	const key = keyMaterial(keys, 'hanami/suggestion-events-export/pseudonym/hmac-sha256/v1');
	return `${domain}_${createHmac('sha256', key).update(exportId, 'utf8').update('\0', 'utf8').update(domain, 'ascii').update('\0', 'utf8').update(rawId, 'utf8').digest('base64url')}`;
}
