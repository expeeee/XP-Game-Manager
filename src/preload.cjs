const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('libraryApi', {
  load: () => ipcRenderer.invoke('library:load'),
  discoverMetadata: () => ipcRenderer.invoke('library:discover-metadata'),
  applyStoreAppId: (game, appId) => ipcRenderer.invoke('library:apply-store-app-id', game, appId),
  searchSteamStore: (query) => ipcRenderer.invoke('library:search-steam-store', query),
  chooseFolder: () => ipcRenderer.invoke('library:choose-folder'),
  addFolder: (folder) => ipcRenderer.invoke('library:add-folder', folder),
  removeFolder: (folder) => ipcRenderer.invoke('library:remove-folder', folder),
  getTorboxSettings: () => ipcRenderer.invoke('torbox:get-settings'),
  saveTorboxSettings: (configuration) => ipcRenderer.invoke('torbox:save-settings', configuration),
  chooseTorboxDirectory: () => ipcRenderer.invoke('torbox:choose-directory'),
  addTorboxMagnet: (configuration) => ipcRenderer.invoke('torbox:add-magnet', configuration),
  listTorboxJobs: () => ipcRenderer.invoke('torbox:list'),
  downloadTorboxFile: (jobId, fileId) => ipcRenderer.invoke('torbox:download-file', jobId, fileId),
  downloadAllTorboxFiles: (jobId) => ipcRenderer.invoke('torbox:download-all-files', jobId),
  controlTorbox: (jobId, operation) => ipcRenderer.invoke('torbox:control', jobId, operation),
  onTorboxProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on('torbox:progress', listener);
    return () => ipcRenderer.removeListener('torbox:progress', listener);
  },
  chooseProtonDirectory: () => ipcRenderer.invoke('settings:choose-proton-directory'),
  discoverCompatibilityTools: () => ipcRenderer.invoke('settings:discover-proton-tools'),
  diagnoseSystemHealth: () => ipcRenderer.invoke('system:diagnose-health'),
  saveProtonSettings: (configuration) => ipcRenderer.invoke('settings:save-proton', configuration),
  listGeReleases: () => ipcRenderer.invoke('settings:list-ge-releases'),
  installGeProton: (version) => ipcRenderer.invoke('settings:install-ge-proton', version),
  chooseExecutable: () => ipcRenderer.invoke('launcher:choose-executable'),
  getLauncher: (gameId) => ipcRenderer.invoke('launcher:get', gameId),
  saveLauncher: (game, configuration) => ipcRenderer.invoke('launcher:save', game, configuration),
  previewLaunch: (game, configuration) => ipcRenderer.invoke('launcher:preview', game, configuration),
  launch: (game, configuration) => ipcRenderer.invoke('launcher:launch', game, configuration),
  installVcRedist: (game, configuration) => ipcRenderer.invoke('launcher:install-vc-redist', game, configuration),
  installRuntimeAddon: (game, configuration, addonKey) => ipcRenderer.invoke('launcher:install-runtime-addon', game, configuration, addonKey),
  onLaunchLog: (callback) => {
    const listener = (_event, logObj) => callback(logObj);
    ipcRenderer.on('launcher:log', listener);
    return () => ipcRenderer.removeListener('launcher:log', listener);
  },
  onLaunchStatus: (callback) => {
    const listener = (_event, statusObj) => callback(statusObj);
    ipcRenderer.on('launcher:status', listener);
    return () => ipcRenderer.removeListener('launcher:status', listener);
  }
});
