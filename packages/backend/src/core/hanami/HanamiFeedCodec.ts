/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
export * from '@/core/hanami/HanamiFeedCodecTypes.js';

import {
	type HanamiCommonFeedEntryLocator,
	type HanamiCursorPayload,
	type HanamiCursorSigningKey,
	type HanamiFeedEntryLocator,
	type HanamiFeedKind,
	type HanamiPersonalFeedEntryLocator,
	type HanamiRefreshToken,
	HanamiFeedCodecError,
} from '@/core/hanami/HanamiFeedCodecTypes.js';

// ───────────────────────── format constants ─────────────────────────

const CURSOR_VERSION_PREFIX = 'v1';
const CURSOR_MAGIC = 'HTC';
const LOCATOR_MAGIC = 'HFE';
const FORMAT_VERSION = 1;

const MAX_KID_BYTES = 64;
const MAX_USER_ID_BYTES = 64;
const MAX_EPOCH_ID_BYTES = 128;
const MAX_ROW_ID_BYTES = 128;
const MAX_SEQUENCE_DECIMAL_CHARS = 19; // length of PostgreSQL signed bigint max (9223372036854775807)

const PG_BIGINT_MAX = '9223372036854775807';

const REFRESH_TOKEN_RAW_BYTES = 32;
const REFRESH_TOKEN_ENCODED_LEN = 43; // ceil(32 * 4 / 3)
const REFRESH_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const BASE64URL_ALPHABET_RE = /^[A-Za-z0-9_-]+$/;
const CANONICAL_DECIMAL_RE = /^(?:0|[1-9]\d*)$/;
const GENERATED_MONTH_RE = /^[0-9]{4}-(?:0[1-9]|1[0-2])$/;

// ───────────────────────── base64url helpers ─────────────────────────

function base64UrlEncode(buf: Buffer): string {
	return buf.toString('base64url');
}

function base64UrlDecode(
	s: string,
	context: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR' | 'INVALID_REFRESH_TOKEN',
): Buffer {
	if (s.length === 0) {
		throw new HanamiFeedCodecError(`${context}: empty base64url`, errorCode);
	}
	if (s.includes('=')) {
		throw new HanamiFeedCodecError(`${context}: padding is not allowed`, errorCode);
	}
	if (!BASE64URL_ALPHABET_RE.test(s)) {
		throw new HanamiFeedCodecError(`${context}: invalid base64url alphabet`, errorCode);
	}
	const mod = s.length % 4;
	if (mod === 1) {
		throw new HanamiFeedCodecError(`${context}: invalid unpadded base64url length`, errorCode);
	}
	const buf = Buffer.from(s, 'base64url');
	// Reject non-canonical encodings (e.g. trailing bits that would require padding).
	if (base64UrlEncode(buf) !== s) {
		throw new HanamiFeedCodecError(`${context}: non-canonical base64url encoding`, errorCode);
	}
	return buf;
}

// ───────────────────────── UTF-8 / buffer builders ─────────────────────────

function decodeUtf8Strict(
	buf: Buffer,
	start: number,
	end: number,
	field: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR',
): string {
	const value = buf.toString('utf8', start, end);
	const reencoded = Buffer.from(value, 'utf8');
	const original = buf.subarray(start, end);
	if (reencoded.length !== original.length || !reencoded.equals(original)) {
		throw new HanamiFeedCodecError(`${field} is not valid UTF-8`, errorCode);
	}
	return value;
}

function encodeLengthPrefixedString(
	value: string,
	maxBytes: number,
	field: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR' = 'INVALID_CURSOR',
): Buffer {
	const bytes = Buffer.from(value, 'utf8');
	if (bytes.length === 0 || bytes.length > maxBytes) {
		throw new HanamiFeedCodecError(`${field} length out of bounds`, errorCode);
	}
	const len = Buffer.allocUnsafe(2);
	len.writeUInt16BE(bytes.length, 0);
	return Buffer.concat([len, bytes]);
}

