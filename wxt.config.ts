import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: {
    name: 'UNOS Tab Tracker',
    description: 'Track tab usage, relationships, and metadata',
    version: '0.0.1',
    permissions: ['tabs', 'storage', 'alarms'],
    host_permissions: ['<all_urls>'],
  },
});
