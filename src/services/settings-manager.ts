import {
  RUNTIME_FEATURES,
  getEffectiveSecrets,
  getRuntimeConfigSnapshot,
  getSecretState,
  isFeatureEnabled,
  setSecretValue,
  validateSecret,
  verifySecretWithApi,
  type RuntimeSecretKey,
} from './runtime-config';
import { PLAINTEXT_KEYS, MASKED_SENTINEL } from './settings-constants';

export class SettingsManager {
  private pendingSecrets = new Map<RuntimeSecretKey, string>();
  private validatedKeys = new Map<RuntimeSecretKey, boolean>();
  private validationMessages = new Map<RuntimeSecretKey, string>();

  captureUnsavedInputs(container: HTMLElement): void {
    container.querySelectorAll<HTMLInputElement>('input[data-secret]').forEach((input) => {
      const key = input.dataset.secret as RuntimeSecretKey | undefined;
      if (!key) return;
      const raw = input.value.trim();
      if (!raw || raw === MASKED_SENTINEL) return;
      if (PLAINTEXT_KEYS.has(key) && !this.pendingSecrets.has(key)) {
        const stored = getRuntimeConfigSnapshot().secrets[key]?.value || '';
        if (raw === stored) return;
      }
      this.pendingSecrets.set(key, raw);
      const result = validateSecret(key, raw);
      if (!result.valid) {
        this.validatedKeys.set(key, false);
        this.validationMessages.set(key, result.hint || 'Invalid format');
      }
    });
    const modelSelect = container.querySelector<HTMLSelectElement>('select[data-model-select]');
    const modelManual = container.querySelector<HTMLInputElement>('input[data-model-manual]');
    const modelValue = (modelManual && !modelManual.classList.contains('hidden-input') ? modelManual.value.trim() : modelSelect?.value) || '';
    if (modelValue && !this.pendingSecrets.has('OLLAMA_MODEL')) {
      this.pendingSecrets.set('OLLAMA_MODEL', modelValue);
      this.validatedKeys.set('OLLAMA_MODEL', true);
    }
  }

  hasPendingChanges(): boolean {
    return this.pendingSecrets.size > 0;
  }

  getMissingRequiredSecrets(): string[] {
    const missing: string[] = [];
    for (const feature of RUNTIME_FEATURES) {
      if (!isFeatureEnabled(feature.id)) continue;
      const secrets = getEffectiveSecrets(feature);
      const hasPending = secrets.some(k => this.pendingSecrets.has(k));
      if (!hasPending) continue;
      for (const key of secrets) {
        if (!getSecretState(key).valid && !this.pendingSecrets.has(key)) {
          missing.push(key);
        }
      }
    }
    return missing;
  }

  getValidationErrors(): string[] {
    const errors: string[] = [];
    for (const [key, value] of this.pendingSecrets) {
      const result = validateSecret(key, value);
      if (!result.valid) errors.push(`${key}: ${result.hint || 'Invalid format'}`);
    }
    return errors;
  }

  async verifyPendingSecrets(): Promise<string[]> {
    const errors: string[] = [];
    const context = Object.fromEntries(this.pendingSecrets.entries()) as Partial<Record<RuntimeSecretKey, string>>;

    const toVerifyRemotely: Array<[RuntimeSecretKey, string]> = [];
    for (const [key, value] of this.pendingSecrets) {
      const localResult = validateSecret(key, value);
      if (!localResult.valid) {
        this.validatedKeys.set(key, false);
        this.validationMessages.set(key, localResult.hint || 'Invalid format');
        errors.push(`${key}: ${localResult.hint || 'Invalid format'}`);
      } else {
        toVerifyRemotely.push([key, value]);
      }
    }

    if (toVerifyRemotely.length > 0) {
      const results = await Promise.race([
        Promise.all(toVerifyRemotely.map(async ([key, value]) => {
          const result = await verifySecretWithApi(key, value, context);
          return { key, result };
        })),
        new Promise<Array<{ key: RuntimeSecretKey; result: { valid: boolean; message?: string } }>>(resolve =>
          setTimeout(() => resolve(toVerifyRemotely.map(([key]) => ({
            key, result: { valid: true, message: 'Saved (verification timed out)' },
          }))), 15000)
        ),
      ]);
      for (const { key, result: verifyResult } of results) {
        this.validatedKeys.set(key, verifyResult.valid);
        if (!verifyResult.valid) {
          this.validationMessages.set(key, verifyResult.message || 'Verification failed');
          errors.push(`${key}: ${verifyResult.message || 'Verification failed'}`);
        } else {
          this.validationMessages.delete(key);
        }
      }
    }

    return errors;
  }

  async commitVerifiedSecrets(): Promise<void> {
    for (const [key, value] of this.pendingSecrets) {
      if (this.validatedKeys.get(key) !== false) {
        await setSecretValue(key, value);
        this.pendingSecrets.delete(key);
        this.validatedKeys.delete(key);
        this.validationMessages.delete(key);
      }
    }
  }

  setPending(key: RuntimeSecretKey, value: string): void {
    this.pendingSecrets.set(key, value);
  }

  getPending(key: RuntimeSecretKey): string | undefined {
    return this.pendingSecrets.get(key);
  }

  hasPending(key: RuntimeSecretKey): boolean {
    return this.pendingSecrets.has(key);
  }

  deletePending(key: RuntimeSecretKey): void {
    this.pendingSecrets.delete(key);
    this.validatedKeys.delete(key);
    this.validationMessages.delete(key);
  }

  setValidation(key: RuntimeSecretKey, valid: boolean, message?: string): void {
    this.validatedKeys.set(key, valid);
    if (message) {
      this.validationMessages.set(key, message);
    } else {
      this.validationMessages.delete(key);
    }
  }

  getValidationState(key: RuntimeSecretKey): { validated?: boolean; message?: string } {
    return {
      validated: this.validatedKeys.get(key),
      message: this.validationMessages.get(key),
    };
  }

  destroy(): void {
    this.pendingSecrets.clear();
    this.validatedKeys.clear();
    this.validationMessages.clear();
  }
}
