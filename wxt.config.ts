import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'UNOS Web Extension',
    description: 'Track tab usage, relationships, and metadata',
    version: '0.0.1',
    permissions: ['tabs', 'storage', 'alarms', 'downloads', 'scripting', 'offscreen', 'system.memory', 'cookies', 'nativeMessaging'],
    host_permissions: ['<all_urls>'],
    icons: {
      '16': 'icons/icon-16.png',
      '32': 'icons/icon-32.png',
      '48': 'icons/icon-48.png',
      '128': 'icons/icon-128.png',
    },
  },
});
