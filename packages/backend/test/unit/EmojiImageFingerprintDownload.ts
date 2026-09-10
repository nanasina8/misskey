/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import * as http from 'node:http';
import { describe, expect, jest, test } from '@jest/globals';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { DownloadService } from '@/core/DownloadService.js';

describe('fingerprint strict HTTP agent', () => {
	const service = new HttpRequestService({
		allowedPrivateNetworks: ['127.0.0.0/8'], proxyBypassHosts: [], outgoingAddress: undefined,
		deliverJobConcurrency: 1, proxy: null,
	} as never);

	test('rejects non HTTP(S) before any network access', () => {
		expect(() => service.getFilteredDirectAgent(new URL('file:///tmp/image.png'))).toThrow('Only HTTP(S)');
	});

	test('uses a direct filtered agent which blocks loopback outside production', async () => {
		const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
		const server = http.createServer((_request, response) => response.end('unexpected'));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as import('node:net').AddressInfo).port;
			await expect(new Promise<void>((resolve, reject) => {
				http.get(`http://127.0.0.1:${port}/`, { agent: service.getFilteredDirectAgent(new URL(`http://127.0.0.1:${port}/`)) }, response => {
					response.resume(); resolve();
				}).on('error', reject);
			})).rejects.toThrow('Blocked address');
		} finally {
			process.env.NODE_ENV = previous;
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('keeps allowedPrivateNetworks available to non-fingerprint agents', async () => {
		const previous = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
		const server = http.createServer((_request, response) => response.end('allowed'));
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as import('node:net').AddressInfo).port;
			await expect(new Promise<void>((resolve, reject) => {
				http.get(`http://127.0.0.1:${port}/`, { agent: service.getAgentByUrl(new URL(`http://127.0.0.1:${port}/`), true) }, response => {
					response.resume(); response.on('end', resolve);
				}).on('error', reject);
			})).resolves.toBeUndefined();
		} finally {
			process.env.NODE_ENV = previous;
			await new Promise<void>(resolve => server.close(() => resolve()));
		}
	});

	test('stops a redirect loop after five validated hops', async () => {
		let requests = 0;
		const server = http.createServer((request, response) => {
			requests++; response.writeHead(302, { location: request.url === '/a' ? '/b' : '/a' }); response.end();
		});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as import('node:net').AddressInfo).port;
			const download = new DownloadService({ userAgent: 'test' } as never, {
				getFilteredDirectAgent: () => new http.Agent(),
			} as never, { getLogger: () => ({ info: jest.fn(), succ: jest.fn(), warn: jest.fn() }) } as never);
			await expect(download.downloadFingerprintImage(`http://127.0.0.1:${port}/a`)).rejects.toThrow('redirect limit');
			expect(requests).toBe(6);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	});

		test('aborts a chunked response once it exceeds 16 MiB', async () => {
			let chunksSent = 0;
			const chunk = Buffer.alloc(1024 * 1024);
			const server = http.createServer((_request, response) => {
				const send = (): void => {
					if (chunksSent++ > 16) { response.end(); return; }
					response.write(chunk);
					setTimeout(send, 5);
				};
				response.on('close', () => { /* the client stopped receiving */ });
				send();
			});
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
		try {
			const port = (server.address() as import('node:net').AddressInfo).port;
			const download = new DownloadService({ userAgent: 'test' } as never, {
				getFilteredDirectAgent: () => new http.Agent(),
			} as never, { getLogger: () => ({ info: jest.fn(), succ: jest.fn(), warn: jest.fn() }) } as never);
			await expect(download.downloadFingerprintImage(`http://127.0.0.1:${port}/chunked`)).rejects.toThrow('exceeds 16 MiB');
			expect(chunksSent).toBeLessThan(18);
		} finally { await new Promise<void>(resolve => server.close(() => resolve())); }
	});
});
