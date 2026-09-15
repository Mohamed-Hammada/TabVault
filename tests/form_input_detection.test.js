import test from "node:test";
import assert from "node:assert/strict";
import {
  EXCLUDED_FORM_INPUT_TYPES,
  getElementSelector,
  isUserEditableElement,
  evaluateFormElement,
  detectDirtyFormInput
} from "../lib/form.js";

function createMockEl(props = {}) {
  const el = {
    tagName: props.tagName || "INPUT",
    type: props.type || "text",
    id: props.id || "",
    name: props.name || "",
    className: props.className || "",
    value: props.value !== undefined ? props.value : "",
    defaultValue: props.defaultValue !== undefined ? props.defaultValue : "",
    disabled: Boolean(props.disabled),
    readOnly: Boolean(props.readOnly),
    hidden: Boolean(props.hidden),
    isConnected: props.isConnected !== false,
    contentEditable: Boolean(props.contentEditable || props.isContentEditable),
    isContentEditable: Boolean(props.contentEditable || props.isContentEditable),
    innerText: props.innerText || props.text || "",
    textContent: props.textContent || props.innerText || props.text || "",
    offsetParent: props.offsetParent !== undefined ? props.offsetParent : {},
    style: props.style || {},
    getAttribute(name) {
      if (name === "aria-hidden") return props["aria-hidden"] || null;
      return null;
    }
  };
  return el;
}

function createMockDoc(elements = []) {
  return {
    querySelectorAll(selector) {
      return elements;
    }
  };
}

test("Configurator controls: range slider with default value does not trigger form-input", () => {
  const slider = createMockEl({
    tagName: "INPUT",
    type: "range",
    id: "suspension-height",
    value: "50",
    defaultValue: "50"
  });

  const evaluation = evaluateFormElement(slider);
  assert.equal(evaluation, null, "Range sliders must be excluded from unsaved draft evaluation");
});

test("Configurator controls: color picker with default hex does not trigger form-input", () => {
  const colorPicker = createMockEl({
    tagName: "INPUT",
    type: "color",
    id: "car-paint-color",
    value: "#ff0000",
    defaultValue: "#ff0000"
  });

  const evaluation = evaluateFormElement(colorPicker);
  assert.equal(evaluation, null, "Color inputs must be excluded from unsaved draft evaluation");
});

test("Search inputs are excluded from blocking idle suspension", () => {
  const searchInput = createMockEl({
    tagName: "INPUT",
    type: "search",
    name: "q",
    value: "Porsche 911",
    defaultValue: ""
  });

  const userModified = new Set([searchInput]);
  const evaluation = evaluateFormElement(searchInput, userModified);
  assert.equal(evaluation, null, "Search inputs must be excluded from unsaved draft evaluation");
});

test("Page load defaults: text input with default value without user interaction is NOT dirty", () => {
  const prefilledInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    id: "car-preset-title",
    value: "Sport Edition",
    defaultValue: "Sport Edition"
  });

  // No user interaction recorded yet
  const userModified = new Set();
  const evaluation = evaluateFormElement(prefilledInput, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, false);
  assert.equal(evaluation.valueChanged, false);
  assert.equal(evaluation.userInteracted, false);
});

test("Dynamic SPA defaults: pre-filled text input without user interaction is NOT dirty", () => {
  const spaField = createMockEl({
    tagName: "INPUT",
    type: "text",
    id: "model-code",
    value: "GT3-RS",
    defaultValue: "" // Framework didn't set defaultValue attribute
  });

  // User has NOT touched the field
  const userModified = new Set();
  const evaluation = evaluateFormElement(spaField, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, false, "Must not be dirty if user has not interacted with it");
});

test("Hidden, disabled, or readonly inputs are ignored", () => {
  const disabledInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    value: "Fixed Data",
    disabled: true
  });
  const readonlyInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    value: "Readonly Data",
    readOnly: true
  });
  const hiddenInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    value: "Hidden Data",
    hidden: true
  });
  const ariaHiddenInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    value: "Aria Hidden",
    "aria-hidden": "true"
  });
  const displayNoneInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    value: "Display None",
    offsetParent: null
  });

  const userModified = new Set([disabledInput, readonlyInput, hiddenInput, ariaHiddenInput, displayNoneInput]);

  assert.equal(evaluateFormElement(disabledInput, userModified), null);
  assert.equal(evaluateFormElement(readonlyInput, userModified), null);
  assert.equal(evaluateFormElement(hiddenInput, userModified), null);
  assert.equal(evaluateFormElement(ariaHiddenInput, userModified), null);
  assert.equal(evaluateFormElement(displayNoneInput, userModified), null);
});

