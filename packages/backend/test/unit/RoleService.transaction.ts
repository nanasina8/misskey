/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, jest, test } from '@jest/globals';
import { RoleService } from '@/core/RoleService.js';
import { MiRole } from '@/models/Role.js';
import { MiRoleAssignment } from '@/models/RoleAssignment.js';
import { MiUser } from '@/models/User.js';

const role = (
	id: string,
	value: boolean,
	priority: number,
	target: 'manual' | 'conditional' = 'manual',
): MiRole => ({
	id,
	target,
	condFormula: { id: `${id}-condition`, type: 'isBot' },
	policies: {
		hanamiTlAvailable: { useDefault: false, priority, value },
	},
} as unknown as MiRole);

describe('RoleService transaction-scoped policies', () => {
	test('matches cached policy semantics while reading roles, assignments, and conditional users only through the manager', async () => {
		const assignedRole = role('assigned', true, 1);
		const expiredRole = role('expired', false, 2);
		const conditionalRole = role('conditional', false, 2, 'conditional');
		const roles = [assignedRole, expiredRole, conditionalRole];
		const users = new Map<string, MiUser>([
			['conditional-user', { id: 'conditional-user', isBot: true } as MiUser],
			['assigned-user', { id: 'assigned-user', isBot: false } as MiUser],
			['default-user', { id: 'default-user', isBot: false } as MiUser],
		]);
		const assignments = new Map<string, MiRoleAssignment[]>([
			['conditional-user', [
				{ roleId: assignedRole.id, expiresAt: null } as MiRoleAssignment,
				{ roleId: expiredRole.id, expiresAt: new Date(Date.now() - 1) } as MiRoleAssignment,
			]],
			['assigned-user', [{ roleId: assignedRole.id, expiresAt: null } as MiRoleAssignment]],
			['default-user', []],
		]);

		const rootRolesRepository = {
			findBy: jest.fn(async () => roles),
		};
		const rootAssignmentsRepository = {
			findBy: jest.fn(async ({ userId }: { userId: string }) => assignments.get(userId) ?? []),
		};
		const rootUsersRepository = {
			findBy: jest.fn(() => {
				throw new Error('root users repository must not be used');
			}),
		};
		const cacheService = {
			findUserById: jest.fn(async (userId: string) => users.get(userId)!),
		};
		const redisForSub = {
			on: jest.fn(),
			off: jest.fn(),
		};
		const service = new RoleService(
			{} as never,
			{ policies: { hanamiTlAvailable: false } } as never,
			{} as never,
			redisForSub as never,
			rootUsersRepository as never,
			rootRolesRepository as never,
			rootAssignmentsRepository as never,
			cacheService as never,
			{
				isLocalUser: (user: MiUser) => user.host == null,
				isRemoteUser: (user: MiUser) => user.host != null,
			} as never,
			{} as never,
			{ parse: jest.fn() } as never,
			{} as never,
			{} as never,
		);

		const userIds = ['conditional-user', 'assigned-user', 'default-user'];
		const cachedResults = await Promise.all(userIds.map(userId => service.getUserPolicies(userId)));
		expect(cachedResults.map(policies => policies.hanamiTlAvailable)).toEqual([false, true, false]);

		const rootCallsBeforeManager = {
			roles: rootRolesRepository.findBy.mock.calls.length,
			assignments: rootAssignmentsRepository.findBy.mock.calls.length,
			users: rootUsersRepository.findBy.mock.calls.length,
			cache: cacheService.findUserById.mock.calls.length,
		};
		const managerRolesRepository = { findBy: jest.fn(async () => roles) };
		const managerAssignmentsRepository = {
			findBy: jest.fn(async ({ userId }: { userId: string }) => assignments.get(userId) ?? []),
		};
		const managerUsersRepository = {
			findOneByOrFail: jest.fn(async ({ id }: { id: string }) => users.get(id)!),
		};
		const manager = {
			getRepository: jest.fn((entity: unknown) => {
				if (entity === MiRole) return managerRolesRepository;
				if (entity === MiRoleAssignment) return managerAssignmentsRepository;
				if (entity === MiUser) return managerUsersRepository;
				throw new Error('unexpected manager repository');
			}),
		};

		const managerResults = await Promise.all(userIds.map(userId => service.getUserPolicies(userId, manager as never)));

		expect(managerResults).toEqual(cachedResults);
		expect(manager.getRepository).toHaveBeenCalledWith(MiRole);
		expect(manager.getRepository).toHaveBeenCalledWith(MiRoleAssignment);
		expect(manager.getRepository).toHaveBeenCalledWith(MiUser);
		expect(managerRolesRepository.findBy).toHaveBeenCalledTimes(3);
		expect(managerAssignmentsRepository.findBy).toHaveBeenCalledTimes(3);
		expect(managerUsersRepository.findOneByOrFail).toHaveBeenCalledTimes(3);
		expect(rootRolesRepository.findBy).toHaveBeenCalledTimes(rootCallsBeforeManager.roles);
		expect(rootAssignmentsRepository.findBy).toHaveBeenCalledTimes(rootCallsBeforeManager.assignments);
		expect(rootUsersRepository.findBy).toHaveBeenCalledTimes(rootCallsBeforeManager.users);
		expect(cacheService.findUserById).toHaveBeenCalledTimes(rootCallsBeforeManager.cache);

		service.dispose();
	});
});
