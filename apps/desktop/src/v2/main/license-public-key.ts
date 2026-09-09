/**
 * Public Ed25519 key used to verify beta entitlements in packaged builds.
 *
 * This is intentionally public material. The matching signing private key and
 * code pepper remain server-side and are never bundled with the desktop app.
 */
export const EMBEDDED_LICENSE_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAImlZ+vjkHW9ZTSDa7HQjzx2PNHFpA/7sIu/mFu/JNBU=
-----END PUBLIC KEY-----
`;
