<!--
SPDX-FileCopyrightText: syuilo and misskey-project
SPDX-License-Identifier: AGPL-3.0-only
-->

<template>
<PageWithHeader v-model:tab="tab" :tabs="headerTabs">
	<div class="_spacer" style="--MI_SPACER-w: 1400px; --MI_SPACER-min: 16px; --MI_SPACER-max: 32px;">
		<!-- 確認待ち -->
		<div v-if="tab === 'queue'" class="_gaps">
			<!-- 状況 -->
			<div class="_panel" :class="$style.statusBar">
				<div :class="$style.statusItems">
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.pending }}</template>
						<template #value>{{ status?.pending ?? '—' }}</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.enqueuedToday }}</template>
						<template #value>{{ status?.enqueuedToday ?? '—' }}<span v-if="meta" :class="$style.sub"> {{ i18n.tsx._aiModeration.perDayLimit({ limit: meta.aiModerationDailyLimit }) }} ・ {{ i18n.tsx._aiModeration.droppedToday({ count: status?.droppedToday ?? 0 }) }}</span></template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.judgedLast24h }}</template>
						<template #value>{{ i18n.tsx._aiModeration.judgedCount({ count: status?.judgedLast24h ?? 0 }) }}<span :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.flaggedCount({ count: status?.flaggedLast24h ?? 0 }) }}</span></template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.runtimeLabel }}</template>
						<template #value>
							{{ status?.runtime?.available === false ? i18n.ts._aiModeration.gpuUnavailable : (status?.runtime ? i18n.ts._aiModeration.gpuAvailable : i18n.ts._aiModeration.gpuUnknown) }}
							<span :class="$style.sub"><template v-if="status?.runtime?.deviceName"> ・ {{ status.runtime.deviceName }}</template><template v-if="status?.runtime?.available === false && status.runtime.reason"> ・ {{ status.runtime.reason }}</template></span>
						</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.tickLabel }}</template>
						<template #value>
							<template v-if="status?.lastTickAt"><MkTime :time="status.lastTickAt"/></template>
							<template v-else>{{ i18n.ts._aiModeration.tickNever }}</template>
							<span :class="$style.sub"><template v-if="status?.lastJudgedAt"> ・ {{ i18n.ts._aiModeration.lastJudged }} <MkTime :time="status.lastJudgedAt"/></template><template v-if="status?.gpuHolder"> ・ {{ i18n.tsx._aiModeration.gpuHolder({ job: status.gpuHolder }) }}</template></span>
						</template>
					</MkKeyValue>
					<MkKeyValue v-if="status">
						<template #key>{{ i18n.ts._aiModeration.gpuWorkerLabel }}</template>
						<template #value>
							{{ gpuWorkerStateLabel(status.gpuQueue.state) }}
							<span :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.gpuQueueWaiting({ count: status.gpuQueue.lengths.judgeTrial + status.gpuQueue.lengths.spamJudge + status.gpuQueue.lengths.spamScan }) }}<template v-if="status.gpuQueue.lastBatch"> ・ {{ i18n.tsx._aiModeration.gpuLastBatch({ kind: gpuKindLabel(status.gpuQueue.lastBatch.kind), size: status.gpuQueue.lastBatch.size, seconds: (status.gpuQueue.lastBatch.durationMs / 1000).toFixed(1) }) }}</template><template v-if="status.gpuQueue.vramGiB != null"> ・ GPU {{ status.gpuQueue.vramGiB.toFixed(1) }}GB</template></span>
							<div v-if="status.gpuQueue.lastError" :class="$style.sub">{{ status.gpuQueue.lastError }}</div>
						</template>
					</MkKeyValue>
					<MkKeyValue v-if="status">
						<template #key>{{ i18n.ts._aiModeration.externalStatusLabel }}</template>
						<template #value>
							<template v-if="!status.external.configured">{{ status.external.enabled ? i18n.ts._aiModeration.externalStatusNoKey : i18n.ts._aiModeration.externalStatusOff }}</template>
							<template v-else>
								{{ i18n.tsx._aiModeration.externalStatusToday({ sent: (status.external.today.ok ?? 0) + (status.external.today.flagged ?? 0), flagged: status.external.today.flagged ?? 0, error: status.external.today.error ?? 0 }) }}
								<span :class="$style.sub"> ・ {{ status.external.includeRemote ? i18n.ts._aiModeration.externalStatusWithRemote : i18n.ts._aiModeration.externalStatusLocalOnly }}<template v-if="(status.external.today.expired ?? 0) + status.external.externalOnlyDroppedToday > 0"> ・ {{ i18n.tsx._aiModeration.externalStatusDropped({ count: (status.external.today.expired ?? 0) + status.external.externalOnlyDroppedToday }) }}</template></span>
							</template>
							<div v-if="status.external.lastError" :class="$style.sub">{{ i18n.ts._aiModeration.externalStatusLastError }} <MkTime :time="status.external.lastError.at"/> ・ {{ status.external.lastError.message }}</div>
						</template>
					</MkKeyValue>
					<MkKeyValue>
						<template #key>{{ i18n.ts._aiModeration.autoHideLabel }}</template>
						<template #value>
							{{ autoHideModeLabel(status?.autoHideMode ?? 'off') }}
							<span v-if="status?.autoHideMode === 'on'" :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.autoHiddenCount({ count: status.autoHiddenLast24h }) }}</span>
							<span v-else-if="status?.autoHideMode === 'trial'" :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.wouldHideCount({ count: status.wouldHideLast24h }) }}</span>
						</template>
					</MkKeyValue>
					<MkKeyValue v-if="outcomes">
						<template #key>{{ i18n.ts._aiModeration.outcomesTitle }}</template>
						<template #value>
							{{ i18n.tsx._aiModeration.outcomesAuto({ suspended: outcomes.auto.suspended, deleted: outcomes.auto.deleted, unhidden: outcomes.auto.unhidden, hidden: outcomes.auto.hidden }) }}
							<span :class="$style.sub"> ・ {{ i18n.tsx._aiModeration.outcomesMissed({ count: outcomes.notAuto.suspended + outcomes.notAuto.deleted }) }}</span>
						</template>
					</MkKeyValue>
				</div>
				<MkButton small rounded :disabled="statusLoading" @click="reloadAll"><i class="ti ti-refresh"></i> {{ i18n.ts._aiModeration.reload }}</MkButton>
			</div>
			<MkInfo v-if="statusError" warn>{{ statusError }}</MkInfo>
			<MkInfo v-if="status?.runtime?.available === false" warn>{{ i18n.ts._aiModeration.noGpuWarning }}</MkInfo>

			<!-- まとめ方・絞り込み -->
			<div :class="$style.toolbar">
				<MkTabs
					v-model:tab="mode"
					:tabs="[{
						key: 'host',
						title: i18n.ts._aiModeration.groupByHost,
					}, {
						key: 'similar',
						title: i18n.ts._aiModeration.groupByLink,
					}, {
						key: 'individual',
						title: i18n.ts._aiModeration.groupByIndividual,
					}]"
				/>
				<MkTabs
					v-if="mode === 'similar'"
					v-model:tab="similarBy"
					:tabs="[{
						key: 'link',
						title: i18n.ts._aiModeration.byLink,
					}, {
						key: 'fingerprint',
						title: i18n.ts._aiModeration.byText,
					}]"
				/>
				<MkTabs
					v-model:tab="filter"
					:tabs="[{
						key: 'unresolved',
						title: i18n.ts._aiModeration.unresolved,
					}, {
						key: 'resolved',
						title: i18n.ts._aiModeration.resolved,
					}, {
						key: 'all',
						title: i18n.ts._aiModeration.allJudged,
					}, ...(mode === 'individual' ? [{
						key: 'autoHidden',
						title: i18n.ts._aiModeration.filterAutoHidden,
					}, {
						key: 'wouldHide',
						title: i18n.ts._aiModeration.filterWouldHide,
					}] : [])]"
				/>
			</div>

			<!-- サーバーごと / 同じリンク・同じ文ごと: 一覧の表と、選んだ行の詳しい内容 -->
			<template v-if="mode !== 'individual'">
				<MkLoading v-if="groupsLoading"/>
				<MkInfo v-else-if="groupsError" warn>{{ groupsError }}</MkInfo>
				<div v-else-if="groups.length === 0" class="_panel" :class="$style.empty">{{ i18n.ts.noNotes }}</div>
				<template v-else>
					<div class="_panel" :class="$style.tableScroll">
						<table :class="[$style.table, $style.listTable]">
							<thead v-if="mode === 'host'">
								<tr>
									<th scope="col"><span :class="$style.srOnly">{{ i18n.ts._aiModeration.colSeverity }}</span></th>
									<th scope="col">{{ i18n.ts._aiModeration.colServer }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.flaggedPosts24h">{{ i18n.ts._aiModeration.colPosts }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.sendingAccounts">{{ i18n.ts._aiModeration.colAccounts }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.targetedLocalUsers">{{ i18n.ts._aiModeration.colTargets }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.localFollowers">{{ i18n.ts._aiModeration.colFollowers }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.unsolicitedRatio">{{ i18n.ts._aiModeration.colUnsolicited }}</th>
									<th scope="col" :class="$style.num" :title="i18n.ts._aiModeration.peakHour">{{ i18n.ts._aiModeration.colPeak }}</th>
								</tr>
							</thead>
							<thead v-else>
								<tr>
									<th scope="col"><span :class="$style.srOnly">{{ i18n.ts._aiModeration.colSeverity }}</span></th>
									<th scope="col">{{ similarBy === 'link' ? i18n.ts._aiModeration.byLink : i18n.ts._aiModeration.byText }}</th>
									<th scope="col" :class="$style.num">{{ i18n.ts._aiModeration.colPosts }}</th>
									<th scope="col" :class="$style.num">{{ i18n.ts._aiModeration.colAccounts }}</th>
									<th scope="col">{{ i18n.ts._aiModeration.hostsBreakdown }}</th>
									<th scope="col">{{ i18n.ts._aiModeration.firstAt }}</th>
								</tr>
							</thead>
							<tbody>
								<tr v-for="group in groups" :key="groupKey(group)" :class="[$style.selectable, { [$style.selected]: selectedGroup != null && groupKey(selectedGroup) === groupKey(group) }]" @click="selectedGroupKey = groupKey(group)">
									<td>
										<i v-if="group.severity === 'strong'" class="ti ti-alert-triangle" style="color: var(--MI_THEME-error);" :title="i18n.ts._aiModeration.strong"></i>
										<i v-else-if="group.severity === 'partial'" class="ti ti-alert-triangle" style="color: var(--MI_THEME-warn);" :title="i18n.ts._aiModeration.partial"></i>
									</td>
									<td :class="$style.nameCell"><button class="_textButton" :class="$style.rowName" @click.stop="selectedGroupKey = groupKey(group)">{{ groupName(group) }}</button><span v-if="group.instance?.isHidden" :class="$style.sub"> ({{ i18n.ts._aiModeration.hiddenShort }})</span></td>
									<template v-if="mode === 'host'">
										<td :class="$style.num">{{ group.flaggedCount }}</td>
										<td :class="$style.num">{{ group.accountCount }}</td>
										<td :class="$style.num">{{ group.targetCount }}</td>
										<td :class="$style.num">{{ group.localFollowersCount ?? 0 }}</td>
										<td :class="$style.num">{{ pct(group.unsolicitedRatio) }}</td>
										<td :class="$style.num">{{ group.peakPerHour }}</td>
									</template>
									<template v-else>
										<td :class="$style.num">{{ group.flaggedCount }}</td>
										<td :class="$style.num">{{ group.accountCount }}</td>
										<td :class="$style.sub">{{ (group.hosts ?? []).map(h => `${h.host ?? '—'} ${h.accounts}`).join('、') }}</td>
										<td :class="$style.sub"><MkTime :time="group.firstAt"/></td>
									</template>
								</tr>
							</tbody>
						</table>
					</div>

					<!-- 選んだ行 -->
					<section v-if="selectedGroup" class="_panel" :class="$style.card">
						<header :class="$style.cardHead">
							<div :class="$style.cardTitle">
								<div :class="$style.cardName">{{ groupName(selectedGroup) }}</div>
								<div v-if="groupCaption(selectedGroup)" :class="$style.sub">{{ groupCaption(selectedGroup) }}</div>
							</div>
							<div :class="$style.sub">{{ i18n.tsx._aiModeration.groupSuffix({ posts: selectedGroup.flaggedCount, accounts: selectedGroup.accountCount }) }}</div>
						</header>
						<div class="_gaps_s" :class="$style.cardBody">
							<MkInfo v-if="mode === 'host' && selectedGroup.severity === 'partial'">{{ i18n.ts._aiModeration.recommendSuspendAccounts }}</MkInfo>
							<div :class="$style.detailGrid">
								<MkKeyValue v-if="reasonChips(selectedGroup).length > 0">
									<template #key>{{ i18n.ts._aiModeration.reasonsTitle }}</template>
									<template #value>
										<ul :class="$style.list">
											<li v-for="(reason, i) in reasonChips(selectedGroup)" :key="i">{{ reason }}</li>
										</ul>
									</template>
								</MkKeyValue>
								<MkKeyValue v-if="selectedGroup.samples?.length">
									<template #key>{{ i18n.ts._aiModeration.samplesTitle }}</template>
									<template #value>
										<ul :class="$style.list">
											<li v-for="(sample, i) in selectedGroup.samples" :key="i">
												{{ sampleText(sample.text).base }}<span v-if="sampleText(sample.text).noise" :class="$style.sub">{{ i18n.ts._aiModeration.trailingNoiseMark }}</span><span :class="$style.sub">{{ i18n.tsx._aiModeration.sampleCount({ count: sample.count }) }}</span>
											</li>
										</ul>
									</template>
								</MkKeyValue>
							</div>

							<!-- アカウント表（サーバーごとのみ） -->
							<div v-if="mode === 'host'">
								<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.accountList }}</div>
								<div v-if="accountState(selectedGroup).length > 0" :class="$style.tableScroll">
									<table :class="$style.table">
										<thead>
											<tr>
												<th scope="col">{{ i18n.ts._aiModeration.accountCol }}</th>
												<th scope="col">{{ i18n.ts._aiModeration.createdAgoCol }}</th>
												<th scope="col" :class="$style.num">{{ i18n.ts._aiModeration.postsFlaggedCol }}</th>
												<th scope="col">{{ i18n.ts._aiModeration.sentToCol }}</th>
												<th scope="col">{{ i18n.ts._aiModeration.aiJudgementCol }}</th>
												<th scope="col">{{ i18n.ts._aiModeration.signalsCol }}</th>
												<th scope="col"><span :class="$style.srOnly">{{ i18n.ts._aiModeration.hideCol }}</span></th>
											</tr>
										</thead>
										<tbody>
											<tr v-for="account in accountState(selectedGroup)" :key="account.user?.id ?? ''">
												<td><MkA v-if="account.user" :to="`/admin/user/${account.user.id}`"><MkAcct :user="account.user"/></MkA><span v-else>—</span><span v-if="account.isHidden" :class="$style.sub"> ({{ i18n.ts._aiModeration.hiddenShort }})</span></td>
												<td><MkTime v-if="account.createdAt" :time="account.createdAt" mode="relative"/></td>
												<td :class="$style.num">{{ account.judgedCount }} / {{ account.flaggedCount }}</td>
												<td>{{ i18n.tsx._aiModeration.sentTo({ count: account.targetCount, kind: accountContactKindLabel(account) }) }}</td>
												<td>{{ accountLabel(account) }}</td>
												<td>{{ accountSignalsLabel(account) }}</td>
												<td><button v-if="account.user" class="_textButton" @click="toggleHideAccount(selectedGroup, account)">{{ account.isHidden ? i18n.ts._aiModeration.unhide : i18n.ts._aiModeration.hide }}</button></td>
											</tr>
										</tbody>
									</table>
								</div>
								<div v-if="remainingAccounts(selectedGroup) > 0" :class="$style.more">
									<button class="_textButton" @click="expandAccounts(selectedGroup)">{{ i18n.tsx._aiModeration.remainingAccounts({ count: remainingAccounts(selectedGroup) }) }}</button>
								</div>
							</div>
						</div>

						<footer class="_buttons" :class="$style.cardFoot">
							<MkButton @click="bulkResolve(selectedGroup)"><i class="ti ti-check"></i> {{ i18n.tsx._aiModeration.bulkResolve({ count: selectedGroup.flaggedCount }) }}</MkButton>
							<MkButton v-if="mode === 'host' && selectedGroup.key" @click="toggleHideHost(selectedGroup)"><i class="ti ti-eye-off"></i> {{ selectedGroup.instance?.isHidden ? i18n.ts._aiModeration.unhideHost : i18n.ts._aiModeration.hideHost }}</MkButton>
							<MkButton v-if="iAmAdmin" @click="bulkSuspend(selectedGroup)"><i class="ti ti-user-off"></i> {{ i18n.tsx._aiModeration.bulkSuspend({ count: selectedGroup.accountCount }) }}</MkButton>
							<template v-if="mode === 'host' && iAmAdmin && selectedGroup.key">
								<MkButton @click="silenceHost(selectedGroup)"><i class="ti ti-volume-3"></i> {{ i18n.ts._aiModeration.silenceHost }}</MkButton>
								<MkButton danger @click="blockHost(selectedGroup)"><i class="ti ti-ban"></i> {{ i18n.ts._aiModeration.blockHost }}</MkButton>
							</template>
							<MkButton v-if="mode === 'similar' && similarBy === 'link' && iAmAdmin && selectedGroup.key" @click="addProhibitedWord(selectedGroup)"><i class="ti ti-forbid"></i> {{ i18n.tsx._aiModeration.addProhibitedWord({ domain: domainOf(selectedGroup.key!) }) }}</MkButton>
							<MkButton v-if="mode === 'host' && selectedGroup.key" link :to="`/instance-info/${selectedGroup.key}`"><i class="ti ti-external-link"></i> {{ i18n.ts._aiModeration.viewFederation }}</MkButton>
						</footer>
					</section>
				</template>
			</template>

			<!-- 1件ずつ: 表 -->
			<MkPagination v-else v-slot="{ items }" :paginator="queuePaginator">
				<div class="_panel" :class="$style.tableScroll">
					<table :class="[$style.table, $style.listTable]">
						<thead>
							<tr>
								<th scope="col">{{ i18n.ts._aiModeration.accountCol }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.noteBody }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.colAi }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.colEvidence }}</th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="item in items" :key="item.id">
								<td :class="$style.acctCell">
									<MkA :to="`/admin/user/${item.noteUserId}`"><MkAcct v-if="item.noteUser" :user="item.noteUser"/><span v-else>—</span></MkA>
									<div v-if="item.author" :class="$style.sub" :title="i18n.tsx._aiModeration.authorSummary({ notes: item.author.notesCount, following: item.author.followingCount, followers: item.author.followersCount })">{{ i18n.tsx._aiModeration.authorShort({ followers: item.author.followersCount }) }} ・ <MkTime :time="item.author.createdAt" mode="relative"/></div>
									<div v-if="itemStateText(item) || item.resolved" :class="$style.stateText">{{ itemStateText(item) || i18n.ts._aiModeration.resolved }}</div>
									<div :class="$style.actionRow">
										<button v-if="!item.resolved" class="_button" :class="$style.iconButton" :title="i18n.ts._aiModeration.resolveAction" :aria-label="i18n.ts._aiModeration.resolveAction" @click="resolveItem(item)"><i class="ti ti-check"></i></button>
										<button class="_button" :class="$style.iconButton" :title="item.author?.isHidden ? i18n.ts._aiModeration.unhideAccount : i18n.ts._aiModeration.hideAccount" :aria-label="item.author?.isHidden ? i18n.ts._aiModeration.unhideAccount : i18n.ts._aiModeration.hideAccount" @click="toggleHideItem(item)"><i :class="item.author?.isHidden ? 'ti ti-eye' : 'ti ti-eye-off'"></i></button>
										<button class="_button" :class="$style.iconButton" :title="i18n.ts.moderationNote" :aria-label="i18n.ts.moderationNote" @click="editMemo(item)"><i class="ti ti-note"></i></button>
										<button v-if="item.note" class="_button" :class="[$style.iconButton, $style.danger]" :title="i18n.ts._aiModeration.deleteNote" :aria-label="i18n.ts._aiModeration.deleteNote" @click="deleteNote(item)"><i class="ti ti-trash"></i></button>
										<button class="_button" :class="[$style.iconButton, $style.danger]" :title="i18n.ts._aiModeration.suspendUser" :aria-label="i18n.ts._aiModeration.suspendUser" @click="suspendUser(item)"><i class="ti ti-user-off"></i></button>
									</div>
								</td>
								<td :class="$style.textCell">
									<MkA v-if="item.note" :to="notePage(item.note)" :class="$style.clamp" :title="item.noteText">{{ item.noteText }}</MkA>
									<span v-else :class="$style.clamp" :title="item.noteText">{{ item.noteText }} <span :class="$style.sub">（{{ i18n.ts._aiModeration.noteDeleted }}）</span></span>
									<div :class="$style.sub" :title="itemReasons(item)"><MkTime v-if="item.judgedAt" :time="item.judgedAt"/> ・ {{ item.contactKind ? `${contactKindLabel(item.contactKind)} ${i18n.tsx._aiModeration.contactTo({ count: item.contactCount })}` : visibilityLabel(item.noteVisibility) }}</div>
									<div v-if="item.moderationNote" :class="$style.memo"><i class="ti ti-note"></i> {{ item.moderationNote }}</div>
								</td>
								<td :class="$style.scoreCell">{{ itemTopScore(item) }}<div v-if="item.externalCategories.length > 0" :class="$style.sub">{{ externalLabel(item) }}</div></td>
								<td :class="$style.signalCell" :title="item.spamSignals.map(spamSignalLabel).join('・')">
									<template v-if="item.spamSignals.length > 0">{{ i18n.tsx._aiModeration.evidencePoints({ points: signalPoints(item) }) }}<div :class="$style.sub">{{ item.spamSignals.map(spamSignalLabel).join('・') }}</div></template>
									<span v-else :class="$style.sub">—</span>
								</td>
							</tr>
						</tbody>
					</table>
				</div>
			</MkPagination>
		</div>

		<!-- 隠しているもの -->
		<div v-else-if="tab === 'hidden'" class="_gaps_s">
			<div :class="$style.sub">{{ i18n.ts._aiModeration.hiddenListCaption }}</div>
			<MkPagination v-slot="{ items }" :paginator="hiddenPaginator">
				<div class="_panel">
					<table :class="$style.table">
						<thead>
							<tr>
								<th scope="col">{{ i18n.ts._aiModeration.hiddenTargetCol }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.hiddenTypeCol }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.hiddenByCol }}</th>
								<th scope="col">{{ i18n.ts._aiModeration.hiddenAtCol }}</th>
								<th scope="col"><span :class="$style.srOnly">{{ i18n.ts._aiModeration.unhide }}</span></th>
							</tr>
						</thead>
						<tbody>
							<tr v-for="row in items" :key="row.id">
								<td><MkA v-if="row.user" :to="`/admin/user/${row.user.id}`"><MkAcct :user="row.user"/></MkA><b v-else>{{ row.host }}</b></td>
								<td>{{ row.targetType === 'host' ? i18n.ts._aiModeration.hiddenTypeHost : i18n.ts._aiModeration.hiddenTypeUser }}</td>
								<td>{{ row.reason === 'auto' ? i18n.ts._aiModeration.hiddenByAuto : i18n.tsx._aiModeration.hiddenByModerator({ name: row.createdBy?.username ?? '—' }) }}</td>
								<td><MkTime :time="row.createdAt"/></td>
								<td><button class="_textButton" @click="unhideRow(row)">{{ i18n.ts._aiModeration.unhide }}</button></td>
							</tr>
						</tbody>
					</table>
				</div>
			</MkPagination>
		</div>

		<!-- 全体を調べる -->
		<XScan v-else-if="tab === 'scan'" :spamSignalLabel="spamSignalLabel"/>

		<!-- 試す（管理者のみ） -->
		<div v-else-if="tab === 'trial' && iAmAdmin" class="_gaps">
			<MkTextarea v-model="trialText">
				<template #label>{{ i18n.ts._aiModeration.trialTextLabel }}</template>
			</MkTextarea>
			<div>
				<MkButton primary :disabled="trialLoading" @click="runTrial">{{ i18n.ts._aiModeration.trialRun }}</MkButton>
			</div>
			<div v-if="trialResult" class="_panel" :class="[$style.keyValues, $style.padded]">
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.aiJudgementQwen }}</template>
					<template #value>{{ trialResult.scores ? `${i18n.ts._aiModeration.spam} ${pct(trialResult.scores.spam)} ・ ${i18n.ts._aiModeration.scam} ${pct(trialResult.scores.scam)} ・ ${i18n.ts._aiModeration.abuse} ${pct(trialResult.scores.abuse)} ・ ${i18n.ts._aiModeration.normal} ${pct(trialResult.scores.normal)}` : '—' }}</template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.externalTitle }}</template>
					<template #value>{{ externalTrialLabel(trialResult) }}</template>
				</MkKeyValue>
				<MkKeyValue>
					<template #key>{{ i18n.ts._aiModeration.trialVerdict }}</template>
					<template #value>{{ trialResult.flagged ? trialFlaggedText(trialResult) : i18n.ts._aiModeration.trialNotFlagged }}</template>
				</MkKeyValue>
			</div>
		</div>

		<!-- 設定（管理者のみ） -->
		<div v-else-if="tab === 'settings' && settingsForm" class="_gaps" :inert="saving">
			<div :class="$style.settingsGrid">
				<div class="_gaps">
					<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.settingsSectionJudge }}</div>
					<MkSwitch v-model="settingsForm.state.aiModerationEnabled">
						<template #label>{{ i18n.ts._aiModeration.settingsEnabled }}</template>
					</MkSwitch>
					<div :class="$style.inputs">
						<MkInput v-model="settingsForm.state.aiModerationNewAuthorDays" type="number" :min="1" :max="90">
							<template #label>{{ i18n.ts._aiModeration.settingsNewAuthorDays }}</template>
						</MkInput>
						<MkInput v-model="settingsForm.state.aiModerationDailyLimit" type="number" :min="0" :max="10000">
							<template #label>{{ i18n.ts._aiModeration.settingsDailyLimit }}</template>
						</MkInput>
					</div>
					<MkSwitch v-model="settingsForm.state.aiModerationLocalEnabled">
						<template #label>{{ i18n.ts._aiModeration.settingsQwen }}</template>
						<template #caption>{{ i18n.ts._aiModeration.settingsQwenCaption }}</template>
					</MkSwitch>
					<MkRange v-model="settingsForm.state.aiModerationLocalThreshold" :min="0" :max="1" :step="0.05" :textConverter="(v) => v.toFixed(2)">
						<template #label>{{ i18n.ts._aiModeration.settingsThreshold }}</template>
					</MkRange>
				</div>

				<div class="_gaps">
					<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.settingsSectionAutoHide }}</div>
					<MkRadios v-model="settingsForm.state.aiModerationAutoHideMode" :options="autoHideModeOptions">
						<template #label>{{ i18n.ts._aiModeration.settingsAutoHide }}</template>
						<template #caption>{{ i18n.ts._aiModeration.settingsAutoHideCaption }}</template>
					</MkRadios>
					<MkRange v-model="settingsForm.state.aiModerationAutoHideThreshold" :min="0.5" :max="1" :step="0.01" :textConverter="(v) => v.toFixed(2)">
						<template #label>{{ i18n.ts._aiModeration.settingsAutoHideThreshold }}</template>
					</MkRange>
					<div :class="$style.inputs">
						<MkInput v-model="settingsForm.state.aiModerationAutoHideDailyLimit" type="number" :min="0" :max="10000">
							<template #label>{{ i18n.ts._aiModeration.settingsAutoHideDailyLimit }}</template>
						</MkInput>
					</div>
					<MkSwitch v-model="settingsForm.state.aiModerationAutoHideHosts">
						<template #label>{{ i18n.ts._aiModeration.settingsAutoHideHosts }}</template>
						<template #caption>{{ i18n.ts._aiModeration.settingsAutoHideHostsCaption }}</template>
					</MkSwitch>
				</div>

				<div class="_gaps">
					<div :class="$style.cardLabel">{{ i18n.ts._aiModeration.settingsSectionExternal }}</div>
					<MkSwitch v-model="settingsForm.state.aiModerationExternalEnabled">
						<template #label>{{ i18n.ts._aiModeration.settingsExternal }}</template>
						<template #caption>{{ i18n.ts._aiModeration.settingsExternalCaption }}</template>
					</MkSwitch>
					<MkInput v-model="settingsForm.state.aiModerationExternalApiUrl" type="url">
						<template #label>{{ i18n.ts._aiModeration.settingsExternalUrl }}</template>
					</MkInput>
					<div :class="$style.inputs">
						<MkInput v-model="settingsForm.state.aiModerationExternalApiKey" type="password">
							<template #label>{{ i18n.ts._aiModeration.settingsExternalKey }}</template>
						</MkInput>
						<MkInput v-model="settingsForm.state.aiModerationExternalModel">
							<template #label>{{ i18n.ts._aiModeration.settingsExternalModel }}</template>
						</MkInput>
					</div>
					<MkSwitch v-model="settingsForm.state.aiModerationExternalIncludeRemote">
						<template #label>{{ i18n.ts._aiModeration.settingsExternalIncludeRemote }}</template>
						<template #caption>{{ i18n.ts._aiModeration.settingsExternalIncludeRemoteCaption }}</template>
					</MkSwitch>
					<fieldset :class="$style.visibilities">
						<legend>{{ i18n.ts._aiModeration.settingsExternalVisibilities }}</legend>
						<div :class="$style.visibilityItems">
							<label v-for="v in visibilityOptions" :key="v.value" :class="$style.visibilityItem">
								<input v-model="settingsForm.state.aiModerationExternalVisibilities" type="checkbox" :value="v.value">
								<span>{{ v.label }}</span>
								<span v-if="v.value === 'specified'" :class="$style.visibilityWarning">{{ i18n.ts._aiModeration.settingsSpecifiedWarning }}</span>
							</label>
						</div>
					</fieldset>
				</div>
			</div>
			<div v-if="footerForm && settingsForm.modified.value" :class="$style.formFooter">
				<MkFormFooter :form="footerForm" :canSaving="!saving"/>
			</div>
		</div>
	</div>
