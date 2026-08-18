<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader :actions="headerActions" :tabs="headerTabs">
	<div ref="rootEl" class="_spacer" style="--MI_SPACER-w: 900px;">
		<div class="_gaps">
			<div :class="$style.inputs">
				<MkButton style="margin-left: auto" @click="resetQuery">{{ i18n.ts.reset }}</MkButton>
			</div>
			<div :class="$style.inputs">
				<MkSelect v-model="sort" :items="sortDef" style="flex: 1;">
					<template #label>{{ i18n.ts.sort }}</template>
				</MkSelect>
				<MkSelect v-model="state" :items="stateDef" style="flex: 1;">
					<template #label>{{ i18n.ts.state }}</template>
				</MkSelect>
				<MkSelect v-model="origin" :items="originDef" style="flex: 1;">
					<template #label>{{ i18n.ts.instance }}</template>
				</MkSelect>
			</div>
			<div :class="$style.inputs">
				<MkInput v-model="searchUsername" style="flex: 1;" type="text" :spellcheck="false">
					<template #prefix>@</template>
					<template #label>{{ i18n.ts.username }}</template>
				</MkInput>
				<MkInput v-model="searchHost" style="flex: 1;" type="text" :spellcheck="false" :disabled="paginator.computedParams?.value?.origin === 'local'">
					<template #prefix>@</template>
					<template #label>{{ i18n.ts.host }}</template>
				</MkInput>
			</div>

			<MkPagination v-slot="{items}" :paginator="paginator">
				<div :class="$style.users">
					<MkA v-for="user in items" :key="user.id" v-tooltip.mfm="`${i18n.ts.lastPosted}: ${user.updatedAt ? dateString(user.updatedAt) : i18n.ts.unknown}`" :class="$style.user" :data-scroll-anchor="user.id" :to="`/admin/user/${user.id}`">
						<MkUserCardMini :user="user"/>
					</MkA>
				</div>
			</MkPagination>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, markRaw, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, useTemplateRef, watch } from 'vue';
import { throttle } from 'throttle-debounce';
import { getScrollContainer } from '@@/js/scroll.js';
import MkButton from '@/components/MkButton.vue';
import MkInput from '@/components/MkInput.vue';
import MkSelect from '@/components/MkSelect.vue';
import MkPagination from '@/components/MkPagination.vue';
import * as os from '@/os.js';
import { lookupUser } from '@/utility/admin-lookup.js';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { useMkSelect } from '@/composables/use-mkselect.js';
import MkUserCardMini from '@/components/MkUserCardMini.vue';
import { dateString } from '@/filters/date.js';
import { Paginator } from '@/utility/paginator.js';

type SearchQuery = {
	sort?: '-createdAt' | '+createdAt' | '-updatedAt' | '+updatedAt' | '-lastActiveDate' | '+lastActiveDate';
	state?: 'all' | 'available' | 'admin' | 'moderator' | 'suspended';
	origin?: 'combined' | 'local' | 'remote';
	username?: string;
	hostname?: string;
};

type SavedState = SearchQuery & {
	scrollTop?: number;
	itemCount?: number;
};

const storageKey = 'admin-users-state';
const defaultLimit = 10;

function loadSavedState(): SavedState {
	try {
		return JSON.parse(sessionStorage.getItem(storageKey) ?? '{}') as SavedState;
	} catch {
		return {};
	}
}

const savedState = loadSavedState();

