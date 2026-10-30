const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function createConfigStore({ app, safeStorage }, filesystem = fs) {
  let existingEncrypted = false;
  const filePath = () => path.join(app.getPath('userData'), 'translation-config.enc');
  const encrypted = () => Boolean(safeStorage?.isEncryptionAvailable())
    && safeStorage.getSelectedStorageBackend?.() !== 'basic_text';
  return {
    async loadConfig() {
      let bytes;
      try {
        const info = await filesystem.stat(filePath());
        if (info.size > 64 * 1024) throw new Error('Invalid encrypted configuration size');
        bytes = await filesystem.readFile(filePath());
        existingEncrypted = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return { config: null, persistence: encrypted() ? 'encrypted' : 'session' };
      }
      if (!encrypted()) throw new Error('Encrypted configuration is unavailable');
      return { config: JSON.parse(safeStorage.decryptString(bytes)), persistence: 'encrypted' };
    },
    async saveConfig(config) {
      const target = filePath();
      if (config === null) {
        try { await filesystem.unlink(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        existingEncrypted = false;
        return encrypted() ? 'encrypted' : 'session';
      }
      if (!encrypted()) {
        if (existingEncrypted) throw new Error('Encrypted configuration cannot be replaced');
        return 'session';
      }
      const bytes = safeStorage.encryptString(JSON.stringify(config));
      await filesystem.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await filesystem.open(temporary, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        await filesystem.rename(temporary, target);
        existingEncrypted = true;
      } finally {
        await handle?.close().catch(() => {});
        await filesystem.unlink(temporary).catch(() => {});
      }
      return 'encrypted';
    },
  };
}

module.exports = { createConfigStore };