function readLengthPrefixedString(
	buf: Buffer,
	offset: { value: number },
	maxBytes: number,
	field: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR',
): string {
	if (offset.value + 2 > buf.length) {
		throw new HanamiFeedCodecError(`truncated ${field} length`, errorCode);
	}
	const len = buf.readUInt16BE(offset.value);
	offset.value += 2;
	if (len > maxBytes) {
		throw new HanamiFeedCodecError(`${field} exceeds maximum length`, errorCode);
	}
	if (offset.value + len > buf.length) {
		throw new HanamiFeedCodecError(`truncated ${field} value`, errorCode);
	}
	const value = decodeUtf8Strict(buf, offset.value, offset.value + len, field, errorCode);
	offset.value += len;
	return value;
}

function readFixedBytes(buf: Buffer, offset: { value: number }, len: number, field: string, errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR'): Buffer {
	if (offset.value + len > buf.length) {
		throw new HanamiFeedCodecError(`truncated ${field}`, errorCode);
	}
	const value = Buffer.from(buf.subarray(offset.value, offset.value + len));
	offset.value += len;
	return value;
}

function readU8(buf: Buffer, offset: { value: number }, field: string, errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR'): number {
	if (offset.value + 1 > buf.length) {
		throw new HanamiFeedCodecError(`truncated ${field}`, errorCode);
	}
	return buf[offset.value++];
}

function readMagic(buf: Buffer, expected: string, errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR'): void {
	const offset = { value: 0 };
	const bytes = readFixedBytes(buf, offset, expected.length, 'magic', errorCode);
	if (bytes.toString('ascii') !== expected) {
		throw new HanamiFeedCodecError('invalid magic', errorCode);
	}
}

function validateCanonicalDecimalBounded(
	value: string,
	field: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR',
): void {
	if (!CANONICAL_DECIMAL_RE.test(value)) {
		throw new HanamiFeedCodecError(`${field} must be a canonical non-negative decimal string with no leading zeros`, errorCode);
	}
	// Bound to PostgreSQL signed bigint maximum without using Number.
	if (value.length > PG_BIGINT_MAX.length || (value.length === PG_BIGINT_MAX.length && value > PG_BIGINT_MAX)) {
		throw new HanamiFeedCodecError(`${field} exceeds PostgreSQL signed bigint max (${PG_BIGINT_MAX})`, errorCode);
	}
}

function validateEpochId(
	epochId: string,
	errorCode: 'INVALID_CURSOR' | 'INVALID_LOCATOR' = 'INVALID_CURSOR',
): void {
	if (epochId.length === 0 || Buffer.byteLength(epochId, 'utf8') > MAX_EPOCH_ID_BYTES) {
		throw new HanamiFeedCodecError('invalid epochId length', errorCode);
	}
}

function secretToBuffer(secret: Buffer | string): Buffer {
	return Buffer.isBuffer(secret) ? Buffer.from(secret) : Buffer.from(secret, 'utf8');
}

// ───────────────────────── signing-key validation ─────────────────────────

/**
 * Validate a list of cursor signing keys for configuration integration.
 *
 * Requirements:
 * - Exactly one current key, optionally plus one previous key (length 1..2).
 * - Every key has a non-empty, unique id (max 64 UTF-8 bytes).
 * - Every secret represents at least 32 bytes.
 *
 * Throws {@link HanamiFeedCodecError} with code `INVALID_SIGNING_KEYS` on failure.
 */
