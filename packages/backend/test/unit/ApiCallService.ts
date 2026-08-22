/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFile } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { MiLocalUser } from '@/models/User.js';
import type { IEndpoint, IEndpointMeta } from '@/server/api/endpoints.js';
import type { ApiCallService as ApiCallServiceType } from '@/server/api/ApiCallService.js';
import { AuthenticationError } from '@/server/api/AuthenticateService.js';
import { Endpoint } from '@/server/api/endpoint-base.js';

const multipartPath = join('/tmp/opencode', `api-call-service-${process.pid}.tmp`);
let cleanup = jest.fn(() => rmSync(multipartPath, { force: true }));
const createTemp = jest.fn<() => Promise<[string, () => void]>>(async () => [multipartPath, cleanup]);

jest.unstable_mockModule('../../src/misc/create-temp.js', () => ({
	createTemp,
	createTempDir: jest.fn(),
}));

const { ApiCallService } = await import('../../src/server/api/ApiCallService.js');

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
};

class TestReply {
	public statusCode?: number;
	public body?: unknown;
	public readonly headers = new Map<string, string>();
	public readonly sent = deferred<void>();

	public code(statusCode: number): this {
		this.statusCode = statusCode;
		return this;
	}

	public header(name: string, value: string): this {
		this.headers.set(name, value);
		return this;
	}

	public send(body?: unknown): this {
		this.body = body;
		this.sent.resolve();
		return this;
	}
}

const user = {
	id: 'user',
	isSuspended: false,
	movedToUri: null,
} as MiLocalUser;

const ownershipMeta = {
	requireCredential: true,
	requireFile: true,
	kind: 'write:drive',
} as const;

const ownershipParamDef = {
	type: 'object',
	properties: {
		label: { type: 'string' },
	},
	required: ['label'],
} as const;

type OwnershipHandler = (
	params: { label: string },
	user: MiLocalUser,
	token: MiAccessToken | null,
	file?: { name: string | null; path: string },
	ip?: string | null,
	headers?: Record<string, string> | null,
) => Promise<Record<string, unknown>>;

class OwnershipEndpoint extends Endpoint<typeof ownershipMeta, typeof ownershipParamDef> {
	public readonly name = 'test/multipart-ownership';
	public readonly meta = ownershipMeta;
	public readonly params = ownershipParamDef;

	constructor(handler: OwnershipHandler) {
		super(ownershipMeta, ownershipParamDef, handler);
	}
}

const internalErrorBody = {
	error: {
		message: 'Internal error occurred. Please contact us if the error persists.',
		code: 'INTERNAL_ERROR',
		id: '5d37dbcb-891e-41ca-a3d6-e690c97775ac',
		kind: 'server',
	},
};