</PageWithHeader>
</template>

<script lang="ts" setup>
import { computed, markRaw, ref, watch } from 'vue';
import type { entities } from 'misskey-js';
import MkAvatar from '@/components/global/MkAvatar.vue';
import MkAcct from '@/components/global/MkAcct.vue';
import MkButton from '@/components/MkButton.vue';
import MkFormFooter from '@/components/MkFormFooter.vue';
import MkInfo from '@/components/MkInfo.vue';
import MkInput from '@/components/MkInput.vue';
import MkKeyValue from '@/components/MkKeyValue.vue';
import MkPagination from '@/components/MkPagination.vue';
import MkRadios from '@/components/MkRadios.vue';
import type { MkRadiosOption } from '@/components/MkRadios.vue';
import MkRange from '@/components/MkRange.vue';
import MkSwitch from '@/components/MkSwitch.vue';
import MkTabs from '@/components/MkTabs.vue';
import MkTextarea from '@/components/MkTextarea.vue';
import XScan from './ai-moderation.scan.vue';
import { i18n } from '@/i18n.js';
import { definePage } from '@/page.js';
import { iAmAdmin } from '@/i.js';
import { fetchInstance } from '@/instance.js';
import * as os from '@/os.js';
import { misskeyApi } from '@/utility/misskey-api.js';
import { Paginator } from '@/utility/paginator.js';
import { useForm } from '@/composables/use-form.js';
import { notePage } from '@@/js/note.js';

