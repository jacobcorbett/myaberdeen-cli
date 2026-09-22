import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, request as apiRequest } from 'playwright-core';
import { prepareLocalState } from './config.js';
import { safeMessage, throwIfAborted } from './io.js';
import { setTimeout as delay } from 'node:timers/promises';

export class AuthenticationRequiredError extends Error {
  constructor(message = 'The MyAberdeen session is not authenticated. Run: myab login') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export class BlackboardSession {
  constructor(config, { headless = true, signal, retries = 2 } = {}) {
    this.config = config;
    this.signal = signal;
    this.retries = retries;
    this.stats = { requests: 0, retries: 0, fileBytes: 0, notModified: 0 };
    this.headless = headless;
    this.context = null;
    this.browser = null;
    this.page = null;
    this.xsrfToken = null;
  }

  async open({ requireAuthentication = true } = {}) {
    throwIfAborted(this.signal);
    prepareLocalState(this.config);
    if (!fs.existsSync(this.config.chromePath)) {
      throw new Error(`Google Chrome was not found at ${this.config.chromePath}`);
    }
    this.assertProfileAvailable();
    this.context = await chromium.launchPersistentContext(this.config.profileDir, {
      executablePath: this.config.chromePath,
      headless: this.headless,
      acceptDownloads: true,
      viewport: { width: 1280, height: 900 },
      args: ['--password-store=basic', '--use-mock-keychain', '--disable-sync', '--disable-background-networking', '--restore-last-session', '--new-window', '--start-maximized']
    });
    // Cancellation may have finished cleanup while Chrome was still launching.
    // Make the newly returned context eligible for the caller's final cleanup.
    this.closing = null;
    throwIfAborted(this.signal);
    this.context.on('request', request => this.captureXsrf(request));
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(`${this.config.baseUrl}/ultra/course`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.bringToFront();
    await this.waitForXsrf(15_000);
    if (requireAuthentication) await this.ensureAuthentication();
    return this;
  }

  async openInteractive() {
    throwIfAborted(this.signal);
    prepareLocalState(this.config);
    this.assertProfileAvailable();
    const portFile = `${this.config.profileDir}/DevToolsActivePort`;
    try { fs.unlinkSync(portFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!fs.existsSync(this.config.chromePath)) throw new Error('Configured Google Chrome executable was not found. Run: myab doctor');
    await new Promise((resolve, reject) => {
      this.launcher = spawn(this.config.chromePath, [
        `--user-data-dir=${this.config.profileDir}`, '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--no-first-run', '--password-store=basic', '--use-mock-keychain',
        '--disable-sync', '--new-window', `${this.config.baseUrl}/ultra/course`
      ], { stdio: 'ignore' });
      this.launcher.once('error', () => reject(new Error('Could not launch the configured Google Chrome executable.')));
      this.launcher.once('spawn', resolve);
    });
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(portFile) && Date.now() < deadline) {
      throwIfAborted(this.signal);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!fs.existsSync(portFile)) throw new Error('Chrome did not start its local debugging connection.');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    this.closing = null;
    throwIfAborted(this.signal);
    this.context = this.browser.contexts()[0];
    this.context.on('request', request => this.captureXsrf(request));
    this.page = this.context.pages().find(page => page.url().includes('abdn.blackboard.com'))
      || this.context.pages()[0]
      || await this.context.newPage();
    await this.page.bringToFront();
    return this;
  }

  captureXsrf(request) {
    if (new URL(request.url()).origin !== new URL(this.config.baseUrl).origin) return;
    const token = request.headers()['x-blackboard-xsrf'];
    if (token) this.xsrfToken = token;
  }

  async waitForXsrf(timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!this.xsrfToken && Date.now() < deadline) {
      throwIfAborted(this.signal);
      await this.page.waitForTimeout(250);
    }
    return this.xsrfToken;
  }

  async verifyAuthentication() {
    if (!this.xsrfToken) {
      await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      await this.waitForXsrf(15_000);
    }
    if (!this.xsrfToken) throw new AuthenticationRequiredError();
    const user = await this.getJson('/learn/api/v1/users/me?expand=systemRoles,insRoles', { allowAuthError: true });
    if (!user?.id) throw new AuthenticationRequiredError();
    return user;
  }

  async ensureAuthentication() {
    try {
      return await this.verifyAuthentication();
    } catch (error) {
      if (!(error instanceof AuthenticationRequiredError)) throw error;
    }

    // A Blackboard session can expire while the university SSO session is still
    // valid. Follow the site's own sign-in entry once to reuse that session.
    // Never interact with password, MFA, account-choice or consent prompts.
    if (new URL(this.page.url()).origin !== new URL(this.config.baseUrl).origin) {
      throw new AuthenticationRequiredError();
    }
    const signIn = this.page.getByRole('link', { name: 'Sign In', exact: true })
      .or(this.page.getByRole('button', { name: 'Sign In', exact: true })).first();
    if (!await signIn.isVisible()) throw new AuthenticationRequiredError();
    this.xsrfToken = null;
    try {
      await signIn.click({ timeout: 10_000 });
      await this.page.waitForURL(url => url.origin === new URL(this.config.baseUrl).origin
        && url.pathname.startsWith('/ultra/'), { timeout: 30_000, waitUntil: 'domcontentloaded' });
    } catch (error) {
      // Browser timeout messages may contain SSO URLs. Keep diagnostics private.
      if (error.name === 'TimeoutError') throw new AuthenticationRequiredError();
      throw new Error('Could not complete the MyAberdeen sign-in redirect. Retry the command.');
    }
    await this.waitForXsrf(15_000);
    return await this.verifyAuthentication();
  }

  headers() {
    if (!this.xsrfToken) throw new AuthenticationRequiredError();
    return {
      Accept: 'application/json',
      'X-Blackboard-XSRF': this.xsrfToken,
      'X-Requested-With': 'XMLHttpRequest'
    };
  }

  assertProfileAvailable() {
    // lstat also detects Chrome's dangling lock symlink. Never delete a live/stale lock here.
    try { fs.lstatSync(`${this.config.profileDir}/SingletonLock`); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    throw new Error('The dedicated MyAberdeen Chrome profile is locked. Close that Chrome window and retry. If it remains locked, restart Chrome normally; do not remove a live profile lock.');
  }

  requestUrl(route) {
    const url = new URL(route, this.config.baseUrl);
    if (url.origin !== new URL(this.config.baseUrl).origin || url.username || url.password) {
      throw new Error('Refusing a request outside the Blackboard origin.');
    }
    return url.href;
  }

  async request(route, options, { fileRedirects = false } = {}) {
    let url = this.requestUrl(route);
    for (let redirects = 0; redirects <= 5; redirects++) {
      const external = new URL(url).origin !== new URL(this.config.baseUrl).origin;
      if (external && !this.fileRequest) this.fileRequest = await apiRequest.newContext();
      const client = external ? this.fileRequest : this.context.request;
      let response;
      for (let attempt = 0; ; attempt++) {
        throwIfAborted(this.signal);
        const headers = external ? { Accept: '*/*' } : options.headers;
        if (external) for (const name of ['If-None-Match', 'If-Modified-Since']) if (options.headers?.[name]) headers[name] = options.headers[name];
        try {
          this.stats.requests++;
          response = await client.get(url, { ...options, headers, maxRedirects: 0, maxRetries: 0, signal: this.signal });
        } catch {
          throwIfAborted(this.signal);
          if (attempt >= this.retries) throw new Error(`Blackboard transport failed for ${new URL(url).pathname}`);
          this.stats.retries++;
          await delay(500 * 2 ** attempt, undefined, { signal: this.signal });
          continue;
        }
        if (![429, 500, 502, 503, 504].includes(response.status()) || attempt >= this.retries) break;
        const retryAfter = response.headers()['retry-after'];
        const seconds = Number(retryAfter);
        const wait = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now()) : 500 * 2 ** attempt;
        await response.dispose();
        this.stats.retries++;
        await delay(Math.min(30_000, Math.max(0, Number.isFinite(wait) ? wait : 1000)), undefined, { signal: this.signal });
      }
      if (![301, 302, 303, 307, 308].includes(response.status())) return response;
      const location = response.headers().location;
      await response.dispose();
      if (!location) throw new Error('Blackboard returned a redirect without a destination.');
      // Validate every hop before attaching headers, including relative redirects.
      const next = new URL(location, url);
      if (fileRedirects && next.protocol === 'https:' && next.hostname.endsWith('.blackboard.com') && !next.username && !next.password) {
        url = next.href;
      } else {
        url = this.requestUrl(next.href);
      }
    }
    throw new Error('Blackboard exceeded the redirect limit.');
  }

  async getJson(route, { allowAuthError = false } = {}) {
    const url = this.requestUrl(route);
    const response = await this.request(url, {
      headers: this.headers(), timeout: 60_000, maxRedirects: 0
    });
    try {
      if (response.status() === 401 || (allowAuthError && response.status() === 403)) {
        if (allowAuthError) return null;
        throw new AuthenticationRequiredError();
      }
      if (!response.ok()) throw new HttpError(response.status(), new URL(url).pathname);
      try { return await response.json(); } catch { throw new Error(`Invalid JSON from ${new URL(url).pathname}.`); }
    } finally { await response.dispose(); }
  }

  async getBinary(route, { etag, lastModified } = {}) {
    const url = this.requestUrl(route);
    const response = await this.request(url, {
      headers: { ...this.headers(), Accept: '*/*', ...(etag ? { 'If-None-Match': etag } : lastModified ? { 'If-Modified-Since': lastModified } : {}) },
      timeout: 120_000,
      maxRedirects: 0
    }, { fileRedirects: true });
    try {
      if (response.status() === 401) throw new AuthenticationRequiredError();
      const validators = { etag: response.headers().etag || null, lastModified: response.headers()['last-modified'] || null };
      if (response.status() === 304) { this.stats.notModified++; return { notModified: true, ...validators }; }
      if (!response.ok()) throw new HttpError(response.status(), new URL(url).pathname);
      const body = Buffer.from(await response.body());
      this.stats.fileBytes += body.length;
      return {
        body, ...validators,
        contentType: response.headers()['content-type'] || '',
        disposition: response.headers()['content-disposition'] || '',
        finalUrl: response.url()
      };
    } finally { await response.dispose(); }
  }

  async close() {
    if (!this.closing) this.closing = this.closeResources();
    return this.closing;
  }

  async closeResources() {
    if (this.fileRequest) await this.fileRequest.dispose();
    this.fileRequest = null;
    if (this.browser) {
      try {
        const cdp = await this.browser.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch {
        await this.browser.close().catch(() => {});
      }
    }
    else if (this.context) await this.context.close();
    // Browser.close acknowledges before Chrome has released its profile on macOS.
    const deadline = Date.now() + (this.context || this.browser || this.launcher ? 10_000 : 0);
    while (Date.now() < deadline) {
      try { fs.lstatSync(`${this.config.profileDir}/SingletonLock`); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (this.launcher && this.launcher.exitCode === null) this.launcher.kill('SIGTERM');
    this.launcher = null;
    this.context = null;
    this.browser = null;
    this.page = null;
    this.xsrfToken = null;
  }
}

export class HttpError extends Error {
  constructor(status, route) { super(`Blackboard request failed (${status}) for ${route}`); this.status = status; }
}
// Playwright navigation/launch diagnostics can contain SSO URLs and headers.
for (const name of ['open', 'openInteractive', 'verifyAuthentication', 'ensureAuthentication']) {
  const operation = BlackboardSession.prototype[name];
  BlackboardSession.prototype[name] = async function (...args) {
    try { return await operation.apply(this, args); }
    catch (error) {
      if (error instanceof AuthenticationRequiredError || error instanceof HttpError || this.signal?.aborted) throw error;
      const message = safeMessage(error);
      if (message === error.message) throw error;
      throw new Error(message);
    }
  };
}
