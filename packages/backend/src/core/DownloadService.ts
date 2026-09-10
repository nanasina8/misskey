/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as fs from 'node:fs';
import * as stream from 'node:stream/promises';
import { Inject, Injectable } from '@nestjs/common';
import chalk from 'chalk';
import got, * as Got from 'got';
import { parse } from 'content-disposition';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { createTemp } from '@/misc/create-temp.js';
import { StatusError } from '@/misc/status-error.js';
import { LoggerService } from '@/core/LoggerService.js';
import type Logger from '@/logger.js';

import { bindThis } from '@/decorators.js';

@Injectable()
export class DownloadService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		private httpRequestService: HttpRequestService,
		private loggerService: LoggerService,
	) {
		this.logger = this.loggerService.getLogger('download');
	}

	@bindThis
	public async downloadUrl(url: string, path: string, options: { timeout?: number, operationTimeout?: number, maxSize?: number } = {} ): Promise<{
		filename: string;
	}> {
		this.logger.info(`Downloading ${chalk.cyan(url)} to ${chalk.cyanBright(path)} ...`);

		const timeout = options.timeout ?? 30 * 1000;
		const operationTimeout = options.operationTimeout ?? 60 * 1000;
		const maxSize = options.maxSize ?? this.config.maxFileSize;

		const urlObj = new URL(url);
		let filename = urlObj.pathname.split('/').pop() ?? 'untitled';

		const req = got.stream(url, {
			headers: {
				'User-Agent': this.config.userAgent,
			},
			timeout: {
				lookup: timeout,
				connect: timeout,
				secureConnect: timeout,
				socket: timeout,	// read timeout
				response: timeout,
				send: timeout,
				request: operationTimeout,	// whole operation timeout
			},
			agent: {
				http: this.httpRequestService.getAgentForHttp(urlObj, true),
				https: this.httpRequestService.getAgentForHttps(urlObj, true),
			},
			http2: false,	// default
			retry: {
				limit: 0,
			},
			enableUnixSockets: false,
		}).on('response', (res: Got.Response) => {
			const contentLength = res.headers['content-length'];
			if (contentLength != null) {
				const size = Number(contentLength);
				if (size > maxSize) {
					this.logger.warn(`maxSize exceeded (${size} > ${maxSize}) on response`);
					req.destroy();
				}
			}

			const contentDisposition = res.headers['content-disposition'];
			if (contentDisposition != null) {
				try {
					const parsed = parse(contentDisposition);
					if (parsed.parameters.filename) {
						filename = parsed.parameters.filename;
					}
				} catch (e) {
					this.logger.warn(`Failed to parse content-disposition: ${contentDisposition}`, { stack: e });
				}
			}
		}).on('downloadProgress', (progress: Got.Progress) => {
			if (progress.transferred > maxSize) {
				this.logger.warn(`maxSize exceeded (${progress.transferred} > ${maxSize}) on downloadProgress`);
				req.destroy();
			}
		});

		try {
			await stream.pipeline(req, fs.createWriteStream(path));
		} catch (e) {
			if (e instanceof Got.HTTPError) {
				throw new StatusError(`${e.response.statusCode} ${e.response.statusMessage}`, e.response.statusCode, e.response.statusMessage);
			} else {
				throw e;
			}
		}

		this.logger.succ(`Download finished: ${chalk.cyan(url)}`);

		return {
			filename,
		};
	}

	/** Strict, bounded retrieval used only by emoji fingerprinting. Existing
	 * downloadUrl users intentionally retain their historical proxy semantics. */
	@bindThis
	public async downloadFingerprintImage(url: string): Promise<Buffer> {
		const maxSize = 16 * 1024 * 1024;
		let current = new URL(url);
		for (let redirects = 0; redirects <= 5; redirects++) {
			if (current.protocol !== 'http:' && current.protocol !== 'https:') throw new Error('Fingerprint download only permits HTTP(S)');
			const request = got.stream(current, {
				headers: { 'User-Agent': this.config.userAgent },
				agent: current.protocol === 'http:'
					? { http: this.httpRequestService.getFilteredDirectAgent(current) as import('node:http').Agent }
					: { https: this.httpRequestService.getFilteredDirectAgent(current) as import('node:https').Agent },
				followRedirect: false,
				throwHttpErrors: false,
				retry: { limit: 0 },
				timeout: { lookup: 10_000, connect: 10_000, secureConnect: 10_000, socket: 10_000, response: 10_000, request: 10_000 },
				maxRedirects: 0,
			});
			const response = await new Promise<Got.Response>((resolve, reject) => {
				request.once('response', resolve);
				request.once('error', reject);
			});
			if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
				request.destroy();
				current = new URL(response.headers.location, current);
				continue;
			}
			if (response.statusCode < 200 || response.statusCode >= 300) {
				request.destroy();
				throw new StatusError(`${response.statusCode} ${response.statusMessage}`, response.statusCode, response.statusMessage);
			}
			const contentLength = response.headers['content-length'];
			if (contentLength != null && Number(contentLength) > maxSize) {
				request.destroy();
				throw new Error('Fingerprint download exceeds 16 MiB');
			}

			const chunks: Buffer[] = [];
			let size = 0;
			for await (const chunk of request) {
				size += chunk.length;
				if (size > maxSize) {
					request.destroy();
					throw new Error('Fingerprint download exceeds 16 MiB');
				}
				chunks.push(chunk);
			}
			return Buffer.concat(chunks, size);
		}
		throw new Error('Fingerprint download exceeded redirect limit');
	}

	@bindThis
	public async downloadTextFile(url: string): Promise<string> {
		// Create temp file
		const [path, cleanup] = await createTemp();

		this.logger.info(`text file: Temp file is ${path}`);

		try {
			// write content at URL to temp file
			await this.downloadUrl(url, path);

			const text = await fs.promises.readFile(path, 'utf8');

			return text;
		} finally {
			cleanup();
		}
	}
}
