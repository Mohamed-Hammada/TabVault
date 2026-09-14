import test from "node:test";
import assert from "node:assert/strict";
import {
  restoreTextInput,
  restoreTextarea,
  restoreSelect,
  restoreCheckbox,
  restoreRadio,
  restoreContentEditable,
  restoreFormState,
  findMatchingFormElement,
  dispatchFormInputEvents,
  TEXT_COMPATIBLE_INPUT_TYPES
} from "../lib/form.js";

function createMockElement(attributes = {}) {
  const dispatchedEvents = [];
  const el = {
    tagName: attributes.tagName || "INPUT",
    type: attributes.type || "text",
    id: attributes.id || "",
    name: attributes.name || "",
    value: attributes.value || "",
    checked: Boolean(attributes.checked),
    placeholder: attributes.placeholder || "",
    autocomplete: attributes.autocomplete || "",
    ariaLabel: attributes.ariaLabel || "",
    textContent: attributes.textContent || attributes.text || "",
    innerText: attributes.innerText || attributes.textContent || attributes.text || "",
    innerHTML: attributes.innerHTML || "",
    selector: attributes.selector || "",
    contentEditable: Boolean(attributes.contentEditable || attributes.isContentEditable),
    getAttribute(name) {
      return attributes[name] || null;
    },
    dispatchedEvents,
    dispatchEvent(evt) {
      dispatchedEvents.push(evt.type);
    }
  };
  return el;
}

function createMockDocument(elements = []) {
  return {
    elements,
    getElementById(id) {
      return elements.find(el => el.id === id) || null;
    },
    querySelector(selector) {
      if (selector.startsWith("#")) {
        const id = selector.slice(1);
        return elements.find(el => el.id === id) || null;
      }
      const direct = elements.find(el => el.selector === selector);
      if (direct) return direct;
      if (selector.includes("[name=") && selector.includes("[value=")) {
        const nameMatch = selector.match(/\[name="?([^"\]]+)"?\]/);
        const valMatch = selector.match(/\[value="?([^"\]]+)"?\]/);
        if (nameMatch && valMatch) {
          return elements.find(el => el.name === nameMatch[1] && el.value === valMatch[1]) || null;
        }
      }
      if (selector.includes("[name=")) {
        const match = selector.match(/\[name="?([^"\]]+)"?\]/);
        if (match) {
          return elements.find(el => el.name === match[1]) || null;
        }
      }
      return null;
    }
  };
}

test("findMatchingFormElement locates elements by ID, selector, and name", () => {
  const el1 = createMockElement({ id: "user_email", name: "email" });
  const el2 = createMockElement({ id: "search_query", name: "q" });
  const doc = createMockDocument([el1, el2]);

  assert.equal(findMatchingFormElement({ id: "user_email" }, doc), el1);
  assert.equal(findMatchingFormElement({ selector: "#search_query" }, doc), el2);
  assert.equal(findMatchingFormElement({ name: "email" }, doc), el1);
  assert.equal(findMatchingFormElement({ id: "nonexistent" }, doc), null);
  assert.equal(findMatchingFormElement(null, doc), null);
});

