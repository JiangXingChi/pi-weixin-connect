/** English notice codes for pi-weixin-connect: every warning/error carries a stable [CODE] prefix. */
export const CODE = {
	CONFIG: "WX_E_CONFIG",
	NOT_LOGGED_IN: "WX_E_NOT_LOGGED_IN",
	SERVICE_STALE: "WX_E_SERVICE_STALE",
	SERVICE_START_FAILED: "WX_E_SERVICE_START_FAILED",
	LOCK_HELD: "WX_E_LOCK_HELD",
	LOCK_TAKEN: "WX_E_LOCK_TAKEN",
	LOGIN_EXPIRED: "WX_E_LOGIN_EXPIRED",
	START_FAILED: "WX_E_START_FAILED",
	QR_BUSY: "WX_E_QR_BUSY",
	STOP_OLD_FAILED: "WX_E_STOP_OLD_FAILED",
	LOGIN_NO_USERID: "WX_E_LOGIN_NO_USERID",
	GATEWAY_NOT_STARTED: "WX_E_GATEWAY_NOT_STARTED",
	LOGIN_FAILED: "WX_E_LOGIN_FAILED",
	STOP_FAILED: "WX_E_STOP_FAILED",
	LOGOUT_BLOCKED: "WX_E_LOGOUT_BLOCKED",
	REPLY_FAILED: "WX_E_REPLY_FAILED",
	BRIDGE_PAUSED: "WX_E_BRIDGE_PAUSED",
	WINDOW_EXPIRED: "WX_E_WINDOW_EXPIRED",
	NEW_SESSION_FAILED: "WX_E_NEW_SESSION_FAILED",
	TUI_ONLY: "WX_E_TUI_ONLY",
};

/** `[CODE] text: detail` — detail is optional. */
export function err(code, text, detail) {
	const body = detail === undefined || detail === null || detail === "" ? text : `${text}: ${detail}`;
	return `[${code}] ${body}`;
}
