import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

type Report = { ok: boolean; checks: { id: string; status: 'passed' | 'blocked'; detail: string }[]; note: string };
type Options = { fetcher?: (url: string, options: RequestInit) => Promise<Response>; timeoutMs?: number };
const { checkDeployment } = await import(pathToFileURL(resolve('scripts/deployment-check.mjs')).href) as {
  checkDeployment: (url: string, options?: Options) => Promise<Report>;
};
const origin = 'https://deployment.example.test';
const headers = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Cache-Control': 'no-store',
};
const csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";
function successfulResponse(path: string) {
  if (path === '/api/health') return Response.json({ status: 'ok', mode: 'production', clinical_use_allowed: true }, { headers });
  if (path === '/api/runtime') return Response.json({ mode: 'production', clinical_use_allowed: true, demo_enabled: false, public_signup_enabled: false, mfa_required: true }, { headers });
  if (path === '/api/patients') return Response.json({ error: 'Not signed in' }, { status: 401, headers });
  return new Response('<!doctype html><html><head></head><body>Application</body></html>', { headers: { ...headers, 'Content-Type': 'text/html', 'Content-Security-Policy': csp } });
}
const successfulFetch = async (url: string) => successfulResponse(new URL(url).pathname);
const blocked = (report: Report, id: string) => report.checks.find(value => value.id === id)?.status === 'blocked';

test('deployment check makes only unauthenticated bounded GET probes and accepts protected production metadata', async () => {
  const paths: string[] = [];
  const report = await checkDeployment(origin, { fetcher: async (url, options) => {
    paths.push(new URL(url).pathname);
    assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'manual'); assert.equal(options.cache, 'no-store');
    const requestHeaders = new Headers(options.headers);
    assert.equal(requestHeaders.has('authorization'), false); assert.equal(requestHeaders.has('cookie'), false);
    assert.ok(options.signal instanceof AbortSignal);
    return successfulResponse(new URL(url).pathname);
  } });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(paths.sort(), ['/', '/api/health', '/api/patients', '/api/runtime']);
  assert.equal(JSON.stringify(report).includes(origin), false);
});

test('invalid origins and disabled TLS fail before a network request without printing credentials', async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error('Must not request'); };
  for (const value of ['http://deployment.example.test', 'https://user:PRIVATE@example.test', `${origin}/path`, `${origin}?token=PRIVATE`, `${origin}/#PRIVATE`, 'PRIVATE']) {
    const report = await checkDeployment(value, { fetcher });
    assert.equal(report.ok, false); assert.equal(blocked(report, 'website-origin'), true);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
  const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  try {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    const report = await checkDeployment(origin, { fetcher });
    assert.equal(blocked(report, 'tls-verification'), true);
  } finally {
    if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
  }
  assert.equal(calls, 0);
});

test('a reachable demo or pilot does not pass clinical production checks', async () => {
  for (const mode of ['demo', 'pilot']) {
    const report = await checkDeployment(origin, { fetcher: async url => {
      const path = new URL(url).pathname;
      if (path === '/api/health') return Response.json({ status: 'ok', mode, clinical_use_allowed: false }, { headers });
      if (path === '/api/runtime') return Response.json({ mode, clinical_use_allowed: false, demo_enabled: mode === 'demo', public_signup_enabled: mode === 'demo', mfa_required: mode !== 'demo' }, { headers });
      return successfulResponse(path);
    } });
    assert.equal(report.ok, false); assert.equal(blocked(report, 'production-runtime'), true);
    assert.equal(blocked(report, 'clinical-release'), true);
  }
});

test('private endpoint bodies are canceled without reading even when access control incorrectly returns patient data', async () => {
  let canceled = false;
  const report = await checkDeployment(origin, { fetcher: async url => {
    const path = new URL(url).pathname;
    if (path !== '/api/patients') return successfulResponse(path);
    const response = new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 200, headers });
    response.text = async () => { throw new Error('Private body must not be read'); };
    response.json = async () => { throw new Error('Private body must not be parsed'); };
    return response;
  } });
  assert.equal(report.ok, false); assert.equal(blocked(report, 'unauthenticated-patients'), true);
  assert.equal(canceled, true);
});

test('cross-origin, insecure and credential redirects are rejected without contacting their targets', async () => {
  for (const location of ['https://untrusted.example/PRIVATE', 'http://deployment.example.test/PRIVATE', 'https://user:PRIVATE@deployment.example.test/']) {
    const requests: string[] = [];
    const report = await checkDeployment(origin, { fetcher: async url => {
      requests.push(url);
      return new Response('', { status: 302, headers: { Location: location } });
    } });
    assert.equal(report.ok, false);
    assert.equal(requests.length, 4);
    assert.equal(requests.every(url => new URL(url).origin === origin), true);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
    assert.equal(JSON.stringify(report).includes('untrusted'), false);
  }
});