type Group = entities.AdminAiModerationGroupsResponse[number];
type GroupAccount = entities.AdminAiModerationGroupAccountsResponse[number];
type QueueItem = entities.AiModerationQueue;
type StatusInfo = entities.AdminAiModerationStatusResponse;
type TrialResult = entities.AdminAiModerationTrialResponse;

const TRAILING_NOISE_RE = /\s+[a-z]{2,6}$/;

const t = i18n.ts._aiModeration;

// 管理者だけが admin/meta を読める（設定・ブロック・サイレンス・禁止ワードに使う）。
const meta = ref<entities.AdminMetaResponse | null>(null);
if (iAmAdmin) {
	meta.value = await misskeyApi('admin/meta');
}

const tab = ref<'queue' | 'hidden' | 'scan' | 'trial' | 'settings'>('queue');
const headerTabs = computed(() => [{
	key: 'queue',
	title: t.queue,
	icon: 'ti ti-list-check',
}, {
	key: 'hidden',
	title: t.hiddenList,
	icon: 'ti ti-eye-off',
}, {
	key: 'scan',
	title: t.scanTab,
	icon: 'ti ti-search',
}, ...(iAmAdmin ? [{
	key: 'trial',
	title: t.trial,
	icon: 'ti ti-flask',
}, {
	key: 'settings',
	title: t.settings,
	icon: 'ti ti-settings',
}] : [])]);

