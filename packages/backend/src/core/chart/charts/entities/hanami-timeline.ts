/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import Chart from '../../core.js';

export const name = 'hanamiTimeline';

export const timelineKinds = ['home', 'local', 'social', 'global', 'hanami'] as const;
export type HanamiTimelineKind = typeof timelineKinds[number];

export const schema = {
	'home.users': { uniqueIncrement: true },
	'home.requests': {},
	'local.users': { uniqueIncrement: true },
	'local.requests': {},
	'social.users': { uniqueIncrement: true },
	'social.requests': {},
	'global.users': { uniqueIncrement: true },
	'global.requests': {},
	'hanami.users': { uniqueIncrement: true },
	'hanami.requests': {},
} as const;

export const entity = Chart.schemaToEntity(name, schema);
