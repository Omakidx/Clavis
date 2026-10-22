/**
 * Storage could not be used safely: the lockdown failed (secret boundary rule 1) or
 * a storage call rejected. Maps to the `STORAGE_UNAVAILABLE` error code. The message is
 * fixed so it can never carry a key or user data.
 */
export class StorageUnavailableError extends Error {
  constructor() {
    super('Secure storage is unavailable.');
    this.name = 'StorageUnavailableError';
  }
}
