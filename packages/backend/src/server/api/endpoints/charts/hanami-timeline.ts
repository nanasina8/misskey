/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import HanamiTimelineChart from '@/core/chart/charts/hanami-timeline.js';
const metricSeries = { type: 'array', optional: false, nullable: false, items: { type: 'number', optional: false, nullable: true } } as const;
const timelineSeries = { type: 'object', optional: false, nullable: false, properties: { users: metricSeries, requests: metricSeries } } as const;

export const meta = {
	tags: ['charts'],
	requireCredential: true,
	requireAdmin: true,
	kind: 'read:admin:queue',
	description: 'Successful REST timeline requests and authenticated unique users in UTC chart windows. JST metrics use the supplemental daily counters.',
	res: { type: 'object', optional: false, nullable: false, properties: { home: timelineSeries, local: timelineSeries, social: timelineSeries, global: timelineSeries, hanami: timelineSeries } },
	allowGet: true,
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		span: { type: 'string', enum: ['day', 'hour'] },
		limit: { type: 'integer', minimum: 1, maximum: 500, default: 30 },
		offset: { type: 'integer', nullable: true, default: null },
	},
	required: ['span'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private hanamiTimelineChart: HanamiTimelineChart,
	) {
		super(meta, paramDef, async (ps) => {
			const chart = await this.hanamiTimelineChart.getChart(ps.span, ps.limit, ps.offset == null ? null : new Date(ps.offset));
			const visible = (series: { users: number[]; requests: number[] }) => ({
				users: series.users.map((users, i) => users < 5 && series.requests[i] > 0 ? null : users),
				requests: series.requests.map((requests, i) => series.users[i] < 5 && requests > 0 ? null : requests),
			});
			return { home: visible(chart.home), local: visible(chart.local), social: visible(chart.social), global: visible(chart.global), hanami: visible(chart.hanami) };
		});
	}
}