// まとめ方 / 絞り込み
const mode = ref<'host' | 'similar' | 'individual'>('host');
const similarBy = ref<'link' | 'fingerprint'>('link');
const filter = ref<'unresolved' | 'resolved' | 'all' | 'autoHidden' | 'wouldHide'>('unresolved');

const currentGroupBy = computed<'host' | 'link' | 'fingerprint'>(() => {
	if (mode.value === 'host') return 'host';
	return similarBy.value;
});
const resolvedParam = computed(() => filter.value === 'resolved');

// 状況
const status = ref<StatusInfo | null>(null);
const statusLoading = ref(false);
const statusError = ref('');
const outcomes = ref<entities.AdminAiModerationOutcomesResponse | null>(null);

async function reloadStatus() {
	if (statusLoading.value) return;
	statusLoading.value = true;
	statusError.value = '';
	try {
		[status.value, outcomes.value] = await Promise.all([
			misskeyApi('admin/ai-moderation/status'),
			misskeyApi('admin/ai-moderation/outcomes', { days: 30 }),
		]);
	} catch (err) {
		statusError.value = errorText(err);
	} finally {
		statusLoading.value = false;
	}
}

// グループ（サーバーごと / 同じリンク・同じ文ごと）
const groups = ref<Group[]>([]);
const groupsLoading = ref(false);
const groupsError = ref('');
const groupAccountsMap = ref<Record<string, GroupAccount[]>>({});
const groupAccountsExpanded = ref<Record<string, boolean>>({});

