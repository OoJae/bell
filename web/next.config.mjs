/**
 * The front end imports the keeper's own modules from `../src` rather than
 * keeping a second copy of the rules, so one set of sources runs in both
 * places. Those sources use explicit `.ts` specifiers because Node requires
 * them; Turbopack resolves them natively.
 */
const nextConfig = {
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  turbopack: {},
  // Next 16 blocks cross-origin dev resources by default. Browsing 127.0.0.1
  // while the server treats localhost as its origin silently blocks the client
  // bundle, so the page server-renders and never hydrates — no error, just a
  // permanent "loading". Listing both spellings avoids that trap.
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
}
export default nextConfig