test("Genuine user typing: modified text input is detected as dirty with rich diagnostics", () => {
  const userField = createMockEl({
    tagName: "INPUT",
    type: "text",
    id: "user-notes",
    name: "notes",
    value: "My custom tune notes",
    defaultValue: ""
  });

  const userModified = new Set([userField]);
  const evaluation = evaluateFormElement(userField, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, true);
  assert.equal(evaluation.elementType, "input");
  assert.equal(evaluation.inputType, "text");
  assert.equal(evaluation.selector, "#user-notes");
  assert.equal(evaluation.hasValue, true);
  assert.equal(evaluation.valueChanged, true);
  assert.equal(evaluation.isUserEditable, true);
  assert.equal(evaluation.userInteracted, true);
});

test("Genuine user typing: textarea with unsaved content is detected as dirty with diagnostics", () => {
  const textarea = createMockEl({
    tagName: "TEXTAREA",
    id: "feedback-area",
    name: "feedback",
    value: "Detailed tuning configuration breakdown...",
    defaultValue: ""
  });

  const userModified = new Set([textarea]);
  const evaluation = evaluateFormElement(textarea, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, true);
  assert.equal(evaluation.elementType, "textarea");
  assert.equal(evaluation.selector, "#feedback-area");
  assert.equal(evaluation.hasValue, true);
  assert.equal(evaluation.valueChanged, true);
  assert.equal(evaluation.isUserEditable, true);
});

test("Genuine user typing: contenteditable element with unsaved content is detected", () => {
  const editable = createMockEl({
    tagName: "DIV",
    id: "rich-editor",
    contentEditable: true,
    innerText: "Unsaved rich draft"
  });

  const userModified = new Set([editable]);
  const evaluation = evaluateFormElement(editable, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, true);
  assert.equal(evaluation.elementType, "contenteditable");
  assert.equal(evaluation.selector, "#rich-editor");
  assert.equal(evaluation.hasValue, true);
  assert.equal(evaluation.isUserEditable, true);
});

test("Clearing or restoring to default clears dirty state", () => {
  const userField = createMockEl({
    tagName: "INPUT",
    type: "text",
    id: "cleared-field",
    value: "",
    defaultValue: "Initial"
  });

  const userModified = new Set([userField]);
  const evaluation = evaluateFormElement(userField, userModified);

  assert.ok(evaluation !== null);
  assert.equal(evaluation.isDirty, false, "Empty value must not be dirty");

  // Restored to defaultValue
  userField.value = "Initial";
  const restoredEval = evaluateFormElement(userField, userModified);
  assert.equal(restoredEval.isDirty, false, "Value matching defaultValue must not be dirty");
});

test("detectDirtyFormInput scans document: clean 3DTuning page with sliders and defaults returns isDirty=false", () => {
  const slider1 = createMockEl({ tagName: "INPUT", type: "range", value: "50", defaultValue: "50" });
  const slider2 = createMockEl({ tagName: "INPUT", type: "range", value: "100", defaultValue: "100" });
  const color = createMockEl({ tagName: "INPUT", type: "color", value: "#000000", defaultValue: "#000000" });
  const search = createMockEl({ tagName: "INPUT", type: "search", value: "Wheels", defaultValue: "" });
  const defaultText = createMockEl({ tagName: "INPUT", type: "text", value: "Default Configuration", defaultValue: "Default Configuration" });

  const doc = createMockDoc([slider1, slider2, color, search, defaultText]);
  const userModified = new Set(); // User hasn't typed anything

  const result = detectDirtyFormInput(doc, userModified);
  assert.equal(result.isDirty, false);
  assert.equal(result.details, null);
});

test("detectDirtyFormInput scans document: returns isDirty=true and details when user types unsaved input", () => {
  const slider = createMockEl({ tagName: "INPUT", type: "range", value: "50", defaultValue: "50" });
  const textInput = createMockEl({
    tagName: "INPUT",
    type: "text",
    id: "project-title",
    value: "My Custom Supercar",
    defaultValue: ""
  });

  const doc = createMockDoc([slider, textInput]);
  const userModified = new Set([textInput]);

  const result = detectDirtyFormInput(doc, userModified);
  assert.equal(result.isDirty, true);
  assert.ok(result.details !== null);
  assert.equal(result.details.selector, "#project-title");
  assert.equal(result.details.hasValue, true);
  assert.equal(result.details.valueChanged, true);
  assert.equal(result.details.isUserEditable, true);
});