function groupKey(group: Group): string {
	return `${currentGroupBy.value}:${resolvedParam.value}:${group.key ?? '__local__'}`;
}

async function reloadGroups() {
	if (groupsLoading.value) return;
	groupsLoading.value = true;
	groupsError.value = '';
	groupAccountsMap.value = {};
	groupAccountsExpanded.value = {};
	try {
		groups.value = await misskeyApi('admin/ai-moderation/groups', {
			groupBy: currentGroupBy.value,
			resolved: resolvedParam.value,
			limit: 50,
		});
	} catch (err) {
		groupsError.value = errorText(err);
	} finally {
		groupsLoading.value = false;
	}
}

watch([mode, similarBy, filter], () => {
	if (mode.value !== 'individual') void reloadGroups();
});

const selectedGroupKey = ref<string | null>(null);
// 選んだ行（無ければ先頭）
const selectedGroup = computed(() => groups.value.find(g => groupKey(g) === selectedGroupKey.value) ?? groups.value[0] ?? null);

function itemTopScore(item: QueueItem): string {
	if (item.localScores == null) return '—';
	const spam = Math.round((item.localScores.spam + item.localScores.scam) * 100);
	const abuse = Math.round(item.localScores.abuse * 100);
	return abuse > spam ? `${i18n.ts._aiModeration.abuse} ${abuse}%` : `${i18n.ts._aiModeration.spam} ${spam}%`;
}

// アカウント表
function accountState(group: Group): GroupAccount[] {
	return groupAccountsMap.value[groupKey(group)] ?? [];
}

function remainingAccounts(group: Group): number {
	return Math.max(0, group.accountCount - (groupAccountsMap.value[groupKey(group)]?.length ?? 0));
}

async function loadGroupAccounts(group: Group, full: boolean): Promise<void> {
	const gk = groupKey(group);
	const accounts = await misskeyApi('admin/ai-moderation/group-accounts', {
		groupBy: currentGroupBy.value,
		key: group.key,
		resolved: resolvedParam.value,
		limit: full ? 100 : 5,
		offset: 0,
	});
	groupAccountsMap.value[gk] = accounts;
	groupAccountsExpanded.value[gk] = full;
}

async function ensureAccounts(group: Group): Promise<void> {
	const gk = groupKey(group);
	if (groupAccountsMap.value[gk] != null) return;
	groupAccountsMap.value[gk] = [];
	groupAccountsExpanded.value[gk] = false;
	try {
		await loadGroupAccounts(group, false);
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	}
}

async function expandAccounts(group: Group): Promise<void> {
	try {
		await loadGroupAccounts(group, true);
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	}
}

// グループが描画されたら先頭のアカウントを取ってくる。
watch(groups, (list) => {
	for (const group of list) {
		if (mode.value === 'host') void ensureAccounts(group);
	}
});

// 1件ずつ
const queuePaginator = markRaw(new Paginator('admin/ai-moderation/queue', {
	limit: 10,
	computedParams: computed(() => {
		if (filter.value === 'resolved') return { resolved: true };
		if (filter.value === 'all') return { onlyFlagged: false };
		if (filter.value === 'autoHidden') return { autoAction: 'hidden' as const };
		if (filter.value === 'wouldHide') return { autoAction: 'wouldHide' as const };
		return { resolved: false };
	}),
}));

watch(mode, (m) => {
	if (m !== 'individual' && (filter.value === 'autoHidden' || filter.value === 'wouldHide')) filter.value = 'unresolved';
});

// 隠しているもの
const hiddenPaginator = markRaw(new Paginator('admin/ai-moderation/hidden', {
	limit: 20,
}));

// 試す
const trialText = ref('');
const trialResult = ref<TrialResult | null>(null);
const trialLoading = ref(false);

async function runTrial(): Promise<void> {
	if (trialLoading.value) return;
	trialLoading.value = true;
	trialResult.value = null;
	try {
		trialResult.value = await misskeyApi('admin/ai-moderation/trial', { text: trialText.value });
	} catch (err) {
		os.alert({ type: 'error', text: errorText(err) });
	} finally {
		trialLoading.value = false;
	}
}

// 設定
type AiModerationSettings = {
	aiModerationEnabled: boolean;
	aiModerationNewAuthorDays: number;
	aiModerationDailyLimit: number;
	aiModerationLocalEnabled: boolean;
	aiModerationLocalThreshold: number;
	aiModerationExternalEnabled: boolean;
	aiModerationExternalApiUrl: string;
	aiModerationExternalApiKey: string;
	aiModerationExternalModel: string;
	aiModerationExternalVisibilities: ('public' | 'home' | 'followers' | 'specified')[];
	aiModerationExternalIncludeRemote: boolean;
	aiModerationAutoHideMode: 'off' | 'trial' | 'on';
	aiModerationAutoHideThreshold: number;
	aiModerationAutoHideDailyLimit: number;
	aiModerationAutoHideHosts: boolean;
};

function metaToForm(m: entities.AdminMetaResponse): AiModerationSettings {
	return {
		aiModerationEnabled: m.aiModerationEnabled,
		aiModerationNewAuthorDays: m.aiModerationNewAuthorDays,
		aiModerationDailyLimit: m.aiModerationDailyLimit,
		aiModerationLocalEnabled: m.aiModerationLocalEnabled,
		aiModerationLocalThreshold: m.aiModerationLocalThreshold,
		aiModerationExternalEnabled: m.aiModerationExternalEnabled,
		aiModerationExternalApiUrl: m.aiModerationExternalApiUrl ?? '',
		aiModerationExternalApiKey: m.aiModerationExternalApiKey ?? '',
		aiModerationExternalModel: m.aiModerationExternalModel ?? '',
		aiModerationExternalVisibilities: [...(m.aiModerationExternalVisibilities ?? [])] as AiModerationSettings['aiModerationExternalVisibilities'],
		aiModerationExternalIncludeRemote: m.aiModerationExternalIncludeRemote,
		aiModerationAutoHideMode: m.aiModerationAutoHideMode,
		aiModerationAutoHideThreshold: m.aiModerationAutoHideThreshold,
		aiModerationAutoHideDailyLimit: m.aiModerationAutoHideDailyLimit,
		aiModerationAutoHideHosts: m.aiModerationAutoHideHosts,
	};
}

function formToMetaParams(state: AiModerationSettings): Record<string, unknown> {
	return {
		aiModerationEnabled: state.aiModerationEnabled,
		aiModerationNewAuthorDays: state.aiModerationNewAuthorDays,
		aiModerationDailyLimit: state.aiModerationDailyLimit,
		aiModerationLocalEnabled: state.aiModerationLocalEnabled,
		aiModerationLocalThreshold: state.aiModerationLocalThreshold,
		aiModerationExternalEnabled: state.aiModerationExternalEnabled,
		aiModerationExternalApiUrl: state.aiModerationExternalApiUrl === '' ? null : state.aiModerationExternalApiUrl,
		aiModerationExternalApiKey: state.aiModerationExternalApiKey === '' ? null : state.aiModerationExternalApiKey,
		aiModerationExternalModel: state.aiModerationExternalModel === '' ? null : state.aiModerationExternalModel,
		aiModerationExternalVisibilities: [...new Set(state.aiModerationExternalVisibilities.filter(Boolean))],
		aiModerationExternalIncludeRemote: state.aiModerationExternalIncludeRemote,
		aiModerationAutoHideMode: state.aiModerationAutoHideMode,
		aiModerationAutoHideThreshold: state.aiModerationAutoHideThreshold,
		aiModerationAutoHideDailyLimit: state.aiModerationAutoHideDailyLimit,
		aiModerationAutoHideHosts: state.aiModerationAutoHideHosts,
	};
}

const saving = ref(false);
const settingsForm = iAmAdmin && meta.value
	? useForm<AiModerationSettings>(metaToForm(meta.value), async (state) => {
		await misskeyApi('admin/update-meta', formToMetaParams(state));
	})
	: null;

async function saveSettings(): Promise<void> {
	if (settingsForm == null || saving.value) return;
	saving.value = true;
	try {
		await settingsForm.save();
		await fetchInstance(true);
		meta.value = await misskeyApi('admin/meta');
	} catch (err) {
		await os.alert({ type: 'error', text: errorText(err) });
	} finally {
		saving.value = false;
	}
}

const footerForm = computed(() => {
	const form = settingsForm;
	if (form == null) return null;
	return {
		...form,
		save: saveSettings,
		discard: () => { if (!saving.value) form.discard(); },
	};
});

