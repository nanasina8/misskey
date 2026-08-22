/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import type { Duplex } from 'node:stream';
import type * as http from 'node:http';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import * as WebSocket from 'ws';
import type { MiAccessToken } from '@/models/AccessToken.js';
import type { MiLocalUser } from '@/models/User.js';
import { StreamingApiServerService } from '@/server/api/StreamingApiServerService.js';
import MainStreamConnection from '@/server/api/stream/Connection.js';

const ACTIVITY_INTERVAL = 1000 * 60 * 5;

const deferred = <T>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, reject, resolve };
};

class TestUpgradeSocket {
	public writable = true;
	public destroyed = false;
	public readonly write = jest.fn((_data: string) => true);
	public readonly destroy = jest.fn(() => {
		this.writable = false;
		this.destroyed = true;
		return this;
	});
}

class TestConnection extends EventEmitter {
	public closed = false;
	public terminating = false;
	public autoCloseOnTerminate = true;
	public readonly ping = jest.fn(() => {
		this.emit('pong');
	});
	public readonly terminate = jest.fn(() => {
		this.terminating = true;
		if (this.autoCloseOnTerminate) {
			void Promise.resolve().then(() => this.close());
		}
	});

	public close(): void {
		if (this.closed) return;
		this.closed = true;
		this.emit('close');
	}
}

const user = {
	id: 'user',
	isSuspended: false,
} as MiLocalUser;

