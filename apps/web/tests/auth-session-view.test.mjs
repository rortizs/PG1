import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  loginFormIssues,
  buildAuthorizationHeader,
  shouldAttachToken,
} from '../src/app/auth/session-view.ts';

// --- loginFormIssues ---

test('loginFormIssues returns non-empty issues for both fields when both are blank', () => {
  const issues = loginFormIssues('', '');
  assert.ok(issues.length >= 2);
});

test('loginFormIssues returns no issues for a valid email and a strong-enough password', () => {
  const issues = loginFormIssues('a@b.com', 'validpassword123');
  assert.deepEqual(issues, []);
});

test('loginFormIssues rejects a malformed email even when non-blank', () => {
  const issues = loginFormIssues('not-an-email', 'validpassword123');
  assert.ok(issues.length >= 1);
});

test('loginFormIssues rejects a password shorter than the 12-character minimum shared with the API', () => {
  // 11 chars: rejected.
  assert.ok(loginFormIssues('a@b.com', '12345678901').length >= 1);
  // 12 chars: exactly the minimum, accepted.
  assert.deepEqual(loginFormIssues('a@b.com', '123456789012'), []);
});

// --- buildAuthorizationHeader ---

test('buildAuthorizationHeader wraps the token in the exact Bearer header shape', () => {
  assert.deepEqual(buildAuthorizationHeader('tok'), { Authorization: 'Bearer tok' });
});

// --- shouldAttachToken ---

test('shouldAttachToken attaches the token to a same-origin /api/ path', () => {
  assert.equal(shouldAttachToken('/api/v1/review-board/cards', 'tok'), true);
});

test('shouldAttachToken refuses the login route itself', () => {
  assert.equal(shouldAttachToken('/api/v1/auth/sessions', 'tok'), false);
});

test('shouldAttachToken still attaches to the logout route (not the login-creation route)', () => {
  assert.equal(shouldAttachToken('/api/v1/auth/sessions/current', 'tok'), true);
});

test('shouldAttachToken refuses an absolute third-party URL', () => {
  assert.equal(shouldAttachToken('https://evil.example.com/x', 'tok'), false);
});

test('shouldAttachToken refuses a protocol-relative absolute URL', () => {
  assert.equal(shouldAttachToken('//evil.example.com/x', 'tok'), false);
});

test('shouldAttachToken refuses a relative URL that resolves outside /api/ (e.g. a static asset)', () => {
  assert.equal(shouldAttachToken('/assets/logo.png', 'tok'), false);
});

test('shouldAttachToken returns false when there is no token to attach', () => {
  assert.equal(shouldAttachToken('/api/v1/review-board/cards', null), false);
});
