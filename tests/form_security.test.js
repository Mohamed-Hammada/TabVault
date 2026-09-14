import test from "node:test";
import assert from "node:assert/strict";
import {
  isPasswordField,
  isCreditCardField,
  looksLikeCreditCardNumber,
  isAuthenticationField,
  detectSensitiveField,
  registerCustomSensitivePattern,
  clearCustomSensitivePatterns,
  normalizeExcludedDomain,
  addExcludedDomain,
  removeExcludedDomain,
  getExcludedDomains,
  clearExcludedDomains,
  isDomainExcluded,
  isSensitiveField,
  isSensitiveUrl,
  isBankingOrAuthUrl,
  BANKING_AUTH_URL_PATTERN,
  sanitizeFormData,
  serializeSafeDomForms,
  restoreTextInput,
  restoreFormState,
  DEFAULT_FORM_SAVING_SETTINGS,
  getFormSavingSettings,
  setFormSavingSettings,
  resetFormSavingSettings,
  isFormSavingEnabled,
  setFormSavingEnabled
} from "../lib/form.js";
import { createTabSnapshot } from "../lib/snapshot.js";

function createMockElement(attributes = {}) {
  const dispatchedEvents = [];
  return {
    tagName: attributes.tagName || "INPUT",
    type: attributes.type || "text",
    id: attributes.id || "",
    name: attributes.name || "",
    value: attributes.value || "",
    checked: Boolean(attributes.checked),
    placeholder: attributes.placeholder || "",
    autocomplete: attributes.autocomplete || "",
    ariaLabel: attributes.ariaLabel || "",
    dispatchedEvents,
    dispatchEvent(evt) {
      dispatchedEvents.push(evt.type);
    }
  };
}

function createMockDocument(elements = []) {
  return {
    elements,
    querySelectorAll(selector) {
      return elements;
    },
    getElementById(id) {
      return elements.find(el => el.id === id) || null;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return elements.find(el => el.id === id) || null;
      }
      return null;
    }
  };
}

test("isPasswordField accurately detects type=password and password-related attributes", () => {
  assert.equal(isPasswordField({ type: "password" }), true);
  assert.equal(isPasswordField({ type: "text", name: "user_password" }), true);
  assert.equal(isPasswordField({ type: "text", id: "login_pwd" }), true);
  assert.equal(isPasswordField({ type: "text", autocomplete: "current-password" }), true);
  assert.equal(isPasswordField({ type: "text", autocomplete: "new-password" }), true);
  assert.equal(isPasswordField({ type: "text", placeholder: "Enter master passcode" }), true);

  // Safe fields must return false
  assert.equal(isPasswordField({ type: "text", name: "username" }), false);
  assert.equal(isPasswordField({ type: "text", name: "search_query" }), false);
  assert.equal(isPasswordField({ type: "email", name: "email_address" }), false);
});

test("Never save passwords by default: serializeSafeDomForms omits all password fields", () => {
  const normalInput = createMockElement({ id: "username", name: "username", type: "text", value: "alice" });
  const passwordInput = createMockElement({ id: "password", name: "password", type: "password", value: "superSecret!" });
  const disguisedPassword = createMockElement({ id: "pwd_field", name: "master_password", type: "text", value: "hiddenPass" });

  const doc = createMockDocument([normalInput, passwordInput, disguisedPassword]);
  const safeData = serializeSafeDomForms(doc, "https://example.com/login");

  // Since example.com/login is considered a sensitive URL, serializeSafeDomForms returns null by default
  assert.equal(safeData, null);

  // On a non-sensitive URL, password fields must still be stripped
  const safeNonAuth = serializeSafeDomForms(doc, "https://example.com/settings");
  assert.notEqual(safeNonAuth, null);
  assert.equal(safeNonAuth.length, 1);
  assert.equal(safeNonAuth[0].id, "username");
  assert.equal(safeNonAuth[0].value, "alice");

  // Confirm neither the type=password nor the disguised password were saved
  const savedIds = safeNonAuth.map(f => f.id);
  assert.equal(savedIds.includes("password"), false);
  assert.equal(savedIds.includes("pwd_field"), false);
});

test("sanitizeFormData purges passwords from untrusted form descriptors", () => {
  const rawForms = [
    { type: "text", name: "comment", value: "Great post!" },
    { type: "password", name: "pass", value: "123456" },
    { type: "text", name: "passcode", value: "9876" }
  ];

  const sanitized = sanitizeFormData(rawForms);
  assert.equal(sanitized.length, 1);
  assert.equal(sanitized[0].name, "comment");
  assert.equal(sanitized[0].value, "Great post!");
});

