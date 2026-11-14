import assert from 'node:assert/strict';
import { test } from 'node:test';
import { history, indentLess, indentMore, redo, undo } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, EditorState, StateEffect, Transaction } from '@codemirror/state';
import { smartList } from '../src/extension.ts';
import { planIndent } from '../src/plan.ts';
import { defaultSettings, readSettings } from '../src/settings.ts';

function editor(input: string, useMarkdown = true, settings = defaultSettings) {
  const anchor = input.indexOf('|');
  const text = input.replace('|', '');
  const head = text.indexOf('|');
  const errors: string[] = [];
  let state = EditorState.create({
    doc: text.replace('|', ''),
    selection: EditorSelection.range(anchor, head < 0 ? anchor : head),
    extensions: [
      useMarkdown ? markdown({ base: markdownLanguage }) : [],
      history(), smartList(settings, message => errors.push(message)),
    ],
  });

  return {
    get state() {
      return state;
    },
    errors,
    dispatch(transaction: Transaction) {
      state = transaction.state;
    },
  };
}

test('native indent moves whole items, updates numbers, preserves selection and undoes atomically', () => {
  const target = editor('10. Parent\n11. |Child\n    continuation\n    - Grandchild\n12. Child2|\n13. Next');
  const original = target.state;
  assert.equal(indentMore(target), true);
  assert.equal(target.state.doc.toString(),
    '10. Parent\n    1. Child\n       continuation\n       - Grandchild\n    2. Child2\n11. Next');
  assert.equal(target.state.sliceDoc(target.state.selection.main.from, target.state.selection.main.from + 5), 'Child');

  const changed = target.state;
  assert.equal(undo(target), true);
  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
  assert.equal(redo(target), true);
  assert.equal(target.state.doc.toString(), changed.doc.toString());
  assert.ok(target.state.selection.eq(changed.selection));
  assert.deepEqual(target.errors, []);
});

test('outdent adopts the destination marker and attaches remaining children to the moved item', () => {
  const target = editor('1. Parent\n   - |Child\n     - Existing\n   - Last\n2. Next');
  indentLess(target);
  assert.equal(target.state.doc.toString(), '1. Parent\n2. Child\n   - Existing\n   - Last\n3. Next');
  assert.deepEqual(target.errors, []);
});

test('explicit numbering restarts are retained while consecutive destination siblings advance', () => {
  const target = editor('1. Parent\n   1. |First\n   7. Second|\n2. Next\n3. Last\n9. Restart');
  indentLess(target);
  assert.equal(target.state.doc.toString(), '1. Parent\n2. First\n7. Second\n8. Next\n9. Last\n9. Restart');
  assert.deepEqual(target.errors, []);
});

test('same-line child lists supply destination alignment and numbering', () => {
  const target = editor('1. 1. Existing\n2. |Child');
  indentMore(target);
  assert.equal(target.state.doc.toString(), '1. 1. Existing\n   2. Child');
  assert.deepEqual(target.errors, []);
});

test('quote padding is normalized even when visual columns do not change', () => {
  const target = editor('> - Parent\n>\t- |Child');
  indentMore(target);
  assert.equal(target.state.doc.toString(), '> - Parent\n>   - Child');
  indentLess(target);
  assert.equal(target.state.doc.toString(), '> - Parent\n> - Child');
  assert.deepEqual(target.errors, []);
});

test('candidate parsing rejects an item swallowed by an open fence', () => {
  const target = editor('- Parent\n  ~~~\n- |Child');
  const original = target.state;
  indentMore(target);
  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
  assert.equal(target.errors.length, 1);
  assert.match(target.errors[0], /another kind of content/);
  assert.equal(undo(target), false);
});

test('language-less editors and prose keep ordinary indentation', () => {
  for (const useMarkdown of [false, true]) {
    const target = editor('|text', useMarkdown);
    indentMore(target);
    assert.equal(target.state.doc.toString(), '  text');
    indentLess(target);
    assert.equal(target.state.doc.toString(), 'text');
    assert.deepEqual(target.errors, []);
  }
});

test('code whitespace and nested quote ownership survive a list move', () => {
  const target = editor('9. Parent\n10.\t|Child\n\t> ```\n\t> \t  x\n\t> ```\n11. Next');
  indentMore(target);
  assert.equal(target.state.doc.toString(), '9. Parent\n   1. Child\n      > ```\n      > \t  x\n      > ```\n10. Next');
  assert.deepEqual(target.errors, []);
});

test('ordered marker overflow rejects the entire transaction', () => {
  const target = editor('999999999. Parent\n           1. |Child\n              continuation');
  const original = target.state;
  indentLess(target);
  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
  assert.equal(target.errors.length, 1);
  assert.match(target.errors[0], /nine digits/);
});

