import { language } from '@codemirror/language';
import { countColumn, EditorSelection } from '@codemirror/state';
import type { ChangeSet, ChangeSpec, EditorState, TransactionSpec } from '@codemirror/state';
import {
  Budget, UnsafeMove, itemAt, metrics, numberedMarker, quotePrefix, readModel, siblings, validateMove,
} from './model.ts';
import type { Item, Model } from './model.ts';
import { defaultSettings } from './settings.ts';
import type { Settings } from './settings.ts';

export type Direction = 1 | -1;
export type Plan =
  | { kind: 'pass' }
  | { kind: 'reject'; reason: string }
  | { kind: 'move'; transaction: TransactionSpec & { changes: ChangeSet } };

export function planIndent(state: EditorState, direction: Direction, settings = defaultSettings, isTab = false): Plan {
  const activeLanguage = state.facet(language);
  if (state.readOnly || state.selection.ranges.length !== 1
    || !activeLanguage || !['markdown', 'yaml-frontmatter'].includes(activeLanguage.name)) {
    return { kind: 'pass' };
  }

  // This is only a negative prefilter; the parser determines whether a marker is really a list
  const line = state.doc.lineAt(state.selection.main.from);
  if (!/^[ \t>]*(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/.test(line.text)) {
    return { kind: 'pass' };
  }

  try {
    const budget = new Budget();
    const source = readModel(state.doc, activeLanguage.parser, budget);
    const { from, to } = state.selection.main;
    const firstItem = itemAt(source, from);
    if (!firstItem) {
      return { kind: 'pass' };
    }

    if (isTab && settings.tabBehavior === 'marker' && from === to) {
      const spaces = /^[ \t]*/.exec(state.doc.sliceString(firstItem.mark.to, state.doc.line(firstItem.line).to))![0];
      if (from > firstItem.mark.to + spaces.length) {
        return { kind: 'pass' };
      }
    }

    const selectionEnd = to > from && state.doc.lineAt(to).from === to ? to - 1 : to;
    const siblingItems = siblings(source, firstItem);
    const lastItem = from === to ? firstItem
      : siblingItems.findLast(item => item.node.from <= selectionEnd && item.node.to >= selectionEnd);
    if (!lastItem) {
      throw new UnsafeMove('Select sibling list items without unrelated text.');
    }

    const selectedItems = siblingItems.slice(siblingItems.indexOf(firstItem), siblingItems.indexOf(lastItem) + 1);
    const previousItem = siblingItems[siblingItems.indexOf(firstItem) - 1];
    const parentItem = firstItem.parent === null ? undefined : source.items[firstItem.parent];
    if ((direction === 1 && !previousItem) || (direction === -1 && !parentItem)) {
      return { kind: 'pass' };
    }

    const edits: ChangeSpec[] = [];
    const parents = new Map<number, number | null>();
    const markers = new Map<number, string>();

    function changeItem(item: Item, column: number, marker: string) {
      budget.check();
      markers.set(item.id, marker);
      rewriteItem(source, edits, item, column, marker, budget);
    }

    function moveItems(items: Item[], column: number, marker: string, startNumber: number) {
      let isConsecutive = true;
      let lastMarker = marker;
      items.forEach((item, index) => {
        if (index > 0 && /^\d/.test(item.marker) && parseInt(item.marker) !== parseInt(items[index - 1].marker) + 1) {
          isConsecutive = false;
        }

        const number = isConsecutive ? startNumber + index : parseInt(item.marker);
        lastMarker = /^\d/.test(marker) ? numberedMarker(number, marker) : marker;
        changeItem(item, column, lastMarker);
      });

      return { isConsecutive, lastMarker };
    }

    function renumberAfter(item: Item, startNumber: number) {
      if (!/^\d/.test(item.marker)) {
        return;
      }

      const siblingItems = siblings(source, item);
      let number = parseInt(item.marker);
      for (const sibling of siblingItems.slice(siblingItems.indexOf(item) + 1)) {
        if (parseInt(sibling.marker) !== ++number) {
          break;
        }

        changeItem(sibling, metrics(source, sibling).column, numberedMarker(startNumber++, sibling.marker));
      }
    }

    if (direction === 1 && previousItem) {
      const childItem = lastChild(source, previousItem, firstItem.marker);
      const column = childItem ? metrics(source, childItem).column : newChildColumn(source, previousItem, settings.indentWidth);
      if (metrics(source, firstItem).quoteDepth !== metrics(source, previousItem).quoteDepth) {
        throw new UnsafeMove('Moving across blockquote boundaries is not supported.');
      }

      const { isConsecutive } = moveItems(
        selectedItems, column, childItem?.marker ?? firstItem.marker, childItem ? parseInt(childItem.marker) + 1 : 1,
      );

      selectedItems.forEach(item => parents.set(item.id, previousItem.id));
      if (isConsecutive) {
        renumberAfter(lastItem, parseInt(lastItem.marker) + 1 - selectedItems.length);
      }
    } else if (parentItem) {
      const targetMetrics = metrics(source, parentItem);
      if (metrics(source, firstItem).quoteDepth !== targetMetrics.quoteDepth) {
        throw new UnsafeMove('Moving across blockquote boundaries is not supported.');
      }

      const { lastMarker } = moveItems(selectedItems, targetMetrics.column, parentItem.marker, parseInt(parentItem.marker) + 1);
      selectedItems.forEach(item => parents.set(item.id, parentItem.parent));

      const trailingItems = siblingItems.slice(siblingItems.indexOf(lastItem) + 1);
      const childItem = lastChild(source, lastItem, lastItem.marker);
      const sourceMetrics = metrics(source, lastItem);
      const contentShift = targetMetrics.column - sourceMetrics.column + lastMarker.length - lastItem.marker.length;
      const column = childItem ? metrics(source, childItem).column + contentShift
        : newChildColumn(source, lastItem, settings.indentWidth, lastMarker) + targetMetrics.column - sourceMetrics.column;
      moveItems(
        trailingItems, column,
        childItem?.marker ?? lastItem.marker, childItem ? parseInt(childItem.marker) + 1 : 1,
      );

      trailingItems.forEach(item => parents.set(item.id, lastItem.id));
      renumberAfter(parentItem, parseInt(lastMarker) + 1);
    }

    const changes = state.changes(edits);
    const candidate = readModel(changes.apply(state.doc), activeLanguage.parser, budget);
    validateMove(source, candidate, changes, parents, markers, budget);

    const { anchor, head } = state.selection.main;
    return {
      kind: 'move',
      transaction: {
        changes,
        selection: EditorSelection.range(changes.mapPos(anchor, 1), changes.mapPos(head, 1)),
        scrollIntoView: true,
        userEvent: direction === 1 ? 'input.indent' : 'delete.dedent',
      },
    };
  } catch (error) {
    if (error instanceof UnsafeMove) {
      return { kind: 'reject', reason: error.message };
    }

    throw error;
  }
}

function newChildColumn(model: Model, parent: Item, width: Settings['indentWidth'], marker = parent.marker) {
  const { column, contentColumn } = metrics(model, parent);
  const requiredColumn = contentColumn + marker.length - parent.marker.length;
  return width === 'auto' ? requiredColumn : Math.max(requiredColumn, column + width);
}

function lastChild(model: Model, parent: Item, marker: string) {
  const childList = parent.node.lastChild;
  if (childList?.name !== (/^\d/.test(marker) ? 'OrderedList' : 'BulletList')) {
    return undefined;
  }

  return model.items.findLast(item => item.parent === parent.id && item.node.parent?.from === childList.from
    && item.marker.slice(-1) === marker.slice(-1));
}

export function rewriteItem(model: Model, changes: ChangeSpec[], item: Item, column: number, marker: string, budget: Budget) {
  const firstLine = model.doc.line(item.line);
  if (!/^[ \t>]*$/.test(model.doc.sliceString(firstLine.from, item.mark.from))) {
    throw new UnsafeMove('A list item sharing its line with a parent cannot be moved independently.');
  }

  const sourceMetrics = metrics(model, item);
  const contentDelta = column - sourceMetrics.column + marker.length - item.marker.length;

  function replace(from: number, to: number, insert: string) {
    if (model.doc.sliceString(from, to) !== insert) {
      changes.push({ from, to, insert });
    }
  }

  for (let lineNumber = item.line; lineNumber <= model.doc.lineAt(item.node.to).number; lineNumber++) {
    budget.check();
    const line = model.doc.line(lineNumber);
    if (line.text.trim().length === 0) {
      continue;
    }

    const quote = quotePrefix(line.text, sourceMetrics.quoteDepth);
    const contentEnd = model.codeStarts.get(lineNumber) ?? line.to;
    const indentFrom = line.from + quote.end;
    const whitespace = /^[ \t]*/.exec(model.doc.sliceString(indentFrom, Math.max(indentFrom, contentEnd)))![0];
    const indentTo = indentFrom + whitespace.length;
    const sourceColumn = countColumn(line.text.slice(0, indentTo - line.from), 4) - quote.column;
    const indentWidth = Math.max(0, sourceColumn + (lineNumber === item.line ? column - sourceMetrics.column : contentDelta));
    replace(indentFrom, indentTo, ' '.repeat(indentWidth + (sourceMetrics.quoteDepth > 0 ? 1 : 0)));

    // Normalize container padding, never whitespace that belongs to a code payload
    for (const mark of model.marks.get(lineNumber) ?? []) {
      if (mark.to <= indentTo || mark.to >= contentEnd) {
        continue;
      }

      const spaces = /^[ \t]*/.exec(model.doc.sliceString(mark.to, contentEnd))![0];
      if (!spaces.includes('\t')) {
        continue;
      }

      const prefix = line.text.slice(0, mark.to - line.from);
      const paddingWidth = countColumn(prefix + spaces, 4) - countColumn(prefix, 4);
      replace(mark.to, mark.to + spaces.length, ' '.repeat(paddingWidth));
    }
  }

  replace(item.mark.from, item.mark.to, marker);
}
