/**
 * TabVault Form State Restoration Engine
 * Provides privacy-first, secure, resilient capture and restoration of user form inputs
 * across standard inputs, textareas, selects, checkboxes, radios, and contenteditable elements.
 */

import {
  isPasswordField,
  isCreditCardField,
  looksLikeCreditCardNumber,
  CREDIT_CARD_FIELD_PATTERN,
  isAuthenticationField,
  AUTHENTICATION_FIELD_PATTERN,
  VALUE_SECRET_PATTERN,
  detectSensitiveField,
  registerCustomSensitivePattern,
  getCustomSensitivePatterns,
  clearCustomSensitivePatterns,
  normalizeExcludedDomain,
  addExcludedDomain,
  removeExcludedDomain,
  getExcludedDomains,
  clearExcludedDomains,
  isDomainExcluded,
  DEFAULT_FORM_SAVING_SETTINGS,
  getFormSavingSettings,
  setFormSavingSettings,
  resetFormSavingSettings,
  isFormSavingEnabled,
  setFormSavingEnabled,
  isSensitiveField,
  isSensitiveUrl,
  isBankingOrAuthUrl,
  BANKING_AUTH_URL_PATTERN,
  sanitizeFormData,
  serializeSafeDomForms,
  SENSITIVE_FIELD_PATTERN,
  SENSITIVE_URL_PATTERN,
  MAX_FORM_FIELD_VALUE_LENGTH,
  MAX_FORM_FIELDS_PER_SNAPSHOT
} from "./snapshot.js";

export {
  isPasswordField,
  isCreditCardField,
  looksLikeCreditCardNumber,
  CREDIT_CARD_FIELD_PATTERN,
  isAuthenticationField,
  AUTHENTICATION_FIELD_PATTERN,
  VALUE_SECRET_PATTERN,
  detectSensitiveField,
  registerCustomSensitivePattern,
  getCustomSensitivePatterns,
  clearCustomSensitivePatterns,
  normalizeExcludedDomain,
  addExcludedDomain,
  removeExcludedDomain,
  getExcludedDomains,
  clearExcludedDomains,
  isDomainExcluded,
  DEFAULT_FORM_SAVING_SETTINGS,
  getFormSavingSettings,
  setFormSavingSettings,
  resetFormSavingSettings,
  isFormSavingEnabled,
  setFormSavingEnabled,
  isSensitiveField,
  isSensitiveUrl,
  isBankingOrAuthUrl,
  BANKING_AUTH_URL_PATTERN,
  sanitizeFormData,
  serializeSafeDomForms,
  SENSITIVE_FIELD_PATTERN,
  SENSITIVE_URL_PATTERN,
  MAX_FORM_FIELD_VALUE_LENGTH,
  MAX_FORM_FIELDS_PER_SNAPSHOT
};

/**
 * Text-compatible input types safely supported by restoreTextInput.
 */
export const TEXT_COMPATIBLE_INPUT_TYPES = Object.freeze([
  "text",
  "search",
  "url",
  "tel",
  "email",
  "number"
]);

/**
 * Safely dispatches standard DOM events to ensure reactive frameworks (React, Vue, etc.)
 * detect programmatic value changes.
 * @param {HTMLElement} element
 * @param {string[]} [eventNames=["input", "change"]]
 */
export function dispatchFormInputEvents(element, eventNames = ["input", "change"]) {
  if (!element || typeof element.dispatchEvent !== "function") return;
  for (const name of eventNames) {
    try {
      const evt = typeof Event === "function"
        ? new Event(name, { bubbles: true, cancelable: true })
        : { type: name, bubbles: true };
      element.dispatchEvent(evt);
    } catch (_) { /* ignore if event creation fails */ }
  }
}