const {
	model: sort,
	def: sortDef,
} = useMkSelect({
	items: [
		{ label: `${i18n.ts.registeredDate} (${i18n.ts.ascendingOrder})`, value: '-createdAt' },
		{ label: `${i18n.ts.registeredDate} (${i18n.ts.descendingOrder})`, value: '+createdAt' },
		{ label: `${i18n.ts.lastActiveDate} (${i18n.ts.ascendingOrder})`, value: '-lastActiveDate' },
		{ label: `${i18n.ts.lastActiveDate} (${i18n.ts.descendingOrder})`, value: '+lastActiveDate' },
		{ label: `${i18n.ts.lastPosted} (${i18n.ts.ascendingOrder})`, value: '-updatedAt' },
		{ label: `${i18n.ts.lastPosted} (${i18n.ts.descendingOrder})`, value: '+updatedAt' },
	],
	initialValue: savedState.sort ?? '+updatedAt',
});
const {
	model: state,
	def: stateDef,
} = useMkSelect({
	items: [
		{ label: i18n.ts.all, value: 'all' },
		{ label: i18n.ts.normal, value: 'available' },
		{ label: i18n.ts.administrator, value: 'admin' },
		{ label: i18n.ts.moderator, value: 'moderator' },
		{ label: i18n.ts.suspend, value: 'suspended' },
	],
	initialValue: savedState.state ?? 'all',
});
const {
	model: origin,
	def: originDef,
} = useMkSelect({
	items: [
		{ label: i18n.ts.all, value: 'combined' },
		{ label: i18n.ts.local, value: 'local' },
		{ label: i18n.ts.remote, value: 'remote' },
	],
	initialValue: savedState.origin ?? 'local',
});
const searchUsername = ref(savedState.username ?? '');
const searchHost = ref(savedState.hostname ?? '');
const rootEl = useTemplateRef('rootEl');
let scrollContainer: HTMLElement | null = null;
let restoreScrollPosition = true;
const paginator = markRaw(new Paginator('admin/show-users', {
	limit: Math.min(100, Math.max(defaultLimit, savedState.itemCount ?? defaultLimit)),
	computedParams: computed(() => ({
		sort: sort.value,
		state: state.value,
		origin: origin.value,
		username: searchUsername.value,
		hostname: searchHost.value,
	})),
	offsetMode: true,
}));

function searchUser() {
	os.selectUser({ includeSelf: true }).then(user => {
		show(user);
	});
}

async function addUser() {
	const { canceled: canceled1, result: username } = await os.inputText({
		title: i18n.ts.username,
	});
	if (canceled1 || username == null) return;

	const { canceled: canceled2, result: password } = await os.inputText({
		title: i18n.ts.password,
		type: 'password',
	});
	if (canceled2 || password == null) return;

	os.apiWithDialog('admin/accounts/create', {
		username: username,
		password: password,
	}).then(res => {
		paginator.reload();
	});
}

function show(user) {
	os.pageWindow(`/admin/user/${user.id}`);
}

function resetQuery() {
	sort.value = '+updatedAt';
	state.value = 'all';
	origin.value = 'local';
	searchUsername.value = '';
	searchHost.value = '';
}

const headerActions = computed(() => [{
	icon: 'ti ti-search',
	text: i18n.ts.search,
	handler: searchUser,
}, {
	asFullButton: true,
	icon: 'ti ti-plus',
	text: i18n.ts.addUser,
	handler: addUser,
}, {
	asFullButton: true,
	icon: 'ti ti-search',
	text: i18n.ts.lookup,
	handler: lookupUser,
}]);

const headerTabs = computed(() => []);

const query = computed(() => ({
	sort: sort.value,
	state: state.value,
	origin: origin.value,
	username: searchUsername.value,
	hostname: searchHost.value,
}));

function saveState() {
	sessionStorage.setItem(storageKey, JSON.stringify({
		...query.value,
		scrollTop: scrollContainer?.scrollTop ?? 0,
		itemCount: Math.max(defaultLimit, paginator.items.value.length),
	} satisfies SavedState));
}

const onScroll = throttle(250, saveState);

async function restorePosition() {
	if (!restoreScrollPosition || paginator.fetching.value || scrollContainer == null) return;
	await nextTick();
	scrollContainer.scrollTop = savedState.scrollTop ?? 0;
	restoreScrollPosition = false;
}

watch(query, () => {
	restoreScrollPosition = false;
	if (scrollContainer) scrollContainer.scrollTop = 0;
	saveState();
}, { deep: true });

watch(paginator.fetching, fetching => {
	if (!fetching) restorePosition();
});

watch(() => paginator.items.value.length, saveState);

onMounted(() => {
	scrollContainer = rootEl.value ? getScrollContainer(rootEl.value) : null;
	scrollContainer?.addEventListener('scroll', onScroll, { passive: true });
	restorePosition();
});

onActivated(restorePosition);

onDeactivated(saveState);

onUnmounted(() => {
	saveState();
	scrollContainer?.removeEventListener('scroll', onScroll);
});

definePage(() => ({
	title: i18n.ts.users,
	icon: 'ti ti-users',
}));
</script>

<style lang="scss" module>
.inputs {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}

.users {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
	grid-gap: 12px;

	> .user:hover {
		text-decoration: none;
	}
}
</style>
