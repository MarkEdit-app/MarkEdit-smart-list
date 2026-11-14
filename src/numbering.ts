import { language } from '@codemirror/language';
import { ChangeSet } from '@codemirror/state';
import type { ChangeSpec, Transaction } from '@codemirror/state';
import type { Parser } from '@lezer/common';
import { Budget, UnsafeMove, metrics, numberedMarker, readModel, validateMove } from './model.ts';
import type { Item, Model } from './model.ts';
import { rewriteItem } from './plan.ts';

type Repair = { kind: 'pass' } | { kind: 'reject'; reason: string } | { kind: 'repair'; changes: ChangeSet };
type Deletion = { from: number; to: number; isWhitespace: boolean };
type NumberRun = { id: number; startNumber: number };
const listMarkerPattern = /^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;

export function repairNumbering(transaction: Transaction): Repair {
  const state = transaction.startState;
  const activeLanguage = state.facet(language);
  if (state.readOnly || !transaction.docChanged || !transaction.newDoc.length
    || !activeLanguage || !['markdown', 'yaml-frontmatter'].includes(activeLanguage.name)) {
    return { kind: 'pass' };
  }

  const deletions: Deletion[] = [];
  let hasInsertion = false;
  transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    if (inserted.length) {
      hasInsertion = true;
    } else if (to > from) {
      deletions.push({ from, to, isWhitespace: /^[ \t]+$/.test(state.doc.sliceString(from, to)) });
    }
  });

  if (hasInsertion) {
    return { kind: 'pass' };
  }

  try {
    const budget = new Budget();
    const hasListDeletion = deletions.some(deletion => {
      const firstLine = state.doc.lineAt(deletion.from);
      const lastLine = state.doc.lineAt(deletion.to);
      if (deletion.isWhitespace && firstLine.number === lastLine.number && listMarkerPattern.test(firstLine.text)) {
        return true;
      }

      for (let lineNumber = firstLine.number; lineNumber <= lastLine.number; lineNumber++) {
        budget.check();
        const line = state.doc.line(lineNumber);
        if (deletion.from <= line.from && deletion.to >= line.to && listMarkerPattern.test(line.text)) {
          return true;
        }
      }

      return false;
    });

    if (!hasListDeletion) {
      return { kind: 'pass' };
    }

    const source = readModel(state.doc, activeLanguage.parser, budget);
    const afterDeletion = readModel(transaction.newDoc, activeLanguage.parser, budget);
    const itemsByPosition = new Map(afterDeletion.items.map(item => [item.mark.from, item]));
    const survivors = new Map<number, Item>();
    const origins = new Map<number, Item>();
    const removedIds = new Set<number>();
    const prefixEdits = new Set<number>();
    const sourceLists = new Map<number, Item[]>();
    const runs = new Map<number, NumberRun>();

    for (const item of source.items) {
      budget.check();
      const from = transaction.changes.mapPos(item.mark.from, 1);
      const to = transaction.changes.mapPos(item.mark.to, -1);
      const survivor = itemsByPosition.get(from);
      if (survivor && survivor.mark.to === to && survivor.marker === item.marker) {
        survivors.set(item.id, survivor);
        origins.set(survivor.id, item);
      }

      const line = state.doc.line(item.line);
      for (const deletion of deletions) {
        if (deletion.from <= line.from && deletion.to >= line.to) {
          removedIds.add(item.id);
        }

        if (deletion.isWhitespace && deletion.from >= line.from && deletion.to <= item.mark.from) {
          prefixEdits.add(item.id);
        }
      }

      const siblingItems = sourceLists.get(item.list) ?? [];
      const previousItem = siblingItems.at(-1);
      siblingItems.push(item);
      sourceLists.set(item.list, siblingItems);

      if (/^\d/.test(item.marker)) {
        runs.set(item.id, previousItem && parseInt(item.marker) === parseInt(previousItem.marker) + 1
          ? runs.get(previousItem.id)! : { id: item.id, startNumber: parseInt(item.marker) });
      }
    }

    const movedIds = new Set<number>();
    for (const [id, item] of survivors) {
      const parentId = source.items[id].parent;
      if (item.parent !== (parentId === null ? null : survivors.get(parentId)?.id)) {
        movedIds.add(id);
      }
    }

    if (!removedIds.size && ![...prefixEdits].some(id => movedIds.has(id))) {
      return { kind: 'pass' };
    }

    const affectedLists = new Set<number>();
    for (const id of new Set([...removedIds, ...movedIds])) {
      for (const item of sourceLists.get(source.items[id].list) ?? []) {
        const survivor = survivors.get(item.id);
        if (survivor) {
          affectedLists.add(survivor.list);
        }
      }
    }

    const targetLists = new Map<number, Item[]>();
    for (const item of afterDeletion.items) {
      if (!affectedLists.has(item.list) || !/^\d/.test(item.marker)) {
        continue;
      }

      const siblingItems = targetLists.get(item.list) ?? [];
      siblingItems.push(item);
      targetLists.set(item.list, siblingItems);
    }

    const markers = new Map<number, string>();
    for (const siblingItems of targetLists.values()) {
      const seenRuns = new Map<number, number>();
      let previousNumber: number | undefined;
      for (const item of siblingItems) {
        budget.check();
        const origin = origins.get(item.id);
        if (!origin) {
          throw new UnsafeMove('The deletion exposes new list syntax whose numbering cannot be inferred.');
        }

        const run = runs.get(origin.id)!;
        const seenRun = seenRuns.get(origin.list);
        const hasMoved = movedIds.has(origin.id);
        let number = seenRun !== undefined && seenRun !== run.id ? run.startNumber
          : previousNumber !== undefined && (seenRun !== undefined || hasMoved) ? previousNumber + 1
            : hasMoved ? 1 : run.startNumber;
        seenRuns.set(origin.list, run.id);

        // Promoted children occupy the deleted parent's place in its original sequence
        for (let parentId = origin.parent; parentId !== null && !survivors.has(parentId); parentId = source.items[parentId].parent) {
          const ancestor = source.items[parentId];
          const ancestorRun = runs.get(parentId);
          if (ancestorRun) {
            seenRuns.set(ancestor.list, ancestorRun.id);
            if (previousNumber === undefined) {
              number = ancestorRun.startNumber;
            }
          }
        }

        if (number !== parseInt(item.marker)) {
          markers.set(item.id, numberedMarker(number, item.marker));
        }

        previousNumber = number;
      }
    }

    if (!markers.size) {
      return { kind: 'pass' };
    }

    return { kind: 'repair', changes: applyNumbers(afterDeletion, markers, activeLanguage.parser, budget) };
  } catch (error) {
    if (error instanceof UnsafeMove) {
      return { kind: 'reject', reason: error.message };
    }

    throw error;
  }
}

