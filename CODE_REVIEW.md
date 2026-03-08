# Code Review: `n8n-nodes-google-maps-agentic` v0.5.6

**Reviewer:** GitHub Copilot  
**Date:** March 8, 2026  
**Files Reviewed:** `GoogleMaps.node.ts`, `GoogleMapsApi.credentials.ts`, `package.json`, `README.md`

---

## Overall Rating: 7.5 / 10

A feature-rich, well-structured node with a clear purpose. It stands out among community nodes for its AI-agent readiness, cost-control field masks, and built-in retry logic. Several important issues around security, edge-case handling, and default values need to be addressed before this can be considered fully production-hardened.

---

## Scorecard

| Category               | Score | Notes                                              |
|------------------------|-------|----------------------------------------------------|
| Feature Coverage       | 9/10  | 8 operations, pagination, email scraping, reviews  |
| AI Agent Integration   | 9/10  | `usableAsTool: true`, descriptive op names         |
| Code Quality           | 7/10  | Clean and DRY, but some fragile patterns           |
| Error Handling         | 7/10  | Retry logic present, but edge cases missed         |
| Security               | 5/10  | API key leaked in URL, SSRF risk in email scraper  |
| Documentation          | 8/10  | README is excellent; inline descriptions are solid |
| Testing                | 0/10  | No test files whatsoever                           |

---

## Strengths

### 1. AI-Agent First Design
Setting `usableAsTool: true` makes this node a native tool for n8n AI Agent workflows. The numbered operation names (`1. Text Search (Paginated)`, `2. Get Place Details`) and agent-friendly error messages using `agent_error` keys are a smart UX choice that helps LLMs self-correct without crashing the workflow.

### 2. Cost-Controlled Field Masks
The `getFieldMask()` helper is a well-thought-out approach to API cost control. Splitting into `basic`, `contact`, and `full` tiers maps directly to Google's SKU tiers, giving users predictable billing behavior.

### 3. Exponential Backoff Retry
The `httpRequestWithRetry` wrapper handles 429 and 5xx responses with classic `1s → 2s → 4s` backoff. This removes a major reliability pain point in high-volume production workflows.

### 4. DRY Place Transformer
`transformPlaceResults()` is a solid abstraction. Normalizing raw Places API responses into flat, consistent JSON shapes means downstream workflow nodes always receive the same schema regardless of the operation used.

### 5. Text Search Pagination
Looping on `nextPageToken` up to the user's `maxResults` cap is the correct approach. Capping the slice at `maxResults` prevents accidental over-fetching. The `pageSize = Math.min(maxResults, 20)` guard respects the API's per-page limit.

### 6. Memory Safety in Email Scraping
Truncating website HTML to 150,000 characters before running regex (`const safeHtml = html.slice(0, 150000)`) is a practical defense against catastrophic regex backtracking on huge pages. The 200ms sleep between requests (`await new Promise(resolve => setTimeout(resolve, 200))`) is a sensible rate-limit courtesy.

---

## Issues & Recommendations

### 🔴 Critical — Security

#### 1. API Key Exposed in URL (`get_photo` operation)
**File:** `GoogleMaps.node.ts` — `get_photo` block  
**Severity:** High

