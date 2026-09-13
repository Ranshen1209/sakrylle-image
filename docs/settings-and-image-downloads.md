# Settings and image result recovery (v0.12.3)

Production defaults are merged with the previous deployment snapshot on startup.
A profile that changes Base64 output, chat/completions streaming, Agent conversation
model, or other options is not pristine. Once a deployment snapshot exists, do not
replace the current profile wholesale on refresh. Preserve local settings unless
an explicitly deployed field changes or the deployment locks parameters.

Settings cards use backdrop filters, which create stacking contexts. When a Select
opens, lift its containing card and use an opaque tinted menu background. Retain
Select's scroll-boundary sizing and upward placement near the modal bottom.

Some providers return signed R2 image URLs without CORS headers. Successful image
creation does not imply that the browser can fetch the bytes. Prefer the existing
"Return Base64 image data" option when the provider supports it. That choice now
survives production-default initialization and refresh.

On download failure, retain original URLs and show a clearly labeled remote
preview with an original-image link. Remote previews do not mean the bytes are
stored in IndexedDB; signed URLs can expire. Retrying an error task with result
URLs downloads only those URLs and updates the same task on success. It must not
submit a new paid generation. Download failures are excluded from automatic
request retries and refill; successful images and failed result URLs are retained.
Provider-side CORS remains necessary to save URL bytes locally. No public proxy,
provider credentials, or Image API proxy-mode changes are introduced.

Regression checks cover production-default refresh, Base64 request serialization,
CORS errors, cancellation, bounded refill, download recovery and duplicate clicks.
Browser checks use a separate local origin and temporary fixtures without changing
production browser history or configuration. Temporary signed URLs are never
committed or shipped.

Local release validation: clean `npm ci`, 788 tests across 47 suites, production
build, and Docker runtime smoke check. Browser checks confirmed persisted options
survive refresh with the production default API injected, upward/downward menus
cover neighboring cards and remain selectable, and the reported R2 image loads
as a 1254×1254 remote preview. R2 returned image/png without
Access-Control-Allow-Origin. No new paid image generation was used for these checks.