test("restoreTextInput restores value and dispatches input & change events for text inputs", () => {
  const inputEl = createMockElement({ id: "first_name", name: "fname", value: "" });
  const doc = createMockDocument([inputEl]);

  const res = restoreTextInput({
    id: "first_name",
    name: "fname",
    type: "text",
    value: "Alex Johnson"
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(inputEl.value, "Alex Johnson");
  assert.deepEqual(inputEl.dispatchedEvents, ["input", "change"]);
});

test("restoreTextInput supports text-compatible input types", () => {
  for (const type of TEXT_COMPATIBLE_INPUT_TYPES) {
    const el = createMockElement({ id: `field_${type}`, type, value: "" });
    const doc = createMockDocument([el]);

    const res = restoreTextInput({
      id: `field_${type}`,
      type,
      value: `Test_${type}_value`
    }, doc);

    assert.equal(res.success, true);
    assert.equal(el.value, `Test_${type}_value`);
  }
});

test("restoreTextInput guards against restoring sensitive password or token fields", () => {
  const passEl = createMockElement({ id: "user_password", type: "password", name: "pwd" });
  const tokenEl = createMockElement({ id: "auth_token", type: "text", name: "access_token" });
  const doc = createMockDocument([passEl, tokenEl]);

  // Attempting to restore password field should be skipped
  const res1 = restoreTextInput({
    id: "user_password",
    type: "password",
    value: "superSecret123"
  }, doc);

  assert.equal(res1.success, false);
  assert.equal(res1.skipped, true);
  assert.equal(passEl.value, "");

  // Attempting to restore token field should be skipped
  const res2 = restoreTextInput({
    id: "auth_token",
    type: "text",
    name: "access_token",
    value: "secret-token-xyz"
  }, doc);

  assert.equal(res2.success, false);
  assert.equal(res2.skipped, true);
  assert.equal(tokenEl.value, "");
});

test("restoreFormState processes batch of inputs and aggregates counts accurately", () => {
  const el1 = createMockElement({ id: "title", value: "" });
  const el2 = createMockElement({ id: "card_number", name: "cc_number", value: "" });
  const doc = createMockDocument([el1, el2]);

  const formFields = [
    { id: "title", type: "text", value: "My Great Draft" },
    { id: "card_number", name: "cc_number", type: "text", value: "4111222233334444" },
    { id: "missing_field", type: "text", value: "Hello" }
  ];

  const result = restoreFormState(formFields, doc);
  assert.equal(result.totalProcessed, 3);
  assert.equal(result.restoredCount, 1);
  assert.equal(result.skippedCount, 1); // card_number skipped
  assert.equal(result.failedCount, 1);  // missing_field failed
  assert.equal(el1.value, "My Great Draft");
  assert.equal(el2.value, "");
});

test("restoreTextarea restores multi-line content and dispatches events", () => {
  const textareaEl = createMockElement({ tagName: "TEXTAREA", id: "article_body", value: "" });
  const doc = createMockDocument([textareaEl]);

  const multiline = "Line 1: Introduction\nLine 2: Analysis\nLine 3: Conclusion";
  const res = restoreTextarea({
    id: "article_body",
    type: "textarea",
    value: multiline
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(textareaEl.value, multiline);
  assert.deepEqual(textareaEl.dispatchedEvents, ["input", "change"]);
});

test("restoreTextarea skips sensitive textareas", () => {
  const secretNotes = createMockElement({ tagName: "TEXTAREA", id: "secret_keys", name: "private_key", value: "" });
  const doc = createMockDocument([secretNotes]);

  const res = restoreTextarea({
    id: "secret_keys",
    name: "private_key",
    type: "textarea",
    value: "BEGIN RSA PRIVATE KEY..."
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(secretNotes.value, "");
});

function createMockSelect(attributes = {}) {
  const dispatchedEvents = [];
  const options = (attributes.options || []).map(opt => ({
    value: typeof opt === "string" ? opt : opt.value,
    text: typeof opt === "string" ? opt : (opt.text || opt.value),
    selected: Boolean(opt.selected)
  }));
  let selectedIndex = attributes.selectedIndex ?? (options.length > 0 ? 0 : -1);
  let value = attributes.value ?? (options[selectedIndex] ? options[selectedIndex].value : "");

  const el = {
    tagName: "SELECT",
    type: attributes.multiple ? "select-multiple" : "select-one",
    id: attributes.id || "",
    name: attributes.name || "",
    multiple: Boolean(attributes.multiple),
    options,
    dispatchedEvents,
    get selectedIndex() {
      if (this.multiple) {
        return options.findIndex(o => o.selected);
      }
      return selectedIndex;
    },
    set selectedIndex(idx) {
      selectedIndex = idx;
      if (options[idx]) {
        value = options[idx].value;
      }
    },
    get value() {
      if (this.multiple) {
        const sel = options.find(o => o.selected);
        return sel ? sel.value : "";
      }
      return value;
    },
    set value(val) {
      value = val;
      const idx = options.findIndex(o => o.value === val);
      if (idx !== -1) {
        selectedIndex = idx;
        options.forEach((o, i) => { o.selected = (i === idx); });
      }
    },
    dispatchEvent(evt) {
      dispatchedEvents.push(evt.type);
    }
  };
  return el;
}

test("restoreSelect restores single-select dropdown by value and selectedIndex", () => {
  const selectEl = createMockSelect({
    id: "country_select",
    name: "country",
    options: ["US", "CA", "GB", "DE"],
    selectedIndex: 0,
    value: "US"
  });
  const doc = createMockDocument([selectEl]);

  const res = restoreSelect({
    id: "country_select",
    name: "country",
    type: "select",
    value: "DE"
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(selectEl.value, "DE");
  assert.equal(selectEl.selectedIndex, 3);
  assert.deepEqual(selectEl.dispatchedEvents, ["change", "input"]);
});

test("restoreSelect restores multi-select element with multiple chosen values", () => {
  const multiSelect = createMockSelect({
    id: "languages",
    name: "languages",
    multiple: true,
    options: ["javascript", "python", "rust", "go"],
    selectedIndex: -1
  });
  const doc = createMockDocument([multiSelect]);

  const res = restoreSelect({
    id: "languages",
    name: "languages",
    type: "select",
    values: ["javascript", "rust"]
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  const selectedValues = multiSelect.options.filter(o => o.selected).map(o => o.value);
  assert.deepEqual(selectedValues, ["javascript", "rust"]);
  assert.deepEqual(multiSelect.dispatchedEvents, ["change", "input"]);
});

test("restoreSelect skips sensitive security-related select elements", () => {
  const secSelect = createMockSelect({
    id: "security_question_id",
    name: "security_question",
    options: ["q1", "q2", "q3"],
    value: "q1"
  });
  const doc = createMockDocument([secSelect]);

  const res = restoreSelect({
    id: "security_question_id",
    name: "security_question",
    type: "select",
    value: "q2"
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(secSelect.value, "q1");
});

test("restoreCheckbox toggles checked state and dispatches change & input events", () => {
  const checkboxEl = createMockElement({
    id: "subscribe_newsletter",
    name: "subscribe",
    type: "checkbox",
    checked: false
  });
  const doc = createMockDocument([checkboxEl]);

  const res = restoreCheckbox({
    id: "subscribe_newsletter",
    name: "subscribe",
    type: "checkbox",
    checked: true
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(checkboxEl.checked, true);
  assert.deepEqual(checkboxEl.dispatchedEvents, ["change", "input"]);

  // Toggle back to unchecked
  const resUncheck = restoreCheckbox({
    id: "subscribe_newsletter",
    type: "checkbox",
    checked: false
  }, doc);

  assert.equal(resUncheck.success, true);
  assert.equal(checkboxEl.checked, false);
});

test("restoreCheckbox locates matching checkbox in group by name and value", () => {
  const cb1 = createMockElement({ id: "color_red", name: "color", value: "red", type: "checkbox", checked: false });
  const cb2 = createMockElement({ id: "color_blue", name: "color", value: "blue", type: "checkbox", checked: false });
  const doc = createMockDocument([cb1, cb2]);

  const res = restoreCheckbox({
    name: "color",
    type: "checkbox",
    value: "blue",
    checked: true
  }, doc);

  assert.equal(res.success, true);
  assert.equal(cb1.checked, false);
  assert.equal(cb2.checked, true);
});

test("restoreCheckbox skips sensitive fields like save credit card or credentials", () => {
  const sensitiveCb = createMockElement({
    id: "save_credit_card_checkbox",
    name: "save_card",
    type: "checkbox",
    checked: false
  });
  const doc = createMockDocument([sensitiveCb]);

  const res = restoreCheckbox({
    id: "save_credit_card_checkbox",
    name: "save_card",
    type: "checkbox",
    checked: true
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(sensitiveCb.checked, false);
});

test("restoreFormState processes checkboxes alongside other fields", () => {
  const textEl = createMockElement({ id: "username_input", type: "text", value: "" });
  const cbEl = createMockElement({ id: "terms_agreement", type: "checkbox", checked: false });
  const doc = createMockDocument([textEl, cbEl]);

  const formFields = [
    { id: "username_input", type: "text", value: "johndoe" },
    { id: "terms_agreement", type: "checkbox", checked: true }
  ];

  const result = restoreFormState(formFields, doc);
  assert.equal(result.totalProcessed, 2);
  assert.equal(result.restoredCount, 2);
  assert.equal(textEl.value, "johndoe");
  assert.equal(cbEl.checked, true);
});

test("restoreRadio selects target radio option in a group and dispatches events", () => {
  const radioSmall = createMockElement({ id: "size_s", name: "size", value: "S", type: "radio", checked: true });
  const radioMedium = createMockElement({ id: "size_m", name: "size", value: "M", type: "radio", checked: false });
  const radioLarge = createMockElement({ id: "size_l", name: "size", value: "L", type: "radio", checked: false });
  const doc = createMockDocument([radioSmall, radioMedium, radioLarge]);

  const res = restoreRadio({
    name: "size",
    type: "radio",
    value: "L",
    checked: true
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(radioLarge.checked, true);
  assert.deepEqual(radioLarge.dispatchedEvents, ["change", "input"]);
});

test("restoreRadio skips sensitive radio buttons", () => {
  const sensitiveRadio = createMockElement({
    id: "payment_method_credit_card",
    name: "credit_card_selection",
    type: "radio",
    checked: false
  });
  const doc = createMockDocument([sensitiveRadio]);

  const res = restoreRadio({
    id: "payment_method_credit_card",
    name: "credit_card_selection",
    type: "radio",
    checked: true
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(sensitiveRadio.checked, false);
});

test("restoreFormState processes radios alongside other form elements", () => {
  const titleInput = createMockElement({ id: "post_title", type: "text", value: "" });
  const radioDraft = createMockElement({ id: "status_draft", name: "status", value: "draft", type: "radio", checked: false });
  const radioPublish = createMockElement({ id: "status_published", name: "status", value: "published", type: "radio", checked: false });
  const doc = createMockDocument([titleInput, radioDraft, radioPublish]);

  const formFields = [
    { id: "post_title", type: "text", value: "Release Notes" },
    { name: "status", type: "radio", value: "published", checked: true }
  ];

  const result = restoreFormState(formFields, doc);
  assert.equal(result.totalProcessed, 2);
  assert.equal(result.restoredCount, 2);
  assert.equal(titleInput.value, "Release Notes");
  assert.equal(radioPublish.checked, true);
});

test("restoreContentEditable restores plain text and dispatches input & change events", () => {
  const editorEl = createMockElement({
    id: "rich_editor",
    contentEditable: true,
    textContent: ""
  });
  const doc = createMockDocument([editorEl]);

  const res = restoreContentEditable({
    id: "rich_editor",
    type: "contenteditable",
    text: "Hello from TabVault contenteditable!"
  }, doc);

  assert.equal(res.success, true);
  assert.equal(res.skipped, false);
  assert.equal(editorEl.textContent, "Hello from TabVault contenteditable!");
  assert.deepEqual(editorEl.dispatchedEvents, ["input", "change"]);
});

test("restoreContentEditable restores HTML when allowHtmlRestoration is enabled", () => {
  const editorEl = createMockElement({
    id: "html_editor",
    contentEditable: true,
    innerHTML: ""
  });
  const doc = createMockDocument([editorEl]);

  const res = restoreContentEditable({
    id: "html_editor",
    type: "contenteditable",
    text: "Bold text",
    html: "<strong>Bold text</strong>"
  }, doc, { allowHtmlRestoration: true });

  assert.equal(res.success, true);
  assert.equal(editorEl.innerHTML, "<strong>Bold text</strong>");
});

test("restoreContentEditable skips sensitive editable areas", () => {
  const secretEditor = createMockElement({
    id: "secret_api_key_field",
    contentEditable: true,
    textContent: ""
  });
  const doc = createMockDocument([secretEditor]);

  const res = restoreContentEditable({
    id: "secret_api_key_field",
    type: "contenteditable",
    text: "sk-live-12345678"
  }, doc);

  assert.equal(res.success, false);
  assert.equal(res.skipped, true);
  assert.equal(secretEditor.textContent, "");
});

test("restoreFormState processes contenteditable elements alongside inputs", () => {
  const titleEl = createMockElement({ id: "doc_title", type: "text", value: "" });
  const editorEl = createMockElement({ id: "doc_body", contentEditable: true, textContent: "" });
  const doc = createMockDocument([titleEl, editorEl]);

  const formFields = [
    { id: "doc_title", type: "text", value: "Architecture Overview" },
    { id: "doc_body", type: "contenteditable", text: "Section 1: Architecture..." }
  ];

  const result = restoreFormState(formFields, doc);
  assert.equal(result.totalProcessed, 2);
  assert.equal(result.restoredCount, 2);
  assert.equal(titleEl.value, "Architecture Overview");
  assert.equal(editorEl.textContent, "Section 1: Architecture...");
});




