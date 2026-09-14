// TabVault — Site-Specific Adapter Timeout & Cancellation Engine

import { AdapterTimeoutError } from "./base.js";

export const DEFAULT_ADAPTER_TIMEOUT_MS = 3000;
export const MIN_ADAPTER_TIMEOUT_MS = 50;
export const MAX_ADAPTER_TIMEOUT_MS = 30000;

/**
 * Normalizes and clamps an adapter timeout value within acceptable bounds.
 *
 * @param {any} value
 * @param {number} [defaultMs=DEFAULT_ADAPTER_TIMEOUT_MS]
 * @returns {number}
 */
export function normalizeAdapterTimeout(value, defaultMs = DEFAULT_ADAPTER_TIMEOUT_MS) {
  if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
    return defaultMs;
  }
  return Math.min(Math.max(Math.floor(value), MIN_ADAPTER_TIMEOUT_MS), MAX_ADAPTER_TIMEOUT_MS);
}

/**
 * Wraps an adapter async action (capture, restore, or custom) in a strict timeout
 * with AbortSignal cancellation support and resource cleanup.
 *
 * @template T
 * @param {Promise<T>|(() => Promise<T>)} action - Promise or factory function returning a promise
 * @param {object} options
 * @param {string} [options.adapterId="adapter"] - Adapter ID for error diagnostics
 * @param {"capture"|"restore"|string} [options.stage="execution"] - Lifecycle stage
 * @param {number} [options.timeoutMs=DEFAULT_ADAPTER_TIMEOUT_MS] - Maximum duration in ms
 * @param {AbortSignal} [options.signal] - Optional abort signal
 * @returns {Promise<T>}
 */
export async function withAdapterTimeout(action, options = {}) {
  const adapterId = options.adapterId || "adapter";
  const stage = options.stage || "execution";
  const timeoutMs = normalizeAdapterTimeout(options.timeoutMs, DEFAULT_ADAPTER_TIMEOUT_MS);
  const signal = options.signal;

  if (signal?.aborted) {
    throw signal.reason || new Error(`[Adapter:${adapterId}:${stage}] Operation aborted before start`);
  }

  let timer = null;
  let abortListener = null;

  try {
    const promise = typeof action === "function" ? action() : action;

    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new AdapterTimeoutError(adapterId, stage, timeoutMs));
      }, timeoutMs);

      if (signal) {
        abortListener = () => {
          reject(signal.reason || new Error(`[Adapter:${adapterId}:${stage}] Operation aborted`));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
    });

    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (signal && abortListener) {
      signal.removeEventListener("abort", abortListener);
      abortListener = null;
    }
  }
}
