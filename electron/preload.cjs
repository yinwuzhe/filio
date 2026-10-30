const { contextBridge, ipcRenderer } = require('electron');

async function translationCall(channel, input) {
  const result = await ipcRenderer.invoke(channel, input);
  if (!result?.ok) {
    const error = new Error(result?.error || '翻译服务请求失败。');
    error.code = result?.code || 'INTERNAL_ERROR';
    throw error;
  }
  return result.value;
}

contextBridge.exposeInMainWorld('folio', Object.freeze({
  getTranslationConfig() { return translationCall('folio:translation-config-get'); },
  saveTranslationConfig(config) { return translationCall('folio:translation-config-save', config); },
  clearTranslationConfig() { return translationCall('folio:translation-config-clear'); },
  translateArticle(input) { return translationCall('folio:translate', input); },
  cancelTranslation(requestId) { return translationCall('folio:translation-cancel', requestId); },
  async fetchFeed(url) {
    const result = await ipcRenderer.invoke('folio:fetch-feed', url);
    if (!result?.ok) throw new Error(result?.error || 'The feed could not be loaded.');
    return result.feed;
  },
  openExternal(url) {
    return ipcRenderer.invoke('folio:open-external', url);
  },
}));