export function validateHanamiCursorSigningKeys(keys: readonly HanamiCursorSigningKey[]): void {
	if (!Array.isArray(keys) || keys.length === 0 || keys.length > 2) {
		throw new HanamiFeedCodecError('hanamiCursorSigningKeys must contain 1 or 2 keys (current + optional previous)', 'INVALID_SIGNING_KEYS');
	}

	const seen = new Set<string>();
	for (const key of keys) {
		if (key == null || typeof key.id !== 'string' || key.id.length === 0) {
			throw new HanamiFeedCodecError('cursor signing key id must be a non-empty string', 'INVALID_SIGNING_KEYS');
		}
		if (Buffer.byteLength(key.id, 'utf8') > MAX_KID_BYTES) {
			throw new HanamiFeedCodecError(`cursor signing key id too long: ${key.id}`, 'INVALID_SIGNING_KEYS');
		}
		if (seen.has(key.id)) {
			throw new HanamiFeedCodecError(`duplicate cursor signing key id: ${key.id}`, 'INVALID_SIGNING_KEYS');
		}
		seen.add(key.id);

		const secret = secretToBuffer(key.secret);
		if (secret.length < 32) {
			throw new HanamiFeedCodecError(`cursor signing key secret must be at least 32 bytes (kid=${key.id})`, 'INVALID_SIGNING_KEYS');
		}
	}
}

// ───────────────────────── cursor ─────────────────────────

/**
 * Encode a Hanami timeline cursor.
 *
 * Always uses `keys[0].id` as the embedded kid and `keys[0]` to sign, so the
 * encoder cannot emit a cursor that cannot later be verified. The key list is
 * validated defensively here.
 */
export function encodeHanamiCursor(
	payload: Omit<HanamiCursorPayload, 'version' | 'kid'>,
	keys: readonly HanamiCursorSigningKey[],
): string {
	validateHanamiCursorSigningKeys(keys);

	const signingKey = keys[0]!;
	const kid = signingKey.id;

	// Enforce bounded lengths and canonical sequence on encoding as well as decoding.
	if (payload.userId.length === 0 || Buffer.byteLength(payload.userId, 'utf8') > MAX_USER_ID_BYTES) {
		throw new HanamiFeedCodecError('invalid userId length', 'INVALID_CURSOR');
	}
	validateEpochId(payload.epochId, 'INVALID_CURSOR');
	validateCanonicalDecimalBounded(payload.sequence, 'sequence', 'INVALID_CURSOR');

	if (payload.kind !== 'personal' && payload.kind !== 'common') {
		throw new HanamiFeedCodecError('invalid cursor kind', 'INVALID_CURSOR');
	}

	const kidBuf = encodeLengthPrefixedString(kid, MAX_KID_BYTES, 'kid');
	const userIdBuf = encodeLengthPrefixedString(payload.userId, MAX_USER_ID_BYTES, 'userId');
	const kindBuf = Buffer.from(payload.kind === 'personal' ? 'p' : 'c', 'ascii');
	const epochIdBuf = encodeLengthPrefixedString(payload.epochId, MAX_EPOCH_ID_BYTES, 'epochId');
	const sequenceBuf = encodeLengthPrefixedString(payload.sequence, MAX_SEQUENCE_DECIMAL_CHARS, 'sequence');

	const payloadBytes = Buffer.concat([
		Buffer.from(CURSOR_MAGIC, 'ascii'),
		Buffer.from([FORMAT_VERSION]),
		kidBuf,
		userIdBuf,
		kindBuf,
		epochIdBuf,
		sequenceBuf,
	]);

	const payloadB64 = base64UrlEncode(payloadBytes);
	const signingInput = `${CURSOR_VERSION_PREFIX}.${payloadB64}`;
	const signature = createHmac('sha256', secretToBuffer(signingKey.secret))
		.update(signingInput, 'ascii')
		.digest();

	return `${CURSOR_VERSION_PREFIX}.${payloadB64}.${base64UrlEncode(signature)}`;
}

/**
 * Decode and verify a Hanami timeline cursor.
 *
 * Validates format, version, alphabet, no padding, bounded lengths,
 * canonical decimal sequence bounded to PostgreSQL bigint, exact byte layout,
 * and the HMAC-SHA-256 signature using the configured key that matches the
 * embedded kid.
 *
 * Throws {@link HanamiFeedCodecError} with code `CURSOR_KEY_EXPIRED` when the
 * structurally valid cursor names a key outside the current/previous rotation
 * window. Malformed payloads, bad signatures for known keys, and wrong formats
 * use `INVALID_CURSOR`. Epoch/retention expiration (`CURSOR_EXPIRED`) is a
 * higher-layer state decision and is **not** emitted by this codec.
 */
