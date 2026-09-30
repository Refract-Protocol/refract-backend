/**
 * Cache-Control for read-heavy, slow-changing GET endpoints (coverage-type
 * catalogs, pool stats). Express already attaches a weak ETag to every
 * `res.json()` body and answers a matching `If-None-Match` with 304, so
 * this only adds the freshness window: clients and shared caches may reuse
 * a response for 60s, then revalidate against the ETag.
 *
 * Never apply this to caller-specific or rapidly-changing responses
 * (holder lookups, quotes).
 */
export const STATIC_RESOURCE_CACHE_CONTROL = "public, max-age=60";