describe('StreamingApiServerService activity updates', () => {
	let service: StreamingApiServerService;
	let server: EventEmitter;
	let connection: TestConnection;
	let updateLastActiveDate: jest.MockedFunction<(target: MiLocalUser) => Promise<void>>;
	let authenticate: jest.MockedFunction<(token: string | null | undefined) => Promise<[MiLocalUser | null, MiAccessToken | null]>>;
	let loggerError: jest.Mock;
	let init: jest.SpiedFunction<MainStreamConnection['init']>;
	let listen: jest.SpiedFunction<MainStreamConnection['listen']>;
	let dispose: jest.SpiedFunction<MainStreamConnection['dispose']>;
	let handleUpgrade: jest.SpiedFunction<WebSocket.WebSocketServer['handleUpgrade']>;

	const request = {
		url: '/streaming?i=token',
		headers: { host: 'example.test' },
	} as http.IncomingMessage;

	const invokeUpgrade = async (socket = new TestUpgradeSocket()): Promise<TestUpgradeSocket> => {
		const upgrade = server.listeners('upgrade')[0] as (
			request: http.IncomingMessage,
			socket: Duplex,
			head: Buffer,
		) => Promise<void>;
		await upgrade(request, socket as unknown as Duplex, Buffer.alloc(0));
		await Promise.resolve();
		await Promise.resolve();
		return socket;
	};

	beforeEach(() => {
		jest.useFakeTimers({ doNotFake: ['nextTick'] });
		jest.setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
		server = new EventEmitter();
		connection = new TestConnection();
		updateLastActiveDate = jest.fn(async () => undefined);
		authenticate = jest.fn(async () => [user, null]);
		loggerError = jest.fn();
		init = jest.spyOn(MainStreamConnection.prototype, 'init').mockResolvedValue(undefined);
		listen = jest.spyOn(MainStreamConnection.prototype, 'listen').mockResolvedValue(undefined);
		dispose = jest.spyOn(MainStreamConnection.prototype, 'dispose').mockImplementation(() => undefined);
		handleUpgrade = jest.spyOn(WebSocket.WebSocketServer.prototype, 'handleUpgrade').mockImplementation((upgradeRequest, _socket, _head, callback) => {
			callback(connection as unknown as WebSocket.WebSocket, upgradeRequest);
		});
		service = new StreamingApiServerService(
			new EventEmitter() as never,
			{} as never,
			{} as never,
			{ authenticate } as never,
			{} as never,
			{} as never,
			{ updateLastActiveDate } as never,
			{ logger: { error: loggerError } } as never,
			{} as never,
			{} as never,
		);
		service.attach(server as unknown as http.Server);
	});

	afterEach(async () => {
		connection.close();
		await service.detach();
		jest.useRealTimers();
	});

	test('rejects the upgrade with 500 and destroys the socket when initial activity fails', async () => {
		const activityError = new Error('activity failed');
		updateLastActiveDate.mockRejectedValue(activityError);
		expect(jest.getTimerCount()).toBe(1);

		const socket = await invokeUpgrade();

		expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 500 Internal Server Error\r\n\r\n');
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		expect(init).not.toHaveBeenCalled();
		expect(handleUpgrade).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
		expect(connection.eventNames()).toEqual([]);
		expect(jest.getTimerCount()).toBe(1);
		expect(loggerError).toHaveBeenCalledWith(
			'Failed to update activity for user user during websocket upgrade',
			expect.objectContaining({ userId: user.id, e: activityError }),
		);
	});

	test('awaits initial activity and completes stream initialization before the handshake', async () => {
		const order: string[] = [];
		const activity = deferred<void>();
		updateLastActiveDate.mockImplementation(async () => {
			order.push('activity-start');
			await activity.promise;
			order.push('activity-end');
		});
		init.mockImplementation(async () => {
			order.push('init');
		});
		handleUpgrade.mockImplementation((upgradeRequest, _socket, _head, callback) => {
			order.push('upgrade');
			callback(connection as unknown as WebSocket.WebSocket, upgradeRequest);
		});

		const upgrading = invokeUpgrade();
		await Promise.resolve();
		expect(order).toEqual(['activity-start']);
		expect(init).not.toHaveBeenCalled();
		expect(handleUpgrade).not.toHaveBeenCalled();

		activity.resolve();
		await upgrading;

		// stream.init() が実I/Oを挟むあいだ message listener は未装着なので、ハンドシェイクより後に
		// 走らせるとクライアントが open 直後に送る connect フレームを取りこぼす。init が先でなければならない。
		expect(order).toEqual(['activity-start', 'activity-end', 'init', 'upgrade']);
	});

	test('stops before upgrade and stream construction when the peer closes during activity', async () => {
		const activity = deferred<void>();
		updateLastActiveDate.mockImplementation(async () => activity.promise);
		const socket = new TestUpgradeSocket();

		const upgrading = invokeUpgrade(socket);
		await Promise.resolve();
		socket.destroy();
		activity.resolve();
		await upgrading;

		expect(handleUpgrade).not.toHaveBeenCalled();
		expect(init).not.toHaveBeenCalled();
		expect(listen).not.toHaveBeenCalled();
	});

	test('handles synchronous upgrade failure by disposing the stream without leaking timers', async () => {
		const upgradeError = new Error('malformed handshake');
		handleUpgrade.mockImplementation(() => {
			throw upgradeError;
		});

		const socket = await invokeUpgrade();

		expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 500 Internal Server Error\r\n\r\n');
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(listen).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(1);
		expect(loggerError).toHaveBeenCalledWith('Failed to upgrade websocket connection', {
			userId: user.id,
			e: upgradeError,
		});
	});

	test('rejects a malformed upgrade that returns without invoking its callback', async () => {
		handleUpgrade.mockImplementation(() => undefined);

		const socket = await invokeUpgrade();

		expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 500 Internal Server Error\r\n\r\n');
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(listen).not.toHaveBeenCalled();
		expect(jest.getTimerCount()).toBe(1);
	});

	test('disposes the stream and rejects the upgrade when stream init fails', async () => {
		const initError = new Error('stream init failed');
		init.mockRejectedValueOnce(initError);

		const socket = await invokeUpgrade();
		await Promise.resolve();

		expect(init).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		// init はハンドシェイクより前なので、terminateすべきWebSocketはまだ存在しない。
		expect(handleUpgrade).not.toHaveBeenCalled();
		expect(connection.terminate).not.toHaveBeenCalled();
		expect(socket.write).toHaveBeenCalledWith('HTTP/1.1 500 Internal Server Error\r\n\r\n');
		expect(socket.destroy).toHaveBeenCalledTimes(1);
		expect(listen).not.toHaveBeenCalled();
		expect(loggerError).toHaveBeenCalledWith('Failed to initialize websocket stream', {
			userId: user.id,
			e: initError,
		});
	});

	test('terminates exactly once when a heartbeat activity update fails', async () => {
		updateLastActiveDate
			.mockResolvedValueOnce(undefined)
			.mockRejectedValueOnce(new Error('heartbeat failed'));
		await invokeUpgrade();

		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL * 2);

		expect(updateLastActiveDate).toHaveBeenCalledTimes(2);
		expect(connection.terminate).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(loggerError).toHaveBeenCalledTimes(1);
	});

	test('does not overlap heartbeat activity updates', async () => {
		const heartbeat = deferred<void>();
		updateLastActiveDate
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(async () => heartbeat.promise)
			.mockResolvedValueOnce(undefined);
		await invokeUpgrade();

		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);
		expect(updateLastActiveDate).toHaveBeenCalledTimes(2);
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);
		expect(updateLastActiveDate).toHaveBeenCalledTimes(2);

		heartbeat.resolve();
		await Promise.resolve();
		await Promise.resolve();
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);

		expect(updateLastActiveDate).toHaveBeenCalledTimes(3);
	});

	test('clears the heartbeat activity timer on close', async () => {
		await invokeUpgrade();
		expect(updateLastActiveDate).toHaveBeenCalledTimes(1);

		connection.close();
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL * 2);

		expect(updateLastActiveDate).toHaveBeenCalledTimes(1);
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('handles an in-flight heartbeat rejection after close without terminating or logging', async () => {
		const heartbeat = deferred<void>();
		updateLastActiveDate
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(async () => heartbeat.promise);
		await invokeUpgrade();
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);
		expect(updateLastActiveDate).toHaveBeenCalledTimes(2);

		connection.close();
		heartbeat.reject(new Error('late heartbeat failure'));
		await Promise.resolve();
		await Promise.resolve();

		expect(connection.terminate).not.toHaveBeenCalled();
		expect(loggerError).not.toHaveBeenCalled();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('heartbeat and liveness races share one asynchronous termination request', async () => {
		const heartbeat = deferred<void>();
		updateLastActiveDate
			.mockResolvedValueOnce(undefined)
			.mockImplementationOnce(async () => heartbeat.promise);
		await invokeUpgrade();
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL);
		expect(updateLastActiveDate).toHaveBeenCalledTimes(2);

		connection.autoCloseOnTerminate = false;
		connection.ping.mockImplementation(() => undefined);
		await jest.advanceTimersByTimeAsync(1000 * 60 * 3);
		expect(connection.terminate).toHaveBeenCalledTimes(1);
		expect(connection.closed).toBe(false);

		heartbeat.reject(new Error('heartbeat failed after liveness timeout'));
		await Promise.resolve();
		await Promise.resolve();
		expect(connection.terminate).toHaveBeenCalledTimes(1);
		expect(loggerError).not.toHaveBeenCalled();

		connection.close();
		expect(dispose).toHaveBeenCalledTimes(1);
	});

	test('keeps anonymous streams free of activity updates', async () => {
		authenticate.mockResolvedValue([null, null]);

		await invokeUpgrade();
		await jest.advanceTimersByTimeAsync(ACTIVITY_INTERVAL * 2);

		expect(updateLastActiveDate).not.toHaveBeenCalled();
		expect(init).toHaveBeenCalledTimes(1);
		expect(handleUpgrade).toHaveBeenCalledTimes(1);
		expect(connection.terminate).not.toHaveBeenCalled();
	});
});
