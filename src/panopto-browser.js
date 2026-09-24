import { AuthenticationRequiredError } from './browser.js';
import { PANOPTO_ORIGIN, recordingId, viewerUrl, normaliseCaptions } from './panopto-data.js';
import { throwIfAborted } from './io.js';

export class PanoptoAccessError extends Error {}
export function panoptoAuthRequired() {
  return new AuthenticationRequiredError('Panopto sign-in is required. Run: myab panopto-login');
}
// Uses only the existing Chrome context and the site's ordinary sign-in flow.
// No OAuth client, copied credentials, or cross-origin Blackboard headers.
export class PanoptoClient {
  constructor(session, { signal, interactive = false } = {}) {
    this.session = session; this.context = session.context; this.signal = signal; this.interactive = interactive;
  }
  async open() {
    this.page = await this.context.newPage();
    await this.page.route('**/*', route => route.request().resourceType() === 'media' ? route.abort() : route.continue());
    await this.navigate(`${PANOPTO_ORIGIN}/Panopto/Pages/Sessions/List.aspx`);
    return this;
  }
  async navigate(url) {
    throwIfAborted(this.signal);
    if (new URL(url).origin !== PANOPTO_ORIGIN) throw new Error('Refusing a page outside the Panopto origin.');
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      const deadline = Date.now() + (this.interactive ? 15 * 60_000 : 20_000);
      let panoptoClicked = false, blackboardClicked = false;
      while (Date.now() < deadline) {
        throwIfAborted(this.signal);
        const current = new URL(this.page.url());
        if (current.origin === PANOPTO_ORIGIN && !/\/Auth\//i.test(current.pathname)) {
          // Wait for delayed redirects before treating a login landing page as success.
          await this.page.waitForTimeout(750);
          const final = new URL(this.page.url());
          if (final.origin === PANOPTO_ORIGIN && !/\/Auth\//i.test(final.pathname)) return;
        }
        if (current.origin === PANOPTO_ORIGIN && !panoptoClicked) {
          const provider = this.page.locator('#providerDropdown');
          const button = this.page.locator('#PageContentPlaceholder_loginControl_externalLoginButton');
          if (await provider.isVisible() && await button.isVisible()) {
            const available = await provider.locator('option').evaluateAll(es => es.map(e => e.value));
            if (!available.includes('BlackboardUltraLTI')) throw panoptoAuthRequired();
            await provider.selectOption('BlackboardUltraLTI'); await button.click(); panoptoClicked = true;
          }
        } else if (current.origin === this.session.config.baseUrl && !blackboardClicked) {
          const button = this.page.getByRole('link', { name: 'Sign In', exact: true }).or(this.page.getByRole('button', { name: 'Sign In', exact: true })).first();
          if (await button.isVisible()) { await button.click(); blackboardClicked = true; }
        }
        await this.page.waitForTimeout(500);
      }
      throw panoptoAuthRequired();
    } catch (error) {
      if (error instanceof AuthenticationRequiredError || this.signal?.aborted) throw error;
      throw new Error('Could not load Panopto through the normal browser flow. Retry, or run myab panopto-login.');
    }
  }
  async readJson(route, body) {
    const url = new URL(route, PANOPTO_ORIGIN);
    if (url.origin !== PANOPTO_ORIGIN || !['/Panopto/Services/Data.svc/GetSessions', '/Panopto/Pages/Viewer/DeliveryInfo.aspx'].includes(url.pathname)) throw new Error('Unsupported Panopto read endpoint.');
    for (let attempt = 0; attempt < 3; attempt++) {
      throwIfAborted(this.signal);
      let response;
      try { response = await this.context.request.post(url.href, { ...body, maxRedirects: 0, timeout: 30_000, headers: { Accept: 'application/json' } }); }
      catch { throw new Error('Panopto request failed; no response was archived.'); }
      try {
        const status = response.status();
        if (status === 401 || status >= 300 && status < 400) throw panoptoAuthRequired();
        if (status === 403) throw new PanoptoAccessError('Panopto denied access to this folder or recording.');
        if (status === 404) throw new PanoptoAccessError('Panopto recording or folder is unavailable.');
        if ((status === 429 || status >= 500) && attempt < 2) {
          const retry = Number(response.headers()['retry-after']);
          await this.page.waitForTimeout(Math.min(10_000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 1000 * (attempt + 1))); continue;
        }
        if (status !== 200) throw new Error(`Panopto read failed (HTTP ${status}).`);
        try { return await response.json(); } catch { throw panoptoAuthRequired(); }
      } finally { await response.dispose(); }
    }
  }
  async sessions({ query = null, folder = null } = {}) {
    if (!query && !folder) throw new Error('Panopto enumeration requires an explicit course search or folder.');
    const results = [], seen = new Set(), subfolders = new Set();
    for (let page = 0; page < 200; page++) {
      const payload = await this.readJson('/Panopto/Services/Data.svc/GetSessions', { data: { queryParameters: {
        query, sortColumn: 1, sortAscending: false, maxResults: 25, page, startDate: null, endDate: null,
        folderID: folder ? recordingId(folder) : null, bookmarked: false, getFolderData: !!folder,
        isSharedWithMe: false, isSubscriptionsPage: false, includeArchived: true,
        includeArchivedStateCount: false, sessionListOnlyArchived: false, includePlaylists: false
      } } });
      const data = payload?.d;
      if (!Array.isArray(data?.Results) || !Number.isSafeInteger(data.TotalNumber) || data.TotalNumber < 0) throw new Error('Unexpected Panopto session-list response; completeness is unknown.');
      for (const child of data.Subfolders || []) subfolders.add(recordingId(child.ID || child.Id || child.FolderID));
      for (const item of data.Results) {
        const id = recordingId(item.DeliveryID);
        if (seen.has(id)) throw new Error('Panopto pagination repeated a recording; completeness is unknown.');
        seen.add(id); results.push({ ...item, Id: id });
      }
      if (results.length >= data.TotalNumber) { results.subfolders = [...subfolders]; return results; }
      if (!data.Results.length) throw new Error('Panopto pagination ended before the advertised total.');
    }
    throw new Error('Panopto pagination limit reached; completeness is unknown.');
  }
  searchSessions(code) { return this.sessions({ query: `"${code.replace(/[^a-z0-9]/gi, '')}"` }); }
  async folderSessions(id) {
    const folders = new Set([recordingId(id)]), recordings = new Map();
    for (const folder of folders) {
      if (folders.size > 200) throw new Error('Panopto subfolder limit reached; completeness is unknown.');
      const rows = await this.sessions({ folder });
      for (const child of rows.subfolders) folders.add(child);
      for (const row of rows) recordings.set(row.Id, row);
    }
    return [...recordings.values()];
  }
  async launchLti(route, courseId) {
    const url = new URL(route, this.session.config.baseUrl);
    if (url.origin !== this.session.config.baseUrl || url.pathname !== '/webapps/blackboard/execute/blti/launchLink'
      || url.searchParams.get('course_id') !== courseId || !/^_\d+_\d+$/.test(url.searchParams.get('content_id') || '')) throw new Error('Invalid course-scoped Panopto launch link.');
    try {
      await this.page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await this.page.waitForURL(u => u.origin === PANOPTO_ORIGIN && /\/Pages\/(Viewer|Embed)\.aspx$/.test(u.pathname), { timeout: 30_000 });
      return recordingId(new URL(this.page.url()).searchParams.get('id'));
    } catch { throw panoptoAuthRequired(); }
  }
  async recording(id) {
    id = recordingId(id);
    const payloads = [], pending = [];
    const listener = response => {
      const u = new URL(response.url());
      if (u.origin !== PANOPTO_ORIGIN || u.pathname !== '/Panopto/Pages/Viewer/DeliveryInfo.aspx') return;
      pending.push((async () => {
        if (response.status() !== 200) return;
        try { payloads.push(await response.json()); } catch { /* Checked below, never save a login/error page. */ }
      })());
    };
    this.page.on('response', listener);
    try {
      await this.navigate(viewerUrl(id));
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        throwIfAborted(this.signal);
        await Promise.allSettled(pending);
        const meta = payloads.find(p => p?.Delivery);
        if (meta && (!meta.Delivery.HasCaptions || payloads.some(Array.isArray))) break;
        await this.page.waitForTimeout(250);
      }
      const raw = payloads.find(p => p?.Delivery);
      if (!raw) throw new PanoptoAccessError('Panopto did not expose recording metadata; it may be unavailable or require sign-in.');
      const d = raw.Delivery;
      const actualId = d.PublicID;
      if (String(actualId).toLowerCase() !== id) throw new Error('Panopto returned a different recording; nothing was archived.');
      const rows = payloads.find(Array.isArray);
      if (d.HasCaptions && !rows) throw new Error('Panopto captions did not load; existing transcript retained.');
      const transcripts = {};
      for (const track of d.AvailableCaptions || []) {
        if (!Number.isSafeInteger(track.Language)) throw new Error('Unknown caption language.');
        const captionRows = await this.readJson('/Panopto/Pages/Viewer/DeliveryInfo.aspx', { form: { deliveryId: id, getCaptions: 'true', language: String(track.Language), responseType: 'json' } });
        transcripts[String(track.Language)] = { language: track.Language, automatic: track.ShowDisclaimer === true, captions: normaliseCaptions(captionRows) };
      }
      if (d.HasCaptions && !Object.keys(transcripts).length) throw new Error('Caption languages were missing; previous transcript retained.');
      const record = {
        id, url: viewerUrl(id), title: String(d.SessionName || ''), description: String(d.SessionAbstract || ''),
        folderId: d.SessionGroupPublicID || null, folderName: d.SessionGroupLongName || d.SessionGroupShortName || '',
        duration: d.Duration, startTime: Number.isFinite(d.SessionStartTime) ? new Date((d.SessionStartTime - 11644473600) * 1000).toISOString() : null, owner: d.OwnerDisplayName || '',
        aiSummary: typeof d.AISummary === 'string' ? d.AISummary : '',
        aiKeyPoints: (d.AIKeyPoints || []).filter(x => typeof x === 'string'),
        chapters: (d.AIChapters || []).filter(x => Number.isFinite(x.Start) && typeof x.Summary === 'string').map(x => ({ start: x.Start, end: x.End, title: x.Summary, aiGenerated: true })),
        contents: (d.Timestamps || []).filter(x => x.ShowInTableOfContents && Number.isFinite(x.Time)).map(x => ({ start: x.Time, title: x.Caption || '', type: x.EventTargetType || '', sequence: x.ObjectSequenceNumber || null })),
        transcripts,
        hasCaptions: !!d.HasCaptions, downloadable: !!raw.DownloadUrl,
        playback: { position: raw.LastViewingPosition ?? null, percentCompleted: raw.CompletionPercentage ?? null }
      };
      // Raw responses contain user identifiers and expiring URLs: never persist them.
      return { record, downloadUrl: typeof raw.DownloadUrl === 'string' ? raw.DownloadUrl : null };
    } catch (error) {
      if (error instanceof AuthenticationRequiredError || error instanceof PanoptoAccessError || this.signal?.aborted) throw error;
      // Playwright errors can contain signed SSO/media URLs and request data.
      throw new Error('Could not read a complete Panopto recording; existing data retained.');
    } finally { this.page.off('response', listener); await Promise.allSettled(pending); }
  }
  async close() { await this.page?.close(); }
}
