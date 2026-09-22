import test from 'node:test';
import assert from 'node:assert/strict';
import { BlackboardSession, AuthenticationRequiredError } from '../src/browser.js';

const baseUrl = 'https://abdn.blackboard.com';

function expiredSession({ visible = true, origin = baseUrl, timeout = false, recovered = true } = {}) {
  const session = new BlackboardSession({ baseUrl });
  const calls = { clicks: 0, checks: 0 };
  session.xsrfToken = 'stale-test-token';
  const signIn = {
    or: () => signIn,
    first: () => signIn,
    isVisible: async () => visible,
    click: async () => {
      calls.clicks++;
      assert.equal(session.xsrfToken, null);
    }
  };
  session.page = {
    url: () => `${origin}/`,
    getByRole: (_, options) => {
      assert.deepEqual(options, { name: 'Sign In', exact: true });
      return signIn;
    },
    waitForURL: async (predicate, options) => {
      assert.equal(options.timeout, 30_000);
      assert.equal(predicate(new URL(`${baseUrl}/ultra/course`)), true);
      assert.equal(predicate(new URL('https://login.microsoftonline.com/ultra/course')), false);
      assert.equal(predicate(new URL(`${baseUrl}/`)), false);
      if (timeout) {
        const error = new Error('private SSO URL');
        error.name = 'TimeoutError';
        throw error;
      }
    }
  };
  session.waitForXsrf = async () => { session.xsrfToken = 'fresh-test-token'; };
  session.verifyAuthentication = async () => {
    calls.checks++;
    if (calls.checks === 1 || !recovered) throw new AuthenticationRequiredError();
    assert.equal(session.xsrfToken, 'fresh-test-token');
    return { id: 'test-user' };
  };
  return { session, calls };
}

test('valid Blackboard session needs no sign-in interaction', async () => {
  const session = new BlackboardSession({ baseUrl });
  session.verifyAuthentication = async () => ({ id: 'test-user' });
  assert.deepEqual(await session.ensureAuthentication(), { id: 'test-user' });
});

test('expired Blackboard session recovers once via remembered SSO and rechecks identity', async () => {
  const { session, calls } = expiredSession();
  assert.deepEqual(await session.ensureAuthentication(), { id: 'test-user' });
  assert.deepEqual(calls, { clicks: 1, checks: 2 });
});

test('authentication failure after SSO does not start a retry loop', async () => {
  const { session, calls } = expiredSession({ recovered: false });
  await assert.rejects(session.ensureAuthentication(), AuthenticationRequiredError);
  assert.deepEqual(calls, { clicks: 1, checks: 2 });
});

test('missing sign-in control or identity-provider prompt requires manual login', async () => {
  for (const options of [{ visible: false }, { origin: 'https://login.microsoftonline.com' }]) {
    const { session, calls } = expiredSession(options);
    await assert.rejects(session.ensureAuthentication(), AuthenticationRequiredError);
    assert.equal(calls.clicks, 0);
  }
});

test('SSO interaction timeout is bounded and does not expose authentication URLs', async () => {
  const { session, calls } = expiredSession({ timeout: true });
  await assert.rejects(session.ensureAuthentication(), error => {
    assert.ok(error instanceof AuthenticationRequiredError);
    assert.doesNotMatch(error.message, /private SSO/);
    return true;
  });
  assert.equal(calls.clicks, 1);
  assert.equal(calls.checks, 1);
});

test('transport and access errors do not trigger sign-in', async () => {
  const { session, calls } = expiredSession();
  const failure = new Error('Blackboard request failed (403)');
  session.verifyAuthentication = async () => { throw failure; };
  await assert.rejects(session.ensureAuthentication(), error => error === failure);
  assert.equal(calls.clicks, 0);
});
