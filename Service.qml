import QtQuick
import Quickshell
import Quickshell.Io

// Takeout's Omarchy plugin entry point: keeps the Takeout server running for
// as long as the Omarchy shell is up. The terminal itself lives in tmux, so
// even if the server restarts, your session doesn't.
Item {
  id: root

  property var shell: null
  property var manifest: null

  readonly property string pluginDir: decodeURIComponent(String(Qt.resolvedUrl("start.sh")).replace(/^file:\/\//, "")).replace(/\/start\.sh$/, "")
  property int failures: 0

  Process {
    id: server
    command: ["bash", root.pluginDir + "/start.sh"]
    running: true
    stdout: SplitParser { onRead: function(line) { console.log("[takeout] " + line) } }
    stderr: SplitParser { onRead: function(line) { console.warn("[takeout] " + line) } }
    onExited: function(exitCode) {
      // Back off on repeated failures (no Node yet, port taken) instead of spinning.
      restartTimer.interval = Math.min(60000, 2000 * Math.pow(2, Math.min(root.failures, 5)))
      root.failures++
      restartTimer.start()
    }
  }

  Timer {
    id: restartTimer
    repeat: false
    onTriggered: server.running = true
  }

  // A server that has stayed up for a while is healthy again.
  Timer {
    interval: 120000
    running: server.running
    repeat: true
    onTriggered: root.failures = 0
  }

  Component.onDestruction: server.running = false
}