export function decodeAndVerifyHanamiCursor(
	cursor: string,
	keys: readonly HanamiCursorSigningKey[],
): HanamiCursorPayload {
	validateHanamiCursorSigningKeys(keys);

	const parts = cursor.split('.');
	if (parts.length !== 3 || parts[0] !== CURSOR_VERSION_PREFIX) {
		throw new HanamiFeedCodecError('invalid cursor format', 'INVALID_CURSOR');
	}
	const [, payloadB64, signatureB64] = parts as [string, string, string];

	const payloadBytes = base64UrlDecode(payloadB64, 'cursorPayload', 'INVALID_CURSOR');
	const signatureBytes = base64UrlDecode(signatureB64, 'cursorSignature', 'INVALID_CURSOR');
	if (signatureBytes.length !== 32) {
		throw new HanamiFeedCodecError('invalid signature length', 'INVALID_CURSOR');
	}

	const offset = { value: 0 };
	readMagic(payloadBytes, CURSOR_MAGIC, 'INVALID_CURSOR');
	offset.value = CURSOR_MAGIC.length;

	const version = readU8(payloadBytes, offset, 'version', 'INVALID_CURSOR');
	if (version !== FORMAT_VERSION) {
		throw new HanamiFeedCodecError(`unsupported cursor version ${version}`, 'INVALID_CURSOR');
	}

	const kid = readLengthPrefixedString(payloadBytes, offset, MAX_KID_BYTES, 'kid', 'INVALID_CURSOR');
	const userId = readLengthPrefixedString(payloadBytes, offset, MAX_USER_ID_BYTES, 'userId', 'INVALID_CURSOR');
	if (kid.length === 0) {
		throw new HanamiFeedCodecError('cursor kid must be non-empty', 'INVALID_CURSOR');
	}
	if (userId.length === 0) {
		throw new HanamiFeedCodecError('cursor userId must be non-empty', 'INVALID_CURSOR');
	}
	const kindByte = readFixedBytes(payloadBytes, offset, 1, 'kind', 'INVALID_CURSOR');
	const kindChar = kindByte.toString('ascii');
	if (kindChar !== 'p' && kindChar !== 'c') {
		throw new HanamiFeedCodecError('invalid cursor kind', 'INVALID_CURSOR');
	}
	const kind: HanamiFeedKind = kindChar === 'p' ? 'personal' : 'common';
	const epochId = readLengthPrefixedString(payloadBytes, offset, MAX_EPOCH_ID_BYTES, 'epochId', 'INVALID_CURSOR');
	const sequence = readLengthPrefixedString(payloadBytes, offset, MAX_SEQUENCE_DECIMAL_CHARS, 'sequence', 'INVALID_CURSOR');

	if (offset.value !== payloadBytes.length) {
		throw new HanamiFeedCodecError('trailing bytes in cursor payload', 'INVALID_CURSOR');
	}

	validateCanonicalDecimalBounded(sequence, 'sequence', 'INVALID_CURSOR');
	validateEpochId(epochId, 'INVALID_CURSOR');

	const signingKey = keys.find(k => k.id === kid);
	if (signingKey == null) {
		throw new HanamiFeedCodecError('cursor signing kid is outside the rotation window', 'CURSOR_KEY_EXPIRED');
	}

	const signingInput = `${CURSOR_VERSION_PREFIX}.${payloadB64}`;
	const expectedSignature = createHmac('sha256', secretToBuffer(signingKey.secret))
		.update(signingInput, 'ascii')
		.digest();

	if (!timingSafeEqual(expectedSignature, signatureBytes)) {
		throw new HanamiFeedCodecError('cursor signature mismatch', 'INVALID_CURSOR');
	}

	return {
		version: FORMAT_VERSION,
		kid,
		userId,
		kind,
		epochId,
		sequence,
	};
}

