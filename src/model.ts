import { DocInput } from '@codemirror/language';
import { countColumn } from '@codemirror/state';
import type { ChangeSet, Text } from '@codemirror/state';
import { IterMode } from '@lezer/common';
import type { Parser, SyntaxNode } from '@lezer/common';

export class UnsafeMove extends Error {}

export class Budget {
  private readonly deadline = performance.now() + 100;

  check() {
    if (performance.now() > this.deadline) {
      throw new UnsafeMove('The document took too long to validate. No changes were made.');
    }
  }
}

export type Item = {
  id: number;
  node: SyntaxNode;
  mark: SyntaxNode;
  marker: string;
  line: number;
  parent: number | null;
  list: number;
};

type Meaning = {
  name: string;
  from: number;
  to: number;
  owner: number | null;
  literal?: string;
};

export type Model = {
  doc: Text;
  items: Item[];
  meaning: Meaning[];
  marks: Map<number, SyntaxNode[]>;
  codeStarts: Map<number, number>;
};

const containers = new Set(['Document', 'OrderedList', 'BulletList', 'ListItem', 'ListMark', 'QuoteMark']);
const literals = new Set(['InlineCode', 'HTMLBlock', 'HTMLTag', 'Comment', 'CommentBlock', 'ProcessingInstruction', 'ProcessingInstructionBlock']);

export function readModel(doc: Text, parser: Parser, budget: Budget): Model {
  const parseState = parser.startParse(new DocInput(doc));
  let tree;
  do {
    budget.check();
    tree = parseState.advance();
  } while (!tree);

  budget.check();
  const model: Model = { doc, items: [], meaning: [], marks: new Map(), codeStarts: new Map() };
  const listIds = new Map<number, number>();

  function addMark(node: SyntaxNode) {
    const lineNumber = doc.lineAt(node.from).number;
    const marks = model.marks.get(lineNumber) ?? [];
    marks.push(node);
    model.marks.set(lineNumber, marks);
  }

  function visit(node: SyntaxNode, owner: number | null) {
    budget.check();
    if (node.name === 'ListItem') {
      const mark = node.getChild('ListMark');
      if (!mark || !node.parent) {
        throw new UnsafeMove('The list syntax is not supported.');
      }

      if (!listIds.has(node.parent.from)) {
        listIds.set(node.parent.from, listIds.size);
      }

      const item: Item = {
        id: model.items.length,
        node,
        mark,
        marker: doc.sliceString(mark.from, mark.to),
        line: doc.lineAt(mark.from).number,
        parent: owner,
        list: listIds.get(node.parent.from)!,
      };

      model.items.push(item);
      owner = item.id;
    }

    if (node.name === 'ListMark' || node.name === 'QuoteMark') {
      addMark(node);
    }

    if (node.name === 'FencedCode' || node.name === 'CodeBlock') {
      const codeChunks: string[] = [];
      const cursor = node.cursor(IterMode.IgnoreMounts);
      do {
        if (cursor.name === 'QuoteMark') {
          addMark(cursor.node);
        }

        if (cursor.name !== 'CodeText') {
          continue;
        }

        codeChunks.push(doc.sliceString(cursor.from, cursor.to));
        for (let lineNumber = doc.lineAt(cursor.from).number; lineNumber <= doc.lineAt(cursor.to).number; lineNumber++) {
          const line = doc.line(lineNumber);
          if (cursor.to <= line.from) {
            continue;
          }

          const codeStart = Math.max(line.from, cursor.from);
          model.codeStarts.set(lineNumber, Math.min(model.codeStarts.get(lineNumber) ?? line.to, codeStart));
        }
      } while (cursor.next());

      model.meaning.push({
        name: node.name,
        from: node.from,
        to: node.to,
        owner,
        literal: codeChunks.join(''),
      });

      // Markdown-looking text in a mounted code language is never a list
      return;
    }

    if (!containers.has(node.name)) {
      model.meaning.push({
        name: node.name,
        from: node.from,
        to: node.to,
        owner,
        // These nodes don't expose container-free payload ranges. Require byte identity
        literal: literals.has(node.name) ? doc.sliceString(node.from, node.to) : undefined,
      });
    }

    for (let child = node.firstChild; child; child = child.nextSibling) {
      visit(child, owner);
    }
  }

  visit(tree.topNode, null);
  return model;
}

export function itemAt(model: Model, position: number): Item | undefined {
  const lineNumber = model.doc.lineAt(position).number;
  const items = model.items.filter(item => item.line === lineNumber);
  return items.filter(item => item.mark.from <= position).at(-1) ?? items[0];
}

export function siblings(model: Model, item: Item): Item[] {
  return model.items.filter(candidate => candidate.list === item.list);
}

export function numberedMarker(number: number, marker: string) {
  if (!Number.isInteger(number) || number < 0 || number > 999999999) {
    throw new UnsafeMove('Ordered-list numbers must be non-negative and at most nine digits.');
  }

  return `${number}${marker.slice(-1)}`;
}

export function quotePrefix(text: string, depth: number) {
  let quoteEnd = 0;
  for (let index = 0; index < depth; index++) {
    const match = /^[ \t]*>/.exec(text.slice(quoteEnd));
    if (!match) {
      throw new UnsafeMove('This move requires rewriting a lazy or same-line blockquote.');
    }

    quoteEnd += match[0].length;
  }

  const padding = depth > 0 && /^[ \t]/.test(text.slice(quoteEnd)) ? 1 : 0;
  return { end: quoteEnd, column: countColumn(text.slice(0, quoteEnd), 4) + padding };
}

export function metrics(model: Model, item: Item) {
  const line = model.doc.line(item.line);
  const prefix = model.doc.sliceString(line.from, item.mark.from);
  const quoteDepth = prefix.split('>').length - 1;
  const quote = quotePrefix(line.text, quoteDepth);
  const column = countColumn(prefix, 4) - quote.column;
  const spaces = /^[ \t]*/.exec(model.doc.sliceString(item.mark.to, line.to))![0];
  const padding = countColumn(prefix + item.marker + spaces, 4) - countColumn(prefix + item.marker, 4);
  return { column, contentColumn: column + item.marker.length + (padding >= 1 && padding <= 4 ? padding : 1), quoteDepth };
}

export function validateMove(
  source: Model,
  candidate: Model,
  changes: ChangeSet,
  parents: Map<number, number | null>,
  markers: Map<number, string>,
  budget: Budget,
) {
  if (source.items.length !== candidate.items.length) {
    throw new UnsafeMove('The move would turn a list item into another kind of content.');
  }

  for (const item of source.items) {
    budget.check();
    const candidateItem = candidate.items[item.id];
    const expectedParent = parents.has(item.id) ? parents.get(item.id) : item.parent;
    if (candidateItem.line !== item.line || candidateItem.parent !== expectedParent || candidateItem.marker !== (markers.get(item.id) ?? item.marker)) {
      throw new UnsafeMove('The resulting list hierarchy does not match the requested move.');
    }
  }

  if (source.meaning.length !== candidate.meaning.length) {
    throw new UnsafeMove('The move would change non-list Markdown structure.');
  }

  source.meaning.forEach((node, index) => {
    budget.check();
    const candidateNode = candidate.meaning[index];
    if (node.name !== candidateNode.name || node.owner !== candidateNode.owner || node.literal !== candidateNode.literal
      || changes.mapPos(node.from, 1) !== candidateNode.from || changes.mapPos(node.to, -1) !== candidateNode.to) {
      throw new UnsafeMove(`The move would change ${node.name} content or ownership.`);
    }
  });
}
