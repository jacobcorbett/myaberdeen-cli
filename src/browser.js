import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium, request as apiRequest } from 'playwright-core';
import { prepareLocalState } from './config.js';

export class AuthenticationRequiredError extends Error {
  constructor(message = 'The MyAberdeen session is not authenticated. Run: myab login') {
    super(message);
    this.name = 'AuthenticationRequiredError';
  }
}

export class BlackboardSession {
  constructor(config, { headless = true } = {}) {
    this.config = config;
    this.headless = headless;
    this.context = null;
    this.browser = null;
    this.page = null;
    this.xsrfToken = null;
  }

  async open({ requireAuthentication = true } = {}) {
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
    this.context.on('request', request => this.captureXsrf(request));
    this.page = this.context.pages()[0] || await this.context.newPage();
    await this.page.goto(`${this.config.baseUrl}/ultra/course`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await this.page.bringToFront();
    await this.waitForXsrf(15_000);
    if (requireAuthentication) await this.ensureAuthentication();
    return this;
  }

  async openInteractive() {
    prepareLocalState(this.config);
    this.assertProfileAvailable();
    const portFile = `${this.config.profileDir}/DevToolsActivePort`;
    try { fs.unlinkSync(portFile); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise((resolve, reject) => {
      const launcher = spawn('/usr/bin/open', [
        '-na', 'Google Chrome', '--args',
        `--user-data-dir=${this.config.profileDir}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0',
        '--no-first-run',
        '--password-store=basic',
        '--use-mock-keychain',
        '--disable-sync',
        '--new-window',
        `${this.config.baseUrl}/ultra/course`
      ], { stdio: 'ignore' });
      launcher.once('error', reject);
      launcher.once('exit', code => code === 0 ? resolve() : reject(new Error(`Chrome launcher exited with ${code}`)));
    });
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(portFile) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!fs.existsSync(portFile)) throw new Error('Chrome did not start its local debugging connection.');
    const port = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
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
      try {
        response = await client.get(url, { ...options,
          headers: external ? { Accept: '*/*' } : options.headers, maxRedirects: 0 });
      } catch {
        // Playwright errors can contain headers and signed query strings.
        throw new Error(`Blackboard transport failed for ${new URL(url).origin}${new URL(url).pathname}`);
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
      if (!response.ok()) throw new Error(`Blackboard request failed (${response.status()}) for ${new URL(url).pathname}`);
      return await response.json();
    } finally { await response.dispose(); }
  }

  async getBinary(route) {
    const url = this.requestUrl(route);
    const response = await this.request(url, {
      headers: { ...this.headers(), Accept: '*/*' },
      timeout: 120_000,
      maxRedirects: 0
    }, { fileRedirects: true });
    try {
      if (response.status() === 401) throw new AuthenticationRequiredError();
      if (!response.ok()) throw new Error(`Download failed (${response.status()}) for ${new URL(url).pathname}`);
      return {
        body: Buffer.from(await response.body()),
        contentType: response.headers()['content-type'] || '',
        disposition: response.headers()['content-disposition'] || '',
        finalUrl: response.url()
      };
    } finally { await response.dispose(); }
  }

  async close() {
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
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try { fs.lstatSync(`${this.config.profileDir}/SingletonLock`); }
      catch (error) { if (error.code === 'ENOENT') break; throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.context = null;
    this.browser = null;
    this.page = null;
    this.xsrfToken = null;
  }
}
