/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

// taiyme 由来: 長押しによる contextmenu イベントの発行を防ぐ（長押し操作の中断対策）
export const preventLongPressContextMenu = (): void => {
	let touching = false;
	let touchCanceled = false;

	const onTouchStart = () => {
		touching = true;
		touchCanceled = false;
	};

	const onTouchMove = () => {
		touching = true;
		touchCanceled = false;
	};

	const onTouchEnd = () => {
		touching = false;
		touchCanceled = false;
	};

	const onTouchCancel = () => {
		touching = false;
		touchCanceled = true;
	};

	window.document.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
	window.document.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
	window.document.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
	window.document.addEventListener('touchcancel', onTouchCancel, { passive: true, capture: true });
	window.document.addEventListener('click', onTouchEnd, { passive: true, capture: true });
	window.document.addEventListener('contextmenu', (ev) => {
		if (touchCanceled || touching) {
			ev.preventDefault();
			ev.stopPropagation();
		}
		onTouchEnd();
	}, { passive: false, capture: true });
};
