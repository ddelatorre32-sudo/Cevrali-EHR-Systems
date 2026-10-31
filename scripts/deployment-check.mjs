#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const maximumBodyBytes = 64 * 1024;
const maximumRedirects = 3;
const defaultTimeoutMs = 5000;
const note = 'These unauthenticated network checks do not verify clinical safety, agreements, backups, storage encryption, approval evidence, or compliance. They do not enable patient use.';
const check = (id, passed, detail) => ({ id, status: passed ? 'passed' : 'blocked', detail });

function websiteOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Invalid website origin');
  return url.origin;
}
function hsts(headers) {
  const values = (headers.get('strict-transport-security') || '').split(';').map(value => value.trim());
  const age = values.find(value => /^max-age\s*=/i.test(value));
  return Boolean(age && /^max-age\s*=\s*\d+$/i.test(age) && Number(age.split('=')[1]) >= 31536000);
}
function csp(headers) {
  const directives = new Map();
  for (const raw of (headers.get('content-security-policy') || '').split(';')) {
    const [name, ...values] = raw.trim().split(/\s+/);
    if (name && !directives.has(name.toLowerCase())) directives.set(name.toLowerCase(), values);
  }
  const single = (name, allowed) => {
    const values = directives.get(name);
    return Boolean(values?.length === 1 && allowed.includes(values[0]));
  };
  const script = directives.get('script-src') || directives.get('default-src') || [];
  const safeScript = value => ["'self'", "'none'", "'strict-dynamic'", "'report-sample'"].includes(value) ||
    /^'(?:nonce-[A-Za-z0-9+/_=-]+|sha(?:256|384|512)-[A-Za-z0-9+/=_-]+)'$/.test(value);
  return single('default-src', ["'self'", "'none'"]) &&
    script.length > 0 && script.every(safeScript) && single('object-src', ["'none'"]) &&
    single('base-uri', ["'self'", "'none'"]) && single('frame-ancestors', ["'none'"]);
}
async function discard(response) {
  try { await response.body?.cancel(); } catch { /* Do not inspect or print response bodies. */ }
}
async function boundedBody(response) {
  const rawLength = response.headers.get('content-length');
  if (rawLength && (!/^\d+$/.test(rawLength) || Number(rawLength) > maximumBodyBytes)) {
    await discard(response); throw new Error('Response size rejected');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maximumBodyBytes) throw new Error('Response size rejected');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, bytes).toString('utf8');
  } finally {
    try { await reader.cancel(); } catch { /* Cleanup never copies server text. */ }
    reader.releaseLock();
  }
}
async function inspect(origin, path, fetcher, timeoutMs, includeBody) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error('Request deadline exceeded')); }, timeoutMs);
  });
  const request = async () => {
    let url = new URL(path, origin);
    for (let redirects = 0; redirects <= maximumRedirects; redirects++) {
      const response = await fetcher(url.href, {
        method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store',
        referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: { Accept: includeBody === 'json' ? 'application/json' : includeBody === 'html' ? 'text/html' : '*/*' },
      });
      if (response.url && new URL(response.url).origin !== origin) {
        await discard(response); throw new Error('Unexpected response origin');
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await discard(response);
        if (!location || redirects === maximumRedirects) throw new Error('Redirect rejected');
        const target = new URL(location, url);
        if (target.origin !== origin || target.protocol !== 'https:' || target.username || target.password)
          throw new Error('Redirect rejected');
        url = target;
        continue;
      }
      // The private endpoint's body is never read, even if access control fails.
      const body = includeBody ? await boundedBody(response) : (await discard(response), undefined);
      return { status: response.status, headers: response.headers, body };
    }
    throw new Error('Redirect rejected');
  };
  try { return await Promise.race([request(), deadline]); }
  finally { clearTimeout(timer); controller.abort(); }
}
function json(response) {
  if (!response || response.status !== 200 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) return null;
  try {
    const value = JSON.parse(response.body);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

/** Read-only unauthenticated probes. Dependency injection is for deterministic tests;
 * the executable always uses the built-in fetch and normal TLS verification. */
export async function checkDeployment(value, options = {}) {
  const checks = [];
  let origin;
  try { origin = websiteOrigin(value); }
  catch {
    return { ok: false, checks: [check('website-origin', false, 'Supply an HTTPS website origin without credentials, a path, a query, or a fragment.')], note };
  }
  checks.push(check('website-origin', true, 'An HTTPS website origin was supplied.'));
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    checks.push(check('tls-verification', false, 'TLS certificate verification must remain enabled.'));
    return { ok: false, checks, note };
  }
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000)
    return { ok: false, checks: [...checks, check('request-timeout', false, 'The request timeout must be between 1 and 10000 milliseconds.')], note };
  const fetcher = options.fetcher || fetch;
  const paths = [['health', '/api/health', 'json'], ['runtime', '/api/runtime', 'json'], ['web', '/', 'html'], ['private', '/api/patients', false]];
  const results = await Promise.allSettled(paths.map(([, path, body]) => inspect(origin, path, fetcher, timeoutMs, body)));
  const responses = {};
  results.forEach((result, index) => {
    const [id] = paths[index];
    const passed = result.status === 'fulfilled';
    checks.push(check(`${id}-reachable`, passed,
      passed ? 'The bounded HTTPS request completed without leaving the website origin.' : 'The request failed TLS, connectivity, redirect, size, or timeout checks.'));
    if (passed) responses[id] = result.value;
  });
  const health = json(responses.health), runtime = json(responses.runtime);
  checks.push(check('health-status', health?.status === 'ok', 'The health endpoint must return a successful JSON health response.'));
  checks.push(check('production-runtime', health?.mode === 'production' && runtime?.mode === 'production', 'Health and runtime metadata must identify production mode.'));
  checks.push(check('clinical-release', health?.clinical_use_allowed === true && runtime?.clinical_use_allowed === true, 'Both endpoints must report an enabled clinical release.'));
  checks.push(check('protected-account-policy', runtime?.demo_enabled === false && runtime?.public_signup_enabled === false && runtime?.mfa_required === true,
    'Public demo accounts and signup must be disabled, and staff MFA must be required.'));
  checks.push(check('unauthenticated-patients', responses.private?.status === 401,
    'An unauthenticated patient-directory request must return HTTP 401. Its response body is never read.'));
  checks.push(check('web-html', responses.web?.status === 200 && /^text\/html(?:\s*;|$)/i.test(responses.web.headers.get('content-type') || '') && /<html(?:\s|>)/i.test(responses.web.body || ''),
    'The public web page must return HTML successfully.'));
  for (const [id] of paths) {
    const headers = responses[id]?.headers;
    checks.push(check(`${id}-transport-policy`, Boolean(headers && hsts(headers)), 'HTTPS responses must require HSTS with a max-age of at least one year.'));
    checks.push(check(`${id}-nosniff`, headers?.get('x-content-type-options')?.toLowerCase() === 'nosniff', 'Responses must prevent MIME-type sniffing.'));
    checks.push(check(`${id}-anti-framing`, headers?.get('x-frame-options')?.toUpperCase() === 'DENY', 'Responses must prohibit framing.'));
    if (id !== 'web') checks.push(check(`${id}-no-store`, /(?:^|,)\s*no-store(?:\s*(?:,|$))/i.test(headers?.get('cache-control') || ''), 'API responses must prohibit caching.'));
  }
  checks.push(check('web-csp', Boolean(responses.web && csp(responses.web.headers)), 'The web page must apply a restrictive script, object, base, and framing Content Security Policy.'));
  return { ok: checks.every(value => value.status === 'passed'), checks, note };
}

const usage = 'Usage: node scripts/deployment-check.mjs --url https://your-practice.example\nUses only unauthenticated GET requests with ordinary TLS verification. No credentials are sent. Response contents are never printed, and the private endpoint body is never read.\n';
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') process.stdout.write(usage);
  else if (args.length !== 2 || args[0] !== '--url') { process.stderr.write(usage); process.exitCode = 1; }
  else {
    try {
      const result = await checkDeployment(args[1]);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = result.ok ? 0 : 1;
    } catch {
      process.stderr.write('Deployment verification failed. Check the website origin and local TLS/network configuration. No server response contents were printed.\n');
      process.exitCode = 1;
    }
  }
}
