/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// Load the built server with Node's native ESM loader. Transforming its cyclic
// endpoint imports into CommonJS during globalSetup changes initialization order.
module.exports = async () => {
	const { default: launch } = await import('../built-test/entry.js');
	await launch();
};
