import { markdown } from '@codemirror/lang-markdown';
import { deleteCharBackward, deleteLine, indentLess, indentMore } from '@codemirror/commands';
import { EditorView, keymap } from '@codemirror/view';
import { smartList } from '../src/extension.ts';
import { defaultSettings } from '../src/settings.ts';

const host = document.querySelector<HTMLElement>('#editor')!;
const results = document.querySelector<HTMLElement>('#results')!;
const errors: string[] = [];
const view = new EditorView({
  doc: '1. Parent\n2. Child\n3. Next',
  parent: host,
  extensions: [
    markdown(),
    smartList(defaultSettings, message => errors.push(message)),
    keymap.of([{ key: 'Mod-]', run: indentMore }, { key: 'Mod-[', run: indentLess }]),
  ],
});

view.dispatch({ selection: { anchor: view.state.doc.toString().indexOf('Child') } });
view.focus();
view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true }));
if (view.state.doc.toString() !== '1. Parent\n   1. Child\n2. Next') {
  throw new Error('Tab did not move the item structurally');
}

view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
if (view.state.doc.toString() !== '1. Parent\n2. Child\n3. Next') {
  throw new Error('Shift-Tab did not outdent the item');
}

indentMore(view);
if (view.state.doc.toString() !== '1. Parent\n   1. Child\n2. Next') {
  throw new Error('Native-command path did not use the planner');
}

view.dispatch({ selection: { anchor: view.state.doc.line(2).from + 3 } });
deleteCharBackward(view);
if (view.state.doc.toString() !== '1. Parent\n  2. Child\n3. Next') {
  throw new Error('Backspace did not repair numbering after removing indentation');
}

deleteLine(view);
if (view.state.doc.toString() !== '1. Parent\n2. Next') {
  throw new Error('Delete Line did not repair following numbers');
}

if (errors.length) {
  throw new Error(errors.join('\n'));
}

results.textContent = 'Passed: Tab, Shift-Tab, native indentation, Backspace, Delete Line';
