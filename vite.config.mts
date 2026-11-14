import { defineConfig } from 'vite';
import { defaultViteConfig } from 'markedit-vite';

export default defineConfig(defaultViteConfig({ copyDistFile: process.env.MARKEDIT_DEPLOY !== '0' }));
