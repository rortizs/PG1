import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { AuthApiClient } from './auth-api-client';
import { SessionStore } from './session-store';
import { loginFormIssues } from './session-view';

type LoginStatus = 'idle' | 'submitting' | 'error';

const DEFAULT_REDIRECT = '/upload';

/**
 * Reviewer sign-in page: real login form (`POST /api/v1/auth/sessions`,
 * design decision D7) using `loginFormIssues` for client-side validation
 * before any network round-trip. On success, stores the session
 * (`SessionStore.setSession`) and navigates to the originally-requested
 * route carried as `?redirectTo=` by `requireSession` (D9), falling back to
 * `/upload`.
 */
@Component({
  selector: 'app-login-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>Reviewer sign in</h1>
    <form [formGroup]="form" (submit)="onSubmit($event)">
      <label>
        Email
        <input type="email" formControlName="email" autocomplete="username" />
      </label>

      <label>
        Password
        <input type="password" formControlName="password" autocomplete="current-password" />
      </label>

      <button type="submit" [disabled]="status() === 'submitting'">
        @if (status() === 'submitting') {
          Signing in...
        } @else {
          Sign in
        }
      </button>
    </form>

    @if (errorMessage(); as message) {
      <p role="alert">{{ message }}</p>
    }
  `,
  styles: [`
    :host {
      display: block;
      max-width: 480px;
      margin: 0 auto;
      padding: var(--pg1-page-margin) var(--pg1-space-gutter);
    }

    h1 {
      margin-bottom: var(--pg1-space-gutter);
    }

    form {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--pg1-node-gap);
      padding: var(--pg1-container-padding);
      border: var(--pg1-border-structural);
      background: var(--pg1-color-surface-container-low);
    }

    form label {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: calc(var(--pg1-space-unit) * 2);
    }

    form input {
      width: 100%;
    }

    [role='alert'] {
      margin-top: var(--pg1-node-gap);
    }
  `],
})
export class LoginPage {
  private readonly api = inject(AuthApiClient);
  private readonly sessionStore = inject(SessionStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  protected readonly form = new FormGroup({
    email: new FormControl('', { nonNullable: true }),
    password: new FormControl('', { nonNullable: true }),
  });
  protected readonly status = signal<LoginStatus>('idle');
  protected readonly errorMessage = signal<string | null>(null);

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    const { email, password } = this.form.getRawValue();
    const issues = loginFormIssues(email, password);
    if (issues.length > 0) {
      this.status.set('error');
      this.errorMessage.set(issues[0]);
      return;
    }

    this.status.set('submitting');
    this.errorMessage.set(null);
    this.api.login(email, password).subscribe({
      next: (session) => {
        this.sessionStore.setSession(session);
        this.status.set('idle');
        void this.router.navigateByUrl(this.resolveRedirectTarget());
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  /**
   * OWASP-conscious redirect handling: `redirectTo` is attacker-influenced
   * query-string input (the reviewer could follow a crafted link), so only
   * an app-relative path (`/…`, never a protocol-relative `//…` or an
   * absolute URL) is ever honored — otherwise this would be an open
   * redirect. Anything else falls back to `/upload`.
   */
  private resolveRedirectTarget(): string {
    const requested = this.route.snapshot.queryParamMap.get('redirectTo');
    if (requested && requested.startsWith('/') && !requested.startsWith('//')) {
      return requested;
    }
    return DEFAULT_REDIRECT;
  }

  private fail(err: unknown): void {
    this.status.set('error');
    this.errorMessage.set(extractLoginErrorMessage(err));
  }
}

function extractLoginErrorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'error' in err) {
    const httpError = err as { error?: { message?: string } };
    if (httpError.error?.message) return httpError.error.message;
  }
  return 'Sign in failed. Please check your credentials and try again.';
}
