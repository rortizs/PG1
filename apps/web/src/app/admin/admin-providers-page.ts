import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { AdminApiClient } from './admin-api-client';
import { AdminSecretStore } from './admin-secret-store';
import {
  AdminProviderRow,
  buildAdminProvidersViewModel,
  buildCreateProviderPayload,
  buildUpdateProviderPayload,
  extractAdminErrorMessage,
  isAdminAuthError,
  maskedKeyLabel,
} from './admin-providers-view';

const SUPPORTED_PROVIDER_NAMES = ['claude', 'deepseek', 'groq'] as const;

/**
 * Admin backoffice page for `llm_provider_config`: list (masked keys, active
 * badge), a single add/edit form (the raw API key field is write-only — it
 * is cleared after every successful save and never pre-filled with a real
 * value when editing an existing row), and a per-row activate action.
 *
 * Every request goes through `AdminApiClient`, which requires the
 * session-scoped `x-admin-secret` (design decision #9) — the first admin
 * action on this page prompts for it; a `403` (wrong secret) clears the
 * cached value so the very next action re-prompts instead of repeating a
 * rejected secret.
 */
@Component({
  selector: 'app-admin-providers-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>LLM provider admin</h1>
    <p role="note">
      Access to this page is gated by a temporary shared secret, NOT real
      authentication. Never share it outside the admin team.
    </p>

    @if (loadError(); as message) {
      <p role="alert">{{ message }}</p>
    }

    @switch (view().kind) {
      @case ('loading') {
        <p>Loading providers...</p>
      }
      @case ('error') {
        <!-- loadError() above already renders the message -->
      }
      @case ('list') {
        <table>
          <thead>
            <tr>
              <th>Provider</th>
              <th>Model</th>
              <th>Key</th>
              <th>Status</th>
              <th></th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            @for (row of listItems(); track row.id) {
              <tr>
                <td>{{ row.provider_name }}</td>
                <td>{{ row.model_id }}</td>
                <td>{{ maskKey(row) }}</td>
                <td>
                  @if (row.is_active) {
                    <span role="status">active</span>
                  } @else {
                    <span role="status">inactive</span>
                  }
                </td>
                <td>
                  <button type="button" (click)="onEdit(row)">Edit</button>
                </td>
                <td>
                  <button
                    type="button"
                    [disabled]="row.is_active"
                    (click)="onActivate(row)"
                  >
                    Activate
                  </button>
                </td>
              </tr>
            }
          </tbody>
        </table>
      }
    }

    <h2>{{ editingId() === null ? 'Add provider' : 'Edit provider' }}</h2>
    <form [formGroup]="form" (submit)="onSubmit($event)">
      <label>
        Provider
        <select formControlName="providerName">
          @for (name of providerNames; track name) {
            <option [value]="name">{{ name }}</option>
          }
        </select>
        @if (editingId() !== null) {
          <small>Provider type cannot be changed on an existing row — activate a new row instead.</small>
        }
      </label>

      <label>
        Model id
        <input type="text" formControlName="modelId" />
      </label>

      <label>
        API key
        <input
          type="password"
          formControlName="apiKey"
          [placeholder]="editingId() === null ? '' : 'Leave blank to keep the current key'"
          autocomplete="off"
        />
      </label>

      <button type="submit" [disabled]="submitting()">
        @if (submitting()) {
          Saving...
        } @else {
          {{ editingId() === null ? 'Add provider' : 'Save changes' }}
        }
      </button>

      @if (editingId() !== null) {
        <button type="button" (click)="onCancelEdit()">Cancel</button>
      }
    </form>

    @if (formError(); as message) {
      <p role="alert">{{ message }}</p>
    }
  `,
})
export class AdminProvidersPage {
  private readonly api = inject(AdminApiClient);
  private readonly secretStore = inject(AdminSecretStore);

  protected readonly providerNames = SUPPORTED_PROVIDER_NAMES;

  private readonly providers = signal<AdminProviderRow[] | null>(null);
  protected readonly loadError = signal<string | null>(null);
  protected readonly formError = signal<string | null>(null);
  protected readonly submitting = signal(false);
  protected readonly editingId = signal<number | null>(null);

  protected readonly view = computed(() =>
    buildAdminProvidersViewModel({ providers: this.providers(), loadError: this.loadError() }),
  );
  protected readonly listItems = computed(() => {
    const current = this.view();
    return current.kind === 'list' ? current.items : [];
  });

  protected readonly form = new FormGroup({
    providerName: new FormControl<(typeof SUPPORTED_PROVIDER_NAMES)[number]>('claude', {
      nonNullable: true,
    }),
    modelId: new FormControl('', { nonNullable: true }),
    apiKey: new FormControl('', { nonNullable: true }),
  });

  constructor() {
    this.loadProviders();
  }

  protected maskKey(row: AdminProviderRow): string {
    return maskedKeyLabel(row);
  }

  protected onSubmit(event: SubmitEvent): void {
    event.preventDefault();
    this.formError.set(null);
    this.submitting.set(true);

    const editingId = this.editingId();
    const formValue = this.form.getRawValue();
    const request =
      editingId === null
        ? this.api.createProvider(buildCreateProviderPayload(formValue))
        : this.api.updateProvider(editingId, buildUpdateProviderPayload(formValue));

    request.subscribe({
      next: () => {
        this.submitting.set(false);
        this.resetForm();
        this.loadProviders();
      },
      error: (err: unknown) => this.failForm(err),
    });
  }

  protected onEdit(row: AdminProviderRow): void {
    this.editingId.set(row.id);
    // The raw API key field is write-only — never pre-filled with the
    // stored (already-masked-server-side) value.
    this.form.setValue({ providerName: this.asProviderName(row.provider_name), modelId: row.model_id, apiKey: '' });
  }

  protected onCancelEdit(): void {
    this.resetForm();
  }

  protected onActivate(row: AdminProviderRow): void {
    this.formError.set(null);
    this.api.activateProvider(row.id).subscribe({
      next: () => this.loadProviders(),
      error: (err: unknown) => this.failForm(err),
    });
  }

  private loadProviders(): void {
    this.api.listProviders().subscribe({
      next: (items) => {
        this.providers.set(items);
        this.loadError.set(null);
      },
      error: (err: unknown) => this.loadError.set(extractAdminErrorMessage(err)),
    });
  }

  private failForm(err: unknown): void {
    this.submitting.set(false);
    if (isAdminAuthError(err)) this.secretStore.clearSecret();
    this.formError.set(extractAdminErrorMessage(err));
  }

  private resetForm(): void {
    this.editingId.set(null);
    this.form.reset({ providerName: 'claude', modelId: '', apiKey: '' });
  }

  private asProviderName(value: string): (typeof SUPPORTED_PROVIDER_NAMES)[number] {
    return SUPPORTED_PROVIDER_NAMES.includes(value as (typeof SUPPORTED_PROVIDER_NAMES)[number])
      ? (value as (typeof SUPPORTED_PROVIDER_NAMES)[number])
      : 'claude';
  }
}