function applyNumbers(model: Model, markers: Map<number, string>, parser: Parser, budget: Budget) {
  let changes = ChangeSet.empty(model.doc.length);
  const markerEdits: ChangeSpec[] = [];
  const markerUpdates = new Map<number, string>();
  for (const [id, marker] of markers) {
    const item = model.items[id];
    if (item.marker.length === marker.length) {
      markerEdits.push({ from: item.mark.from, to: item.mark.to, insert: marker });
      markerUpdates.set(id, marker);
    }
  }

  function applyChanges(edits: ChangeSpec[], expected: Map<number, string>) {
    const changeSet = ChangeSet.of(edits, model.doc.length);
    const candidate = readModel(changeSet.apply(model.doc), parser, budget);
    validateMove(model, candidate, changeSet, new Map(), expected, budget);
    changes = changes.compose(changeSet);
    model = candidate;
  }

  if (markerEdits.length) {
    applyChanges(markerEdits, markerUpdates);
  }

  // Re-read after width changes so nested repairs use their parent's updated alignment
  for (const [id, marker] of markers) {
    const item = model.items[id];
    if (item.marker === marker) {
      continue;
    }

    const edits: ChangeSpec[] = [];
    rewriteItem(model, edits, item, metrics(model, item).column, marker, budget);
    applyChanges(edits, new Map([[id, marker]]));
  }

  return changes;
}