// ───────────────────────── feed-entry locators ─────────────────────────

type LocatorHeader = { version: number; kind: HanamiFeedKind; offset: { value: number } };

function readLocatorHeader(buf: Buffer): LocatorHeader {
	readMagic(buf, LOCATOR_MAGIC, 'INVALID_LOCATOR');
	const offset = { value: LOCATOR_MAGIC.length };

	const version = readU8(buf, offset, 'version', 'INVALID_LOCATOR');
	if (version !== FORMAT_VERSION) {
		throw new HanamiFeedCodecError(`unsupported locator version ${version}`, 'INVALID_LOCATOR');
	}

	const kindByte = readFixedBytes(buf, offset, 1, 'kind', 'INVALID_LOCATOR');
	const kindChar = kindByte.toString('ascii');
	if (kindChar !== 'p' && kindChar !== 'c') {
		throw new HanamiFeedCodecError('invalid locator kind', 'INVALID_LOCATOR');
	}
	const kind: HanamiFeedKind = kindChar === 'p' ? 'personal' : 'common';

	return { version, kind, offset };
}

function decodePersonalLocatorFields(
	buf: Buffer,
	offset: { value: number },
): HanamiPersonalFeedEntryLocator {
	const userId = readLengthPrefixedString(buf, offset, MAX_USER_ID_BYTES, 'userId', 'INVALID_LOCATOR');
	const epochId = readLengthPrefixedString(buf, offset, MAX_EPOCH_ID_BYTES, 'epochId', 'INVALID_LOCATOR');
	const sequence = readLengthPrefixedString(buf, offset, MAX_SEQUENCE_DECIMAL_CHARS, 'sequence', 'INVALID_LOCATOR');

	if (offset.value !== buf.length) {
		throw new HanamiFeedCodecError('trailing bytes in personal locator', 'INVALID_LOCATOR');
	}

	validateCanonicalDecimalBounded(sequence, 'sequence', 'INVALID_LOCATOR');
	validateEpochId(epochId, 'INVALID_LOCATOR');

	return { version: FORMAT_VERSION, userId, epochId, sequence };
}

function decodeCommonLocatorFields(
	buf: Buffer,
	offset: { value: number },
): HanamiCommonFeedEntryLocator {
	const epochId = readLengthPrefixedString(buf, offset, MAX_EPOCH_ID_BYTES, 'epochId', 'INVALID_LOCATOR');
	const generatedMonth = readLengthPrefixedString(buf, offset, 7, 'generatedMonth', 'INVALID_LOCATOR');
	const rowId = readLengthPrefixedString(buf, offset, MAX_ROW_ID_BYTES, 'rowId', 'INVALID_LOCATOR');

	if (offset.value !== buf.length) {
		throw new HanamiFeedCodecError('trailing bytes in common locator', 'INVALID_LOCATOR');
	}

	if (!GENERATED_MONTH_RE.test(generatedMonth)) {
		throw new HanamiFeedCodecError('generatedMonth must be exact YYYY-MM', 'INVALID_LOCATOR');
	}
	validateEpochId(epochId, 'INVALID_LOCATOR');

	return { version: FORMAT_VERSION, epochId, generatedMonth, rowId };
}

/**
 * Encode a personal feed-entry locator.
 *
 * Output is canonical unpadded base64url and unsigned.
 * Authorization must be performed later by DB lookup.
 */
