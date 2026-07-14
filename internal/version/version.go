// Package version holds the application version, overridable at build time:
//
//	go build -ldflags "-X github.com/solean/ponder/internal/version.Version=1.2.3"
package version

var Version = "0.1.0"
