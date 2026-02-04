import type { UiPort } from "../domain/ports/ui-port.ts";
import type { Notification } from "../shared/notification.ts";

export function renderNotifications(ui: UiPort, notifications: readonly Notification[]): void {
	for (const n of notifications) {
		ui[n.level](n.message);
	}
}