The photo URL is constructed with the API key as a query parameter:
```typescript
// CURRENT — API key visible in logs, browser history, n8n execution logs
const photoUrl = `https://places.googleapis.com/v1/${photoReference}/media?key=${apiKey}&maxWidthPx=${photoMaxWidth}&skipHttpRedirect=true`;
```
The New Places API supports header-based authentication. Use that instead:
```typescript
// RECOMMENDED — API key stays in the header, never in the URL
const options = {
    method: 'GET' as IHttpRequestMethods,
    url: `https://places.googleapis.com/v1/${photoReference}/media?maxWidthPx=${photoMaxWidth}&skipHttpRedirect=true`,
    headers: { 'X-Goog-Api-Key': apiKey },
    json: true,
    ignoreHttpStatusErrors: true,
};
```

#### 2. Server-Side Request Forgery (SSRF) in Email Scraper
**File:** `GoogleMaps.node.ts` — `extractEmailsAndSocials()`  
**Severity:** Medium

The function takes a `websiteUrl` from the Google API response and makes an outbound HTTP request without any URL validation. While the source is Google's dataset (relatively trusted), a misconfigured or compromised API response could redirect the n8n server to internal network addresses.

```typescript
// Add a URL allowlist check before the request
const isAllowedUrl = (url: string): boolean => {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' || parsed.protocol === 'http:';
        // Optionally block private IP ranges: 127.x, 10.x, 192.168.x, 172.16-31.x
    } catch {
        return false;
    }
};
```
At minimum, block requests to `localhost`, `127.0.0.1`, and RFC-1918 private ranges.

---

### 🟡 Important — Bugs & Incorrect Behavior

#### 3. `httpRequestWithRetry` — Retry Logic Does Not Actually Retry
**File:** `GoogleMaps.node.ts` — `httpRequestWithRetry()`  
**Severity:** Medium

The retry guard checks `if (response.error)` but when `ignoreHttpStatusErrors: true` is set and the HTTP library receives a 429 or 503, the response body is the raw Google error JSON object (e.g., `{ error: { code: 429, ... } }`), not a thrown exception. The check works incidentally, but the logic is fragile and undocumented. More importantly, the condition:
```typescript
if ((code === 429 || code >= 500) && attempt < maxRetries) {
    ...
    continue;
}
return response; // Non-retryable error, return as-is  ← BUG: reaches here on retryable errors
```
The `return response` on the non-retryable path will also be hit when `attempt === maxRetries` for retryable errors, which is correct — but the comment says "Non-retryable error" which is wrong and confusing. The structural logic should be:
```typescript
if (response?.error) {
    const code = response.error.code;
    if ((code === 429 || code >= 500) && attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * Math.pow(2, attempt)));
        continue;
    }
    return response; // Either non-retryable, or exhausted retries
}
return response; // Success
```

#### 4. `search_nearby` Silently Ignores `maxResults > 20`
**File:** `GoogleMaps.node.ts` — `search_nearby` block  
**Severity:** Low-Medium

The Nearby Search API does not support page tokens, so results are hard-capped at 20. However, the node silently truncates without informing the user:
```typescript
maxResultCount: Math.min(maxResults, 20),
```
Since the same `maxResults` parameter is shared with `text_search` (which supports 60), a user who sets `maxResults = 60` on a Nearby Search will receive at most 20 results with no warning. The description field should be updated to reflect this, or a separate parameter used.

#### 5. `reviewMinRating` / `reviewMaxRating` — No Input Validation
**File:** `GoogleMaps.node.ts` — `transformPlaceResults()`  
**Severity:** Low

There are no min/max constraints on these fields. A user who enters 0 or 6 will pass silently through the filter and get unexpected results. Add `typeOptions: { minValue: 1, maxValue: 5 }` to both parameter definitions.

---

### 🟠 Design & Quality Improvements

#### 6. `dataFields` Defaults to `'full'` (Most Expensive Tier)
**File:** `GoogleMaps.node.ts` — `dataFields` property definition  
**Severity:** Medium (billing impact)

```typescript
default: 'full',  // ← This triggers the highest-cost SKU on every request
```
New users who run a Text Search without changing this setting will unknowingly issue the most expensive API calls (fetching reviews, photos, and opening hours for every result). Defaulting to `'contact'` (Basic + phone + website) is a much safer starting point and still covers the most common B2B lead-gen use case.

#### 7. `package.json` Description — Misleading Claim
**File:** `package.json`  
```json
"description": "...mass email scraping without rate limits."
```
The node does have rate limits — it implements exponential backoff *because* of them. This phrasing could set false user expectations, cause support issues, and potentially violate npm package description guidelines. Change to something like: *"with built-in rate-limit handling and exponential backoff."*

#### 8. `get_place_details` Returns a Flat Object, Others Return Wrapped Objects
**File:** `GoogleMaps.node.ts` — `get_place_details` block  
**Consistency issue**

```typescript
// get_place_details — returns flat { name, address, ... }
returnData.push({ json: mapped[0] });

// text_search — returns wrapped { total_results, results: [...] }
returnData.push({ json: { total_results: ..., results: [...] } });
```
This inconsistency makes it harder to build generic downstream workflow steps that handle output from multiple operations. Consider wrapping single-result operations in a consistent envelope too.

#### 9. No Tests
There are zero test files in the repository. Community nodes are run inside a live n8n instance with real API credentials, making them particularly hard to debug when they fail silently. Adding at least unit tests for:
- `getFieldMask()` output for all three tiers
- `transformPlaceResults()` with mock data
- `extractEmailsAndSocials()` with fixture HTML

...would dramatically improve maintainability.

---

## Summary of Key Changes Needed

| Priority | Action                                                                 |
|----------|------------------------------------------------------------------------|
| 🔴 High   | Move `get_photo` API key from URL to `X-Goog-Api-Key` header           |
| 🔴 High   | Add SSRF protection (block private IPs) in `extractEmailsAndSocials`   |
| 🟡 Medium | Fix misleading comment in `httpRequestWithRetry`                        |
| 🟡 Medium | Change `dataFields` default from `'full'` to `'contact'`               |
| 🟡 Medium | Fix `package.json` description ("without rate limits")                  |
| 🟡 Medium | Document the 20-result cap for `search_nearby` in the parameter UI      |
| 🟠 Low    | Add `typeOptions: { minValue: 1, maxValue: 5 }` to review rating fields |
| 🟠 Low    | Standardize output envelope shape across all operations                |
| 🟠 Low    | Add unit tests for pure helper functions                               |

---

## Final Verdict

This is one of the more thoughtful Google Maps community nodes available for n8n. The AI-agent integration, retry logic, field masks, and email scraping feature add genuine value over simpler alternatives. The README is clear and well-structured.

The critical issue is the **API key leaking into the photo URL**, which must be fixed before recommending this node to teams in a security-conscious environment. The **SSRF risk** in the email scraper is a secondary concern but worth addressing. Once those two issues are resolved and the default `dataFields` is changed to avoid surprise billing, this node would confidently earn an **8.5/10**.
