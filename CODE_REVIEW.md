# Code Review — `n8n-nodes-google-maps-agentic`

**Scope:** Full diff from initial commit (`af44b19`) → `HEAD` (`557973f` / v0.5.10)  
**Date:** 2026-03-08  
**Reviewer:** GitHub Copilot

---

## Verdict: ⚠️ REQUEST CHANGES

| Field | Value |
|-------|-------|
| **Verdict** | REQUEST CHANGES |
| **Confidence** | HIGH |
| **Overall Score** | **7.2 / 10** |

---

### Summary

This package implements a production-grade Google Maps / Places API n8n community node with text search (paginated), nearby search, place details, geocoding, and reverse-geocoding operations. The code is well-organized and the recent versions introduced good security patches (SSRF mitigation, API key leak fix by removing `get_photo`). However, the SSRF protection is **incomplete** — it misses the `169.254.x.x` link-local range that hosts cloud-provider metadata endpoints (AWS/GCP/Azure), which is a known critical SSRF target.

---

### Findings

| Priority | Issue | Location |
|----------|-------|----------|
| P1 | SSRF bypass: `169.254.x.x` link-local range not blocked — exposes cloud metadata endpoints | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L46-L55) |
| P1 | SSRF bypass: DNS rebinding not mitigated — hostname check is pre-resolution only | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L42-L70) |
| P2 | `placeId` interpolated into URL without encoding — path injection risk | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L536) |
| P2 | `reviewMinRating > reviewMaxRating` not validated — silently returns zero reviews | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L150-L158) |
| P2 | `maxResults` silently capped at 20 for `search_nearby` with no pagination loop | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L494) |
| P2 | `console.warn` used for SSRF block log instead of proper n8n logging | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L52) |
| P3 | Pervasive `any` types degrade type safety across all operations | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts) |
| P3 | `httpRequestWithRetry` has no explicit return type annotation | [GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L13) |

---

### Details

---

#### [P1] SSRF bypass — `169.254.x.x` link-local range not blocked

**File:** [nodes/GoogleMaps/GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L46-L55)

The SSRF guard added in v0.5.9 correctly blocks `localhost`, `127.0.0.1`, `::1`, and the three RFC 1918 private ranges. However, it **does not block the link-local range `169.254.0.0/16`**. This is the range that hosts:

- **AWS EC2 Instance Metadata Service:** `http://169.254.169.254/latest/meta-data/`
- **GCP Metadata Server:** `http://169.254.169.254/computeMetadata/v1/`
- **Azure IMDS:** `http://169.254.169.254/metadata/`

If any Google Maps listing contains a `websiteUri` pointing to `http://169.254.169.254/...`, the `extractEmailsAndSocials` function will happily fetch it — potentially exfiltrating cloud credentials, access tokens, or service account keys depending on the cloud environment where n8n is running. This is one of the most commonly exploited SSRF targets.

**Current code:**
```typescript
const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
const isPrivateIP = /^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\./.test(host);
```

**Suggested fix:**
```typescript
const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
const isPrivateIP = /^10\.|^172\.(1[6-9]|2[0-9]|3[0-1])\.|^192\.168\.|^169\.254\./.test(host);
const isMetadata = host === 'metadata.google.internal'; // GCP metadata by hostname
```

---

#### [P1] SSRF bypass — DNS rebinding not mitigated

**File:** [nodes/GoogleMaps/GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L42-L70)

The current SSRF check evaluates `urlObj.hostname` — the string representation of the host **as written in the URL**, before any DNS resolution occurs. An attacker controlling a Google Maps listing can set `websiteUri` to a domain they own (e.g., `http://evil.attacker.com/`) that **at the time of the request resolves to `169.254.169.254`** or another private address (DNS rebinding / TTL=0 attack). The string-based filter passes, and the HTTP client then connects to the private address.

This is harder to fully mitigate without async DNS pre-resolution (not available in this context), but a defence-in-depth approach is:

