/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from '@jest/globals';
import * as crypto from 'node:crypto';
import {
	decodeHanamiCommonFeedEntryLocator,
	decodeHanamiFeedEntryLocator,
	decodeHanamiPersonalFeedEntryLocator,
	decodeAndVerifyHanamiCursor,
	encodeHanamiCommonFeedEntryLocator,
	encodeHanamiCursor,
	encodeHanamiPersonalFeedEntryLocator,
	generateHanamiRefreshToken,
	HANAMI_FEED_CODEC_GOLDEN_VECTORS,
	HanamiFeedCodecError,
	validateHanamiCursorSigningKeys,
	validateHanamiRefreshTokenFormat,
	verifyHanamiFeedCodecGoldenVectors,
	verifyHanamiRefreshTokenDigest,
	computeHanamiRefreshTokenDigest,
} from '@/core/hanami/HanamiFeedCodec.js';

process.env.NODE_ENV = 'test';

function expectCodecErrorCode(
	operation: () => unknown,
	code: HanamiFeedCodecError['code'],
): void {
	try {
		operation();
	} catch (error) {
		expect(error).toBeInstanceOf(HanamiFeedCodecError);
		expect((error as HanamiFeedCodecError).code).toBe(code);
		return;
	}
	throw new Error(`Expected HanamiFeedCodecError with code ${code}`);
}

