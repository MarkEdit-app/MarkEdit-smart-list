import { MarkEdit } from 'markedit-api';
import { smartList } from './src/extension.ts';
import { readSettings } from './src/settings.ts';

const settings = readSettings(MarkEdit.userSettings['extension.markeditSmartList']);

MarkEdit.addExtension(smartList(settings, message => {
  console.warn(`Smart List: ${message}`);
  MarkEdit.playSystemBeep();
}));