export function encodeHanamiPersonalFeedEntryLocator(
	payload: Omit<HanamiPersonalFeedEntryLocator, 'version'>,
): string {
	if (payload.userId.length === 0 || Buffer.byteLength(payload.userId, 'utf8') > MAX_USER_ID_BYTES) {
		throw new HanamiFeedCodecError('invalid userId length', 'INVALID_LOCATOR');
	}
	validateEpochId(payload.epochId, 'INVALID_LOCATOR');
	validateCanonicalDecimalBounded(payload.sequence, 'sequence', 'INVALID_LOCATOR');

	const userIdBuf = encodeLengthPrefixedString(payload.userId, MAX_USER_ID_BYTES, 'userId', 'INVALID_LOCATOR');
	const epochIdBuf = encodeLengthPrefixedString(payload.epochId, MAX_EPOCH_ID_BYTES, 'epochId', 'INVALID_LOCATOR');
	const sequenceBuf = encodeLengthPrefixedString(payload.sequence, MAX_SEQUENCE_DECIMAL_CHARS, 'sequence', 'INVALID_LOCATOR');

	const bytes = Buffer.concat([
		Buffer.from(LOCATOR_MAGIC, 'ascii'),
		Buffer.from([FORMAT_VERSION]),
		Buffer.from('p', 'ascii'),
		userIdBuf,
		epochIdBuf,
		sequenceBuf,
	]);

	return base64UrlEncode(bytes);
}

/**
 * Decode a personal feed-entry locator.
 *
 * Throws {@link HanamiFeedCodecError} with code `INVALID_LOCATOR` on any failure.
 */
export function decodeHanamiPersonalFeedEntryLocator(
	locator: string,
): HanamiPersonalFeedEntryLocator {
	const bytes = base64UrlDecode(locator, 'locator', 'INVALID_LOCATOR');
	const header = readLocatorHeader(bytes);
	if (header.kind !== 'personal') {
		throw new HanamiFeedCodecError('invalid personal locator kind', 'INVALID_LOCATOR');
	}
	return decodePersonalLocatorFields(bytes, header.offset);
}

/**
 * Encode a common feed-entry locator.
 *
 * Output is canonical unpadded base64url and unsigned.
 */
export function encodeHanamiCommonFeedEntryLocator(
	payload: Omit<HanamiCommonFeedEntryLocator, 'version'>,
): string {
	if (!GENERATED_MONTH_RE.test(payload.generatedMonth)) {
		throw new HanamiFeedCodecError('generatedMonth must be exact YYYY-MM', 'INVALID_LOCATOR');
	}
	validateEpochId(payload.epochId, 'INVALID_LOCATOR');
	if (payload.rowId.length === 0 || Buffer.byteLength(payload.rowId, 'utf8') > MAX_ROW_ID_BYTES) {
		throw new HanamiFeedCodecError('invalid rowId length', 'INVALID_LOCATOR');
	}

	const epochIdBuf = encodeLengthPrefixedString(payload.epochId, MAX_EPOCH_ID_BYTES, 'epochId', 'INVALID_LOCATOR');
	const monthBuf = encodeLengthPrefixedString(payload.generatedMonth, 7, 'generatedMonth', 'INVALID_LOCATOR');
	const rowIdBuf = encodeLengthPrefixedString(payload.rowId, MAX_ROW_ID_BYTES, 'rowId', 'INVALID_LOCATOR');

	const bytes = Buffer.concat([
		Buffer.from(LOCATOR_MAGIC, 'ascii'),
		Buffer.from([FORMAT_VERSION]),
		Buffer.from('c', 'ascii'),
		epochIdBuf,
		monthBuf,
		rowIdBuf,
	]);

	return base64UrlEncode(bytes);
}

/**
 * Decode a common feed-entry locator.
 *
 * Throws {@link HanamiFeedCodecError} with code `INVALID_LOCATOR` on any failure.
 */
export function decodeHanamiCommonFeedEntryLocator(
	locator: string,
): HanamiCommonFeedEntryLocator {
	const bytes = base64UrlDecode(locator, 'locator', 'INVALID_LOCATOR');
	const header = readLocatorHeader(bytes);
	if (header.kind !== 'common') {
		throw new HanamiFeedCodecError('invalid common locator kind', 'INVALID_LOCATOR');
	}
	return decodeCommonLocatorFields(bytes, header.offset);
}