function safeEscapeCss(str) {
  if (!str) return "";
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(str);
  }
  return String(str).replace(/["'\\]/g, "\\$&");
}

/**
 * Locates a target DOM element based on snapshot field identifiers (id, name, selector, fallback).
 * @param {object} field - Saved field descriptor { id, name, selector, type }
 * @param {Document} doc
 * @returns {HTMLElement|null}
 */
export function findMatchingFormElement(field, doc) {
  if (!field || !doc || typeof doc.querySelector !== "function") return null;

  // 1. Match by ID
  if (field.id) {
    if (typeof doc.getElementById === "function") {
      const el = doc.getElementById(field.id);
      if (el) return el;
    }
    try {
      const el = doc.querySelector(`#${safeEscapeCss(field.id)}`);
      if (el) return el;
    } catch (_) {}
  }

  // 2. Match by selector
  if (field.selector) {
    try {
      const el = doc.querySelector(field.selector);
      if (el) return el;
    } catch (_) {}
  }

  // 3. Match by name and tag/type
  if (field.name) {
    try {
      const escapedName = safeEscapeCss(field.name);
      const type = (field.type || "").toLowerCase();
      if (type === "select") {
        const el = doc.querySelector(`select[name="${escapedName}"]`);
        if (el) return el;
      } else if (type === "textarea") {
        const el = doc.querySelector(`textarea[name="${escapedName}"]`);
        if (el) return el;
      } else if (type === "checkbox" || type === "radio") {
        if (field.value) {
          const escapedVal = safeEscapeCss(field.value);
          const el = doc.querySelector(`input[type="${type}"][name="${escapedName}"][value="${escapedVal}"]`);
          if (el) return el;
        }
        const el = doc.querySelector(`input[type="${type}"][name="${escapedName}"]`);
        if (el) return el;
      } else {
        const el = doc.querySelector(`input[name="${escapedName}"]`);
        if (el) return el;
      }
      // General name match
      const general = doc.querySelector(`[name="${escapedName}"]`);
      if (general) return general;
    } catch (_) {}
  }

  return null;
}

/**
 * Safely restores the value of an `input[type=text]` or text-compatible input element.
 * Verifies that the field is not sensitive before applying the value.
 * @param {object} field - Saved field data { id, name, selector, value, type }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   value: string|null
 * }}
 */
export function restoreTextInput(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", value: null };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Element not found for selector: ${field.selector || field.name || field.id}`, value: null };
  }

  // Security guard: ensure element is not password/sensitive
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: element.type || field.type,
      name: element.name || field.name,
      id: element.id || field.id,
      autocomplete: element.autocomplete,
      placeholder: element.placeholder
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: field contains sensitive keywords or password/card attributes",
        value: null
      };
    }
  }

  const targetValue = typeof field.value === "string"
    ? field.value.slice(0, MAX_FORM_FIELD_VALUE_LENGTH)
    : (field.value !== undefined && field.value !== null ? String(field.value) : "");

  try {
    element.value = targetValue;
    dispatchFormInputEvents(element, ["input", "change"]);
    return {
      success: true,
      skipped: false,
      field,
      error: null,
      value: element.value
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      value: null
    };
  }
}

/**
 * Safely restores the value of a `textarea` element.
 * Verifies that the field is not sensitive before applying the value.
 * @param {object} field - Saved field data { id, name, selector, value }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   value: string|null
 * }}
 */
export function restoreTextarea(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", value: null };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Textarea not found for selector: ${field.selector || field.name || field.id}`, value: null };
  }

  // Security guard: ensure textarea is not sensitive
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: "textarea",
      name: element.name || field.name,
      id: element.id || field.id,
      placeholder: element.placeholder
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: textarea contains sensitive keywords",
        value: null
      };
    }
  }

  const targetValue = typeof field.value === "string"
    ? field.value.slice(0, MAX_FORM_FIELD_VALUE_LENGTH)
    : (field.value !== undefined && field.value !== null ? String(field.value) : "");

  try {
    element.value = targetValue;
    dispatchFormInputEvents(element, ["input", "change"]);
    return {
      success: true,
      skipped: false,
      field,
      error: null,
      value: element.value
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      value: null
    };
  }
}

/**
 * Safely restores the selected value or index of a `select` dropdown element.
 * Supports single and multiple select elements.
 * @param {object} field - Saved field data { id, name, selector, value, selectedIndex, values }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   value: string|string[]|null,
 *   selectedIndex: number
 * }}
 */
export function restoreSelect(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", value: null, selectedIndex: -1 };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Select element not found for selector: ${field.selector || field.name || field.id}`, value: null, selectedIndex: -1 };
  }

  // Security guard: ensure select is not sensitive (e.g. security questions)
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: "select",
      name: element.name || field.name,
      id: element.id || field.id
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: select element contains sensitive keywords",
        value: null,
        selectedIndex: -1
      };
    }
  }

  try {
    // Multi-select support
    if (element.multiple && (Array.isArray(field.values) || Array.isArray(field.value))) {
      const targetValues = Array.isArray(field.values) ? field.values : field.value;
      if (element.options) {
        for (let i = 0; i < element.options.length; i++) {
          const opt = element.options[i];
          opt.selected = targetValues.includes(opt.value);
        }
      }
    } else {
      // Single-select support
      if (typeof field.value === "string" && field.value !== "") {
        element.value = field.value;
      }
      if (typeof field.selectedIndex === "number" && field.selectedIndex >= 0) {
        if (element.selectedIndex !== field.selectedIndex && (!field.value || element.value !== field.value)) {
          element.selectedIndex = field.selectedIndex;
        }
      }
    }

    dispatchFormInputEvents(element, ["change", "input"]);

    return {
      success: true,
      skipped: false,
      field,
      error: null,
      value: element.value,
      selectedIndex: element.selectedIndex ?? -1
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      value: null,
      selectedIndex: -1
    };
  }
}