test('opaque multiline literals are refused when their payload cannot be kept byte-identical', () => {
  for (const input of ['- Parent\n- |Child `a\n  \tb`', '- Parent\n- |Child\n  <pre>\n  \tx\n  </pre>']) {
    const target = editor(input);
    const original = target.state;
    indentMore(target);
    assert.equal(target.state.doc.toString(), original.doc.toString());
    assert.ok(target.state.selection.eq(original.selection));
    assert.equal(target.errors.length, 1);
    assert.match(target.errors[0], /content or ownership/);
  }
});

test('structural planning does not depend on the editor having parsed the selected item', () => {
  const prefix = 'Paragraph\n\n'.repeat(1000);
  const target = editor(prefix + '1. Parent\n2. |Child\n3. Next');
  assert.ok(syntaxTree(target.state).length < target.state.doc.length);
  indentMore(target);
  assert.equal(target.state.doc.toString(), prefix + '1. Parent\n   1. Child\n2. Next');
  assert.deepEqual(target.errors, []);
});

test('unsupported mixed selections and same-line source items are explicitly refused', () => {
  for (const input of ['- Parent\n- |Child\n\noutside|', '1. 1. |Existing\n2. Child']) {
    const target = editor(input);
    const original = target.state;
    indentLess(target);
    assert.equal(target.state.doc.toString(), original.doc.toString());
    assert.ok(target.state.selection.eq(original.selection));
    assert.equal(target.errors.length, 1);
  }
});

test('Tab inside item text is not treated as structural indentation', () => {
  const target = editor('1. Parent\n2. Ch|ild');
  assert.equal(planIndent(target.state, 1, defaultSettings, true).kind, 'pass');
  assert.equal(planIndent(target.state, 1, { ...defaultSettings, tabBehavior: 'item' }, true).kind, 'move');
  assert.equal(planIndent(target.state, 1).kind, 'move');
});

test('whole-line deletion repairs following numbers and their content alignment in the same undo step', () => {
  const target = editor('8. Keep\n9. |Remove\n10. Next\n    ```\n      code\n    ```\n11. Last');
  const original = target.state;
  const line = original.doc.line(2);
  target.dispatch(target.state.update({
    changes: { from: line.from - 1, to: line.to },
    userEvent: 'delete.line',
  }));

  assert.equal(target.state.doc.toString(), '8. Keep\n9. Next\n   ```\n     code\n   ```\n10. Last');
  assert.deepEqual(target.errors, []);

  const changed = target.state;
  assert.equal(undo(target), true);
  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
  assert.equal(redo(target), true);
  assert.equal(target.state.doc.toString(), changed.doc.toString());
  assert.ok(target.state.selection.eq(changed.selection));
});

test('deleting the first line of a numbering run preserves its starting number, including restarts', () => {
  for (const [input, lineNumber, output] of [
    ['|1. Remove\n2. Next\n3. Last', 1, '\n1. Next\n2. Last'],
    ['1. Keep\n2. Keep\n7. |Remove\n8. Next\n9. Last', 3, '1. Keep\n2. Keep\n\n7. Next\n8. Last'],
  ] as const) {
    const target = editor(input);
    const line = target.state.doc.line(lineNumber);
    target.dispatch(target.state.update({
      changes: { from: line.from, to: line.to },
      userEvent: 'delete.selection',
    }));

    assert.equal(target.state.doc.toString(), output);
    assert.deepEqual(target.errors, []);
  }
});

test('deleting leading spaces repairs the lifted item, its remaining children, and destination siblings', () => {
  const target = editor('1. Parent\n   |1. Child\n   2. Last\n2. Next');
  const original = target.state;
  const line = original.doc.line(2);
  target.dispatch(target.state.update({
    changes: { from: line.from, to: line.from + 3 },
    selection: { anchor: line.from },
    userEvent: 'delete.backward',
  }));

  assert.equal(target.state.doc.toString(), '1. Parent\n2. Child\n   1. Last\n3. Next');
  assert.equal(target.state.selection.main.head, line.from);
  assert.deepEqual(target.errors, []);
  undo(target);
  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
});

test('ordinary character deletion does not repair unrelated numbering', () => {
  const target = editor('1. Parent\n3. Ch|ild\n4. Next');
  const cursor = target.state.selection.main.head;
  target.dispatch(target.state.update({
    changes: { from: cursor - 1, to: cursor },
    userEvent: 'delete.backward',
  }));

  assert.equal(target.state.doc.toString(), '1. Parent\n3. Cild\n4. Next');
  assert.deepEqual(target.errors, []);
});