const visibilityOptions = [
	{ value: 'public', label: i18n.ts._visibility.public },
	{ value: 'home', label: i18n.ts._visibility.home },
	{ value: 'followers', label: i18n.ts._visibility.followers },
	{ value: 'specified', label: i18n.ts._visibility.specified },
] as const;

const autoHideModeOptions: MkRadiosOption<'off' | 'trial' | 'on'>[] = [
	{ value: 'off', label: i18n.ts._aiModeration.autoHideOff },
	{ value: 'trial', label: i18n.ts._aiModeration.autoHideTrial, caption: i18n.ts._aiModeration.autoHideTrialCaption },
	{ value: 'on', label: i18n.ts._aiModeration.autoHideOn, caption: i18n.ts._aiModeration.autoHideOnCaption },
];

function autoHideModeLabel(mode: 'off' | 'trial' | 'on'): string {
	return autoHideModeOptions.find(o => o.value === mode)?.label ?? mode;
}

function autoActionLabel(action: NonNullable<QueueItem['autoAction']>): string {
	switch (action) {
		case 'hidden': return i18n.ts._aiModeration.autoActionHidden;
		case 'hiddenHost': return i18n.ts._aiModeration.autoActionHiddenHost;
		case 'wouldHide': return i18n.ts._aiModeration.autoActionWouldHide;
		case 'wouldHideHost': return i18n.ts._aiModeration.autoActionWouldHideHost;
	}
}

// ユーザーから隠す（可逆）
async function setHidden(target: { targetType: 'user'; userId: string } | { targetType: 'host'; host: string }, hidden: boolean, label: string, sourceQueueId?: string): Promise<boolean> {
	const { canceled } = await os.confirm({
		type: hidden ? 'warning' : 'question',
		text: hidden ? i18n.tsx._aiModeration.confirmHide({ target: label }) : i18n.tsx._aiModeration.confirmUnhide({ target: label }),
	});
	if (canceled) return false;
	try {
		const params: { targetType: 'user' | 'host'; userId?: string; host?: string } = target.targetType === 'user'
			? { targetType: 'user', userId: target.userId }
			: { targetType: 'host', host: target.host };
		if (hidden) {
			await misskeyApi('admin/ai-moderation/hide', { ...params, sourceQueueId });
		} else {
			await misskeyApi('admin/ai-moderation/unhide', params);
		}
	} catch (err) {
		await os.alert({ type: 'error', text: errorText(err) });
		return false;
	}
	hiddenPaginator.reload();
	os.success();
	return true;
}

async function toggleHideHost(group: Group): Promise<void> {
	if (group.key == null) return;
	const hidden = !(group.instance?.isHidden ?? false);
	if (await setHidden({ targetType: 'host', host: group.key }, hidden, group.key)) await reloadGroups();
}

async function toggleHideAccount(group: Group, account: GroupAccount): Promise<void> {
	if (account.user == null) return;
	const hidden = !account.isHidden;
	if (!await setHidden({ targetType: 'user', userId: account.user.id }, hidden, accountAcct(account.user))) return;
	const list = groupAccountsMap.value[groupKey(group)];
	if (list != null) {
		groupAccountsMap.value[groupKey(group)] = list.map(a => a.user?.id === account.user?.id ? { ...a, isHidden: hidden } : a);
	}
}

async function toggleHideItem(item: QueueItem): Promise<void> {
	const hidden = !(item.author?.isHidden ?? false);
	const label = item.noteUser != null ? accountAcct(item.noteUser) : item.noteUserId;
	if (!await setHidden({ targetType: 'user', userId: item.noteUserId }, hidden, label, item.id)) return;
	queuePaginator.updateItem(item.id, (x) => ({
		...x,
		author: x.author != null ? { ...x.author, isHidden: hidden } : x.author,
	}));
}

async function unhideRow(row: entities.AdminAiModerationHiddenResponse[number]): Promise<void> {
	const target = row.targetType === 'host'
		? { targetType: 'host' as const, host: row.host ?? '' }
		: { targetType: 'user' as const, userId: row.userId ?? '' };
	const label = row.user != null ? accountAcct(row.user) : (row.host ?? '');
	if (await setHidden(target, false, label)) {
		if (mode.value !== 'individual') await reloadGroups();
	}
}

function accountAcct(user: { username: string; host: string | null }): string {
	return user.host != null ? `@${user.username}@${user.host}` : `@${user.username}`;
}

// 共通ヘルパー
function errorText(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === 'object' && err != null && 'message' in err) return String((err as { message: unknown }).message);
	return String(err);
}

function isCountMismatch(err: unknown): boolean {
	return typeof err === 'object' && err != null && 'code' in err && (err as { code: unknown }).code === 'AI_MODERATION_COUNT_MISMATCH';
}

async function withBulkGuard(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		if (isCountMismatch(err)) {
			await os.alert({ type: 'warning', text: t.countMismatch });
			await Promise.all([reloadStatus(), mode.value !== 'individual' ? reloadGroups() : queuePaginator.reload()]);
		} else {
			await os.alert({ type: 'error', text: errorText(err) });
		}
	}
}

const pct = (n: number | null | undefined): string => n == null ? '—' : `${Math.round(n * 100)}%`;

function avgPerAccount(group: Group): string {
	return group.accountCount === 0 ? '0' : (group.flaggedCount / group.accountCount).toFixed(1);
}

function groupName(group: Group): string {
	if (currentGroupBy.value === 'host') return group.key ?? '—';
	if (currentGroupBy.value === 'link') return group.key ?? '—';
	return group.samples?.[0]?.text ?? group.key ?? '—';
}

function reasonChips(group: Group): string[] {
	const chips: string[] = [];
	const spam = (group.labelCounts?.spam ?? 0) + (group.labelCounts?.scam ?? 0);
	if (spam > 0 && group.avgSpamScore != null) {
		chips.push(i18n.tsx._aiModeration.reasonSpam({ flagged: spam, total: group.flaggedCount, avg: Math.round(group.avgSpamScore * 100) }));
	}
	if (group.newAccountRatio != null && group.newAccountRatio > 0) {
		chips.push(i18n.tsx._aiModeration.reasonNewAccounts({ ratio: Math.round(group.newAccountRatio * 100) }));
	}
	if (group.topNamePattern != null && group.topNamePatternRatio != null && group.topNamePatternRatio > 0) {
		chips.push(i18n.tsx._aiModeration.reasonNamePattern({ pattern: group.topNamePattern, ratio: Math.round(group.topNamePatternRatio * 100) }));
	}
	if (group.noAvatarRatio != null && group.noAvatarRatio > 0) {
		chips.push(i18n.tsx._aiModeration.reasonNoAvatar({ ratio: Math.round(group.noAvatarRatio * 100) }));
	}
	if (group.topLinks != null && group.topLinks.length > 0) {
		chips.push(i18n.tsx._aiModeration.reasonSameLink({ link: group.topLinks[0].link, accounts: group.topLinks[0].accounts }));
	}
	if (group.trailingNoiseRatio > 0) {
		chips.push(i18n.tsx._aiModeration.reasonTrailingNoise({ ratio: Math.round(group.trailingNoiseRatio * 100) }));
	}
	if (group.maxPerAccount > 1) {
		chips.push(i18n.tsx._aiModeration.reasonMaxPerAccount({ count: group.maxPerAccount }));
	}
	if (group.instance?.openRegistrations === true && isOldMisskey(group.instance.softwareName, group.instance.softwareVersion)) {
		chips.push(t.reasonOldOpenServer);
	}
	return chips;
}

// 2023.9.0 より前の版（13.x 以前）は年号でない版番号を使っていた
function isOldMisskey(softwareName: string | null, softwareVersion: string | null): boolean {
	if (softwareName !== 'misskey' || softwareVersion == null) return false;
	const major = Number.parseInt(softwareVersion, 10);
	return Number.isFinite(major) && major < 2000;
}

function sampleText(text: string): { base: string; noise: boolean } {
	const m = text.match(TRAILING_NOISE_RE);
	if (m != null && m.index != null) {
		return { base: text.slice(0, m.index), noise: true };
	}
	return { base: text, noise: false };
}

function domainOf(key: string): string {
	return key.split('/')[0];
}

const contactKindLabels: Record<string, string> = {
	dm: t.dmLabel,
	mention: t.mentionLabel,
	reply: t.replyLabel,
};

function contactKindLabel(kind: string | null): string {
	if (kind == null) return '';
	return contactKindLabels[kind] ?? kind;
}

function accountContactKindLabel(account: GroupAccount): string {
	return account.contactKinds.map(k => contactKindLabel(k)).filter(Boolean).join('/') || '—';
}

