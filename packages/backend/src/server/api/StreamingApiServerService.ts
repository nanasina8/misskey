/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'events';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import * as WebSocket from 'ws';
import { DI } from '@/di-symbols.js';
import type { MiAccessToken } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import type { MiLocalUser } from '@/models/User.js';
import { UserService } from '@/core/UserService.js';
import { AuthenticateService, AuthenticationError } from './AuthenticateService.js';
import { ApiLoggerService } from './ApiLoggerService.js';
import MainStreamConnection, { ConnectionRequest } from './stream/Connection.js';
import type * as http from 'node:http';
import { ContextIdFactory, ModuleRef } from '@nestjs/core';

type ActiveConnection = {
	lastActive: number;
	closed: boolean;
	terminationRequested: boolean;
	terminateOnce: () => void;
};

@Injectable()
export class StreamingApiServerService {
	#wss: WebSocket.WebSocketServer;
	#connections = new Map<WebSocket.WebSocket, ActiveConnection>();
	#cleanConnectionsIntervalId: NodeJS.Timeout | null = null;
	#activeUsers = new Map<MiLocalUser['id'], { connections: number; intervalId: NodeJS.Timeout; }>();

	constructor(
		@Inject(DI.redisForSub)
		private redisForSub: Redis.Redis,

		private moduleRef: ModuleRef,
		private authenticateService: AuthenticateService,
		private usersService: UserService,
		private apiLoggerService: ApiLoggerService,
	) {
	}

