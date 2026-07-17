// Package ai generates deck content (strategy primers) by shelling out to a
// locally installed Claude Code CLI. Using `claude -p` means requests
// authenticate against the user's existing Claude subscription login — no API
// key is stored or billed per-token by this app.
package ai

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// DefaultModel is the Claude Code model alias used for primer generation.
// Primers are generated once and cached, so quality beats speed here.
const DefaultModel = "opus"

// Status describes whether AI generation is usable on this machine.
type Status struct {
	Available bool   `json:"available"`
	CLIPath   string `json:"cliPath,omitempty"`
	Version   string `json:"version,omitempty"`
	Detail    string `json:"detail,omitempty"`
}

// CLIProvider locates and drives the `claude` binary. Safe for concurrent
// use; discovery runs once and is cached.
type CLIProvider struct {
	once    sync.Once
	cliPath string
	version string
	detail  string
}

// lookupCLI finds the claude binary. The desktop app is typically launched
// from Finder with a minimal PATH, so LookPath alone is not enough — probe
// the common install locations too.
func (p *CLIProvider) lookupCLI() {
	if path, err := exec.LookPath("claude"); err == nil {
		p.cliPath = path
		return
	}
	home, _ := os.UserHomeDir()
	candidates := []string{
		filepath.Join(home, ".claude", "local", "claude"),
		filepath.Join(home, ".local", "bin", "claude"),
		filepath.Join(home, ".bun", "bin", "claude"),
		"/opt/homebrew/bin/claude",
		"/usr/local/bin/claude",
	}
	for _, candidate := range candidates {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			p.cliPath = candidate
			return
		}
	}
	p.detail = "Claude Code CLI not found. Install it and sign in with your Claude subscription to enable AI features."
}

// Status reports CLI availability, resolving and version-checking it once.
func (p *CLIProvider) Status(ctx context.Context) Status {
	p.once.Do(func() {
		p.lookupCLI()
		if p.cliPath == "" {
			return
		}
		versionCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		out, err := exec.CommandContext(versionCtx, p.cliPath, "--version").Output()
		if err != nil {
			p.detail = fmt.Sprintf("found %s but `claude --version` failed: %v", p.cliPath, err)
			p.cliPath = ""
			return
		}
		p.version = strings.TrimSpace(string(out))
	})
	return Status{
		Available: p.cliPath != "",
		CLIPath:   p.cliPath,
		Version:   p.version,
		Detail:    p.detail,
	}
}

// streamLine is the subset of Claude Code's stream-json output we care
// about: incremental text deltas while generating, and the final result.
type streamLine struct {
	Type    string `json:"type"`
	Subtype string `json:"subtype"`
	IsError bool   `json:"is_error"`
	Result  string `json:"result"`
	Event   struct {
		Type  string `json:"type"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
	} `json:"event"`
}

// Generate runs `claude -p` with the given prompt, invoking onDelta for each
// streamed text fragment, and returns the final response text. onDelta may be
// nil. Cancelling ctx kills the CLI process.
func (p *CLIProvider) Generate(ctx context.Context, model, prompt string, onDelta func(string)) (string, error) {
	status := p.Status(ctx)
	if !status.Available {
		return "", errors.New(status.Detail)
	}
	if model == "" {
		model = DefaultModel
	}

	args := []string{
		"-p", prompt,
		"--output-format", "stream-json",
		"--include-partial-messages",
		"--verbose",
		"--model", model,
		// Web search grounds card text and current-metagame claims; everything
		// else (shell, file edits) is irrelevant to primer generation.
		"--allowedTools", "WebSearch,WebFetch",
		"--disallowedTools", "Bash,Edit,Write,NotebookEdit,Task",
	}
	cmd := exec.CommandContext(ctx, p.cliPath, args...)
	// Run from a neutral directory so the CLI doesn't pick up project context
	// (CLAUDE.md, local settings) from wherever the app was launched.
	cmd.Dir = os.TempDir()

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return "", fmt.Errorf("claude cli stdout: %w", err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("start claude cli: %w", err)
	}

	var (
		result    string
		gotResult bool
		runErr    error
	)
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var parsed streamLine
		if err := json.Unmarshal(line, &parsed); err != nil {
			continue
		}
		switch parsed.Type {
		case "stream_event":
			if parsed.Event.Type == "content_block_delta" && parsed.Event.Delta.Type == "text_delta" && onDelta != nil {
				onDelta(parsed.Event.Delta.Text)
			}
		case "result":
			gotResult = true
			if parsed.IsError {
				// The CLI can report subtype "success" alongside is_error
				// (e.g. auth failures), so only mention informative subtypes.
				message := truncate(parsed.Result, 500)
				if message == "" {
					message = "unknown error"
				}
				if parsed.Subtype != "" && parsed.Subtype != "success" {
					runErr = fmt.Errorf("claude cli error (%s): %s", parsed.Subtype, message)
				} else {
					runErr = fmt.Errorf("claude cli error: %s", message)
				}
			} else {
				result = parsed.Result
			}
		}
	}
	if scanErr := scanner.Err(); scanErr != nil && runErr == nil {
		runErr = fmt.Errorf("read claude cli output: %w", scanErr)
	}

	if err := cmd.Wait(); err != nil && runErr == nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		runErr = fmt.Errorf("claude cli failed: %v: %s", err, truncate(stderr.String(), 500))
	}
	if runErr != nil {
		return "", runErr
	}
	if !gotResult || strings.TrimSpace(result) == "" {
		return "", fmt.Errorf("claude cli produced no result: %s", truncate(stderr.String(), 500))
	}
	return result, nil
}

func truncate(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…"
}
