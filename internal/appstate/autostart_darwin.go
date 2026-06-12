//go:build darwin

package appstate

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const launchAgentLabel = "dev.ixianlabs.mtgdata"

func launchAgentPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("resolve home dir: %w", err)
	}
	return filepath.Join(home, "Library", "LaunchAgents", launchAgentLabel+".plist"), nil
}

// autostartExecutable resolves the binary a LaunchAgent should point at and
// rejects transient binaries (`go run`, test builds) that would leave a
// dangling agent behind.
func autostartExecutable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("resolve executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve executable symlinks: %w", err)
	}
	tempDir, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil {
		tempDir = os.TempDir()
	}
	if strings.HasPrefix(exe, tempDir) || strings.Contains(exe, string(filepath.Separator)+"go-build") {
		return "", fmt.Errorf("launch at login requires an installed app build (current binary is temporary: %s)", exe)
	}
	return exe, nil
}

func xmlEscape(value string) string {
	replacer := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;")
	return replacer.Replace(value)
}

func GetAutostartStatus() AutostartStatus {
	status := AutostartStatus{Supported: true}
	agentPath, err := launchAgentPath()
	if err != nil {
		status.Note = err.Error()
		return status
	}
	status.AgentPath = agentPath
	if _, err := os.Stat(agentPath); err == nil {
		status.Enabled = true
	}
	if exe, err := autostartExecutable(); err == nil {
		status.Executable = exe
	} else {
		status.Note = err.Error()
	}
	return status
}

func SetAutostart(enabled bool) (AutostartStatus, error) {
	agentPath, err := launchAgentPath()
	if err != nil {
		return GetAutostartStatus(), err
	}

	if !enabled {
		if err := os.Remove(agentPath); err != nil && !os.IsNotExist(err) {
			return GetAutostartStatus(), fmt.Errorf("remove launch agent: %w", err)
		}
		return GetAutostartStatus(), nil
	}

	exe, err := autostartExecutable()
	if err != nil {
		return GetAutostartStatus(), err
	}

	plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>%s</string>
	<key>ProgramArguments</key>
	<array>
		<string>%s</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>ProcessType</key>
	<string>Interactive</string>
</dict>
</plist>
`, launchAgentLabel, xmlEscape(exe))

	if err := os.MkdirAll(filepath.Dir(agentPath), 0o755); err != nil {
		return GetAutostartStatus(), fmt.Errorf("create LaunchAgents dir: %w", err)
	}
	if err := os.WriteFile(agentPath, []byte(plist), 0o644); err != nil {
		return GetAutostartStatus(), fmt.Errorf("write launch agent: %w", err)
	}
	return GetAutostartStatus(), nil
}