describe('HanamiFeedCodec contracts', () => {
	const primaryKeys = [
		{ id: 'current', secret: 'x'.repeat(32) },
		{ id: 'previous', secret: 'y'.repeat(32) },
	] as const;

	test('golden vectors round-trip', () => {
		expect(() => verifyHanamiFeedCodecGoldenVectors()).not.toThrow();
		expect(encodeHanamiPersonalFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload))
			.toBe(HANAMI_FEED_CODEC_GOLDEN_VECTORS.personalLocator);
		expect(encodeHanamiCommonFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload))
			.toBe(HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonLocator);
	});

	test('cursor signing keys are validated for allowed cardinality and structure', () => {
		expect(() => validateHanamiCursorSigningKeys(primaryKeys)).not.toThrow();
		expect(() => validateHanamiCursorSigningKeys([{ id: 'a', secret: 'z'.repeat(31) }])).toThrow(HanamiFeedCodecError);
		expect(() => validateHanamiCursorSigningKeys([])).toThrow(HanamiFeedCodecError);
		expect(() => validateHanamiCursorSigningKeys([
			{ id: 'a', secret: 'z'.repeat(32) },
			{ id: 'a', secret: 'z'.repeat(32) },
			{ id: 'c', secret: 'z'.repeat(32) },
		])).toThrow(HanamiFeedCodecError);
		expect(() => validateHanamiCursorSigningKeys([
			{ id: 'a', secret: 'z'.repeat(32) },
			{ id: 'b', secret: 'z'.repeat(32) },
			{ id: 'c', secret: 'z'.repeat(32) },
		])).toThrow(HanamiFeedCodecError);
	});

	test('key rotation verifies current and previous keys while new cursors use the current key', () => {
		const payload = {
			userId: 'alice',
			kind: 'personal' as const,
			epochId: 'epoch-01',
			sequence: '9007199254740993',
		};
		const currentCursor = encodeHanamiCursor(payload, primaryKeys);
		const previousCursor = encodeHanamiCursor(payload, [primaryKeys[1]]);

		const decodedCurrent = decodeAndVerifyHanamiCursor(currentCursor, primaryKeys);
		const decodedPrevious = decodeAndVerifyHanamiCursor(previousCursor, primaryKeys);

		expect(decodedCurrent.kid).toBe('current');
		expect(decodedPrevious.kid).toBe('previous');

		const nextCursor = encodeHanamiCursor({
			userId: decodedPrevious.userId,
			kind: decodedPrevious.kind,
			epochId: decodedPrevious.epochId,
			sequence: '9007199254740992',
		}, primaryKeys);
		expect(decodeAndVerifyHanamiCursor(nextCursor, primaryKeys).kid).toBe('current');
	});

	test('a structurally valid cursor with a removed key is expired', () => {
		const cursor = encodeHanamiCursor({
			userId: 'alice',
			kind: 'personal',
			epochId: 'epoch-01',
			sequence: '42',
		}, [{ id: 'removed', secret: 'z'.repeat(32) }]);

		expectCodecErrorCode(
			() => decodeAndVerifyHanamiCursor(cursor, primaryKeys),
			'CURSOR_KEY_EXPIRED',
		);
	});

	test('cursor rejects malformed signatures and malformed structure', () => {
		const payload = {
			userId: 'alice',
			kind: 'personal' as const,
			epochId: 'epoch-01',
			sequence: '9007199254740993',
		};
		const [_, payloadB64, signatureB64] = encodeHanamiCursor(payload, primaryKeys).split('.');

		expectCodecErrorCode(
			() => decodeAndVerifyHanamiCursor(`v2.${payloadB64}.${signatureB64}`, primaryKeys),
			'INVALID_CURSOR',
		);

		const payloadBytes = Buffer.from(payloadB64, 'base64url');
		const tamperedPayload = Buffer.concat([payloadBytes, Buffer.from([0])]);
		const tamperedPayloadB64 = tamperedPayload.toString('base64url');
		const trailingSignature = crypto.createHmac('sha256', Buffer.from(primaryKeys[0]!.secret))
			.update(`v1.${tamperedPayloadB64}`)
			.digest()
			.toString('base64url');
		const withTrailingBytes = `v1.${tamperedPayloadB64}.${trailingSignature}`;
		expectCodecErrorCode(
			() => decodeAndVerifyHanamiCursor(withTrailingBytes, primaryKeys),
			'INVALID_CURSOR',
		);

		const signatureBytes = Buffer.from(signatureB64, 'base64url');
		const truncatedSignature = signatureBytes.subarray(0, 31).toString('base64url');
		expect(() => decodeAndVerifyHanamiCursor(`v1.${payloadB64}.${truncatedSignature}`, primaryKeys)).toThrow(HanamiFeedCodecError);

		const mutatedPayload = Buffer.from(payloadB64, 'base64url');
		let kindOffset = 0;
		kindOffset += 3; // HTC
		kindOffset += 1; // format version
		const kidLen = mutatedPayload.readUInt16BE(kindOffset);
		kindOffset += 2 + kidLen;
		const userIdLen = mutatedPayload.readUInt16BE(kindOffset);
		kindOffset += 2 + userIdLen;
		mutatedPayload[kindOffset] = 0x7a;
		const mutatedCursor = `v1.${mutatedPayload.toString('base64url')}.${signatureB64}`;
		expect(() => decodeAndVerifyHanamiCursor(mutatedCursor, primaryKeys)).toThrow(HanamiFeedCodecError);

		const knownKeyTamperedPayload = Buffer.from(payloadB64, 'base64url');
		const kidLength = knownKeyTamperedPayload.readUInt16BE(4);
		const userLengthOffset = 6 + kidLength;
		const userLength = knownKeyTamperedPayload.readUInt16BE(userLengthOffset);
		if (userLength === 0) throw new Error('test cursor userId must be non-empty');
		knownKeyTamperedPayload[userLengthOffset + 2] ^= 0x01;
		const knownKeyTamperedCursor = `v1.${knownKeyTamperedPayload.toString('base64url')}.${signatureB64}`;
		expectCodecErrorCode(
			() => decodeAndVerifyHanamiCursor(knownKeyTamperedCursor, primaryKeys),
			'INVALID_CURSOR',
		);

		const nonCanonicalPayload = 'AB';
		const nonCanonicalSignature = crypto.createHmac('sha256', Buffer.from(primaryKeys[0]!.secret)).update(`v1.${nonCanonicalPayload}`).digest().toString('base64url');
		expect(() => decodeAndVerifyHanamiCursor(`v1.${nonCanonicalPayload}.${nonCanonicalSignature}`, primaryKeys)).toThrow(HanamiFeedCodecError);

		expect(() => decodeAndVerifyHanamiCursor(`v1.${payloadB64}.${signatureB64}=`, primaryKeys)).toThrow(HanamiFeedCodecError);

		const tamperedSignature = Buffer.from(signatureB64, 'base64url');
		tamperedSignature[0] ^= 0x01;
		const withBadSig = `v1.${payloadB64}.${tamperedSignature.toString('base64url')}`;
		expectCodecErrorCode(
			() => decodeAndVerifyHanamiCursor(withBadSig, primaryKeys),
			'INVALID_CURSOR',
		);
	});

	test('cursor and locator enforce strict UTF-8 and bigint safety', () => {
		const payload = {
			userId: 'alice',
			kind: 'personal' as const,
			epochId: 'epoch-01',
			sequence: '9007199254740993',
		};
		const cursor = encodeHanamiCursor(payload, primaryKeys);
		const [_, payloadB64] = cursor.split('.');
		const cursorBytes = Buffer.from(payloadB64, 'base64url');
		let cursorOffset = 0;
		cursorOffset += 3; // magic
		cursorOffset += 1; // format version
		const cursorKeyLen = cursorBytes.readUInt16BE(cursorOffset);
		cursorOffset += 2;
		cursorOffset += cursorKeyLen;
		const cursorUserLen = cursorBytes.readUInt16BE(cursorOffset);
		cursorOffset += 2;
		cursorOffset += 1; // kind
		cursorBytes[cursorOffset + cursorUserLen] = 0x80;
		const badCursorB64 = cursorBytes.toString('base64url');
		const badCursorSignature = crypto.createHmac('sha256', Buffer.from(primaryKeys[0]!.secret)).update(`v1.${badCursorB64}`).digest().toString('base64url');
		expect(() => decodeAndVerifyHanamiCursor(`v1.${badCursorB64}.${badCursorSignature}`, primaryKeys)).toThrow(HanamiFeedCodecError);

		const locator = encodeHanamiPersonalFeedEntryLocator({
			userId: 'alice',
			epochId: 'epoch-01',
			sequence: '9007199254740993',
		});
		const locatorBytes = Buffer.from(locator, 'base64url');
		locatorBytes[7] = 0x80;
		expect(() => decodeHanamiPersonalFeedEntryLocator(locatorBytes.toString('base64url'))).toThrow(HanamiFeedCodecError);

		const decoded = decodeAndVerifyHanamiCursor(cursor, primaryKeys);
		expect(decoded.sequence).toBe('9007199254740993');
		expect(decoded.version).toBe(1);
	});

	test('personal/common locators encode, decode, dispatch, and validate month', () => {
		const personal = encodeHanamiPersonalFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.payload);
		const decodedPersonal = decodeHanamiPersonalFeedEntryLocator(personal);
		expect(decodedPersonal.version).toBe(1);
		expect(decodedPersonal.userId).toBe('alice');

		const common = encodeHanamiCommonFeedEntryLocator(HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload);
		const decodedCommon = decodeHanamiCommonFeedEntryLocator(common);
		expect(decodedCommon.generatedMonth).toBe('2026-08');

		const roundTrip = decodeHanamiFeedEntryLocator(personal);
		expect(roundTrip.kind).toBe('personal');
		expect(() => encodeHanamiCommonFeedEntryLocator({ ...HANAMI_FEED_CODEC_GOLDEN_VECTORS.commonPayload, generatedMonth: '2026-13' })).toThrow(HanamiFeedCodecError);
		const commonBytes = Buffer.from(common, 'base64url');
		let commonOffset = 3;
		commonOffset += 1; // format version
		commonOffset += 1; // locator kind
		const commonEpochLen = commonBytes.readUInt16BE(commonOffset);
		commonOffset += 2 + commonEpochLen;
		const generatedMonthLen = commonBytes.readUInt16BE(commonOffset);
		commonOffset += 2;
		if (generatedMonthLen > 0) {
			commonBytes[commonOffset] = 0x80;
		}
		expect(() => decodeHanamiCommonFeedEntryLocator(commonBytes.toString('base64url'))).toThrow(HanamiFeedCodecError);
	});

	test('refresh token helpers enforce exact format and timing-safe verify', () => {
		const token = generateHanamiRefreshToken();
		const computed = computeHanamiRefreshTokenDigest(token.token);
		const same = computeHanamiRefreshTokenDigest(token.token);
		expect(token.token).toHaveLength(43);
		expect(token.digest.length).toBe(32);
		expect(computed.equals(same)).toBe(true);
		expect(verifyHanamiRefreshTokenDigest(token.token, token.digest)).toBe(true);
		expect(verifyHanamiRefreshTokenDigest(token.token, Buffer.alloc(32))).toBe(false);
		expect(() => validateHanamiRefreshTokenFormat('badtoken')).toThrow(HanamiFeedCodecError);

		expect(() => validateHanamiRefreshTokenFormat(token.token.slice(0, 42))).toThrow(HanamiFeedCodecError);
		expect(() => validateHanamiRefreshTokenFormat(token.token + '!')).toThrow(HanamiFeedCodecError);
	});
});