/**
 * Safely restores the checked state of a `checkbox` input element.
 * Verifies that the field is not sensitive before applying the checked status.
 * @param {object} field - Saved field data { id, name, selector, checked, value }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   checked: boolean
 * }}
 */
export function restoreCheckbox(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", checked: false };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Checkbox not found for selector: ${field.selector || field.name || field.id}`, checked: false };
  }

  // Security guard: ensure checkbox is not sensitive
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: "checkbox",
      name: element.name || field.name,
      id: element.id || field.id,
      ariaLabel: element.ariaLabel || field.ariaLabel
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: checkbox contains sensitive keywords",
        checked: Boolean(element.checked)
      };
    }
  }

  const shouldBeChecked = field.checked !== undefined
    ? Boolean(field.checked)
    : (field.value === true || field.value === "true" || field.value === "1" || field.value === "on");

  try {
    element.checked = shouldBeChecked;
    dispatchFormInputEvents(element, ["change", "input"]);

    return {
      success: true,
      skipped: false,
      field,
      error: null,
      checked: Boolean(element.checked)
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      checked: false
    };
  }
}

/**
 * Safely restores the checked state of a `radio` button element.
 * Verifies that the field is not sensitive before selecting the radio option.
 * @param {object} field - Saved field data { id, name, selector, checked, value }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   checked: boolean
 * }}
 */
export function restoreRadio(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", checked: false };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Radio button not found for selector: ${field.selector || field.name || field.id}`, checked: false };
  }

  // Security guard: ensure radio group is not sensitive
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: "radio",
      name: element.name || field.name,
      id: element.id || field.id,
      ariaLabel: element.ariaLabel || field.ariaLabel
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: radio element contains sensitive keywords",
        checked: Boolean(element.checked)
      };
    }
  }

  const shouldBeChecked = field.checked !== undefined
    ? Boolean(field.checked)
    : true;

  try {
    element.checked = shouldBeChecked;
    dispatchFormInputEvents(element, ["change", "input"]);

    return {
      success: true,
      skipped: false,
      field,
      error: null,
      checked: Boolean(element.checked)
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      checked: false
    };
  }
}

/**
 * Safely restores the content of a `contenteditable` element.
 * Verifies that the field is not sensitive before applying the text content.
 * Sanitizes and sets textContent by default to prevent XSS.
 * @param {object} field - Saved field data { id, selector, text, html }
 * @param {Document} doc
 * @param {object} [options]
 * @param {boolean} [options.bypassSensitivityCheck=false]
 * @param {boolean} [options.allowHtmlRestoration=false]
 * @returns {{
 *   success: boolean,
 *   skipped: boolean,
 *   field: object,
 *   error: string|null,
 *   text: string|null
 * }}
 */
export function restoreContentEditable(field, doc, options = {}) {
  if (!field || typeof field !== "object") {
    return { success: false, skipped: false, field, error: "Invalid field descriptor", text: null };
  }

  const element = findMatchingFormElement(field, doc);
  if (!element) {
    return { success: false, skipped: false, field, error: `Contenteditable element not found for selector: ${field.selector || field.id}`, text: null };
  }

  // Security guard: ensure element is not sensitive
  if (!options.bypassSensitivityCheck) {
    const isSensitive = isSensitiveField({
      type: "contenteditable",
      name: (element.getAttribute && element.getAttribute("name")) || field.name,
      id: element.id || field.id,
      ariaLabel: element.ariaLabel || field.ariaLabel
    });

    if (isSensitive) {
      return {
        success: false,
        skipped: true,
        field,
        error: "Restoration skipped: contenteditable contains sensitive keywords",
        text: null
      };
    }
  }

  const targetText = typeof field.text === "string"
    ? field.text.slice(0, MAX_FORM_FIELD_VALUE_LENGTH)
    : (typeof field.value === "string" ? field.value.slice(0, MAX_FORM_FIELD_VALUE_LENGTH) : "");

  try {
    if (options.allowHtmlRestoration && typeof field.html === "string" && field.html !== "") {
      element.innerHTML = field.html.slice(0, MAX_FORM_FIELD_VALUE_LENGTH);
    } else {
      element.textContent = targetText;
      if (element.innerText !== undefined) {
        element.innerText = targetText;
      }
    }

    dispatchFormInputEvents(element, ["input", "change"]);

    return {
      success: true,
      skipped: false,
      field,
      error: null,
      text: element.textContent || element.innerText || targetText
    };
  } catch (err) {
    return {
      success: false,
      skipped: false,
      field,
      error: err.message,
      text: null
    };
  }
}

