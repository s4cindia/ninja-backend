# CloudFront CORS Configuration Guide

## Problem

Frontend CloudFront domain (`https://dhi5xqbewozlg.cloudfront.net`) cannot access backend API (`https://d1ruc3qmc844x9.cloudfront.net`) due to CORS policy errors:

```text
Access to XMLHttpRequest at 'https://d1ruc3qmc844x9.cloudfront.net/api/v1/jobs/...'
from origin 'https://dhi5xqbewozlg.cloudfront.net' has been blocked by CORS policy:
Response to preflight request doesn't pass access control check:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## Root Cause

CloudFront is not configured to pass through CORS headers from the backend Express server to the browser. Even though the backend sends proper CORS headers, CloudFront strips them unless explicitly configured.

## Solution

### Step 1: Configure Response Headers Policy

**Current Configuration:**
- ⚠️ **Origin request policy:** `AllViewer` (works but inefficient - forwards all headers)
- ✅ **Cache policy:** `CachingDisabled` (acceptable for now)
- ❌ **Response headers policy:** Not set (THIS IS THE PROBLEM)

**What to Change:**

1. Go to: **CloudFront** → **Distributions** → **ERLCMRRAZVMQV** (backend)
2. Click **Behaviors** tab → Select default behavior → Click **Edit**

3. **Response headers policy** (REQUIRED):
   - Click the dropdown and select **`SimpleCORS`** (AWS managed policy)

4. **Origin request policy** (RECOMMENDED):
   - Change from `AllViewer` to **`CORS-CustomOrigin`**
   - Why: More efficient, only forwards CORS-required headers (`Origin`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`)
   - Lower cost and better performance

   **OR** create a custom policy with these settings:
   - Name: `NinjaCORS`
   - CORS headers:
     - ✅ Access-Control-Allow-Origin: `*` (or specify frontend domain)
     - ✅ Access-Control-Allow-Methods: `GET, POST, PUT, PATCH, DELETE, OPTIONS`
     - ✅ Access-Control-Allow-Headers: `Content-Type, Authorization, Accept, Origin, X-Requested-With`
     - ✅ Access-Control-Allow-Credentials: `true`
     - ✅ Access-Control-Max-Age: `86400` (24 hours)

5. Click **Save changes**

### Step 2: Invalidate CloudFront Cache

After making changes, invalidate the cache to apply immediately:

```bash
aws cloudfront create-invalidation \
  --distribution-id ERLCMRRAZVMQV \
  --paths "/*"
```

### Step 3: Verify the Fix

1. Open browser DevTools → Network tab
2. Reload the frontend page
3. Look for the API request
4. Check Response Headers - you should now see:
   ```text
   Access-Control-Allow-Origin: https://dhi5xqbewozlg.cloudfront.net
   Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
   Access-Control-Allow-Headers: Content-Type, Authorization, ...
   Access-Control-Allow-Credentials: true
   ```

## Advanced Configuration (Production)

For production, consider upgrading the cache policy to improve performance while maintaining CORS support:

### Option A: Use Managed Cache Policy

Change **Cache policy** from `CachingDisabled` to:
- **`Managed-CachingOptimized`** - Good general-purpose caching
- Configure **Cache key settings** → Include **Origin** header

### Option B: Create Custom Cache Policy

1. Go to **CloudFront** → **Policies** → **Cache** → **Create policy**
2. Name: `NinjaAPICaching`
3. **TTL settings:**
   - Minimum: `0`
   - Maximum: `86400` (24 hours)
   - Default: `300` (5 minutes)
4. **Cache key settings:**
   - ✅ Include query strings: `All`
   - ✅ Include headers: `Origin`, `Authorization`, `Accept`
   - ✅ Include cookies: `All` (if using cookie-based auth)
5. Save and apply to behavior

## Why This Happens

1. **Backend sends CORS headers:** The Express server (`src/index.ts`) is configured to send proper CORS headers
2. **CloudFront strips headers by default:** CloudFront doesn't forward response headers unless explicitly configured
3. **Browser blocks request:** Without `Access-Control-Allow-Origin` header, the browser rejects the response

## Configuration Summary

| Setting | Current Value | Recommended Value |
|---------|---------------|-------------------|
| Origin request policy | `AllViewer` ⚠️ | **`CORS-CustomOrigin`** ✅ |
| Cache policy | `CachingDisabled` ⚠️ | `CachingDisabled` (dev) or `Managed-CachingOptimized` (prod) |
| Response headers policy | **Not set** ❌ | **`SimpleCORS`** ✅ |

## Why CORS-CustomOrigin vs AllViewer?

| Policy | What It Forwards | Use Case | Efficiency |
|--------|-----------------|----------|------------|
| **AllViewer** | ALL headers, cookies, query strings | Testing, debugging | ❌ Low - forwards everything |
| **CORS-CustomOrigin** | Only CORS headers (`Origin`, `Access-Control-Request-*`) + query strings | Production APIs with CORS | ✅ High - minimal forwarding |
| **CORS-S3Origin** | Same as CORS-CustomOrigin but for S3 | S3 static sites | ✅ High |

**Recommendation:** Use `CORS-CustomOrigin` for the Ninja backend API. It's the AWS best practice for REST APIs that need CORS support.

## Troubleshooting

### After applying changes, CORS still fails

1. **Clear browser cache:** Hard refresh (Ctrl+Shift+R)
2. **Verify CloudFront invalidation completed:**
   ```bash
   aws cloudfront get-invalidation --distribution-id ERLCMRRAZVMQV --id <INVALIDATION_ID>
   ```
3. **Check backend logs:** Ensure backend is sending CORS headers
4. **Test with curl:**
   ```bash
   curl -X OPTIONS https://d1ruc3qmc844x9.cloudfront.net/api/v1/jobs/test \
     -H "Origin: https://dhi5xqbewozlg.cloudfront.net" \
     -H "Access-Control-Request-Method: GET" \
     -v
   ```
   You should see `Access-Control-Allow-Origin` in the response headers.

### OPTIONS requests return 403/404

- Verify **Origin request policy** is set to `AllViewer` (forwards OPTIONS requests to backend)
- Check backend handles `OPTIONS` requests (Express CORS middleware should handle this automatically)

## Related Files

- **Backend CORS config:** `src/index.ts` (lines 19-52)
- **CORS origins env var:** `CORS_ORIGINS=https://dhi5xqbewozlg.cloudfront.net` (ECS task definition)
- **CloudFront distribution:** `ERLCMRRAZVMQV` (d1ruc3qmc844x9.cloudfront.net)

---

**Updated:** February 13, 2026
**Status:** Awaiting Response Headers Policy configuration