/**
 * Encode a feed-entry locator, dispatching by kind.
 */
export function encodeHanamiFeedEntryLocator(locator: HanamiFeedEntryLocator): string {
	if (locator.kind === 'personal') {
		return encodeHanamiPersonalFeedEntryLocator(locator);
	} else if (locator.kind === 'common') {
		return encodeHanamiCommonFeedEntryLocator(locator);
	} else {
		throw new HanamiFeedCodecError('invalid feed-entry locator kind', 'INVALID_LOCATOR');
	}
}

/**
 * Decode a feed-entry locator, dispatching by kind.
 *
 * Decodes the base64url payload once, validates magic/version, and dispatches
 * to the kind-specific field decoder.
 */
export function decodeHanamiFeedEntryLocator(locator: string): HanamiFeedEntryLocator {
	const bytes = base64UrlDecode(locator, 'locator', 'INVALID_LOCATOR');
	const header = readLocatorHeader(bytes);
	if (header.kind === 'personal') {
		return { kind: 'personal', ...decodePersonalLocatorFields(bytes, header.offset) };
	} else {
		return { kind: 'common', ...decodeCommonLocatorFields(bytes, header.offset) };
	}
}

// ───────────────────────── refresh token ─────────────────────────

/**
 * Generate a new refresh token and its SHA-256 digest.
 *
 * The returned `token` is a 32-byte cryptographically random value encoded
 * with canonical unpadded base64url (43 characters). The `digest` is the
 * SHA-256 hash of the token string, suitable for storing in a `bytea` column.
 *
 * This is the only function in the module that performs side effects
 * (entropy extraction).
 */
export function generateHanamiRefreshToken(): HanamiRefreshToken {
	const token = randomBytes(REFRESH_TOKEN_RAW_BYTES).toString('base64url');
	// base64url of 32 bytes is always 43 chars without padding.
	const digest = createHash('sha256').update(token, 'ascii').digest();
	return Object.freeze({ token, digest });
}

/**
 * Compute the SHA-256 digest of a refresh token string.
 *
 * Validates the token format first; throws on invalid input.
 */
export function computeHanamiRefreshTokenDigest(token: string): Buffer {
	validateHanamiRefreshTokenFormat(token);
	return createHash('sha256').update(token, 'ascii').digest();
}

/**
 * Verify a refresh token against a stored SHA-256 digest using a timing-safe
 * comparison.
 *
 * Returns `false` for any malformed token or digest mismatch.
 */
export function verifyHanamiRefreshTokenDigest(token: string, digest: Buffer): boolean {
	try {
		validateHanamiRefreshTokenFormat(token);
	} catch {
		return false;
	}
	if (!Buffer.isBuffer(digest) || digest.length !== 32) {
		return false;
	}
	const expected = createHash('sha256').update(token, 'ascii').digest();
	return timingSafeEqual(expected, digest);
}

/**
 * Validate that a refresh token is a strict 32-byte base64url value.
 *
 * Throws {@link HanamiFeedCodecError} with code `INVALID_REFRESH_TOKEN` on failure.
 */
export function validateHanamiRefreshTokenFormat(token: string): void {
	if (typeof token !== 'string' || token.length !== REFRESH_TOKEN_ENCODED_LEN) {
		throw new HanamiFeedCodecError('refresh token must be 43 base64url characters', 'INVALID_REFRESH_TOKEN');
	}
	if (!REFRESH_TOKEN_RE.test(token)) {
		throw new HanamiFeedCodecError('refresh token contains invalid characters or padding', 'INVALID_REFRESH_TOKEN');
	}
	// Ensure the decoded raw length is exactly 32 bytes.
	const raw = base64UrlDecode(token, 'refreshToken', 'INVALID_REFRESH_TOKEN');
	if (raw.length !== REFRESH_TOKEN_RAW_BYTES) {
		throw new HanamiFeedCodecError('refresh token does not decode to 32 bytes', 'INVALID_REFRESH_TOKEN');
	}
}