**Suggested fix:**
```typescript
// Add allowlist of accepted schemes and enforce non-IP hostnames for extra safety
const acceptedSchemes = ['http:', 'https:'];
if (!acceptedSchemes.includes(urlObj.protocol)) {
    console.warn(`Blocked non-HTTP scheme: ${urlObj.protocol}`);
    return { emails: [], social_links: [] };
}

// Reject bare numeric IPv4 addresses entirely
const isNumericIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
if (isNumericIPv4) {
    console.warn(`Blocked numeric IPv4 address: ${host}`);
    return { emails: [], social_links: [] };
}
```

Blocking *all* direct IP addresses (not just private ranges) eliminates the numeric-form SSRF vector entirely. Legitimate business websites use hostnames, not raw IP addresses.

---

#### [P2] `placeId` not encoded before URL interpolation

**File:** [nodes/GoogleMaps/GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L536)

```typescript
url: `https://places.googleapis.com/v1/places/${placeId}`,
```

`placeId` comes from raw user input. If it contains `/`, `?`, or `#` characters, the resulting URL path is malformed and could silently hit a different Google endpoint or expose unintended query parameters. While Google place IDs are constrained in practice, the code makes no assumption about input format.

**Suggested fix:**
```typescript
url: `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
```

---

#### [P2] No validation that `reviewMinRating <= reviewMaxRating`

**File:** [nodes/GoogleMaps/GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L150-L158)

If a user sets `reviewMinRating = 5` and `reviewMaxRating = 1`, the filter:
```typescript
reviews = reviews.filter((review: any) => {
    const r = review.rating || 0;
    return r >= reviewMinRating && r <= reviewMaxRating; // always false when min > max
});
```
...returns an empty `reviews` array with no error or warning. The user gets silently broken results.

**Suggested fix:**
```typescript
if (reviewMinRating > reviewMaxRating) {
    throw new NodeOperationError(
        context.getNode(),
        `reviewMinRating (${reviewMinRating}) cannot be greater than reviewMaxRating (${reviewMaxRating}).`,
        { itemIndex: nodeItemIndex }
    );
}
```

Note: `context.getNode()` is available because `context: IExecuteFunctions` is in scope.

---

#### [P2] `search_nearby` silently caps `maxResults` at 20 with no pagination

**File:** [nodes/GoogleMaps/GoogleMaps.node.ts](nodes/GoogleMaps/GoogleMaps.node.ts#L494)

`text_search` implements a full pagination loop and can fetch up to 60 results. `search_nearby` does not — it builds a single request with:
```typescript
maxResultCount: Math.min(maxResults, 20),
```

The `Max Results` field is shown in the UI for both `text_search` and `search_nearby`, but for nearby search, values above 20 are silently capped without feedback. The field description says "Text Search only" — but this is buried and the user sees the control anyway, expecting it to work.

**Suggested fix (minimal):** Either implement a pagination loop for `search_nearby` similar to `text_search`, or set `displayOptions` to only show `maxResults` for `operation: ['text_search']` and remove the false expectation entirely.

---

### Positive Highlights

- **`get_photo` removal (v0.5.7–5.8):** Correct call. The old implementation embedded the API key in the photo URL query string (`key=${apiKey}`) and then redirected the client. This exposed the key in server logs, browser history, and referrer headers. Removing it is the right security trade-off.
- **Field masks (cost control):** The `getFieldMask` helper and the change of `dataFields` default from `'full'` to `'basic'` (v0.5.9) are excellent API cost-management practices.
- **Exponential backoff:** The `httpRequestWithRetry` wrapper correctly handles Google's `429` and `5xx` responses with exponential delay. The logic is sound.
- **`typeOptions: { minValue: 1, maxValue: 5 }` (v0.5.10):** Good UI-level constraint on rating range fields.
- **Credential storage:** The credentials file correctly sets `typeOptions: { password: true }` for the API key so it is stored encrypted and masked in the n8n UI.

---

### Recommendation

1. **Fix the SSRF gap immediately** — add `169.254.x.x` to the private IP regex and block all numeric IPv4 addresses entirely. This is the highest-risk finding given n8n is commonly deployed on cloud VMs.
2. **Encode `placeId` in the URL** — one-line fix, eliminates path injection.
3. **Add `reviewMinRating` vs `reviewMaxRating` guard** — prevents silent data loss.
4. **Clarify or implement pagination for `search_nearby`** — document the 20-result cap or add the loop.
