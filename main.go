package main

import (
	"context"
	"embed"
	"io/fs"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
)

//go:embed all:web/dist
var embeddedAssets embed.FS

func main() {
	assets, err := fs.Sub(embeddedAssets, "web/dist")
	if err != nil {
		log.Fatalf("prepare embedded web assets: %v", err)
	}

	app := NewApp()
	if err := wails.Run(&options.App{
		Title:            "MTGData",
		Width:            1480,
		Height:           960,
		MinWidth:         1200,
		MinHeight:        760,
		BackgroundColour: &options.RGBA{R: 8, G: 12, B: 21, A: 1},
		AssetServer: &assetserver.Options{
			Assets: assets,
		},
		OnStartup: app.startup,
		OnShutdown: func(_ context.Context) {
			app.shutdown()
		},
		Bind: []any{
			app,
		},
	}); err != nil {
		log.Fatalf("run wails app: %v", err)
	}
}
