export type NotificationLevel = "info" | "warn";

export interface Notification {
	readonly level: NotificationLevel;
	readonly message: string;
}

export const Notification = {
	info: (message: string): Notification => ({ level: "info", message }),
	warn: (message: string): Notification => ({ level: "warn", message }),
} as const;