describe('ApiCallService activity updates', () => {
	let service: ApiCallServiceType;
	let authenticate: jest.MockedFunction<(token: string | null | undefined) => Promise<[MiLocalUser | null, MiAccessToken | null]>>;
	let updateLastActiveDate: jest.MockedFunction<(target: MiLocalUser) => Promise<void>>;
	let loggerError: jest.Mock;
	let loggerWarn: jest.Mock;

	const createEndpoint = (meta: IEndpointMeta = {}) => ({
		name: 'test/endpoint',
		meta,
		params: {
			type: 'object',
			properties: {
				value: { type: 'number' },
			},
		},
		exec: jest.fn(async () => ({ ok: true })),
	}) as unknown as IEndpoint & { exec: jest.Mock };

	const createRequest = (body: Record<string, unknown> = {}) => ({
		method: 'POST',
		body,
		query: {},
		headers: { authorization: 'Bearer token' },
		ip: '127.0.0.1',
	}) as unknown as FastifyRequest<{ Body: Record<string, unknown>, Querystring: Record<string, unknown> }>;

	const createMultipartRequest = (options: {
		fields?: Record<string, unknown>;
		stream?: Readable & { truncated: boolean };
	} = {}) => {
		const upload = options.stream ?? Object.assign(Readable.from(['file']), { truncated: false });
		return {
			method: 'POST',
			headers: {},
			ip: '127.0.0.1',
			file: async () => ({
				file: upload,
				fields: options.fields ?? { i: { value: 'token' } },
				filename: 'file.txt',
			}),
		} as unknown as FastifyRequest<{ Body: Record<string, unknown>, Querystring: Record<string, unknown> }>;
	};

	beforeEach(() => {
		cleanup = jest.fn(() => rmSync(multipartPath, { force: true }));
		createTemp.mockClear();
		createTemp.mockImplementation(async () => [multipartPath, cleanup]);
		authenticate = jest.fn(async () => [user, null]);
		updateLastActiveDate = jest.fn(async () => undefined);
		loggerError = jest.fn();
		loggerWarn = jest.fn();
		service = new ApiCallService(
			{ enableIpLogging: false } as never,
			{ sentryForBackend: false } as never,
			{} as never,
			{ authenticate } as never,
			{ limit: jest.fn() } as never,
			{
				getUserPolicies: jest.fn(async () => ({ rateLimitFactor: 1 })),
				getUserRoles: jest.fn(async () => []),
			} as never,
			{ updateLastActiveDate } as never,
			{ logger: { error: loggerError, warn: loggerWarn } } as never,
		);
	});

	afterEach(() => {
		service.dispose();
	});

	test('returns the standard 500 response and skips an ordinary endpoint when activity fails', async () => {
		const activityError = new Error('activity failed');
		const endpoint = createEndpoint();
		const reply = new TestReply();
		updateLastActiveDate.mockRejectedValue(activityError);

		service.handleRequest(endpoint, createRequest(), reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(reply.statusCode).toBe(500);
		expect(reply.body).toEqual(internalErrorBody);
		expect(endpoint.exec).not.toHaveBeenCalled();
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to update activity for user user during API call test/endpoint',
			expect.objectContaining({ ep: 'test/endpoint', userId: user.id, e: activityError }),
		);
	});

	test('returns the standard 500 response and skips a multipart endpoint when activity fails', async () => {
		const endpoint = createEndpoint({ requireFile: true });
		const reply = new TestReply();
		updateLastActiveDate.mockRejectedValue(new Error('activity failed'));

		await service.handleMultipartRequest(endpoint, createMultipartRequest(), reply as unknown as FastifyReply);

		expect(createTemp).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(reply.statusCode).toBe(500);
		expect(reply.body).toEqual(internalErrorBody);
		expect(endpoint.exec).not.toHaveBeenCalled();
	});

	test('keeps the multipart file available through endpoint completion and cleans it once on success', async () => {
		const endpoint = createEndpoint({ requireFile: true });
		endpoint.exec.mockImplementation(async (_data, _user, _token, file) => {
			const uploadedFile = file as { path: string };
			expect(cleanup).not.toHaveBeenCalled();
			expect(await readFile(uploadedFile.path, 'utf8')).toBe('file');
			return { ok: true };
		});
		const reply = new TestReply();

		await service.handleMultipartRequest(endpoint, createMultipartRequest(), reply as unknown as FastifyReply);

		expect(reply.body).toEqual({ ok: true });
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('cleans the multipart file once on truncation', async () => {
		const endpoint = createEndpoint({ requireFile: true });
		const upload = Object.assign(Readable.from(['partial']), { truncated: true });
		const reply = new TestReply();

		await service.handleMultipartRequest(endpoint, createMultipartRequest({ stream: upload }), reply as unknown as FastifyReply);

		expect(reply.statusCode).toBe(413);
		expect(endpoint.exec).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('cleans the multipart file once when the upload pipeline fails', async () => {
		const pipelineError = new Error('upload failed');
		const upload = Readable.from((async function* () {
			yield 'partial';
			throw pipelineError;
		})()) as Readable & { truncated: boolean };
		upload.truncated = false;

		await expect(service.handleMultipartRequest(
			createEndpoint({ requireFile: true }),
			createMultipartRequest({ stream: upload }),
			new TestReply() as unknown as FastifyReply,
		)).rejects.toBe(pipelineError);

		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('cleans the multipart file once on invalid token shape and authentication failure', async () => {
		const invalidReply = new TestReply();
		await service.handleMultipartRequest(
			createEndpoint({ requireFile: true }),
			createMultipartRequest({ fields: { i: { value: { invalid: true } } } }),
			invalidReply as unknown as FastifyReply,
		);
		expect(invalidReply.statusCode).toBe(400);
		expect(cleanup).toHaveBeenCalledTimes(1);

		cleanup = jest.fn(() => rmSync(multipartPath, { force: true }));
		createTemp.mockImplementation(async () => [multipartPath, cleanup]);
		authenticate.mockRejectedValueOnce(new AuthenticationError('bad token'));
		const authReply = new TestReply();
		await service.handleMultipartRequest(
			createEndpoint({ requireFile: true }),
			createMultipartRequest(),
			authReply as unknown as FastifyReply,
		);
		expect(authReply.statusCode).toBe(401);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('cleans the multipart file once when endpoint execution fails', async () => {
		const endpoint = createEndpoint({ requireFile: true });
		endpoint.exec.mockImplementation(async () => {
			throw new Error('endpoint failed');
		});
		const reply = new TestReply();

		await service.handleMultipartRequest(endpoint, createMultipartRequest(), reply as unknown as FastifyReply);

		expect(reply.statusCode).toBe(500);
		expect(reply.body).toEqual({
			error: expect.objectContaining(internalErrorBody.error),
		});
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('cleans the multipart file once when field validation fails before endpoint execution', async () => {
		const endpoint = createEndpoint({ requireFile: true });
		const reply = new TestReply();

		await service.handleMultipartRequest(
			endpoint,
			createMultipartRequest({ fields: { i: { value: 'token' }, value: { value: 'not-json' } } }),
			reply as unknown as FastifyReply,
		);

		expect(reply.statusCode).toBe(400);
		expect(endpoint.exec).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('does not replace a successful response when cleanup reports an error', async () => {
		const cleanupError = new Error('already removed');
		cleanup.mockImplementationOnce(() => {
			rmSync(multipartPath, { force: true });
			throw cleanupError;
		});
		const reply = new TestReply();

		await service.handleMultipartRequest(createEndpoint({ requireFile: true }), createMultipartRequest(), reply as unknown as FastifyReply);

		expect(reply.body).toEqual({ ok: true });
		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(loggerWarn).toHaveBeenCalledWith('Failed to clean up multipart temporary file', {
			path: multipartPath,
			e: cleanupError,
		});
	});

	test('real Endpoint validation failure leaves multipart cleanup solely to ApiCallService', async () => {
		const handler = jest.fn<OwnershipHandler>(async () => ({ ok: true }));
		const endpoint = new OwnershipEndpoint(handler);
		const reply = new TestReply();

		await service.handleMultipartRequest(endpoint, createMultipartRequest(), reply as unknown as FastifyReply);

		expect(reply.statusCode).toBe(400);
		expect(handler).not.toHaveBeenCalled();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('real Endpoint success keeps the file through awaited handler completion and preserves ip/header positions', async () => {
		const started = deferred<void>();
		const release = deferred<void>();
		const handler = jest.fn<OwnershipHandler>(async (_params, _user, _token, file) => {
			expect(cleanup).not.toHaveBeenCalled();
			expect(await readFile(file!.path, 'utf8')).toBe('file');
			started.resolve();
			await release.promise;
			expect(await readFile(file!.path, 'utf8')).toBe('file');
			return { ok: true };
		});
		const endpoint = new OwnershipEndpoint(handler);
		const reply = new TestReply();
		const handling = service.handleMultipartRequest(
			endpoint,
			createMultipartRequest({ fields: { i: { value: 'token' }, label: { value: 'valid' } } }),
			reply as unknown as FastifyReply,
		);

		await started.promise;
		expect(cleanup).not.toHaveBeenCalled();
		release.resolve();
		await handling;

		expect(reply.body).toEqual({ ok: true });
		expect(handler).toHaveBeenCalledWith(
			expect.objectContaining({ label: 'valid' }),
			user,
			null,
			expect.objectContaining({ path: multipartPath }),
			'127.0.0.1',
			expect.any(Object),
		);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('real Endpoint failure keeps the file available until rejection and then cleans once', async () => {
		const handlerError = new Error('handler failed');
		const handler = jest.fn<OwnershipHandler>(async (_params, _user, _token, file) => {
			expect(cleanup).not.toHaveBeenCalled();
			expect(await readFile(file!.path, 'utf8')).toBe('file');
			throw handlerError;
		});
		const endpoint = new OwnershipEndpoint(handler);
		const reply = new TestReply();

		await service.handleMultipartRequest(
			endpoint,
			createMultipartRequest({ fields: { i: { value: 'token' }, label: { value: 'valid' } } }),
			reply as unknown as FastifyReply,
		);

		expect(reply.statusCode).toBe(500);
		expect(handler).toHaveBeenCalledTimes(1);
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	test('real Endpoint preserves FILE_REQUIRED when called without an upload', async () => {
		const handler = jest.fn<OwnershipHandler>(async () => ({ ok: true }));
		const endpoint = new OwnershipEndpoint(handler);

		await expect(endpoint.exec({ label: 'valid' }, user, null)).rejects.toMatchObject({ code: 'FILE_REQUIRED' });
		expect(handler).not.toHaveBeenCalled();
	});

	test('awaits successful activity before parameter coercion and endpoint execution', async () => {
		const order: string[] = [];
		const endpoint = createEndpoint();
		endpoint.exec.mockImplementation(async (data: unknown) => {
			order.push('endpoint');
			return data;
		});
		const request = {
			method: 'GET',
			body: undefined,
			query: { value: '42' },
			headers: { authorization: 'Bearer token' },
			ip: '127.0.0.1',
		} as unknown as FastifyRequest<{ Body: Record<string, unknown>, Querystring: Record<string, unknown> }>;
		updateLastActiveDate.mockImplementation(async () => {
			order.push(`activity:${request.query.value}`);
		});
		const reply = new TestReply();

		service.handleRequest(endpoint, request, reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(order).toEqual(['activity:42', 'endpoint']);
		expect(endpoint.exec).toHaveBeenCalledWith(
			expect.objectContaining({ value: 42 }),
			user,
			null,
			null,
			'127.0.0.1',
			expect.any(Object),
		);
	});

	test('does not update activity when an authenticated app is denied by a token guard', async () => {
		const endpoint = createEndpoint({ requireCredential: true, kind: 'read:account' });
		const app = { permission: [] } as unknown as MiAccessToken;
		authenticate.mockResolvedValue([user, app]);
		const reply = new TestReply();

		service.handleRequest(endpoint, createRequest(), reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(reply.statusCode).toBe(403);
		expect(updateLastActiveDate).not.toHaveBeenCalled();
		expect(endpoint.exec).not.toHaveBeenCalled();
	});

	test('leaves anonymous endpoint calls free of activity work', async () => {
		const endpoint = createEndpoint();
		authenticate.mockResolvedValue([null, null]);
		const reply = new TestReply();

		service.handleRequest(endpoint, createRequest(), reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(reply.body).toEqual({ ok: true });
		expect(updateLastActiveDate).not.toHaveBeenCalled();
		expect(endpoint.exec).toHaveBeenCalledTimes(1);
	});

	test('strips the body credential before handing params to the endpoint', async () => {
		const endpoint = createEndpoint();
		authenticate.mockResolvedValue([null, null]);
		const reply = new TestReply();

		service.handleRequest(endpoint, createRequest({ value: 42, i: 'secret-token' }), reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(reply.body).toEqual({ ok: true });
		expect(endpoint.exec.mock.calls[0]?.[0]).toEqual({ value: 42 });
	});

	test('accepts a credential-bearing body on a paramDef that forbids extra properties', async () => {
		// misskeyApi / misskey-js は認証トークンをボディの `i` に載せる。ApiCallService が剥がさないと
		// additionalProperties: false のendpointは全リクエストがINVALID_PARAMで落ちる。
		const strictParamDef = {
			type: 'object',
			additionalProperties: false,
			properties: {
				value: { type: 'number' },
			},
			required: ['value'],
		} as const;
		const handler = jest.fn(async () => ({ ok: true }));
		const endpoint = {
			name: 'test/strict',
			meta: {},
			params: strictParamDef,
			exec: new Endpoint({} as IEndpointMeta, strictParamDef, handler as never).exec,
		} as unknown as IEndpoint & { exec: jest.Mock };
		authenticate.mockResolvedValue([null, null]);
		const reply = new TestReply();

		service.handleRequest(endpoint, createRequest({ value: 42, i: 'secret-token' }), reply as unknown as FastifyReply);
		await reply.sent.promise;

		expect(reply.body).toEqual({ ok: true });
		expect(handler).toHaveBeenCalledTimes(1);
	});
});