test("restoreTextInput and restoreFormState skip password restoration by default", () => {
  const pwdEl = createMockElement({ id: "user_password", type: "password", value: "" });
  const doc = createMockDocument([pwdEl]);

  const res = restoreTextInput({
    id: "user_password",
    type: "password",
    value: "compromisedPassword"
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(pwdEl.value, "");

  const batchResult = restoreFormState([{
    id: "user_password",
    type: "password",
    value: "compromisedPassword"
  }], doc);

  assert.equal(batchResult.restoredCount, 0);
  assert.equal(batchResult.skippedCount, 1);
  assert.equal(pwdEl.value, "");
});

test("looksLikeCreditCardNumber accurately validates Luhn numbers and rejects invalid sequences", () => {
  // Common test cards that satisfy Luhn:
  assert.equal(looksLikeCreditCardNumber("4532015112830366"), true);
  assert.equal(looksLikeCreditCardNumber("4532-0151-1283-0366"), true);
  assert.equal(looksLikeCreditCardNumber("4532 0151 1283 0366"), true);

  // Invalid sequences:
  assert.equal(looksLikeCreditCardNumber("4532015112830367"), false);
  assert.equal(looksLikeCreditCardNumber("12345"), false); // too short
  assert.equal(looksLikeCreditCardNumber("abc1234567890123"), false);
  assert.equal(looksLikeCreditCardNumber(null), false);
});

test("isCreditCardField identifies credit card attributes, CVV, expiry, and cardholder", () => {
  assert.equal(isCreditCardField({ autocomplete: "cc-number" }), true);
  assert.equal(isCreditCardField({ autocomplete: "cc-csc" }), true);
  assert.equal(isCreditCardField({ autocomplete: "cc-exp" }), true);
  assert.equal(isCreditCardField({ name: "credit_card_number" }), true);
  assert.equal(isCreditCardField({ id: "cvv_input" }), true);
  assert.equal(isCreditCardField({ placeholder: "Cardholder name" }), true);
  assert.equal(isCreditCardField({ name: "iban_code" }), true);
  assert.equal(isCreditCardField({ name: "swift_code" }), true);

  // Detection via value matching Luhn
  assert.equal(isCreditCardField({ name: "generic_input", value: "4532015112830366" }), true);

  // Safe non-financial fields
  assert.equal(isCreditCardField({ name: "postal_code", value: "90210" }), false);
  assert.equal(isCreditCardField({ name: "order_notes", value: "Please deliver after 5pm" }), false);
});

test("Never save credit-card fields: serializeSafeDomForms and sanitizeFormData exclude all card data", () => {
  const cardInput = createMockElement({ id: "card_num", name: "cc_number", type: "text", value: "4532015112830366" });
  const cvvInput = createMockElement({ id: "card_cvv", name: "cvv", type: "text", value: "123" });
  const expiryInput = createMockElement({ id: "card_exp", name: "exp_date", type: "text", value: "12/28" });
  const commentInput = createMockElement({ id: "order_comment", name: "comment", type: "text", value: "Gift wrap please" });

  const doc = createMockDocument([cardInput, cvvInput, expiryInput, commentInput]);
  const serialized = serializeSafeDomForms(doc, "https://shop.example.org/customer-inquiry");

  assert.notEqual(serialized, null);
  assert.equal(serialized.length, 1);
  assert.equal(serialized[0].id, "order_comment");
  assert.equal(serialized[0].value, "Gift wrap please");

  // Verify none of the card fields made it through
  const savedIds = serialized.map(f => f.id);
  assert.equal(savedIds.includes("card_num"), false);
  assert.equal(savedIds.includes("card_cvv"), false);
  assert.equal(savedIds.includes("card_exp"), false);
});

test("isAuthenticationField identifies 2FA, OTP, security questions, API keys, tokens, and PINs", () => {
  assert.equal(isAuthenticationField({ autocomplete: "one-time-code" }), true);
  assert.equal(isAuthenticationField({ name: "mfa_token" }), true);
  assert.equal(isAuthenticationField({ id: "otp_code_input" }), true);
  assert.equal(isAuthenticationField({ name: "security_question_1" }), true);
  assert.equal(isAuthenticationField({ name: "secret_answer" }), true);
  assert.equal(isAuthenticationField({ placeholder: "Enter your 6-digit verification code" }), true);
  assert.equal(isAuthenticationField({ name: "api_key" }), true);
  assert.equal(isAuthenticationField({ name: "private_key" }), true);
  assert.equal(isAuthenticationField({ name: "access_token" }), true);
  assert.equal(isAuthenticationField({ id: "bearer_token" }), true);
  assert.equal(isAuthenticationField({ name: "pin_code" }), true);
  assert.equal(isAuthenticationField({ name: "ssn_input" }), true);

  // Safe standard fields
  assert.equal(isAuthenticationField({ name: "user_bio" }), false);
  assert.equal(isAuthenticationField({ name: "display_name" }), false);
});

test("Never save sensitive authentication fields: serializeSafeDomForms and sanitizeFormData exclude auth fields", () => {
  const otpInput = createMockElement({ id: "two_factor_code", name: "2fa_code", type: "text", value: "654321" });
  const keyInput = createMockElement({ id: "auth_key", name: "api_key", type: "text", value: "sk-proj-abcdef12345" });
  const commentInput = createMockElement({ id: "feedback_text", name: "feedback", type: "text", value: "Loving the app!" });

  const doc = createMockDocument([otpInput, keyInput, commentInput]);
  const serialized = serializeSafeDomForms(doc, "https://example.org/feedback-page");

  assert.notEqual(serialized, null);
  assert.equal(serialized.length, 1);
  assert.equal(serialized[0].id, "feedback_text");
  assert.equal(serialized[0].value, "Loving the app!");

  const savedIds = serialized.map(f => f.id);
  assert.equal(savedIds.includes("two_factor_code"), false);
  assert.equal(savedIds.includes("auth_key"), false);
});

test("detectSensitiveField categorizes sensitive fields and provides diagnostics", () => {
  const pwd = detectSensitiveField({ type: "password", name: "user_password" });
  assert.equal(pwd.isSensitive, true);
  assert.equal(pwd.category, "password");
  assert.equal(pwd.matchedRule, "isPasswordField");

  const cc = detectSensitiveField({ name: "credit_card_number" });
  assert.equal(cc.isSensitive, true);
  assert.equal(cc.category, "credit_card");

  const auth = detectSensitiveField({ name: "mfa_token" });
  assert.equal(auth.isSensitive, true);
  assert.equal(auth.category, "authentication");

  const hidden = detectSensitiveField({ type: "hidden", name: "tracking_id" });
  assert.equal(hidden.isSensitive, true);
  assert.equal(hidden.category, "hidden_or_file");

  const secretVal = detectSensitiveField({ name: "custom_key", value: "sk_live_123456789012345678" });
  assert.equal(secretVal.isSensitive, true);
  assert.equal(secretVal.category, "value_secret");

  const safe = detectSensitiveField({ type: "text", name: "favorite_color", value: "blue" });
  assert.equal(safe.isSensitive, false);
  assert.equal(safe.category, null);
});

test("detectSensitiveField supports custom sensitive patterns and global registration", () => {
  clearCustomSensitivePatterns();

  // Test custom pattern passed via options
  const optionMatch = detectSensitiveField({ name: "internal_employee_id" }, {
    customPatterns: [/employee_id/i]
  });
  assert.equal(optionMatch.isSensitive, true);
  assert.equal(optionMatch.category, "custom");

  // Test globally registered pattern
  registerCustomSensitivePattern("project_ares");
  const globalMatch = detectSensitiveField({ name: "project_ares_identifier" });
  assert.equal(globalMatch.isSensitive, true);
  assert.equal(globalMatch.category, "custom");

  clearCustomSensitivePatterns();
  const clearedMatch = detectSensitiveField({ name: "project_ares_identifier" });
  assert.equal(clearedMatch.isSensitive, false);
});

test("normalizeExcludedDomain normalizes protocols, paths, and wildcards correctly", () => {
  assert.equal(normalizeExcludedDomain("https://mybank.com/online"), "mybank.com");
  assert.equal(normalizeExcludedDomain("http://internal.corp:8080/path"), "internal.corp:8080");
  assert.equal(normalizeExcludedDomain("*.payment-gateway.net"), "payment-gateway.net");
  assert.equal(normalizeExcludedDomain("  sub.example.com/  "), "sub.example.com");
  assert.equal(normalizeExcludedDomain(""), "");
  assert.equal(normalizeExcludedDomain(null), "");
});

test("isDomainExcluded accurately matches exact domains, subdomains, and wildcard lists", () => {
  clearExcludedDomains();
  addExcludedDomain("secure-portal.com");

  assert.equal(isDomainExcluded("https://secure-portal.com/dashboard"), true);
  assert.equal(isDomainExcluded("https://sub.secure-portal.com/app"), true);
  assert.equal(isDomainExcluded("https://another-site.com"), false);

  // Custom exclusions argument
  assert.equal(isDomainExcluded("https://internal.company.local/wiki", ["company.local"]), true);
  assert.equal(isDomainExcluded("https://public-blog.com", ["company.local"]), false);

  removeExcludedDomain("secure-portal.com");
  assert.equal(isDomainExcluded("https://secure-portal.com"), false);
});

test("Domain exclusions prevent form serialization and restoration", () => {
  clearExcludedDomains();
  addExcludedDomain("confidential-workplace.com");

  const inputEl = createMockElement({ id: "project_name", name: "project", type: "text", value: "Initial text" });
  const doc = createMockDocument([inputEl]);

  // Serialization on excluded domain returns null
  const serialized = serializeSafeDomForms(doc, "https://confidential-workplace.com/projects/new");
  assert.equal(serialized, null);

  // Restoration on excluded domain skips all fields
  const restoreRes = restoreFormState(
    [{ id: "project_name", type: "text", value: "Attempted restoration" }],
    doc,
    { url: "https://confidential-workplace.com/projects/new" }
  );
  assert.equal(restoreRes.restoredCount, 0);
  assert.equal(restoreRes.skippedCount, 1);
  assert.equal(inputEl.value, "Initial text");

  clearExcludedDomains();
});

test("User-controlled form saving settings allow configuring, toggling, and resetting behavior", () => {
  resetFormSavingSettings();
  const initial = getFormSavingSettings();
  assert.equal(initial.enabled, true);
  assert.equal(initial.mode, "safe");
  assert.equal(isFormSavingEnabled(), true);

  // Toggle off globally
  setFormSavingEnabled(false);
  assert.equal(isFormSavingEnabled(), false);
  assert.equal(getFormSavingSettings().enabled, false);

  // Toggle on
  setFormSavingEnabled(true);
  assert.equal(isFormSavingEnabled(), true);

  // Update specific field options
  setFormSavingSettings({ saveTextareas: false, saveCheckboxes: false });
  const updated = getFormSavingSettings();
  assert.equal(updated.saveTextareas, false);
  assert.equal(updated.saveCheckboxes, false);
  assert.equal(updated.saveTextInputs, true);

  // Reset to factory defaults
  const reset = resetFormSavingSettings();
  assert.equal(reset.saveTextareas, true);
  assert.equal(reset.saveCheckboxes, true);
  assert.equal(reset.enabled, true);
});

test("Disabled form saving setting prevents DOM serialization and skips restoration", () => {
  resetFormSavingSettings();
  const inputEl = createMockElement({ id: "article_title", name: "title", type: "text", value: "Draft Post" });
  const textareaEl = createMockElement({ tagName: "TEXTAREA", id: "article_body", name: "body", type: "textarea", value: "Post content" });
  const doc = createMockDocument([inputEl, textareaEl]);

  // Disable form saving
  setFormSavingEnabled(false);

  // Serialization returns null
  const serialized = serializeSafeDomForms(doc, "https://blog.example.com/edit");
  assert.equal(serialized, null);

  // Restoration skips all items
  const restoreRes = restoreFormState(
    [
      { id: "article_title", type: "text", value: "New Title" },
      { id: "article_body", type: "textarea", value: "New Body" }
    ],
    doc
  );
  assert.equal(restoreRes.restoredCount, 0);
  assert.equal(restoreRes.skippedCount, 2);
  assert.equal(inputEl.value, "Draft Post");
  assert.equal(textareaEl.value, "Post content");

  // Re-enable and verify individual field settings
  resetFormSavingSettings();
  setFormSavingSettings({ saveTextareas: false });

  const partialSerialized = serializeSafeDomForms(doc, "https://blog.example.com/edit");
  assert.notEqual(partialSerialized, null);
  assert.equal(partialSerialized.length, 1);
  assert.equal(partialSerialized[0].id, "article_title");

  // Selective restoration respects field flags
  const partialRestore = restoreFormState(
    [
      { id: "article_title", type: "text", value: "Restored Title" },
      { id: "article_body", type: "textarea", value: "Restored Body" }
    ],
    doc
  );
  assert.equal(partialRestore.restoredCount, 1);
  assert.equal(partialRestore.skippedCount, 1);
  assert.equal(inputEl.value, "Restored Title");
  assert.equal(textareaEl.value, "Post content"); // textarea was skipped!

  resetFormSavingSettings();
});

test("isBankingOrAuthUrl and BANKING_AUTH_URL_PATTERN detect banking and auth endpoints", () => {
  // Authentication URLs
  assert.equal(isBankingOrAuthUrl("https://accounts.google.com/signin/v2/identifier"), true);
  assert.equal(isBankingOrAuthUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize"), true);
  assert.equal(isBankingOrAuthUrl("https://github.com/login"), true);
  assert.equal(isBankingOrAuthUrl("https://github.com/session"), true);
  assert.equal(isBankingOrAuthUrl("https://auth0.mycompany.com/u/login"), true);
  assert.equal(isBankingOrAuthUrl("https://mycompany.okta.com/login/default"), true);
  assert.equal(isBankingOrAuthUrl("https://example.com/oauth/authorize?client_id=123"), true);
  assert.equal(isBankingOrAuthUrl("https://example.com/users/password-reset"), true);

  // Banking & Financial institutions
  assert.equal(isBankingOrAuthUrl("https://secure07ea.chase.com/web/auth/dashboard"), true);
  assert.equal(isBankingOrAuthUrl("https://online.citi.com/US/login.do"), true);
  assert.equal(isBankingOrAuthUrl("https://www.bankofamerica.com/online-banking/sign-in/"), true);
  assert.equal(isBankingOrAuthUrl("https://connect.secure.wellsfargo.com/auth/login"), true);
  assert.equal(isBankingOrAuthUrl("https://www.paypal.com/signin"), true);
  assert.equal(isBankingOrAuthUrl("https://checkout.stripe.com/c/pay/cs_live_123"), true);
  assert.equal(isBankingOrAuthUrl("https://wise.com/login/"), true);
  assert.equal(isBankingOrAuthUrl("https://www.coinbase.com/signin"), true);
  assert.equal(isBankingOrAuthUrl("https://digital.fidelity.com/ftgw/digital/portfolio/summary"), true);

  // Safe non-banking/non-auth URLs
  assert.equal(isBankingOrAuthUrl("https://en.wikipedia.org/wiki/Operating_system"), false);
  assert.equal(isBankingOrAuthUrl("https://developer.mozilla.org/en-US/docs/Web/API"), false);
  assert.equal(isBankingOrAuthUrl("https://news.ycombinator.com/item?id=12345"), false);
  assert.equal(isBankingOrAuthUrl("https://docs.github.com/en/actions"), false);
});

test("Do not capture form data from banking/authentication websites by default", () => {
  resetFormSavingSettings();

  // Create document with benign fields that would normally be captured
  const nameInput = createMockElement({ id: "user_name", name: "name", type: "text", value: "Jane Doe" });
  const commentInput = createMockElement({ id: "customer_notes", name: "notes", type: "text", value: "Need help with portal" });
  const doc = createMockDocument([nameInput, commentInput]);

  const bankingUrls = [
    "https://www.chase.com/portal/inquiry",
    "https://onlinebanking.bankofamerica.com/portal",
    "https://www.paypal.com/disputes",
    "https://accounts.google.com/login",
    "https://login.live.com/login.srf",
    "https://app.example.com/oauth/authorize",
    "https://mybank.com/onlinebanking"
  ];

  for (const url of bankingUrls) {
    // 1. serializeSafeDomForms returns null
    const serialized = serializeSafeDomForms(doc, url);
    assert.equal(serialized, null, `Expected null serialized form data for banking URL: ${url}`);

    // 2. sanitizeFormData returns null
    const rawFields = [
      { id: "user_name", name: "name", type: "text", value: "Jane Doe" }
    ];
    const sanitized = sanitizeFormData(rawFields, url);
    assert.equal(sanitized, null, `Expected null sanitized form data for banking URL: ${url}`);

    // 3. createTabSnapshot sets forms: null
    const snapshot = createTabSnapshot({ id: 99, url, title: "Secure Portal" }, {
      url,
      forms: rawFields
    });
    assert.equal(snapshot.forms, null, `Expected snapshot.forms to be null for URL: ${url}`);

    // 4. restoreFormState skips restoration
    const restoreRes = restoreFormState(rawFields, doc, { url });
    assert.equal(restoreRes.restoredCount, 0);
    assert.equal(restoreRes.skippedCount, 1);
    assert.match(restoreRes.details[0].error, /banking\/authentication/i);
  }

  // Verify non-sensitive site still captures safely
  const safeSerialized = serializeSafeDomForms(doc, "https://recipes.example.com/cookies");
  assert.notEqual(safeSerialized, null);
  assert.equal(safeSerialized.length, 2);
});