	@bindThis
	public attach(server: http.Server): void {
		this.#wss = new WebSocket.WebSocketServer({
			noServer: true,
			maxPayload: 1024 * 1024, // 1MiB
			perMessageDeflate: false,
		});

		server.on('upgrade', async (request, socket, head) => {
			if (request.url == null) {
				this.rejectUpgrade(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
				return;
			}

			let q: URLSearchParams;
			try {
				q = new URL(request.url, `http://${request.headers.host}`).searchParams;
			} catch {
				this.rejectUpgrade(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
				return;
			}

			let user: MiLocalUser | null = null;
			let app: MiAccessToken | null = null;

			// https://datatracker.ietf.org/doc/html/rfc6750.html#section-2.1
			// Note that the standard WHATWG WebSocket API does not support setting any headers,
			// but non-browser apps may still be able to set it.
			const token = request.headers.authorization?.startsWith('Bearer ')
				? request.headers.authorization.slice(7)
				: q.get('i');

			try {
				[user, app] = await this.authenticateService.authenticate(token);

				if (app !== null && !app.permission.some(p => p === 'read:account')) {
					throw new AuthenticationError('Your app does not have necessary permissions to use websocket API.');
				}
			} catch (e) {
				if (e instanceof AuthenticationError) {
					this.rejectUpgrade(socket, [
						'HTTP/1.1 401 Unauthorized',
						'WWW-Authenticate: Bearer realm="Misskey", error="invalid_token", error_description="Failed to authenticate"',
					].join('\r\n') + '\r\n\r\n');
				} else {
					this.rejectUpgrade(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
				}
				return;
			}

			if (user?.isSuspended) {
				this.rejectUpgrade(socket, 'HTTP/1.1 403 Forbidden\r\n\r\n');
				return;
			}

			if (user) {
				try {
					await this.usersService.updateLastActiveDate(user);
				} catch (err) {
					this.apiLoggerService.logger.error(`Failed to update activity for user ${user.id} during websocket upgrade`, {
						userId: user.id,
						e: err,
					});
					this.rejectUpgrade(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
					return;
				}
			}

			if (socket.destroyed || !socket.writable) return;

			let stream: MainStreamConnection | undefined;
			try {
				const contextId = ContextIdFactory.create();
				this.moduleRef.registerRequestByContextId<ConnectionRequest>({
					user,
					token: app,
				}, contextId);
				stream = await this.moduleRef.create(MainStreamConnection, contextId);
				await stream.init();
			} catch (err) {
				stream?.dispose();
				this.apiLoggerService.logger.error('Failed to initialize websocket stream', { userId: user?.id, e: err });
				this.rejectUpgrade(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
				return;
			}

			if (socket.destroyed || !socket.writable) {
				stream.dispose();
				return;
			}

			const initializedStream = stream;
			let callbackInvoked = false;
			try {
				this.#wss.handleUpgrade(request, socket, head, (connection) => {
					callbackInvoked = true;
					this.#wss.emit('connection', connection, request, { stream: initializedStream, user, app });
				});
			} catch (err) {
				stream.dispose();
				this.apiLoggerService.logger.error('Failed to upgrade websocket connection', { userId: user?.id, e: err });
				this.rejectUpgrade(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
				return;
			}

			if (!callbackInvoked) {
				stream.dispose();
				this.apiLoggerService.logger.error('Websocket upgrade completed without a connection callback', { userId: user?.id });
				this.rejectUpgrade(socket, 'HTTP/1.1 500 Internal Server Error\r\n\r\n');
			}
		});

		const globalEv = new EventEmitter();

		this.redisForSub.on('message', (_: string, data: string) => {
			const parsed = JSON.parse(data);
			globalEv.emit('message', parsed);
		});

		this.#wss.on('connection', (connection: WebSocket.WebSocket, request: http.IncomingMessage, ctx: {
			stream: MainStreamConnection,
			user: MiLocalUser | null;
			app: MiAccessToken | null
		}) => {
			void this.startConnection(connection, request, ctx, globalEv);
		});

		// 一定期間通信が無いコネクションは実際には切断されている可能性があるため定期的にterminateする
		this.#cleanConnectionsIntervalId = setInterval(() => {
			const now = Date.now();
			for (const [connection, state] of this.#connections.entries()) {
				if (state.closed || state.terminationRequested) {
					this.#connections.delete(connection);
				} else if (now - state.lastActive > 1000 * 60 * 2) {
					state.terminateOnce();
				} else {
					try {
						connection.ping();
					} catch {
						state.terminateOnce();
					}
				}
			}
		}, 1000 * 60);
	}

	private rejectUpgrade(socket: import('node:stream').Duplex, response: string): void {
		if (socket.destroyed) return;
		try {
			if (socket.writable) socket.write(response);
		} catch {
			// The peer may close while authentication or activity work is in progress.
		}
		if (!socket.destroyed) socket.destroy();
	}

	private async startConnection(
		connection: WebSocket.WebSocket,
		_request: http.IncomingMessage,
		ctx: { stream: MainStreamConnection; user: MiLocalUser | null; app: MiAccessToken | null },
		globalEv: EventEmitter,
	): Promise<void> {
		const { stream, user } = ctx;
		const ev = new EventEmitter();
		let userUpdateIntervalId: NodeJS.Timeout | null = null;
		let userUpdateInFlight = false;
		let disposed = false;
		const disposeOnce = (): void => {
			if (disposed) return;
			disposed = true;
			stream.dispose();
		};
		const onRedisMessage = (data: any): void => {
			ev.emit(data.channel, data.message);
		};
		const state: ActiveConnection = {
			lastActive: Date.now(),
			closed: false,
			terminationRequested: false,
			terminateOnce: () => {
				if (state.closed || state.terminationRequested) return;
				state.terminationRequested = true;
				this.#connections.delete(connection);
				try {
					connection.terminate();
				} catch {
					onClose();
				}
			},
		};
		const onClose = (): void => {
			if (state.closed) return;
			state.closed = true;
			this.#connections.delete(connection);
			if (userUpdateIntervalId != null) clearInterval(userUpdateIntervalId);
			ev.removeAllListeners();
			globalEv.off('message', onRedisMessage);
			connection.off('pong', onPong);
			disposeOnce();
		};
		const onPong = (): void => {
			if (!state.closed && !state.terminationRequested) state.lastActive = Date.now();
		};

		connection.once('close', onClose);
		connection.on('pong', onPong);
		globalEv.on('message', onRedisMessage);

		try {
			await stream.listen(ev, connection);
		} catch (err) {
			if (!state.closed) {
				this.apiLoggerService.logger.error('Failed to start websocket stream listener', { userId: user?.id, e: err });
				disposeOnce();
				state.terminateOnce();
			}
			return;
		}
		if (state.closed || state.terminationRequested) return;

		this.#connections.set(connection, state);
		if (user) {
			userUpdateIntervalId = setInterval(() => {
				if (state.closed || state.terminationRequested || userUpdateInFlight) return;
				userUpdateInFlight = true;
				void this.usersService.updateLastActiveDate(user).catch((err: Error) => {
					if (state.closed || state.terminationRequested) return;
					this.apiLoggerService.logger.error(`Failed to update activity for user ${user.id} on websocket heartbeat`, {
						userId: user.id,
						e: err,
					});
					state.terminateOnce();
				}).finally(() => {
					userUpdateInFlight = false;
				});
			}, 1000 * 60 * 5);
		}
	}

	@bindThis
	private onUserConnected(user: MiLocalUser): void {
		const activeUser = this.#activeUsers.get(user.id);
		if (activeUser) {
			activeUser.connections++;
			return;
		}

		this.usersService.updateLastActiveDate(user);
		this.#activeUsers.set(user.id, {
			connections: 1,
			intervalId: setInterval(() => {
				this.usersService.updateLastActiveDate(user);
			}, 1000 * 60 * 5),
		});
	}

	@bindThis
	private onUserDisconnected(user: MiLocalUser): void {
		const activeUser = this.#activeUsers.get(user.id);
		if (!activeUser) return;

		activeUser.connections--;
		if (activeUser.connections <= 0) {
			clearInterval(activeUser.intervalId);
			this.#activeUsers.delete(user.id);
		}
	}

	@bindThis
	public detach(): Promise<void> {
		if (this.#cleanConnectionsIntervalId) {
			clearInterval(this.#cleanConnectionsIntervalId);
			this.#cleanConnectionsIntervalId = null;
		}
		return new Promise((resolve) => {
			this.#wss.close(() => resolve());
		});
	}
}
