// Everything the editor page needs from CodeMirror, bundled into web/vendor/cm.js by build.sh.
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, Decoration } from "@codemirror/view";
export { EditorState, StateField, StateEffect, Compartment } from "@codemirror/state";
export { history, historyKeymap, defaultKeymap, indentWithTab, undo, redo } from "@codemirror/commands";
export { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter } from "@codemirror/language";
export { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
export { closeBrackets, autocompletion } from "@codemirror/autocomplete";
export { html } from "@codemirror/lang-html";
export { css } from "@codemirror/lang-css";
export { javascript } from "@codemirror/lang-javascript";
export { oneDark } from "@codemirror/theme-one-dark";
