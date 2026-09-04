import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { AdminApiClient } from './admin-api-client';
import {
  AdminProviderRow,
  buildAdminProvidersViewModel,
  buildCreateProviderPayload,
  buildUpdateProviderPayload,
  extractAdminErrorMessage,
  maskedKeyLabel,
} from './admin-providers-view';

const SUPPORTED_PROVIDER_NAMES = ['claude', 'deepseek', 'groq'] as const;

/**
 * Admin backoffice page for `llm_provider_config`: list (masked keys, active
 * badge), a single add/edit form (the raw API key field is write-only — it
 * is cleared after every successful save and never pre-filled with a real
 * value when editing an existing row), and a per-row activate action.
 *
 * Access is gated by the same reviewer session as every other page
 * (`requireSession` route guard + `sessionInterceptor`) — there is no
 * separate admin role or secret: any authenticated reviewer can reach this
 * page, per the confirmed reviewer-authentication design decision D6.
 */
@Component({
  selector: 'app-admin-providers-page',
  imports: [ReactiveFormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>LLM provider admin</h1>

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
                    <span role="status" class="status-active">active</span>
                  } @else {
                    <span role="status" class="status-inactive">inactive</span>
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
  styles: [`
    :host {
      display: block;
      max-width: 880px;
      margin: 0 auto;
      padding: var(--pg1-page-margin) var(--pg1-space-gutter);
    }

    h1 {
      margin-bottom: var(--pg1-node-gap);
    }

    h2 {
      margin-top: var(--pg1-space-gutter);
      margin-bottom: var(--pg1-node-gap);
    }

    p[role='alert'] {
      margin-bottom: var(--pg1-space-gutter);
    }

    table {
      margin-bottom: var(--pg1-space-gutter);
    }

    /* Status is rendered as literal text with no distinguishing attribute
       in the template, so a minimal presentational class is unavoidable
       to tell active/inactive apart visually. */
    .status-active,
    .status-inactive {
      display: inline-block;
      font-family: var(--pg1-font-mono);
      font-size: var(--pg1-label-mono-sm-size);
      letter-spacing: var(--pg1-label-mono-sm-tracking);
      text-transform: uppercase;
      padding: calc(var(--pg1-space-unit) * 1) calc(var(--pg1-space-unit) * 2);
      border: 1px solid currentColor;
    }

    .status-active {
      color: var(--pg1-color-academic-blue);
    }

    .status-inactive {
      color: var(--pg1-color-outline);
    }

    /* Edit is the 5th table column, Activate the 6th — targeted
       structurally so Edit reads as a secondary (outline) action and
       Activate as the row's primary action, without adding a class. */
    td:nth-child(5) button {
      background: transparent;
      color: var(--pg1-color-ink);
      border: 1px solid var(--pg1-color-ink);
    }

    td:nth-child(5) button:hover {
      background: var(--pg1-ink-wash-05);
    }

    td:nth-child(6) button {
      background: var(--pg1-color-ink);
      color: var(--pg1-color-on-primary);
      border: 1.5px solid var(--pg1-color-ink);
    }

    td:nth-child(6) button:hover:not(:disabled) {
      background: var(--pg1-color-academic-blue);
      border-color: var(--pg1-color-academic-blue);
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
      max-width: 360px;
      display: flex;
      flex-direction: column;
      gap: calc(var(--pg1-space-unit) * 2);
    }

    form select,
    form input {
      width: 100%;
    }

    form small {
      margin-top: calc(var(--pg1-space-unit) * 1);
    }

    /* The lone type="button" inside the form is Cancel: secondary action. */
    form button[type='button'] {
      background: transparent;
      color: var(--pg1-color-ink);
      border: 1px solid var(--pg1-color-ink);
    }

    form button[type='button']:hover {
      background: var(--pg1-ink-wash-05);
    }
  `],
})
export class AdminProvidersPage {
  private readonly api = inject(AdminApiClient);

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
