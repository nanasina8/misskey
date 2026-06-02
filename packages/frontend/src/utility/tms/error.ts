/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taiyme 由来
export class TmsError extends Error {
	public readonly code: string;
	public readonly id: string;
	public readonly kind: string;

	constructor(error: {
		readonly message: string;
		readonly code: string;
		readonly id: string;
		readonly kind?: string | null;
	}) {
		const kind = error.kind == null ? 'tms' : `tms/${error.kind}`;
		const message = `${error.message} (kind: ${kind})`;

		super(message);

		this.code = error.code;
		this.id = error.id;
		this.kind = kind;
	}
}
