/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';

export function getIpHash(ip: string): string {
	const address = isIP(ip) ? ip : ip.replace(/:[0-9]+$/, '');
	if (!isIP(address)) throw new Error('Invalid IP address');
	// Normalize IPv4-mapped IPv6 to the same key as IPv4. For native IPv6,
	// group the /64 prefix so rotating interface addresses cannot bypass limits.
	const prefix = ipaddr.process(address).toByteArray().slice(0, 8);
	return 'ip-' + BigInt('0x' + prefix.map(byte => byte.toString(16).padStart(2, '0')).join('')).toString(36);
}