/**
 * Restores a batch of serialized form fields on the document.
 * @param {Array<object>} formFields - Array of safe serialized form descriptors
 * @param {Document} doc
 * @param {object} [options]
 * @returns {{
 *   totalProcessed: number,
 *   restoredCount: number,
 *   skippedCount: number,
 *   failedCount: number,
 *   details: Array<object>
 * }}
 */
export function restoreFormState(formFields = [], doc, options = {}) {
  if (!Array.isArray(formFields) || !doc) {
    return {
      totalProcessed: 0,
      restoredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      details: []
    };
  }

  const settings = {
    ...getFormSavingSettings(),
    ...options
  };

  if (!settings.enabled || settings.mode === "disabled" || options.restoreFormsEnabled === false) {
    return {
      totalProcessed: formFields.length,
      restoredCount: 0,
      skippedCount: formFields.length,
      failedCount: 0,
      details: formFields.map(f => ({
        success: false,
        skipped: true,
        field: f,
        error: "Restoration skipped: form saving/restoration is disabled by user setting",
        value: null
      }))
    };
  }

  const activeExclusions = [
    ...(settings.excludedDomains || []),
    ...(options.excludedDomains || [])
  ];

  // Domain exclusions guard
  if (options.url && isDomainExcluded(options.url, activeExclusions)) {
    return {
      totalProcessed: formFields.length,
      restoredCount: 0,
      skippedCount: formFields.length,
      failedCount: 0,
      details: formFields.map(f => ({
        success: false,
        skipped: true,
        field: f,
        error: "Restoration skipped: domain is excluded from form restoration",
        value: null
      }))
    };
  }

  // Banking and authentication websites guard
  if (options.url && !settings.allowSensitiveUrls && isBankingOrAuthUrl(options.url, activeExclusions)) {
    return {
      totalProcessed: formFields.length,
      restoredCount: 0,
      skippedCount: formFields.length,
      failedCount: 0,
      details: formFields.map(f => ({
        success: false,
        skipped: true,
        field: f,
        error: "Restoration skipped: form data restoration on banking/authentication websites is disabled by default",
        value: null
      }))
    };
  }

  const details = [];
  let restoredCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const field of formFields) {
    if (!field || typeof field !== "object") continue;
    const type = (field.type || "text").toLowerCase();

    let result;
    if (type === "textarea") {
      if (settings.saveTextareas === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: textarea saving disabled by user setting", value: null };
      } else {
        result = restoreTextarea(field, doc, options);
      }
    } else if (type === "select") {
      if (settings.saveSelects === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: select saving disabled by user setting", value: null };
      } else {
        result = restoreSelect(field, doc, options);
      }
    } else if (type === "checkbox") {
      if (settings.saveCheckboxes === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: checkbox saving disabled by user setting", value: null };
      } else {
        result = restoreCheckbox(field, doc, options);
      }
    } else if (type === "radio") {
      if (settings.saveRadios === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: radio saving disabled by user setting", value: null };
      } else {
        result = restoreRadio(field, doc, options);
      }
    } else if (type === "contenteditable") {
      if (settings.saveContentEditable === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: contenteditable saving disabled by user setting", value: null };
      } else {
        result = restoreContentEditable(field, doc, options);
      }
    } else {
      if (settings.saveTextInputs === false) {
        result = { success: false, skipped: true, field, error: "Restoration skipped: text input saving disabled by user setting", value: null };
      } else {
        result = restoreTextInput(field, doc, options);
      }
    }

    details.push(result);
    if (result.success) {
      restoredCount++;
    } else if (result.skipped) {
      skippedCount++;
    } else {
      failedCount++;
    }
  }

  return {
    totalProcessed: formFields.length,
    restoredCount,
    skippedCount,
    failedCount,
    details
  };
}