function accountLabel(account: GroupAccount): string {
	const label = account.topLabel != null ? scoreLabelText(account.topLabel) : null;
	const score = account.topScore != null ? `${Math.round(account.topScore * 100)}%` : null;
	return label != null && score != null ? `${label} ${score}` : '—';
}

function accountSignalsLabel(account: GroupAccount): string {
	const parts: string[] = [];
	if (account.signals.noAvatar) parts.push(t.signalNoAvatar);
	if (account.signals.namePattern !== '') parts.push(`${t.signalNamePattern} ${account.signals.namePattern}`);
	if (account.followingCount === 0) parts.push(t.signalFollow0);
	return parts.join('・') || '—';
}

const scoreLabelText = (label: string): string => {
	switch (label) {
		case 'spam': return t.spam;
		case 'scam': return t.scam;
		case 'abuse': return t.abuse;
		default: return t.normal;
	}
};

const visibilityLabels: Record<string, string> = {
	public: i18n.ts._visibility.public,
	home: i18n.ts._visibility.home,
	followers: i18n.ts._visibility.followers,
	specified: i18n.ts._visibility.specified,
};

function visibilityLabel(v: string): string {
	return visibilityLabels[v] ?? v;
}

function triggerLabel(trigger: string, item: QueueItem): string {
	switch (trigger) {
		case 'unsolicitedContact': return t.triggerUnsolicitedContact;
		case 'newAuthorLink': return item.links.length > 0 ? `${t.triggerNewAuthorLink} ${item.links[0]}` : t.triggerNewAuthorLink;
		case 'newLocalContact': return t.triggerNewLocalContact;
		case 'externalCheck': return t.triggerExternalCheck;
		default: return trigger;
	}
}

function scoreRows(item: QueueItem): Array<{ label: string; value: number; width: string }> {
	const scores = item.localScores;
	if (scores == null) return [];
	return [
		{ label: t.spam, value: Math.round((scores.spam ?? 0) * 100), width: `${Math.round((scores.spam ?? 0) * 100)}%` },
		{ label: t.scam, value: Math.round((scores.scam ?? 0) * 100), width: `${Math.round((scores.scam ?? 0) * 100)}%` },
		{ label: t.abuse, value: Math.round((scores.abuse ?? 0) * 100), width: `${Math.round((scores.abuse ?? 0) * 100)}%` },
		{ label: t.normal, value: Math.round((scores.normal ?? 0) * 100), width: `${Math.round((scores.normal ?? 0) * 100)}%` },
	];
}

function externalLabel(item: QueueItem): string {
	if (item.externalCategories.length > 0) {
		return i18n.tsx._aiModeration.externalApiCategories({ categories: item.externalCategories.join('、') });
	}
	if (item.noteVisibility === 'specified') return t.externalApiNotSentDm;
	return t.externalApiOff;
}

function externalTrialLabel(result: TrialResult): string {
	if (result.externalCategories.length > 0) {
		return i18n.tsx._aiModeration.externalApiCategories({ categories: result.externalCategories.join('、') });
	}
	return t.externalApiOff;
}

function trialFlaggedText(result: TrialResult): string {
	if (result.scores != null) {
		return i18n.tsx._aiModeration.trialFlagged({
			score: Math.round((result.scores.spam + result.scores.scam) * 100),
			threshold: Math.round((meta.value?.aiModerationLocalThreshold ?? 0) * 100),
		});
	}
	return t.trialFlaggedPlain;
}

// 操作
async function blockHost(group: Group): Promise<void> {
	if (group.key == null) return;
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._aiModeration.confirmBlockHost({ host: group.key }),
	});
	if (canceled) return;
	await misskeyApi('admin/update-meta', {
		blockedHosts: [...(meta.value?.blockedHosts ?? []), group.key],
	});
	meta.value = await misskeyApi('admin/meta');
	await reloadGroups();
	os.success();
}

async function silenceHost(group: Group): Promise<void> {
	if (group.key == null) return;
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._aiModeration.confirmSilenceHost({ host: group.key }),
	});
	if (canceled) return;
	await misskeyApi('admin/update-meta', {
		silencedHosts: [...(meta.value?.silencedHosts ?? []), group.key],
	});
	meta.value = await misskeyApi('admin/meta');
	await reloadGroups();
	os.success();
}

async function addProhibitedWord(group: Group): Promise<void> {
	if (group.key == null) return;
	const domain = domainOf(group.key);
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.tsx._aiModeration.confirmAddProhibitedWord({ word: domain }),
	});
	if (canceled) return;
	await misskeyApi('admin/update-meta', {
		prohibitedWords: [...(meta.value?.prohibitedWords ?? []), domain],
	});
	meta.value = await misskeyApi('admin/meta');
	os.success();
}

async function collectGroupUserIds(group: Group): Promise<string[]> {
	const ids: string[] = [];
	let offset = 0;
	while (ids.length < 200) {
		const accounts = await misskeyApi('admin/ai-moderation/group-accounts', {
			groupBy: currentGroupBy.value,
			key: group.key,
			resolved: resolvedParam.value,
			limit: 100,
			offset,
		});
		if (accounts.length === 0) break;
		for (const account of accounts) {
			if (account.user != null) ids.push(account.user.id);
		}
		if (accounts.length < 100) break;
		offset += 100;
	}
	return ids;
}

async function bulkSuspend(group: Group): Promise<void> {
	await withBulkGuard(async () => {
		const userIds = await collectGroupUserIds(group);
		if (userIds.length === 0) {
			await os.alert({ type: 'info', text: i18n.ts.none });
			return;
		}
		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.tsx._aiModeration.confirmSuspend({ target: groupName(group), count: userIds.length }),
		});
		if (canceled) return;
		const result = await misskeyApi('admin/ai-moderation/bulk-suspend', {
			userIds,
			expectedCount: userIds.length,
		});
		if (result.skipped.length > 0) {
			await os.alert({ type: 'warning', text: `${i18n.tsx._aiModeration.suspendedResult({ count: result.suspended.length })} / ${i18n.tsx._aiModeration.skippedResult({ count: result.skipped.length })}` });
		} else {
			os.success();
		}
		await Promise.all([reloadStatus(), reloadGroups()]);
	});
}

async function bulkResolve(group: Group): Promise<void> {
	await withBulkGuard(async () => {
		const { canceled } = await os.confirm({
			type: 'warning',
			text: i18n.tsx._aiModeration.confirmResolve({ target: groupName(group), count: group.flaggedCount }),
		});
		if (canceled) return;
		await misskeyApi('admin/ai-moderation/bulk-resolve', {
			groupBy: currentGroupBy.value,
			key: group.key,
			expectedCount: group.flaggedCount,
		});
		os.success();
		await Promise.all([reloadStatus(), reloadGroups()]);
	});
}

async function resolveItem(item: QueueItem): Promise<void> {
	const { canceled, result } = await os.inputText({
		type: 'text',
		title: t.moderationNoteLabel,
		default: item.moderationNote ?? '',
	});
	await misskeyApi('admin/ai-moderation/resolve', {
		queueId: item.id,
		moderationNote: canceled ? undefined : (result ?? ''),
	});
	queuePaginator.removeItem(item.id);
	os.success();
}

async function editMemo(item: QueueItem): Promise<void> {
	const { canceled, result } = await os.inputText({
		type: 'text',
		title: i18n.ts.moderationNote,
		default: item.moderationNote ?? '',
	});
	if (canceled) return;
	await saveMemo(item, result ?? '');
}

const gpuWorkerStateLabels: Record<string, string> = {
	idle: t.gpuStateIdle,
	unloaded: t.gpuStateUnloaded,
	running: t.gpuStateRunning,
	loading: t.gpuStateLoading,
	yielded: t.gpuStateYielded,
	waitingGpu: t.gpuStateWaitingGpu,
	noGpu: t.gpuStateNoGpu,
	failed: t.gpuStateFailed,
	stopped: t.gpuStateStopped,
	unknown: t.gpuStateUnknown,
};

function gpuWorkerStateLabel(state: string): string {
	return gpuWorkerStateLabels[state] ?? state;
}

function gpuKindLabel(kind: string): string {
	return ({ judgeTrial: t.gpuKindTrial, spamJudge: t.gpuKindJudge, spamScan: t.gpuKindScan } as Record<string, string>)[kind] ?? kind;
}

function reloadAll(): void {
	void reloadStatus();
	if (mode.value !== 'individual') {
		void reloadGroups();
	} else {
		queuePaginator.reload();
	}
}

const spamSignalLabels: Record<string, string> = {
	strangerContact: t.signalStrangerContact,
	manyStrangers: t.signalManyStrangers,
	sameTextOtherAccounts: t.signalSameTextOtherAccounts,
	repeatedText: t.signalRepeatedText,
	sameLinkOtherAccounts: t.signalSameLinkOtherAccounts,
	hostWave: t.signalHostWave,
	noAvatar: t.signalNoAvatar,
	trailingNoise: t.signalTrailingNoise,
};

