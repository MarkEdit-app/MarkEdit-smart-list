import { completionStatus } from '@codemirror/autocomplete';
import { EditorState, Prec, Transaction } from '@codemirror/state';
import type { Extension, Text, TransactionSpec } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import type { EditorView } from '@codemirror/view';
import { planIndent } from './plan.ts';
import type { Direction } from './plan.ts';
import { repairNumbering } from './numbering.ts';
import type { Settings } from './settings.ts';

export function smartList(settings: Settings, onFailure: (message: string) => void): Extension {
  let isFiltering = false;

  function command(view: EditorView, direction: Direction, isTab = false) {
    if (view.composing || (isTab && completionStatus(view.state) !== null)) {
      return false;
    }

    const plan = planIndent(view.state, direction, settings, isTab);
    if (plan.kind === 'pass') {
      return false;
    }

    if (plan.kind === 'reject') {
      onFailure(plan.reason);
    } else {
      const transaction = filterTransaction(view.state, plan.transaction.changes.apply(view.state.doc), plan.transaction);
      if (transaction) {
        view.dispatch(transaction);
      }
    }

    return true;
  }

  function filterTransaction(state: EditorState, expectedDoc: Text, ...specs: TransactionSpec[]) {
    let transaction: Transaction;
    isFiltering = true;
    try {
      transaction = state.update(...specs);
    } finally {
      isFiltering = false;
    }

    if (!transaction.newDoc.eq(expectedDoc)) {
      onFailure('Another editor filter rejected or changed the list edit.');
      return undefined;
    }

    return transaction;
  }

  return [
    Prec.highest(keymap.of([
      { key: 'Tab', run: view => command(view, 1, true) },
      { key: 'Shift-Tab', run: view => command(view, -1) },
      { key: 'Mod-]', run: view => command(view, 1) },
      { key: 'Mod-[', run: view => command(view, -1) },
    ])),
    Prec.highest(EditorState.transactionFilter.of(transaction => {
      // Generated transactions must run through filters without being planned again
      if (isFiltering || transaction.annotation(Transaction.remote)) {
        return transaction;
      }

      const event = transaction.annotation(Transaction.userEvent);
      const direction = event === 'input.indent' ? 1 : event === 'delete.dedent' ? -1 : undefined;
      if (!direction) {
        if (!settings.renumberOnDelete || !transaction.isUserEvent('delete')) {
          return transaction;
        }

        const repair = repairNumbering(transaction);
        if (repair.kind === 'pass') {
          return transaction;
        }

        if (repair.kind === 'reject') {
          onFailure(repair.reason);
          return {};
        }

        return filterTransaction(transaction.startState, repair.changes.apply(transaction.newDoc), transaction, {
          changes: repair.changes,
          selection: transaction.newSelection.map(repair.changes, 1),
          sequential: true,
        }) ?? {};
      }

      const plan = planIndent(transaction.startState, direction, settings);
      if (plan.kind === 'pass') {
        return transaction;
      }

      if (plan.kind === 'reject') {
        onFailure(plan.reason);
        return {};
      }

      // Only replace ordinary indentation; don't discard effects supplied by other extensions
      if (transaction.effects.length > 0) {
        onFailure('The indentation includes another extension action and cannot be replaced safely.');
        return {};
      }

      const replacement: TransactionSpec = {
        ...plan.transaction,
        annotations: [
          Transaction.addToHistory.of(transaction.annotation(Transaction.addToHistory) ?? true),
        ],
      };

      return filterTransaction(transaction.startState, plan.transaction.changes.apply(transaction.startState.doc), replacement) ?? {};
    })),
  ];
}
