/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const source = readFileSync(resolve(process.cwd(), 'src/components/MkStreamingNotesTimeline.vue'), 'utf8');

describe('MkStreamingNotesTimeline Hanami integration', () => {
	test('renders and anchors wrappers by feed entry while passing the wrapped note and locator', () => {
		expect(source).toContain('const items = (hanamiPaginator?.items ?? paginator!.items) as Ref<TimelineItem[]>;');
		expect(source).not.toContain('computed<TimelineItem[]>(() => hanamiPaginator?.items.value');
		expect(source).toContain(':key="itemKey(item)"');
		expect(source).toContain(':data-scroll-anchor="itemKey(item)"');
		expect(source).toContain(':note="itemNote(item)"');
		expect(source).toContain(':hanamiFeedEntryId="itemFeedEntryId(item)"');
		expect(source).toContain('return isHanamiItem(item) ? item.feedEntryId : item.id;');
	});

	test('uses Hanami removal and excludes Hanami from polling and streaming', () => {
		expect(source).toContain('hanamiPaginator.removeNote(noteId);');
		expect(source).toContain("if (props.src !== 'hanami' && !store.s.realtimeMode)");
		expect(source).toContain("store.s.realtimeMode && props.src !== 'hanami' ? useStream() : null");
		expect(source).not.toContain("useChannel('hanamiTimeline'");
		expect(source).not.toContain("provide('hanamiTimeline'");
	});

	test('separates user refresh from automatic reinitialization', () => {
		expect(source).toContain('await (hanamiPaginator?.refresh() ?? paginator!.reload());');
		expect(source).toContain('await (hanamiPaginator?.init() ?? paginator!.reload());');
	});
});
