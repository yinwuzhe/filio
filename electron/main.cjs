const { app, BrowserWindow, ipcMain, shell, dialog, safeStorage } = require('electron');
const path = require('node:path');
const { pathToFileURL, fileURLToPath } = require('node:url');

app.setName('Folio');

const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
let mainWindow = null;
let rendererUrl = null;
let activeFeedRequests = 0;
let feedModule;
let translationService;

function getTranslationService() {
  translationService ??= import(pathToFileURL(path.join(__dirname, '..', 'server', 'translation.mjs')).href)
    .then(({ createTranslationService }) => {
      const { createConfigStore } = require(path.join(__dirname, 'translation.cjs'));
      return createTranslationService(createConfigStore({ app, safeStorage }));
    });
  return translationService;
}

function developmentRendererUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password) {
    throw new Error('ELECTRON_RENDERER_URL must point to a local HTTP or HTTPS development server.');
  }
  return url;
}

function isRendererDocument(value) {
  try {
    const url = new URL(value);
    if (rendererUrl) {
      return url.origin === rendererUrl.origin
        && url.pathname === rendererUrl.pathname
        && url.search === rendererUrl.search;
    }
    return url.protocol === 'file:' && !url.host && !url.search
      && fileURLToPath(url) === indexPath;
  } catch {
    return false;
  }
}

function assertTrustedSender(event) {
  const contents = mainWindow?.webContents;
  const frame = event.senderFrame;
  if (!contents || contents.isDestroyed() || event.sender !== contents
    || !frame || frame !== contents.mainFrame || !isRendererDocument(frame.url)) {
    throw new Error('This request is not authorized.');
  }
}

function externalUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error('Enter a valid web address.');
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid web address.');
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Only HTTP and HTTPS links can be opened.');
  }
  return url.href;
}

function registerIpc() {
  const translationChannels = {
    'folio:translation-config-get': 'getConfig',
    'folio:translation-config-save': 'saveConfig',
    'folio:translation-config-clear': 'clearConfig',
    'folio:translate': 'translate',
    'folio:translation-cancel': 'cancel',
  };
  for (const [channel, method] of Object.entries(translationChannels)) {
    ipcMain.handle(channel, async (event, input) => {
      assertTrustedSender(event);
      try {
        const service = await getTranslationService();
        assertTrustedSender(event);
        return { ok: true, value: await service[method](input) };
      } catch (error) {
        const known = error?.name === 'TranslationError';
        return { ok: false, error: known ? error.message : '翻译服务暂时不可用，请重试。', code: known ? error.code : 'INTERNAL_ERROR' };
      }
    });
  }
  ipcMain.handle('folio:fetch-feed', async (event, url) => {
    assertTrustedSender(event);
    if (activeFeedRequests >= 6) {
      return { ok: false, error: 'Too many feeds are loading. Please try again shortly.' };
    }
    activeFeedRequests += 1;
    try {
      feedModule ??= import(pathToFileURL(path.join(__dirname, '..', 'server', 'feeds.mjs')).href);
      const { fetchFeed } = await feedModule;
      return { ok: true, feed: await fetchFeed(url) };
    } catch (error) {
      return {
        ok: false,
        error: error?.name === 'FeedError' ? error.message : 'The feed could not be loaded. Please try again.',
      };
    } finally {
      activeFeedRequests -= 1;
    }
  });

  ipcMain.handle('folio:open-external', async (event, value) => {
    assertTrustedSender(event);
    const url = externalUrl(value);
    try {
      await shell.openExternal(url);
    } catch {
      throw new Error('The link could not be opened in your browser.');
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    title: 'Folio',
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#fafbf9',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 20, y: 20 },
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  mainWindow = window;
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const preventUnexpectedNavigation = (event, url) => {
    if (!isRendererDocument(url)) event.preventDefault();
  };
  window.webContents.on('will-navigate', preventUnexpectedNavigation);
  window.webContents.on('will-redirect', preventUnexpectedNavigation);
  window.webContents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame || !isRendererDocument(event.url)) event.preventDefault();
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('page-title-updated', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      translationService?.then((service) => service.cancelAll()).catch(() => {});
    }
  });
  const loading = rendererUrl ? window.loadURL(rendererUrl.href) : window.loadFile(indexPath);
  loading.catch(() => {
    if (!window.isDestroyed()) {
      dialog.showErrorBox('Folio could not start', 'The application page could not be loaded. Rebuild the app or check that the development server is running.');
      window.close();
    }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (app.isReady()) createWindow();
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(() => {
    try {
      if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
        rendererUrl = developmentRendererUrl(process.env.ELECTRON_RENDERER_URL);
      }
      registerIpc();
      createWindow();
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    } catch (error) {
      dialog.showErrorBox('Folio could not start', error.message);
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
