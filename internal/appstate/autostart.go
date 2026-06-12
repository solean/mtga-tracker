package appstate

// AutostartStatus describes whether the app is configured to launch at login.
type AutostartStatus struct {
	Supported  bool   `json:"supported"`
	Enabled    bool   `json:"enabled"`
	AgentPath  string `json:"agentPath,omitempty"`
	Executable string `json:"executable,omitempty"`
	Note       string `json:"note,omitempty"`
}