test('same-origin redirects are bounded and successful same-origin redirects keep header checks', async () => {
  const report = await checkDeployment(origin, { fetcher: async url => {
    const path = new URL(url).pathname;
    if (path === '/') return new Response('', { status: 302, headers: { Location: '/app' } });
    return successfulResponse(path === '/app' ? '/' : path);
  } });
  assert.equal(report.ok, true);
  let requests = 0;
  const loop = await checkDeployment(origin, { fetcher: async () => {
    requests++; return new Response('', { status: 302, headers: { Location: '/loop' } });
  } });
  assert.equal(loop.ok, false); assert.equal(requests, 16);
});

test('oversized, malformed, and non-JSON metadata fail with no response text in reports', async () => {
  for (const response of [
    () => new Response('PRIVATE'.repeat(12000), { headers: { ...headers, 'Content-Type': 'application/json' } }),
    () => new Response('PRIVATE', { headers: { ...headers, 'Content-Type': 'application/json', 'Content-Length': '1000000' } }),
    () => new Response('PRIVATE', { headers: { ...headers, 'Content-Type': 'application/json' } }),
    () => new Response('PRIVATE', { headers: { ...headers, 'Content-Type': 'text/html' } }),
  ]) {
    const report = await checkDeployment(origin, { fetcher: async url => new URL(url).pathname === '/api/runtime' ? response() : successfulResponse(new URL(url).pathname) });
    assert.equal(report.ok, false); assert.equal(blocked(report, 'protected-account-policy'), true);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
  }
});

test('timeouts and transport exceptions are bounded and redact arbitrary underlying errors', async () => {
  const began = Date.now();
  const timed = await checkDeployment(origin, { timeoutMs: 20, fetcher: async () => new Promise<Response>(() => {}) });
  assert.equal(timed.ok, false); assert.ok(Date.now() - began < 1000);
  const failed = await checkDeployment(origin, { fetcher: async () => { throw new Error('PRIVATE certificate/server error'); } });
  assert.equal(failed.ok, false); assert.equal(JSON.stringify(failed).includes('PRIVATE'), false);
  assert.equal(failed.checks.filter(value => value.id.endsWith('-reachable') && value.status === 'blocked').length, 4);
});

test('missing security headers and permissive or duplicate CSP directives are not accepted', async () => {
  for (const policy of ['', "default-src 'self'; script-src 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'", `script-src *; ${csp}`]) {
    const report = await checkDeployment(origin, { fetcher: async url => {
      const response = successfulResponse(new URL(url).pathname);
      response.headers.set('content-security-policy', policy);
      if (new URL(url).pathname !== '/') response.headers.delete('cache-control');
      return response;
    } });
    assert.equal(report.ok, false); assert.equal(blocked(report, 'web-csp'), true);
    assert.equal(blocked(report, 'runtime-no-store'), true);
  }
  const report = await checkDeployment(origin, { fetcher: async url => {
    const response = successfulResponse(new URL(url).pathname);
    response.headers.set('strict-transport-security', 'max-age=0');
    response.headers.delete('x-content-type-options'); response.headers.delete('x-frame-options');
    return response;
  } });
  assert.equal(blocked(report, 'web-transport-policy'), true);
  assert.equal(blocked(report, 'web-nosniff'), true); assert.equal(blocked(report, 'web-anti-framing'), true);
});

test('CSP sources cannot widen none, self, or base restrictions by adding external or wildcard sources', async () => {
  for (const [directive, widened] of [
    ["object-src 'none'", "object-src 'none' https://untrusted.example"],
    ["frame-ancestors 'none'", "frame-ancestors 'none' https://untrusted.example"],
    ["default-src 'self'", "default-src 'self' *"],
    ["default-src 'self'", "default-src 'none' https://untrusted.example"],
    ["default-src 'self'", "default-src 'none' 'self'"],
    ["base-uri 'self'", "base-uri 'self' https://untrusted.example"],
    ["base-uri 'self'", "base-uri 'none' *"],
    ["base-uri 'self'", "base-uri 'none' 'self'"],
  ]) {
    const policy = csp.replace(directive, widened);
    const report = await checkDeployment(origin, { fetcher: async url => {
      const response = successfulResponse(new URL(url).pathname);
      if (new URL(url).pathname === '/') response.headers.set('content-security-policy', policy);
      return response;
    } });
    assert.equal(report.ok, false, widened);
    assert.equal(blocked(report, 'web-csp'), true, widened);
  }
});

test('CLI rejects invalid input and unknown flags without copying credential values or accepting an insecure option', () => {
  const script = resolve('scripts/deployment-check.mjs');
  for (const args of [['--url', 'https://user:PRIVATE@example.test'], ['--url', origin, '--insecure'], ['--token', 'PRIVATE']]) {
    const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000 });
    assert.equal(child.status, 1); assert.equal((child.stdout + child.stderr).includes('PRIVATE'), false);
  }
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(help.status, 0); assert.match(help.stdout, /unauthenticated GET/);
});
