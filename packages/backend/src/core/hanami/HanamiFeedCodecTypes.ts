/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Hanami feed kind carried in cursors and feed-entry locators.
 */
export type HanamiFeedKind = 'personal' | 'common';

/**
 * Decoded payload of a signed opaque Hanami timeline cursor.
 *
 * @see hanami-persisted-personalized-timeline-spec-20260813 §9.1
 */
export type HanamiCursorPayload = {
	/** Cursor format version. Phase 1 is always 1. */
	readonly version: 1;

	/** Key id that signed the cursor. */
	readonly kid: string;

	/** Complete user id that owns the cursor. */
	readonly userId: string;

	/** Feed kind the cursor traverses. */
	readonly kind: HanamiFeedKind;

	/** Feed epoch id. */
	readonly epochId: string;

	/**
	 * Last scanned personal sequence as a canonical non-negative decimal string.
	 * Never converted to Number.
	 */
	readonly sequence: string;
};

/**
 * Decoded payload of a personal feed-entry locator.
 *
 * @see hanami-persisted-personalized-timeline-spec-20260813 §7.3
 */
export type HanamiPersonalFeedEntryLocator = {
	readonly version: 1;
	readonly userId: string;
	readonly epochId: string;
	readonly sequence: string;
};

/**
 * Decoded payload of a common feed-entry locator.
 *
 * @see hanami-persisted-personalized-timeline-spec-20260813 §7.3
 */
export type HanamiCommonFeedEntryLocator = {
	readonly version: 1;
	readonly epochId: string;
	/** Exact `YYYY-MM` generation month. */
	readonly generatedMonth: string;
	readonly rowId: string;
};

/**
 * Discriminated union of decoded feed-entry locators.
 */
export type HanamiFeedEntryLocator =
	| ({ readonly kind: 'personal' } & HanamiPersonalFeedEntryLocator)
	| ({ readonly kind: 'common' } & HanamiCommonFeedEntryLocator);

/**
 * A cursor signing key.
 *
 * The first element in a validated key list is used for signing.
 * Verification looks up the key by its `id` and requires the secret to be
 * at least 32 bytes.
 */
export type HanamiCursorSigningKey = {
	readonly id: string;
	readonly secret: Buffer | string;
};

/**
 * A freshly generated refresh token and its SHA-256 digest for bytea storage.
 *
 * @see hanami-persisted-personalized-timeline-spec-20260813 §10
 */
export type HanamiRefreshToken = {
	/** The 32-byte base64url token string (43 chars, no padding). */
	readonly token: string;
	/** SHA-256 digest of `token` as a Buffer. */
	readonly digest: Buffer;
};

/**
 * Error thrown by the codec for malformed input, validation failure, or a
 * structurally valid cursor whose signing key has left the rotation window.
 */
export class HanamiFeedCodecError extends Error {
	constructor(
		message: string,
		public readonly code:
			| 'INVALID_CURSOR'
			| 'CURSOR_KEY_EXPIRED'
			| 'INVALID_LOCATOR'
			| 'INVALID_REFRESH_TOKEN'
			| 'INVALID_SIGNING_KEYS',
	) {
		super(message);
		this.name = 'HanamiFeedCodecError';
	}
}