test('preferred indentation respects marker widths and existing child alignment', () => {
  for (const [indentWidth, input, output] of [
    [3, '- Parent\n- |Child', '- Parent\n   - Child'],
    [4, '- Parent\n- |Child', '- Parent\n    - Child'],
    [3, '10. Parent\n11. |Child', '10. Parent\n    1. Child'],
    [4, '1. Parent\n   1. Existing\n2. |Child', '1. Parent\n   1. Existing\n   2. Child'],
  ] as const) {
    const target = editor(input, true, { ...defaultSettings, indentWidth });
    indentMore(target);
    assert.equal(target.state.doc.toString(), output);
    assert.deepEqual(target.errors, []);
  }
});

test('preferred indentation applies to new children after outdenting across a marker-width boundary', () => {
  const target = editor('1. Parent\n   1. First\n   10. |Child\n   11. Last\n2. Next',
    true, { ...defaultSettings, indentWidth: 4 });
  indentLess(target);
  assert.equal(target.state.doc.toString(), '1. Parent\n   1. First\n2. Child\n    1. Last\n3. Next');
  assert.deepEqual(target.errors, []);
});

test('disabling deletion renumbering leaves explicit indentation numbering enabled', () => {
  const target = editor('1. Parent\n2. |Remove\n3. Next', true, { ...defaultSettings, renumberOnDelete: false });
  const line = target.state.doc.line(2);
  target.dispatch(target.state.update({
    changes: { from: line.from, to: line.to + 1 },
    selection: { anchor: line.from },
    userEvent: 'delete.line',
  }));

  assert.equal(target.state.doc.toString(), '1. Parent\n3. Next');
  indentMore(target);
  assert.equal(target.state.doc.toString(), '1. Parent\n   1. Next');
  assert.deepEqual(target.errors, []);
});

test('settings preserve omitted defaults and reject invalid values', () => {
  assert.deepEqual(readSettings({ indentWidth: 4 }), { ...defaultSettings, indentWidth: 4 });
  for (const [value, message] of [
    [[], /must be an object/],
    [{ indentWidth: 2 }, /indentWidth/],
    [{ renumberOnDelete: 'false' }, /renumberOnDelete/],
    [{ tabBehavior: 'all' }, /tabBehavior/],
  ] as const) {
    assert.throws(() => readSettings(value), message);
  }
});

test('collapsed carets in leading whitespace still select the whole list item', () => {
  for (const [input, command, output] of [
    ['1. Parent\n|   1. Child\n2. Next', indentLess, '1. Parent\n2. Child\n3. Next'],
    ['1. Parent\n|  2. Child\n3. Next', indentMore, '1. Parent\n   1. Child\n2. Next'],
  ] as const) {
    const target = editor(input);
    command(target);
    assert.equal(target.state.doc.toString(), output);
    assert.deepEqual(target.errors, []);
  }
});

test('native indentation respects both full and partial change-filter rejection', () => {
  for (const blockAll of [true, false]) {
    const target = editor('1. Parent\n2. |Child\n3. Next');
    target.dispatch(target.state.update({
      effects: StateEffect.appendConfig.of(EditorState.changeFilter.of(transaction => {
        if (blockAll) {
          return false;
        }

        const line = transaction.startState.doc.line(3);
        return [line.from, line.to];
      })),
    }));

    const original = target.state;
    indentMore(target);
    assert.equal(target.state.doc.toString(), original.doc.toString());
    assert.ok(target.state.selection.eq(original.selection));
    assert.equal(target.errors.length, 1);
    assert.match(target.errors[0], /filter/);
    assert.equal(undo(target), false);
  }
});

test('deletion and numbering repair are rejected together when a following marker is protected', () => {
  const target = editor('1. Parent\n2. |Remove\n3. Next');
  target.dispatch(target.state.update({
    effects: StateEffect.appendConfig.of(EditorState.changeFilter.of(transaction => {
      const line = transaction.startState.doc.line(3);
      return [line.from, line.to];
    })),
  }));

  const original = target.state;
  const line = original.doc.line(2);
  target.dispatch(target.state.update({
    changes: { from: line.from, to: line.to + 1 },
    userEvent: 'delete.line',
  }));

  assert.equal(target.state.doc.toString(), original.doc.toString());
  assert.ok(target.state.selection.eq(original.selection));
  assert.equal(target.errors.length, 1);
  assert.match(target.errors[0], /filter/);
  assert.equal(undo(target), false);
});

test('filters that rebuild transaction specs do not trigger recursive list planning', () => {
  const target = editor('1. Parent\n2. |Child\n3. Next');
  target.dispatch(target.state.update({
    effects: StateEffect.appendConfig.of(EditorState.transactionFilter.of(transaction => ({
      changes: transaction.changes,
      selection: transaction.selection,
      effects: transaction.effects,
      userEvent: transaction.annotation(Transaction.userEvent),
    }))),
  }));

  indentMore(target);
  assert.equal(target.state.doc.toString(), '1. Parent\n   1. Child\n2. Next');
  assert.deepEqual(target.errors, []);
});
