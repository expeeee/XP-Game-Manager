const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('libraryApi', {
  load: () => ipcRenderer.invoke('library:load'),
  discoverMetadata: () => ipcRenderer.invoke('library:discover-metadata'),
  applyStoreAppId: (game, appId) => ipcRenderer.invoke('library:apply-store-app-id', game, appId),
  chooseFolder: () => ipcRenderer.invoke('library:choose-folder'),
  addFolder: (folder) => ipcRenderer.invoke('library:add-folder', folder),
  removeFolder: (folder) => ipcRenderer.invoke('library:remove-folder', folder),
  saveProtonSettings: (configuration) => ipcRenderer.invoke('settings:save-proton', configuration),
  installGeProton: () => ipcRenderer.invoke('settings:install-ge-proton'),
  chooseExecutable: () => ipcRenderer.invoke('launcher:choose-executable'),
  getLauncher: (gameId) => ipcRenderer.invoke('launcher:get', gameId),
  saveLauncher: (game, configuration) => ipcRenderer.invoke('launcher:save', game, configuration),
  previewLaunch: (game, configuration) => ipcRenderer.invoke('launcher:preview', game, configuration),
  launch: (game, configuration) => ipcRenderer.invoke('launcher:launch', game, configuration)
});
