export type Settings = {
  indentWidth: 'auto' | 3 | 4;
  renumberOnDelete: boolean;
  tabBehavior: 'marker' | 'item';
};

export const defaultSettings: Settings = {
  indentWidth: 'auto',
  renumberOnDelete: true,
  tabBehavior: 'marker',
};

export function readSettings(value: unknown): Settings {
  if (value === undefined) {
    return { ...defaultSettings };
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('extension.markeditSmartList must be an object.');
  }

  const indentWidth = 'indentWidth' in value ? value.indentWidth : defaultSettings.indentWidth;
  const renumberOnDelete = 'renumberOnDelete' in value ? value.renumberOnDelete : defaultSettings.renumberOnDelete;
  const tabBehavior = 'tabBehavior' in value ? value.tabBehavior : defaultSettings.tabBehavior;

  if (indentWidth !== 'auto' && indentWidth !== 3 && indentWidth !== 4) {
    throw new Error('extension.markeditSmartList.indentWidth must be "auto", 3, or 4.');
  }

  if (typeof renumberOnDelete !== 'boolean') {
    throw new Error('extension.markeditSmartList.renumberOnDelete must be a boolean.');
  }

  if (tabBehavior !== 'marker' && tabBehavior !== 'item') {
    throw new Error('extension.markeditSmartList.tabBehavior must be "marker" or "item".');
  }

  return { indentWidth, renumberOnDelete, tabBehavior };
}
