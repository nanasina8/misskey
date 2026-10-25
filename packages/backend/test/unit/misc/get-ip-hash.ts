/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { getIpHash } from '@/misc/get-ip-hash.js';

describe('IP rate limit keys', () => {
	test.each([
		['127.0.0.1', 'ip-z8kflt'],
		['192.0.2.17', 'ip-1h9u1w1'],
		['192.0.2.17:12345', 'ip-1h9u1w1'],
		['::ffff:192.0.2.17', 'ip-1h9u1w1'],
		['::ffff:c000:211', 'ip-1h9u1w1'],
		['::1', 'ip-0'],
		['2001:db8:1234:5678::1', 'ip-hir6906uoepk'],
		['2001:db8:1234:5678:ffff:ffff:ffff:ffff', 'ip-hir6906uoepk'],
	])('groups %s into the expected address or /64 key', (address, expected) => {
		expect(getIpHash(address)).toBe(expected);
	});

	test.each(['invalid', '127.00.0.1', '127.0.0.1/8', '2001:db8::invalid'])('rejects malformed input %s', address => {
		expect(() => getIpHash(address)).toThrow();
	});
});