// ───────────────────────── golden-vector verification ─────────────────────────

const GOLDEN_KEY_HEX = '0123456789abcdef'.repeat(4);

/**
 * Golden vectors from WP1-CODEC task description.
 *
 * These exist so integration tests can assert bit-exact compatibility without
 * adding new test files to the repository.
 */
export const HANAMI_FEED_CODEC_GOLDEN_VECTORS = Object.freeze({
	keyHex: GOLDEN_KEY_HEX,
	cursor: 'v1.SFRDAQACazEABWFsaWNlcAAIZXBvY2gtMDEAEDkwMDcxOTkyNTQ3NDA5OTM.0Gdi6SnIZZm2Fz6ZvWnZG0_hffq-A72FjpECmjuGS9U',
	personalLocator: 'SEZFAXAABWFsaWNlAAhlcG9jaC0wMQAQOTAwNzE5OTI1NDc0MDk5Mw',
	commonLocator: 'SEZFAWMAD2NvbW1vbi1lcG9jaC0wMQAHMjAyNi0wOAAIcm93LTAwMDE',
	payload: Object.freeze({
		kid: 'k1',
		userId: 'alice',
		kind: 'personal' as const,
		epochId: 'epoch-01',
		sequence: '9007199254740993',
	}),
	commonPayload: Object.freeze({
		epochId: 'common-epoch-01',
		generatedMonth: '2026-08',
		rowId: 'row-0001',
	}),
});

/**
 * Verify the codec against the WP1-CODEC golden vectors.
 *
 * Throws if any vector does not round-trip exactly.
 */
export function verifyHanamiFeedCodecGoldenVectors(): void {
	const key: HanamiCursorSigningKey = {
		id: HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload.kid,
		secret: Buffer.from(HANAMI_FEED_CODEC_GOLDEN_VECTORS.keyHex, 'hex'),
	};
	const keys = [key] as const;

	// Cursor
	const { userId, kind, epochId, sequence } = HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload;
	const encodedCursor = encodeHanamiCursor({ userId, kind, epochId, sequence }, keys);
	if (encodedCursor !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.cursor) {
		throw new Error(`cursor golden mismatch: expected ${HANAMI_FEED_CODEC_GOLDEN_VECTORS.cursor}, got ${encodedCursor}`);
	}
	const decodedCursor = decodeAndVerifyHanamiCursor(encodedCursor, keys);
	if (
		decodedCursor.kid !== key.id ||
		decodedCursor.userId !== userId ||
		decodedCursor.kind !== kind ||
		decodedCursor.epochId !== epochId ||
		decodedCursor.sequence !== sequence
	) {
		throw new Error('cursor payload golden mismatch after decode');
	}

	// Personal locator
	const encodedPersonal = encodeHanamiPersonalFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload);
	if (encodedPersonal !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.personalLocator) {
		throw new Error(`personal locator golden mismatch: expected ${HANAMI_FEED_CODEC_GOLDEN_VECTORS.personalLocator}, got ${encodedPersonal}`);
	}
	const decodedPersonal = decodeHanamiPersonalFeedEntryLocator(encodedPersonal);
	if (
		decodedPersonal.userId !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload.userId ||
		decodedPersonal.epochId !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload.epochId ||
		decodedPersonal.sequence !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload.sequence
	) {
		throw new Error('personal locator payload golden mismatch after decode');
	}

	// Common locator
	const encodedCommon = encodeHanamiCommonFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload);
	if (encodedCommon !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonLocator) {
		throw new Error(`common locator golden mismatch: expected ${HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonLocator}, got ${encodedCommon}`);
	}
	const decodedCommon = decodeHanamiCommonFeedEntryLocator(encodedCommon);
	if (
		decodedCommon.epochId !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload.epochId ||
		decodedCommon.generatedMonth !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload.generatedMonth ||
		decodedCommon.rowId !== HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload.rowId
	) {
		throw new Error('common locator payload golden mismatch after decode');
	}
}