// backend の SPAM_SIGNAL_POINTS と同じ
const spamSignalPoints: Record<string, number> = {
	strangerContact: 2,
	manyStrangers: 2,
	sameTextOtherAccounts: 3,
	repeatedText: 2,
	sameLinkOtherAccounts: 1,
	hostWave: 1,
	noAvatar: 1,
	trailingNoise: 1,
};

function spamSignalLabel(signal: string): string {
	return spamSignalLabels[signal] ?? signal;
}

function signalPoints(item: QueueItem): number {
	return item.spamSignals.reduce((sum, signal) => sum + (spamSignalPoints[signal] ?? 0), 0);
}

function itemReasons(item: QueueItem): string {
	const parts = item.triggers.map(trigger => triggerLabel(trigger, item));
	if (item.related.sameLinkAccounts > 0) parts.push(i18n.tsx._aiModeration.relatedSameLink({ count: item.related.sameLinkAccounts }));
	if (item.related.sameTextCount > 0) parts.push(i18n.tsx._aiModeration.relatedSameText({ count: item.related.sameTextCount }));
	parts.push(i18n.tsx._aiModeration.relatedUserFlagged({ flagged: item.related.userFlagged, judged: item.related.userJudged }));
	return parts.join('・');
}

async function saveMemo(item: QueueItem, moderationNote: string): Promise<void> {
	await misskeyApi('admin/ai-moderation/update', {
		queueId: item.id,
		moderationNote,
	});
	queuePaginator.updateItem(item.id, (x) => ({ ...x, moderationNote }));
	os.success();
}

function itemSuffix(item: QueueItem): string {
	const top = item.localScores != null ? Math.round((item.localScores.spam + item.localScores.scam) * 100) : null;
	return top != null ? i18n.tsx._aiModeration.itemSuffix({ score: top }) : '';
}

function scoreText(item: QueueItem): string {
	if (item.localScores == null) return '—';
	return scoreRows(item).map(row => `${row.label} ${row.value}%`).join(' ・ ');
}

function itemStateText(item: QueueItem): string {
	const parts: string[] = [];
	if (item.author?.isHidden) parts.push(i18n.ts._aiModeration.accountHidden);
	if (item.author?.isHostHidden) parts.push(i18n.ts._aiModeration.hostHidden);
	if (item.autoAction) parts.push(autoActionLabel(item.autoAction));
	return parts.join(' ・ ');
}

function groupCaption(group: Group): string {
	const parts: string[] = [];
	if (group.severity === 'strong') parts.push(i18n.ts._aiModeration.strong);
	else if (group.severity === 'partial') parts.push(i18n.ts._aiModeration.partial);
	if (mode.value === 'host' && group.instance != null) {
		if (group.instance.softwareName) parts.push(group.instance.softwareVersion ? `${group.instance.softwareName} ${group.instance.softwareVersion}` : group.instance.softwareName);
		if (group.instance.openRegistrations != null) parts.push(group.instance.openRegistrations ? i18n.ts._aiModeration.registrationOpen : i18n.ts._aiModeration.registrationClosed);
		if (group.instance.isHidden) parts.push(i18n.ts._aiModeration.hostHidden);
	}
	return parts.join(' ・ ');
}

async function deleteNote(item: QueueItem): Promise<void> {
	if (item.note == null) return;
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts.deleteConfirm,
	});
	if (canceled) return;
	await misskeyApi('notes/delete', { noteId: item.note.id });
	queuePaginator.updateItem(item.id, (x) => ({ ...x, note: null }));
	os.success();
}

async function suspendUser(item: QueueItem): Promise<void> {
	const { canceled } = await os.confirm({
		type: 'warning',
		text: i18n.ts.suspendConfirm,
	});
	if (canceled) return;
	await misskeyApi('admin/suspend-user', { userId: item.noteUserId });
	queuePaginator.updateItem(item.id, (x) => ({
		...x,
		noteUser: x.noteUser != null ? { ...x.noteUser, isSuspended: true } : x.noteUser,
		author: x.author != null ? { ...x.author, isSuspended: true } : x.author,
	}));
	os.success();
}

void reloadStatus();
if (mode.value !== 'individual') void reloadGroups();

definePage(() => ({
	title: i18n.ts._aiModeration.title,
	icon: 'ti ti-robot',
}));
</script>

<style lang="scss" module>
.sub {
	font-size: 0.9em;
	opacity: 0.7;
}

.cardLabel {
	font-size: 0.85em;
	opacity: 0.7;
}

.padded {
	padding: 16px;
}

.keyValues {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 200px), 1fr));
	gap: 12px;
}

.statusBar {
	display: flex;
	align-items: center;
	gap: 16px;
	padding: 12px 16px;
}

.statusItems {
	flex: 1;
	min-width: 0;
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
	gap: 12px 24px;
}

.toolbar {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px 24px;
}

.card {
	overflow: clip;
}

.cardHead {
	display: flex;
	align-items: center;
	gap: 12px;
	padding: 12px 16px;
	border-bottom: solid 0.5px var(--MI_THEME-divider);
}

.cardIcon {
	flex: none;
	font-size: 1.2em;
}

.cardTitle {
	flex: 1;
	min-width: 0;
}

.cardName {
	font-weight: bold;
	overflow-wrap: anywhere;
}

.cardBody {
	padding: 12px 16px;
}

.cardFoot {
	padding: 12px 16px;
	border-top: solid 0.5px var(--MI_THEME-divider);
}

.listTable {
	tbody tr {
		vertical-align: top;
	}
}

.num {
	text-align: right !important;
	font-variant-numeric: tabular-nums;
}

.selectable {
	cursor: pointer;

	&:hover {
		background: var(--MI_THEME-buttonBg);
	}
}

.selected {
	background: var(--MI_THEME-accentedBg);

	&:hover {
		background: var(--MI_THEME-accentedBg);
	}
}

.nameCell {
	white-space: normal;
	overflow-wrap: anywhere;
	min-width: 140px;
}

.rowName {
	text-align: left;
	font-weight: bold;
}

.detailGrid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
	gap: 12px 24px;
}

.acctCell {
	width: 160px;
	min-width: 160px;
	white-space: normal;
	overflow-wrap: anywhere;
}

.stateText {
	font-size: 0.85em;
	color: var(--MI_THEME-warn);
}

.textCell {
	min-width: 200px;
	white-space: normal;
	overflow-wrap: anywhere;
}

.clamp {
	display: -webkit-box;
	-webkit-box-orient: vertical;
	-webkit-line-clamp: 3;
	overflow: hidden;
}

.scoreCell {
	white-space: nowrap;
}

.signalCell {
	min-width: 100px;
	max-width: 150px;
	white-space: normal;
}

.actionRow {
	display: flex;
	gap: 2px;
	margin-top: 4px;
	margin-left: -6px;
}

.iconButton {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 30px;
	height: 30px;
	border-radius: 6px;

	&:hover {
		background: var(--MI_THEME-buttonHoverBg);
	}
}

.danger {
	color: var(--MI_THEME-error);
}

.memo {
	font-size: 0.9em;
	opacity: 0.8;
	white-space: pre-wrap;
}

.list {
	margin: 0;
	padding-left: 1.2em;
}

.noteText {
	white-space: pre-wrap;
	overflow-wrap: anywhere;
}

.tableScroll {
	overflow-x: auto;
}

.table {
	width: 100%;
	border-collapse: collapse;
	font-size: 0.9em;
	white-space: nowrap;

	th, td {
		padding: 8px 12px;
		text-align: left;
	}

	th {
		font-weight: normal;
		opacity: 0.7;
	}

	tbody tr {
		border-top: solid 0.5px var(--MI_THEME-divider);
	}
}

.more {
	padding: 8px 12px;
	border-top: solid 0.5px var(--MI_THEME-divider);
}

.srOnly {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
	white-space: nowrap;
}

.empty {
	padding: 16px;
	text-align: center;
	opacity: 0.7;
}

.settingsGrid {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
	gap: 32px;
	align-items: start;
}

.formFooter {
	position: sticky;
	bottom: 0;
}

.inputs {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(min(100%, 160px), 1fr));
	gap: 12px;
}

.visibilities {
	margin: 0;
	padding: 0;
	border: none;

	> legend {
		padding: 0 0 8px;
		font-size: 0.85em;
	}
}

.visibilityItems {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 16px;
}

.visibilityItem {
	display: inline-flex;
	align-items: center;
	gap: 6px;
}

.visibilityWarning {
	font-size: 0.85em;
	color: var(--MI_THEME-warn);
}

</style>
