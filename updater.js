// Automatic updates from the GitHub Releases page (electron-updater). LaTeXDesk asks before downloading,
// downloads in the background, and installs when the app is next closed (or straight away on "Restart now").
// Releases need the installer, its .blockmap and latest.yml attached (electron-builder makes all three).
const { app } = require('electron')

let updater = null
let send = () => {}
let state = { status: 'idle' }

function setState(patch) {
  state = { ...state, ...patch }
  send(state)
}

function load() {
  if (updater) return updater
  ;({ autoUpdater: updater } = require('electron-updater'))
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = true
  updater.logger = null
  // tests point it at a local feed (dev-app-update.yml) while running unpackaged
  if (process.env.LATEXDESK_UPDATE_FEED) {
    updater.forceDevUpdateConfig = true
    updater.setFeedURL({ provider: 'generic', url: process.env.LATEXDESK_UPDATE_FEED })
  }
  updater.on('checking-for-update', () => setState({ status: 'checking', error: null }))
  updater.on('update-available', info => setState({ status: 'available', version: info.version, notes: releaseNotes(info), date: info.releaseDate }))
  updater.on('update-not-available', () => setState({ status: 'current' }))
  updater.on('download-progress', p => setState({ status: 'downloading', percent: Math.round(p.percent), bytesPerSecond: p.bytesPerSecond }))
  updater.on('update-downloaded', info => setState({ status: 'ready', version: info.version }))
  updater.on('error', e => setState({ status: 'error', error: friendly(e) }))
  return updater
}

function releaseNotes(info) {
  const n = info.releaseNotes
  if (!n) return ''
  // GitHub gives HTML; a short plain-text version is enough for the prompt
  const text = (Array.isArray(n) ? n.map(x => x.note).join('\n') : String(n)).replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ')
  return text.replace(/\s+/g, ' ').trim().slice(0, 600)
}

function friendly(e) {
  const msg = String(e?.message ?? e)
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|net::ERR/i.test(msg)) return 'No internet connection, or GitHub could not be reached.'
  if (/404|latest\.yml/i.test(msg)) return 'The newest release has no update information yet.'
  return msg.split('\n')[0].slice(0, 200)
}

/** Updates only work in the installed app (not when running from source), unless a test feed is set. */
function supported() {
  return app.isPackaged || !!process.env.LATEXDESK_UPDATE_FEED
}

async function check() {
  if (!supported()) return setState({ status: 'unsupported' }), state
  try {
    await load().checkForUpdates()
  } catch (e) {
    setState({ status: 'error', error: friendly(e) })
  }
  return state
}

async function download() {
  if (!supported()) return state
  try {
    setState({ status: 'downloading', percent: 0 })
    await load().downloadUpdate()
  } catch (e) {
    setState({ status: 'error', error: friendly(e) })
  }
  return state
}

function install() {
  if (state.status !== 'ready') return false
  // quit and run the installer silently, then reopen LaTeXDesk
  setImmediate(() => load().quitAndInstall(true, true))
  return true
}

function init(onState) {
  send = onState
}

module.exports = { init, check, download, install, supported, state: () => state }
