/** Cookie names, here so the middleware can read them without loading server-only modules. */
export const SESSION_COOKIE = "rayz_session";
export const SHOP_COOKIE = "rayz_shop";
/** A browser's trusted-device secret, signed. Approved rows in trusted_devices say which shops it counts for. */
export const TRUSTED_DEVICE_COOKIE = "rayz_trusted_device";
/** Short-lived proof that a sign-in was just blocked, so this browser may ask for device approval. */
export const DEVICE_REQUEST_COOKIE = "rayz_device_request";
